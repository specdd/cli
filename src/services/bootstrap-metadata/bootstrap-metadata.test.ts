import { join } from 'node:path';
import { SPECDD_BOOTSTRAP_PATH } from '../../constants.js';
import type {
  FileExistenceDependency,
  FileReaderDependency,
} from '../../infrastructure/file-system.js';
import {
  BootstrapMetadata,
  BootstrapMetadataError,
  BootstrapMetadataMissingFieldError,
} from './bootstrap-metadata.js';

type BootstrapMetadataFileSystemDependency = FileExistenceDependency & FileReaderDependency;

class MemoryFileSystem implements BootstrapMetadataFileSystemDependency {
  public readonly checkedExistencePaths: string[] = [];

  public readonly readFilePaths: string[] = [];

  private readonly files: Map<string, Uint8Array>;

  private readonly existenceFailure: Error | null;

  private readonly readFailure: Error | null;

  public constructor(options: {
    files?: Readonly<Record<string, string>>;
    existenceFailure?: Error | null;
    readFailure?: Error | null;
  } = {}) {
    this.files = new Map(Object.entries(options.files ?? {}).map(([path, content]) => [
      path,
      new TextEncoder().encode(content),
    ]));
    this.existenceFailure = options.existenceFailure ?? null;
    this.readFailure = options.readFailure ?? null;
  }

  public async exists(path: string): Promise<boolean> {
    this.checkedExistencePaths.push(path);

    if (null !== this.existenceFailure) {
      throw this.existenceFailure;
    }

    return this.files.has(path);
  }

  public async readFile(path: string): Promise<Uint8Array> {
    this.readFilePaths.push(path);

    if (null !== this.readFailure) {
      throw this.readFailure;
    }

    const file = this.files.get(path);

    if (undefined === file) {
      throw new Error(`File not found: ${path}`);
    }

    return file;
  }
}

const targetDirectoryPath = '/project';
const bootstrapPath = join(targetDirectoryPath, SPECDD_BOOTSTRAP_PATH);

const createBootstrapContent = (version = '1.2.3', changelog = 'https://specdd.ai/changelog/'): string => {
  return `---
Version: ${version}
Changelog: ${changelog}
---
`;
};

describe('BootstrapMetadata', () => {
  it('checks whether local bootstrap exists', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent(),
      },
    });
    const metadata = new BootstrapMetadata(fileSystem);

    await expect(metadata.hasBootstrap(targetDirectoryPath)).resolves.toBe(true);
    expect(fileSystem.checkedExistencePaths).toEqual([
      bootstrapPath,
    ]);
  });

  it('returns false when local bootstrap is missing', async () => {
    const metadata = new BootstrapMetadata(new MemoryFileSystem());

    await expect(metadata.hasBootstrap(targetDirectoryPath)).resolves.toBe(false);
  });

  it('reads Version and Changelog front matter values', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent('"1.2.3"', "'https://example.test/changelog'"),
      },
    });
    const metadata = new BootstrapMetadata(fileSystem);

    await expect(metadata.readVersion(targetDirectoryPath)).resolves.toBe('1.2.3');
    await expect(metadata.readChangelog(targetDirectoryPath)).resolves.toBe('https://example.test/changelog');
    expect(fileSystem.readFilePaths).toEqual([
      bootstrapPath,
      bootstrapPath,
    ]);
  });

  it('raises when front matter is missing', async () => {
    const metadata = new BootstrapMetadata(new MemoryFileSystem({
      files: {
        [bootstrapPath]: '# Bootstrap\n',
      },
    }));

    await expect(metadata.readVersion(targetDirectoryPath)).rejects.toBeInstanceOf(BootstrapMetadataMissingFieldError);
  });

  it('raises when requested field is missing before front matter closes', async () => {
    const metadata = new BootstrapMetadata(new MemoryFileSystem({
      files: {
        [bootstrapPath]: `---
Homepage: https://specdd.ai
---
Version: 1.2.3
`,
      },
    }));

    await expect(metadata.readVersion(targetDirectoryPath)).rejects.toBeInstanceOf(BootstrapMetadataMissingFieldError);
  });

  it('raises metadata error when existence check fails', async () => {
    const metadata = new BootstrapMetadata(new MemoryFileSystem({
      existenceFailure: new Error('exists failed'),
    }));

    await expect(metadata.hasBootstrap(targetDirectoryPath)).rejects.toBeInstanceOf(BootstrapMetadataError);
  });

  it('raises metadata error when bootstrap cannot be read', async () => {
    const metadata = new BootstrapMetadata(new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent(),
      },
      readFailure: new Error('read failed'),
    }));

    await expect(metadata.readVersion(targetDirectoryPath)).rejects.toBeInstanceOf(BootstrapMetadataError);
  });
});
