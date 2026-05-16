import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';

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
}

export type FileExistenceDependency = Pick<FileSystem, 'exists'>;

export type DirectoryCheckerDependency = Pick<FileSystem, 'isDirectory'>;

export type DirectoryCreatorDependency = Pick<FileSystem, 'createDirectory'>;

export type FileReaderDependency = Pick<FileSystem, 'readFile'>;

export type FileWriterDependency = Pick<FileSystem, 'writeFile'>;

export type FileSystemDependency = Pick<FileSystem, 'createDirectory' | 'exists' | 'isDirectory' | 'readFile' | 'writeFile'>;
