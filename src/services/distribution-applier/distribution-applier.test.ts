import { dirname } from 'node:path';
import JSZip from 'jszip';
import type {
  DirectoryCreatorDependency,
  FileExistenceDependency,
  FileReaderDependency,
  FileSystemCreateDirectoryOptions,
  FileWriterDependency,
} from '../../infrastructure/file-system.js';
import { Config } from '../config/config.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import {
  DistributionApplier,
  type DistributionApplyMode,
  DistributionTargetWriteError,
  DistributionUnsafeEntryPathError,
  DistributionZipNotFoundError,
  DistributionZipReadError,
} from './distribution-applier.js';

class MemoryStream implements LoggerStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

type DistributionApplierFileSystemDependency = DirectoryCreatorDependency
  & FileExistenceDependency
  & FileReaderDependency
  & FileWriterDependency;

class MemoryFileSystem implements DistributionApplierFileSystemDependency {
  public readonly createDirectoryCalls: Array<{ path: string; recursive: boolean }> = [];

  private readonly directories = new Set<string>();

  private readonly files = new Map<string, Uint8Array>();

  private readonly textDecoder = new TextDecoder();

  private throwOnCreateDirectory = false;

  private throwOnExists = false;

  private throwOnReadFile = false;

  private throwOnWriteFile = false;

  public constructor(files: ReadonlyMap<string, Uint8Array> = new Map()) {
    for (const [path, data] of files) {
      this.files.set(path, data);
    }
  }

  public failCreateDirectory(): void {
    this.throwOnCreateDirectory = true;
  }

  public failExists(): void {
    this.throwOnExists = true;
  }

  public failReadFile(): void {
    this.throwOnReadFile = true;
  }

  public failWriteFile(): void {
    this.throwOnWriteFile = true;
  }

  public getText(path: string): string | null {
    const data = this.files.get(path);

    if (undefined === data) {
      return null;
    }

    return this.textDecoder.decode(data);
  }

  public async exists(path: string): Promise<boolean> {
    if (this.throwOnExists) {
      throw new Error('exists failed');
    }

    return this.files.has(path);
  }

  public async createDirectory(path: string, options: FileSystemCreateDirectoryOptions): Promise<void> {
    if (this.throwOnCreateDirectory) {
      throw new Error('create directory failed');
    }

    this.createDirectoryCalls.push({
      path,
      recursive: options.recursive,
    });
    this.directories.add(path);
  }

  public async readFile(path: string): Promise<Uint8Array> {
    if (this.throwOnReadFile) {
      throw new Error('read failed');
    }

    const file = this.files.get(path);

    if (undefined === file) {
      const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      throw error;
    }

    return file;
  }

  public async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (this.throwOnWriteFile) {
      throw new Error('write failed');
    }

    if (!this.directories.has(dirname(path))) {
      throw new Error(`Parent directory was not created: ${dirname(path)}`);
    }

    this.files.set(path, data);
  }
}

const textEncoder = new TextEncoder();
const zipPath = '/tmp/specdd.zip';
const targetDirectoryPath = '/project';

const createLogger = (): { logger: Logger; stdout: MemoryStream } => {
  const stdout = new MemoryStream();
  const logger = new Logger(new Config(), {
    colorLevel: 0,
    stdout,
  });

  return {
    logger,
    stdout,
  };
};

const createZip = async (
  entries: ReadonlyArray<readonly [string, string]>,
  directories: readonly string[] = [],
): Promise<Uint8Array> => {
  const zip = new JSZip();

  for (const directory of directories) {
    zip.folder(directory);
  }

  for (const [path, content] of entries) {
    zip.file(path, content);
  }

  return zip.generateAsync({
    type: 'uint8array',
  });
};

const createZipWithCorruptFileData = async (): Promise<Uint8Array> => {
  const zip = new JSZip();

  zip.file('corrupt.md', 'content content content', {
    compression: 'DEFLATE',
  });

  const zipBytes = await zip.generateAsync({
    compression: 'DEFLATE',
    type: 'uint8array',
  });
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const fileNameLength = view.getUint16(26, true);
  const extraFieldLength = view.getUint16(28, true);
  const fileDataOffset = 30 + fileNameLength + extraFieldLength;
  const corruptZipBytes = new Uint8Array(zipBytes);

  corruptZipBytes[fileDataOffset] = corruptZipBytes[fileDataOffset]! ^ 0xff;

  return corruptZipBytes;
};

const createFileSystem = async (
  zipEntries: ReadonlyArray<readonly [string, string]>,
  targetFiles: ReadonlyArray<readonly [string, string]> = [],
  directories: readonly string[] = [],
): Promise<MemoryFileSystem> => {
  const files = new Map<string, Uint8Array>();

  files.set(zipPath, await createZip(zipEntries, directories));

  for (const [path, content] of targetFiles) {
    files.set(path, textEncoder.encode(content));
  }

  return new MemoryFileSystem(files);
};

const applyDistribution = async (
  fileSystem: MemoryFileSystem,
  logger: Logger,
  mode: DistributionApplyMode = 'init',
): Promise<ReturnType<DistributionApplier['applyDistribution']>> => {
  const applier = new DistributionApplier(logger, fileSystem);

  return applier.applyDistribution({
    mode,
    targetDirectoryPath,
    zipPath,
  });
};

describe('DistributionApplier', () => {
  it('writes missing zip files and explicitly creates their parent directories', async () => {
    const fileSystem = await createFileSystem(
      [
        ['.specdd/bootstrap.md', 'bootstrap'],
        ['docs/guide.md', 'guide'],
        ['root.md', 'root'],
      ],
      [],
      ['empty-directory'],
    );
    const { logger, stdout } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).resolves.toEqual({
      overwrittenPaths: [],
      skippedPaths: [],
      writtenPaths: [
        '/project/.specdd/bootstrap.md',
        '/project/docs/guide.md',
        '/project/root.md',
      ],
    });
    expect(fileSystem.createDirectoryCalls).toEqual([
      {
        path: '/project/.specdd',
        recursive: true,
      },
      {
        path: '/project/docs',
        recursive: true,
      },
      {
        path: '/project',
        recursive: true,
      },
    ]);
    expect(fileSystem.getText('/project/.specdd/bootstrap.md')).toBe('bootstrap');
    expect(fileSystem.getText('/project/docs/guide.md')).toBe('guide');
    expect(fileSystem.getText('/project/root.md')).toBe('root');
    expect(stdout.messages).toEqual([
      '[info] Wrote /project/.specdd/bootstrap.md.\n',
      '[info] Wrote /project/docs/guide.md.\n',
      '[info] Wrote /project/root.md.\n',
    ]);
  });

  it('overwrites existing bootstrap and skips other existing files', async () => {
    const fileSystem = await createFileSystem(
      [
        ['.specdd/bootstrap.md', 'new bootstrap'],
        ['app.sdd', 'new app spec'],
        ['new.md', 'new file'],
      ],
      [
        ['/project/.specdd/bootstrap.md', 'old bootstrap'],
        ['/project/app.sdd', 'existing app spec'],
      ],
    );
    const { logger, stdout } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).resolves.toEqual({
      overwrittenPaths: [
        '/project/.specdd/bootstrap.md',
      ],
      skippedPaths: [
        '/project/app.sdd',
      ],
      writtenPaths: [
        '/project/new.md',
      ],
    });
    expect(fileSystem.getText('/project/.specdd/bootstrap.md')).toBe('new bootstrap');
    expect(fileSystem.getText('/project/app.sdd')).toBe('existing app spec');
    expect(fileSystem.getText('/project/new.md')).toBe('new file');
    expect(stdout.messages).toEqual([
      '[info] Overwrote /project/.specdd/bootstrap.md.\n',
      '[info] Skipping existing file /project/app.sdd.\n',
      '[info] Wrote /project/new.md.\n',
    ]);
  });

  it('writes a missing bootstrap but skips other missing files during update', async () => {
    const fileSystem = await createFileSystem([
      ['.specdd/bootstrap.md', 'bootstrap'],
      ['app.sdd', 'app spec'],
      ['docs/guide.md', 'guide'],
    ]);
    const { logger, stdout } = createLogger();

    await expect(applyDistribution(fileSystem, logger, 'update')).resolves.toEqual({
      overwrittenPaths: [],
      skippedPaths: [
        '/project/app.sdd',
        '/project/docs/guide.md',
      ],
      writtenPaths: [
        '/project/.specdd/bootstrap.md',
      ],
    });
    expect(fileSystem.createDirectoryCalls).toEqual([
      {
        path: '/project/.specdd',
        recursive: true,
      },
    ]);
    expect(fileSystem.getText('/project/.specdd/bootstrap.md')).toBe('bootstrap');
    expect(fileSystem.getText('/project/app.sdd')).toBe(null);
    expect(fileSystem.getText('/project/docs/guide.md')).toBe(null);
    expect(stdout.messages).toEqual([
      '[info] Wrote /project/.specdd/bootstrap.md.\n',
      '[info] Skipping missing file /project/app.sdd.\n',
      '[info] Skipping missing file /project/docs/guide.md.\n',
    ]);
  });

  it('raises when the distribution zip is missing', async () => {
    const fileSystem = new MemoryFileSystem();
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(DistributionZipNotFoundError);
  });

  it('raises when the distribution zip cannot be read as a zip archive', async () => {
    const fileSystem = new MemoryFileSystem(new Map([
      [zipPath, textEncoder.encode('not a zip')],
    ]));
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(DistributionZipReadError);
  });

  it('raises when the distribution zip file cannot be read', async () => {
    const fileSystem = new MemoryFileSystem(new Map([
      [zipPath, textEncoder.encode('zip')],
    ]));
    fileSystem.failReadFile();
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(DistributionZipReadError);
  });

  it('raises when a zip entry cannot be decompressed', async () => {
    const fileSystem = new MemoryFileSystem(new Map([
      [zipPath, await createZipWithCorruptFileData()],
    ]));
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(DistributionZipReadError);
  });

  it.each([
    ['../outside.md'],
    ['..\\outside.md'],
    ['a/../../outside.md'],
    ['/absolute.md'],
    ['C:/absolute.md'],
  ])('raises when a zip entry path is unsafe: %s', async (entryPath) => {
    const fileSystem = await createFileSystem([
      [entryPath, 'unsafe'],
      ['safe.md', 'safe'],
    ]);
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(
      DistributionUnsafeEntryPathError,
    );
    expect(fileSystem.createDirectoryCalls).toEqual([]);
    expect(fileSystem.getText('/project/safe.md')).toBe(null);
  });

  it('raises when target file existence cannot be checked', async () => {
    const fileSystem = await createFileSystem([
      ['.specdd/bootstrap.md', 'bootstrap'],
    ]);
    fileSystem.failExists();
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(
      DistributionTargetWriteError,
    );
  });

  it('raises when a parent directory cannot be created', async () => {
    const fileSystem = await createFileSystem([
      ['.specdd/bootstrap.md', 'bootstrap'],
    ]);
    fileSystem.failCreateDirectory();
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(
      DistributionTargetWriteError,
    );
  });

  it('raises when a target file cannot be written', async () => {
    const fileSystem = await createFileSystem([
      ['.specdd/bootstrap.md', 'bootstrap'],
    ]);
    fileSystem.failWriteFile();
    const { logger } = createLogger();

    await expect(applyDistribution(fileSystem, logger)).rejects.toBeInstanceOf(
      DistributionTargetWriteError,
    );
  });
});
