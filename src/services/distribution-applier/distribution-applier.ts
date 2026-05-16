import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { posix } from 'node:path';
import JSZip from 'jszip';
import { CliError } from '../../cli-error.js';
import { SPECDD_BOOTSTRAP_PATH } from '../../constants.js';
import type {
  DirectoryCreatorDependency,
  FileExistenceDependency,
  FileReaderDependency,
  FileWriterDependency,
} from '../../infrastructure/file-system.js';
import type { Logger } from '../logger/logger.js';

const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:/;

export type DistributionApplyRequest = {
  zipPath: string;
  targetDirectoryPath: string;
};

export type DistributionApplyResult = {
  writtenPaths: string[];
  overwrittenPaths: string[];
  skippedPaths: string[];
};

type DistributionZipEntry = {
  file: JSZip.JSZipObject;
  normalizedRelativePath: string;
  targetPath: string;
};

type DistributionApplierFileSystemDependency = DirectoryCreatorDependency
  & FileExistenceDependency
  & FileReaderDependency
  & FileWriterDependency;

export class DistributionZipNotFoundError extends CliError {
  public constructor(zipPath: string) {
    super(`SpecDD distribution zip not found: ${zipPath}`);
    this.name = 'DistributionZipNotFoundError';
  }
}

export class DistributionZipReadError extends CliError {
  public constructor(zipPath: string) {
    super(`Failed to read SpecDD distribution zip: ${zipPath}`);
    this.name = 'DistributionZipReadError';
  }
}

export class DistributionUnsafeEntryPathError extends CliError {
  public constructor(entryPath: string) {
    super(`SpecDD distribution zip contains an unsafe entry path: ${entryPath}`);
    this.name = 'DistributionUnsafeEntryPathError';
  }
}

export class DistributionTargetWriteError extends CliError {
  public constructor(path: string) {
    super(`Failed to write SpecDD distribution file: ${path}`);
    this.name = 'DistributionTargetWriteError';
  }
}

export class DistributionApplier {
  private readonly logger: Logger;

  private readonly fileSystem: DistributionApplierFileSystemDependency;

  public constructor(logger: Logger, fileSystem: DistributionApplierFileSystemDependency) {
    this.logger = logger;
    this.fileSystem = fileSystem;
  }

  public async applyDistribution(request: DistributionApplyRequest): Promise<DistributionApplyResult> {
    this.logger.debug(`Applying SpecDD distribution ${request.zipPath} to ${request.targetDirectoryPath}.`);

    const archive = await this.loadArchive(request.zipPath);
    const entries = this.resolveFileEntries(archive, request.targetDirectoryPath);
    const result: DistributionApplyResult = {
      overwrittenPaths: [],
      skippedPaths: [],
      writtenPaths: [],
    };

    for (const entry of entries) {
      await this.applyFileEntry(entry, result);
    }

    return result;
  }

  private async loadArchive(zipPath: string): Promise<JSZip> {
    const zipBytes = await this.readZip(zipPath);

    try {
      return await new JSZip().loadAsync(zipBytes);
    } catch {
      throw new DistributionZipReadError(zipPath);
    }
  }

  private async readZip(zipPath: string): Promise<Uint8Array> {
    try {
      return await this.fileSystem.readFile(zipPath);
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        throw new DistributionZipNotFoundError(zipPath);
      }

      throw new DistributionZipReadError(zipPath);
    }
  }

  private isFileNotFoundError(error: unknown): boolean {
    return error instanceof Error && 'ENOENT' === (error as NodeJS.ErrnoException).code;
  }

  private resolveFileEntries(archive: JSZip, targetDirectoryPath: string): DistributionZipEntry[] {
    const targetRootPath = resolve(targetDirectoryPath);
    const entries: DistributionZipEntry[] = [];

    archive.forEach((relativePath, file) => {
      const entryPath = file.unsafeOriginalName ?? relativePath;
      const entry = this.resolveEntry(entryPath, file, targetRootPath);

      if (file.dir) {
        return;
      }

      entries.push(entry);
    });

    return entries;
  }

  private resolveEntry(entryPath: string, file: JSZip.JSZipObject, targetRootPath: string): DistributionZipEntry {
    const normalizedRelativePath = this.normalizeEntryPath(entryPath);
    const targetPath = resolve(targetRootPath, ...normalizedRelativePath.split('/'));

    this.assertTargetPathInsideRoot(entryPath, targetPath, targetRootPath);

    return {
      file,
      normalizedRelativePath,
      targetPath,
    };
  }

  private normalizeEntryPath(entryPath: string): string {
    const normalizedPath = posix.normalize(entryPath.replaceAll('\\', '/'));

    if (posix.isAbsolute(normalizedPath)) {
      throw new DistributionUnsafeEntryPathError(entryPath);
    }

    if (WINDOWS_DRIVE_PATH_PATTERN.test(normalizedPath)) {
      throw new DistributionUnsafeEntryPathError(entryPath);
    }

    return normalizedPath;
  }

  private assertTargetPathInsideRoot(entryPath: string, targetPath: string, targetRootPath: string): void {
    const relativeTargetPath = relative(targetRootPath, targetPath);

    if ('..' === relativeTargetPath || relativeTargetPath.startsWith(`..${sep}`) || isAbsolute(relativeTargetPath)) {
      throw new DistributionUnsafeEntryPathError(entryPath);
    }
  }

  private async applyFileEntry(entry: DistributionZipEntry, result: DistributionApplyResult): Promise<void> {
    const exists = await this.targetExists(entry.targetPath);

    if (exists && SPECDD_BOOTSTRAP_PATH !== entry.normalizedRelativePath) {
      result.skippedPaths.push(entry.targetPath);
      this.logger.info(`Skipping existing file ${entry.targetPath}.`);

      return;
    }

    const entryBytes = await this.readEntryBytes(entry);

    await this.writeTargetFile(entry.targetPath, entryBytes);

    if (exists) {
      result.overwrittenPaths.push(entry.targetPath);
      this.logger.info(`Overwrote ${entry.targetPath}.`);

      return;
    }

    result.writtenPaths.push(entry.targetPath);
    this.logger.info(`Wrote ${entry.targetPath}.`);
  }

  private async targetExists(targetPath: string): Promise<boolean> {
    try {
      return await this.fileSystem.exists(targetPath);
    } catch {
      throw new DistributionTargetWriteError(targetPath);
    }
  }

  private async readEntryBytes(entry: DistributionZipEntry): Promise<Uint8Array> {
    try {
      return await entry.file.async('uint8array');
    } catch {
      throw new DistributionZipReadError(entry.normalizedRelativePath);
    }
  }

  private async writeTargetFile(targetPath: string, data: Uint8Array): Promise<void> {
    try {
      await this.fileSystem.createDirectory(dirname(targetPath), {
        recursive: true,
      });
      await this.fileSystem.writeFile(targetPath, data);
    } catch {
      throw new DistributionTargetWriteError(targetPath);
    }
  }
}
