import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { CliError } from '../../cli-error.js';
import type { FileSystem } from '../../infrastructure/file-system.js';

export type PluginRegistryEntry = {
  readonly src: string;
  readonly origin: string;
  readonly sig: string;
  readonly version: string;
  readonly [key: string]: unknown;
};

export const pluginRegistrationsMatch = (
  left: PluginRegistryEntry | undefined,
  right: PluginRegistryEntry | undefined,
): boolean => {
  if (undefined === left || undefined === right) {
    return left === right;
  }

  return left.src === right.src
    && left.origin === right.origin
    && left.sig === right.sig
    && left.version === right.version;
};

export class PluginRegistryError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'PluginRegistryError';
  }
}

export class PluginRegistry {
  public constructor(
    private readonly fileSystem: Pick<FileSystem, 'readFile' | 'writeFileAtomic'>,
    private readonly getHomeDirectory: () => string = homedir,
  ) {}

  public resolveSourcePath(registryPath: string, src: string): string {
    const expanded = src.startsWith('~') ? `${this.getHomeDirectory()}${src.slice(1)}` : src;
    return resolve(dirname(registryPath), expanded);
  }

  public async read(registryPath: string): Promise<PluginRegistryEntry[]> {
    let bytes: Uint8Array;

    try {
      bytes = await this.fileSystem.readFile(registryPath);
    } catch (error) {
      if ('object' === typeof error && null !== error && 'code' in error && 'ENOENT' === error.code) {
        return [];
      }

      throw this.failure(registryPath, error);
    }

    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, }).decode(bytes));
      return this.validate(registryPath, parsed);
    } catch (error) {
      throw this.failure(registryPath, error);
    }
  }

  public async upsert(registryPath: string, entry: PluginRegistryEntry, expected?: PluginRegistryEntry | null): Promise<void> {
    const entries = await this.read(registryPath);
    this.validate(registryPath, [entry,]);
    const target = this.resolveSourcePath(registryPath, entry.src);
    const index = entries.findIndex((existing) => target === this.resolveSourcePath(registryPath, existing.src));

    if (undefined !== expected && !pluginRegistrationsMatch(expected ?? undefined, entries[index])) {
      throw new PluginRegistryError(`Plugin registration changed during installation: ${entry.src}`);
    }

    if (-1 === index) {
      entries.push(entry);
    } else {
      const existing = entries[index]!;
      entries[index] = { ...existing, ...entry, src: existing.src, };
    }

    try {
      await this.fileSystem.writeFileAtomic(registryPath, Buffer.from(`${JSON.stringify(entries, null, 2)}\n`));
    } catch (error) {
      throw this.failure(registryPath, error);
    }
  }

  private validate(registryPath: string, value: unknown): PluginRegistryEntry[] {
    if (!Array.isArray(value)) {
      throw new PluginRegistryError('Plugin registry must contain a JSON array.');
    }

    const paths = new Set<string>();
    const entries: PluginRegistryEntry[] = [];

    for (const candidate of value as unknown[]) {
      if ('object' !== typeof candidate || null === candidate || Array.isArray(candidate)) {
        throw new PluginRegistryError('Plugin registry entries must be objects.');
      }

      const record = candidate as Record<string, unknown>;

      for (const field of ['src', 'origin', 'sig', 'version',]) {
        const fieldValue = record[field];

        if ('string' !== typeof fieldValue || '' === fieldValue.trim() || fieldValue.includes('\0')) {
          throw new PluginRegistryError(`Plugin registry entry requires a nonempty string ${field}.`);
        }
      }

      const entry = record as PluginRegistryEntry;

      if (!/^[a-f0-9]{64}$/.test(entry.sig)) {
        throw new PluginRegistryError('Plugin registry sig must be a lowercase SHA-256 checksum.');
      }

      const path = this.resolveSourcePath(registryPath, entry.src);

      if (paths.has(path)) {
        throw new PluginRegistryError(`Duplicate plugin registry source: ${entry.src}`);
      }

      paths.add(path);
      entries.push(entry);
    }

    return entries;
  }

  private failure(path: string, error: unknown): PluginRegistryError {
    return new PluginRegistryError(`Cannot read or update plugin registry ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
