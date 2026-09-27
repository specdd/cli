import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type FileSystemCreateDirectoryOptions = {
  readonly recursive: boolean;
};

export class FileSystem {
  public async exists(path: string): Promise<boolean> {
    try {
      await access(path);

      return true;
    } catch {
      return false;
    }
  }

  public async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  public async createDirectory(path: string, options: FileSystemCreateDirectoryOptions): Promise<void> {
    await mkdir(path, {
      recursive: options.recursive,
    });
  }

  public async readFile(path: string): Promise<Uint8Array> {
    return readFile(path);
  }

  public async writeFile(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  public async lstat(path: string): Promise<Stats> {
    return lstat(path);
  }

  public async realpath(path: string): Promise<string> {
    return realpath(path);
  }

  public async writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);

    try {
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }

      await rename(temporaryPath, path);
    } catch (error) {
      try {
        await rm(temporaryPath, { force: true, });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError,], `File replacement and cleanup failed: ${path}`);
      }

      throw error;
    }
  }

  public async removePath(path: string, options: { readonly recursive?: boolean } = {}): Promise<void> {
    await rm(path, { recursive: options.recursive ?? false, });
  }

  public async withExclusiveLock<T>(path: string, callback: () => Promise<T>): Promise<T> {
    const handle = await open(path, 'wx', 0o600);
    let failure: unknown;

    try {
      await handle.close();
      return await callback();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await rm(path);
      } catch (cleanupError) {
        if (undefined !== failure) {
          throw new AggregateError([failure, cleanupError,], `Operation and lock release failed: ${path}`);
        }

        throw cleanupError;
      }
    }
  }
}

export type FileExistenceDependency = Pick<FileSystem, 'exists'>;

export type DirectoryCheckerDependency = Pick<FileSystem, 'isDirectory'>;

export type DirectoryCreatorDependency = Pick<FileSystem, 'createDirectory'>;

export type FileReaderDependency = Pick<FileSystem, 'readFile'>;

export type FileWriterDependency = Pick<FileSystem, 'writeFile'>;

export type FileSystemDependency = Pick<FileSystem, 'createDirectory' | 'exists' | 'isDirectory' | 'readFile' | 'writeFile'>;
