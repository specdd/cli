import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError, isCliError } from '../../cli-error.js';
import { PLUGIN_LOCK_PATH, PLUGIN_REGISTRY_PATH, SPECDD_BOOTSTRAP_PATH } from '../../constants.js';
import type { FileSystem } from '../../infrastructure/file-system.js';
import type { GitClient } from '../../infrastructure/git-client.js';
import type { ConfirmationPrompt } from '../../infrastructure/confirmation-prompt.js';
import type { PluginSignatureVerifier, PluginSignatureResult } from '../plugin-signature-verifier/plugin-signature-verifier.js';
import type { Logger } from '../logger/logger.js';
import type { PluginSource, PluginSourceDescriptor } from '../plugin-source/plugin-source.js';
import { pluginRegistrationsMatch, type PluginRegistry, type PluginRegistryEntry } from '../plugin-registry/plugin-registry.js';

export type PluginAddRequest = {
  readonly targetDirectoryPath: string;
  readonly repository: string;
  readonly pluginName: string;
  readonly version?: string | undefined;
};

export type PluginAddResult = {
  readonly outcome: 'installed' | 'replaced' | 'unchanged';
  readonly pluginPath: string;
  readonly registryPath: string;
  readonly commit: string;
  readonly version: string;
};

export type PluginRefreshRequest = PluginAddRequest & {
  readonly registration: PluginRegistryEntry;
};

export class PluginInstallError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'PluginInstallError';
  }
}

type PluginFileSystem = Pick<FileSystem, 'lstat' | 'readFile' | 'writeFileAtomic' | 'createDirectory' | 'removePath' | 'withExclusiveLock'>;

export class PluginInstaller {
  public constructor(
    private readonly source: Pick<PluginSource, 'resolve'>,
    private readonly registry: Pick<PluginRegistry, 'read' | 'resolveSourcePath' | 'upsert'>,
    private readonly git: Pick<GitClient, 'readFiles'>,
    private readonly fileSystem: PluginFileSystem,
    private readonly logger: Pick<Logger, 'info' | 'debug' | 'warn'>,
    private readonly signatureVerifier: Pick<PluginSignatureVerifier, 'verify'>,
    private readonly confirmation: Pick<ConfirmationPrompt, 'confirm'>,
  ) {}

  public async add(request: PluginAddRequest): Promise<PluginAddResult> {
    return this.run(request);
  }

  public async refresh(request: PluginRefreshRequest): Promise<PluginAddResult> {
    return this.run(request, request.registration);
  }

  private async run(request: PluginAddRequest, registration?: PluginRegistryEntry): Promise<PluginAddResult> {
    if (!isAbsolute(request.targetDirectoryPath)) {
      throw new PluginInstallError('Plugin installation requires an absolute project directory.');
    }

    const root = resolve(request.targetDirectoryPath);
    const source = this.source.resolve(request.repository, request.pluginName, request.version);
    const registryPath = join(root, PLUGIN_REGISTRY_PATH);
    const lockPath = join(root, PLUGIN_LOCK_PATH);
    const pluginPath = resolve(dirname(registryPath), source.relativeDestination);

    if (undefined !== registration && pluginPath !== this.registry.resolveSourcePath(registryPath, registration.src)) {
      throw new PluginInstallError(`Plugin registration does not use its managed installation path: ${registration.src}`);
    }

    try {
      const bootstrap = await this.inspect(join(root, SPECDD_BOOTSTRAP_PATH));

      if (!bootstrap?.isFile()) {
        throw new PluginInstallError(`Plugin installation requires ${join(root, SPECDD_BOOTSTRAP_PATH)}. Run specdd init first.`);
      }

      await this.checkSafePath(root, registryPath);
      await this.checkSafePath(root, lockPath);
      await this.checkSafePath(root, pluginPath);

      return await this.fileSystem.withExclusiveLock(lockPath, async () => {
        return this.install(root, source, pluginPath, registryPath, registration);
      });
    } catch (error) {
      if (isCliError(error)) {
        throw error;
      }

      if ('object' === typeof error && null !== error && 'code' in error && 'EEXIST' === error.code) {
        throw new PluginInstallError(`Plugin installation lock is already held: ${lockPath}`);
      }

      throw new PluginInstallError(`Plugin installation failed: ${this.errorMessage(error)}`);
    }
  }

  private async install(
    root: string,
    source: PluginSourceDescriptor,
    pluginPath: string,
    registryPath: string,
    registration: PluginRegistryEntry | undefined,
  ): Promise<PluginAddResult> {
    await this.checkSafePath(root, registryPath);
    await this.checkSafePath(root, pluginPath);
    const entries = await this.registry.read(registryPath);
    const existing = entries.find((entry) => pluginPath === this.registry.resolveSourcePath(registryPath, entry.src));

    if (undefined !== registration && !pluginRegistrationsMatch(registration, existing)) {
      throw new PluginInstallError(`Plugin registration changed before update: ${registration.src}`);
    }

    const previous = await this.readManagedFile(pluginPath, existing);
    this.logger.debug(`Reading plugin source ${source.repositoryFilePath} at ${source.version}.`);
    const downloaded = await this.git.readFiles(source.repositoryUrl, [
      { path: source.repositoryFilePath, },
      { path: source.repositorySignaturePath, optional: true, },
    ], source.gitRef);
    const bytes = downloaded.files.get(source.repositoryFilePath)!;
    const verification = await this.signatureVerifier.verify(bytes, downloaded.files.get(source.repositorySignaturePath), {
      vendorOnly: source.isOfficialRepository,
    });

    if (source.isOfficialRepository && ('verified' !== verification.status || 'vendor' !== verification.source)) {
      const reason = 'unverified' === verification.status || 'unsigned' === verification.status
        ? this.signatureWarning(verification)
        : 'The signature was not verified with an embedded SpecDD signing key.';
      throw new PluginInstallError(
        `Official SpecDD plugin ${source.repositoryCoordinates}:${source.repositoryFilePath} at ${downloaded.commit} requires a valid signature from the embedded SpecDD signing keys. ${reason}`,
      );
    }

    if ('verified' === verification.status) {
      this.logger.info(`Verified plugin signature from ${verification.source} signing key ${verification.signerFingerprint}.`);
    } else {
      this.logger.warn([
        this.signatureWarning(verification),
        `Plugin: ${source.repositoryCoordinates}:${source.repositoryFilePath} at ${downloaded.commit}`,
        'Make sure you trust the vendor before continuing.',
      ].join('\n'), { force: true, });

      if (!await this.confirmation.confirm()) {
        throw new PluginInstallError('Plugin installation cancelled: explicit interactive confirmation is required.');
      }
    }

    const entry: PluginRegistryEntry = {
      src: registration?.src ?? source.relativeDestination,
      origin: `${source.originRepositoryUrl}#${downloaded.commit}`,
      sig: this.checksum(bytes),
      version: source.version,
    };

    // Verification and confirmation may take time; preserve intervening local edits.
    await this.checkSafePath(root, registryPath);
    await this.checkSafePath(root, pluginPath);
    const current = await this.readManagedFile(pluginPath, existing);
    const currentEntries = await this.registry.read(registryPath);
    const currentRegistration = currentEntries.find((candidate) => pluginPath === this.registry.resolveSourcePath(registryPath, candidate.src));

    if (!pluginRegistrationsMatch(existing, currentRegistration)) {
      throw new PluginInstallError(`Plugin registration changed during installation: ${source.relativeDestination}`);
    }

    if ((undefined === previous) !== (undefined === current)
      || (undefined !== previous && undefined !== current && !Buffer.from(previous).equals(current))) {
      throw new PluginInstallError(`Plugin destination changed during download: ${pluginPath}`);
    }

    const unchanged = undefined !== previous && undefined !== existing
      && existing.origin === entry.origin && existing.sig === entry.sig && existing.version === entry.version;
    const outcome = unchanged ? 'unchanged' : undefined === previous ? 'installed' : 'replaced';

    if (!unchanged) {
      await this.fileSystem.createDirectory(dirname(pluginPath), { recursive: true, });
      await this.checkSafePath(root, pluginPath);
      await this.fileSystem.writeFileAtomic(pluginPath, bytes);

      try {
        await this.registry.upsert(registryPath, entry, existing ?? null);
      } catch (error) {
        try {
          if (undefined === previous) {
            await this.fileSystem.removePath(pluginPath);
          } else {
            await this.fileSystem.writeFileAtomic(pluginPath, previous);
          }
        } catch (rollbackError) {
          throw new PluginInstallError(`Registry update failed: ${this.errorMessage(error)}; rollback failed for ${pluginPath}: ${this.errorMessage(rollbackError)}`);
        }

        throw error;
      }
    }

    const result: PluginAddResult = { outcome, pluginPath, registryPath, commit: downloaded.commit, version: source.version, };
    this.logger.info(`Plugin ${outcome}: ${pluginPath} (version ${source.version}, commit ${downloaded.commit}). Registry: ${registryPath}`);
    return result;
  }

  private signatureWarning(result: Exclude<PluginSignatureResult, { status: 'verified' }>): string {
    if ('unsigned' === result.status) {
      return 'This plugin is NOT signed and its publisher cannot be verified.';
    }

    if ('untrusted' === result.status) {
      const identity = 'never' === result.identityValidity
        ? 'GnuPG reports this signing identity as untrusted.'
        : 'Your system has not established sufficient trust in the signer\'s identity.';
      return [
        `The plugin's signature is valid. ${identity}`,
        `Signing key: ${result.signerFingerprint}`,
        `Identity validity: ${result.identityValidity}`,
        'Continue only if you have independently confirmed that this key belongs to a vendor you trust.',
      ].join('\n');
    }

    const reasons = {
      'unknown-vendor': 'The signature was not made by an embedded SpecDD signing key.',
      'unknown-key': 'The signing public key is not available in your local keyring.',
      invalid: 'The signature is malformed or does not match the plugin contents.',
      expired: 'The signature or signing key has expired.',
      revoked: 'The signing key has been revoked.',
      unavailable: 'GnuPG is unavailable for system signature verification.',
      'verification-error': 'System signature verification failed.',
    };
    return `This plugin's signature could not be verified. ${reasons[result.reason]}`;
  }

  private async readManagedFile(path: string, entry: PluginRegistryEntry | undefined): Promise<Uint8Array | undefined> {
    const metadata = await this.inspect(path);

    if (undefined === metadata) {
      return undefined;
    }

    if (!metadata.isFile()) {
      throw new PluginInstallError(`Plugin destination is not a regular file: ${path}`);
    }

    if (undefined === entry) {
      throw new PluginInstallError(`Refusing to overwrite an unregistered plugin file: ${path}`);
    }

    const bytes = await this.fileSystem.readFile(path);

    if (entry.sig !== this.checksum(bytes)) {
      throw new PluginInstallError(`Plugin has local modifications and does not match its recorded checksum: ${path}`);
    }

    return bytes;
  }

  private async checkSafePath(root: string, path: string): Promise<void> {
    const relativePath = relative(root, path);

    if (isAbsolute(relativePath) || '..' === relativePath || relativePath.startsWith(`..${sep}`)) {
      throw new PluginInstallError(`Plugin destination is outside the project: ${path}`);
    }

    const parts = relativePath.split(sep);
    let current = root;

    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const metadata = await this.inspect(current);

      if (metadata?.isSymbolicLink()) {
        throw new PluginInstallError(`Plugin write path contains a symlink: ${current}`);
      }

      if (index < parts.length - 1 && undefined !== metadata && !metadata.isDirectory()) {
        throw new PluginInstallError(`Plugin write ancestor is not a directory: ${current}`);
      }
    }
  }

  private async inspect(path: string): Promise<Stats | undefined> {
    try {
      return await this.fileSystem.lstat(path);
    } catch (error) {
      if ('object' === typeof error && null !== error && 'code' in error && 'ENOENT' === error.code) {
        return undefined;
      }

      throw error;
    }
  }

  private checksum(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
