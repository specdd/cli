import { join } from 'node:path';
import {
  SPECDD_BOOTSTRAP_PATH,
  SPECDD_CHANGELOG_URL,
  SPECDD_GITIGNORE_PATH,
  SPECDD_LOCAL_BOOTSTRAP_GITIGNORE_CONTENT,
} from '../../constants.js';
import type {
  DirectoryCheckerDependency,
  DirectoryCreatorDependency,
  FileExistenceDependency,
  FileReaderDependency,
  FileWriterDependency,
  FileSystemCreateDirectoryOptions,
} from '../../infrastructure/file-system.js';
import { Config } from '../config/config.js';
import { BootstrapMetadata } from '../bootstrap-metadata/bootstrap-metadata.js';
import type {
  DistributionApplyMode,
  DistributionApplyResult,
} from '../distribution-applier/distribution-applier.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import { SpecDDVersion } from '../specdd-version/specdd-version.js';
import {
  DistributionInvalidVersionError,
  DistributionInstallError,
  DistributionInstaller,
  DistributionTargetAlreadyInitializedError,
  DistributionTargetNotInitializedError,
  type BootstrapMetadataDependency,
  type DistributionApplierDependency,
  type DistributionClientDependency,
  type SignatureVerifierDependency,
} from './distribution-installer.js';

type DistributionInstallerFileSystemDependency = DirectoryCheckerDependency
  & DirectoryCreatorDependency
  & FileExistenceDependency
  & FileReaderDependency
  & FileWriterDependency;

class MemoryStream implements LoggerStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

class MemoryFileSystem implements DistributionInstallerFileSystemDependency {
  public readonly checkedDirectoryPaths: string[] = [];

  public readonly checkedExistencePaths: string[] = [];

  public readonly createdDirectories: Array<{ path: string; recursive: boolean }> = [];

  public readonly readFilePaths: string[] = [];

  public readonly writtenFiles: Array<{ path: string; content: string }> = [];

  private readonly directories: Set<string>;

  private readonly paths: Set<string>;

  private readonly files: Map<string, Uint8Array>;

  private readonly directoryFailure: Error | null;

  private readonly existenceFailure: Error | null;

  private readonly createFailure: Error | null;

  private readonly readFailure: Error | null;

  private readonly writeFailure: Error | null;

  public constructor(options: {
    directories?: readonly string[];
    paths?: readonly string[];
    files?: Readonly<Record<string, string>>;
    directoryFailure?: Error | null;
    existenceFailure?: Error | null;
    createFailure?: Error | null;
    readFailure?: Error | null;
    writeFailure?: Error | null;
  } = {}) {
    this.directories = new Set(options.directories ?? []);
    this.paths = new Set(options.paths ?? []);
    this.files = new Map(Object.entries(options.files ?? {}).map(([path, content]) => [
      path,
      new TextEncoder().encode(content),
    ]));
    this.directoryFailure = options.directoryFailure ?? null;
    this.existenceFailure = options.existenceFailure ?? null;
    this.createFailure = options.createFailure ?? null;
    this.readFailure = options.readFailure ?? null;
    this.writeFailure = options.writeFailure ?? null;
  }

  public async isDirectory(path: string): Promise<boolean> {
    this.checkedDirectoryPaths.push(path);

    if (null !== this.directoryFailure) {
      throw this.directoryFailure;
    }

    return this.directories.has(path);
  }

  public async exists(path: string): Promise<boolean> {
    this.checkedExistencePaths.push(path);

    if (null !== this.existenceFailure) {
      throw this.existenceFailure;
    }

    return this.paths.has(path) || this.directories.has(path) || this.files.has(path);
  }

  public async createDirectory(path: string, options: FileSystemCreateDirectoryOptions): Promise<void> {
    if (null !== this.createFailure) {
      throw this.createFailure;
    }

    this.createdDirectories.push({
      path,
      recursive: options.recursive,
    });
    this.directories.add(path);
  }

  public setFile(path: string, content: string): void {
    this.files.set(path, new TextEncoder().encode(content));
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

  public async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (null !== this.writeFailure) {
      throw this.writeFailure;
    }

    const content = new TextDecoder().decode(data);

    this.writtenFiles.push({
      content,
      path,
    });
    this.files.set(path, data);
  }
}

class FakeDistributionClient implements DistributionClientDependency {
  public readonly requests: Array<{ version: string }> = [];

  public readonly resolutionRequests: Array<{ version: string }> = [];

  private readonly events: string[];

  private readonly failure: Error | null;

  private readonly latestVersion: string;

  public constructor(events: string[], failure: Error | null = null, latestVersion = '1.2.3') {
    this.events = events;
    this.failure = failure;
    this.latestVersion = latestVersion;
  }

  public async downloadRelease(request: { version: string }): Promise<{
    version: string;
    directoryPath: string;
    zipPath: string;
    signaturePath: string;
  }> {
    this.requests.push(request);
    this.events.push('download');

    if (null !== this.failure) {
      throw this.failure;
    }

    return {
      directoryPath: '/tmp/specdd-1',
      signaturePath: '/tmp/specdd-1/specdd.zip.asc',
      version: '1.2.3',
      zipPath: '/tmp/specdd-1/specdd.zip',
    };
  }

  public async resolveReleaseVersion(request: { version: string }): Promise<{ version: string }> {
    this.resolutionRequests.push(request);
    this.events.push('resolve');

    return {
      version: this.latestVersion,
    };
  }
}

class FakeSignatureVerifier implements SignatureVerifierDependency {
  public readonly requests: Array<{ zipPath: string; signaturePath: string }> = [];

  private readonly events: string[];

  private readonly failure: Error | null;

  public constructor(events: string[], failure: Error | null = null) {
    this.events = events;
    this.failure = failure;
  }

  public async verifyDistribution(request: { zipPath: string; signaturePath: string }): Promise<{
    zipPath: string;
    signaturePath: string;
    signerFingerprint: string;
  }> {
    this.requests.push(request);
    this.events.push('verify');

    if (null !== this.failure) {
      throw this.failure;
    }

    return {
      signaturePath: request.signaturePath,
      signerFingerprint: 'fd87313256e08c486951f9091372d38569116bc5',
      zipPath: request.zipPath,
    };
  }
}

class FakeDistributionApplier implements DistributionApplierDependency {
  public readonly requests: Array<{
    mode: DistributionApplyMode;
    zipPath: string;
    targetDirectoryPath: string;
  }> = [];

  private readonly events: string[];

  private readonly failure: Error | null;

  private readonly afterApply: (() => void) | null;

  public constructor(events: string[], failure: Error | null = null, afterApply: (() => void) | null = null) {
    this.events = events;
    this.failure = failure;
    this.afterApply = afterApply;
  }

  public async applyDistribution(request: {
    mode: DistributionApplyMode;
    zipPath: string;
    targetDirectoryPath: string;
  }): Promise<DistributionApplyResult> {
    this.requests.push(request);
    this.events.push('apply');

    if (null !== this.failure) {
      throw this.failure;
    }

    this.afterApply?.();

    return {
      overwrittenPaths: [
        '/project/.specdd/bootstrap.md',
      ],
      skippedPaths: [
        '/project/app.sdd',
      ],
      writtenPaths: [
        '/project/new.md',
      ],
    };
  }
}

const targetDirectoryPath = '/project';
const bootstrapPath = join(targetDirectoryPath, SPECDD_BOOTSTRAP_PATH);
const gitignorePath = join(targetDirectoryPath, SPECDD_GITIGNORE_PATH);

const createBootstrapContent = (version: string, changelog = SPECDD_CHANGELOG_URL): string => {
  return `---
Version: ${version}
Changelog: ${changelog}
---
`;
};

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

const createInstaller = (
  fileSystem: DistributionInstallerFileSystemDependency,
  distributionClient: DistributionClientDependency,
  signatureVerifier: SignatureVerifierDependency,
  distributionApplier: DistributionApplierDependency,
  logger: Logger,
  bootstrapMetadata: BootstrapMetadataDependency = new BootstrapMetadata(fileSystem),
): DistributionInstaller => {
  return new DistributionInstaller(
    logger,
    fileSystem,
    new SpecDDVersion(),
    bootstrapMetadata,
    distributionClient,
    signatureVerifier,
    distributionApplier,
  );
};

describe('DistributionInstaller', () => {
  it('initializes an existing target directory that does not already contain bootstrap', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
      ],
    });
    const distributionClient = new FakeDistributionClient(events);
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).resolves.toEqual({
      applyResult: {
        overwrittenPaths: [
          '/project/.specdd/bootstrap.md',
        ],
        skippedPaths: [
          '/project/app.sdd',
        ],
        writtenPaths: [
          '/project/new.md',
        ],
      },
      signerFingerprint: 'fd87313256e08c486951f9091372d38569116bc5',
      updated: true,
      version: '1.2.3',
    });
    expect(fileSystem.checkedDirectoryPaths).toEqual([
      '/project',
    ]);
    expect(fileSystem.checkedExistencePaths).toEqual([
      '/project/.specdd/bootstrap.md',
      '/project/.specdd/.gitignore',
    ]);
    expect(fileSystem.createdDirectories).toEqual([]);
    expect(fileSystem.writtenFiles).toEqual([
      {
        content: SPECDD_LOCAL_BOOTSTRAP_GITIGNORE_CONTENT,
        path: gitignorePath,
      },
    ]);
    expect(distributionClient.requests).toEqual([
      {
        version: 'latest',
      },
    ]);
    expect(signatureVerifier.requests).toEqual([
      {
        signaturePath: '/tmp/specdd-1/specdd.zip.asc',
        zipPath: '/tmp/specdd-1/specdd.zip',
      },
    ]);
    expect(distributionApplier.requests).toEqual([
      {
        mode: 'init',
        targetDirectoryPath: '/project',
        zipPath: '/tmp/specdd-1/specdd.zip',
      },
    ]);
    expect(events).toEqual([
      'download',
      'verify',
      'apply',
    ]);
    expect(stdout.messages).toEqual([
      '[info] Initializing SpecDD in /project.\n',
      '[info] Installed SpecDD 1.2.3 in /project.\n',
      '[info] Added /project/.specdd/.gitignore to ignore bootstrap.local.md.\n',
    ]);
  });

  it('creates a missing init target directory before installing', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem();
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      distributionApplier,
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).resolves.toMatchObject({
      version: '1.2.3',
    });
    expect(fileSystem.checkedDirectoryPaths).toEqual([
      '/project',
    ]);
    expect(fileSystem.checkedExistencePaths).toEqual([
      '/project',
      '/project/.specdd/bootstrap.md',
      '/project/.specdd/.gitignore',
    ]);
    expect(fileSystem.createdDirectories).toEqual([
      {
        path: '/project',
        recursive: true,
      },
    ]);
    expect(fileSystem.writtenFiles).toEqual([
      {
        content: SPECDD_LOCAL_BOOTSTRAP_GITIGNORE_CONTENT,
        path: gitignorePath,
      },
    ]);
    expect(distributionApplier.requests).toEqual([
      {
        mode: 'init',
        targetDirectoryPath: '/project',
        zipPath: '/tmp/specdd-1/specdd.zip',
      },
    ]);
    expect(events).toEqual([
      'download',
      'verify',
      'apply',
    ]);
  });

  it('leaves existing local gitignore unchanged during init', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [gitignorePath]: 'custom\n',
      },
    });
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).resolves.toMatchObject({
      updated: true,
      version: '1.2.3',
    });
    expect(fileSystem.checkedExistencePaths).toEqual([
      '/project/.specdd/bootstrap.md',
      '/project/.specdd/.gitignore',
    ]);
    expect(fileSystem.writtenFiles).toEqual([]);
    expect(stdout.messages).toEqual([
      '[info] Initializing SpecDD in /project.\n',
      '[info] Installed SpecDD 1.2.3 in /project.\n',
    ]);
  });

  it('raises install error when local gitignore cannot be written after init install', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
      ],
      writeFailure: new Error('write failed'),
    });
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(fileSystem.writtenFiles).toEqual([]);
    expect(events).toEqual([
      'download',
      'verify',
      'apply',
    ]);
  });

  it('raises when init target path exists but is not a directory', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      paths: [
        targetDirectoryPath,
      ],
    });
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(fileSystem.checkedDirectoryPaths).toEqual([
      '/project',
    ]);
    expect(fileSystem.checkedExistencePaths).toEqual([
      '/project',
    ]);
    expect(fileSystem.createdDirectories).toEqual([]);
    expect(events).toEqual([]);
  });

  it('raises when init targets a directory with existing bootstrap', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      paths: [
        bootstrapPath,
      ],
    });
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionTargetAlreadyInitializedError);
    expect(fileSystem.checkedExistencePaths).toEqual([
      '/project/.specdd/bootstrap.md',
    ]);
    expect(events).toEqual([]);
    expect(stdout.messages).toEqual([]);
  });

  it('rejects requested versions with leading v and suggests the numeric version', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem();
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'v1.2.3',
    })).rejects.toThrow('Invalid SpecDD version: v1.2.3. Did you mean 1.2.3?');
    await expect(installer.init({
      targetDirectoryPath,
      version: 'v1.2.3',
    })).rejects.toBeInstanceOf(DistributionInvalidVersionError);
    expect(fileSystem.checkedDirectoryPaths).toEqual([]);
    expect(fileSystem.checkedExistencePaths).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects invalid requested versions without suggestion', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem();
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'next',
    })).rejects.toThrow('Invalid SpecDD version: next');
    await expect(installer.init({
      targetDirectoryPath,
      version: 'next',
    })).rejects.toBeInstanceOf(DistributionInvalidVersionError);
    expect(fileSystem.checkedDirectoryPaths).toEqual([]);
    expect(fileSystem.checkedExistencePaths).toEqual([]);
    expect(events).toEqual([]);
  });

  it('updates to an explicit release version when local bootstrap version differs', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.2', 'https://old.example/changelog'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const distributionApplier = new FakeDistributionApplier(events, null, () => {
      fileSystem.setFile(bootstrapPath, createBootstrapContent('1.2.3', 'https://new.example/changelog'));
    });
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: '1.2.3',
    })).resolves.toMatchObject({
      signerFingerprint: 'fd87313256e08c486951f9091372d38569116bc5',
      updated: true,
      version: '1.2.3',
    });
    expect(fileSystem.checkedDirectoryPaths).toEqual([
      '/project',
    ]);
    expect(fileSystem.checkedExistencePaths).toEqual([
      '/project/.specdd/bootstrap.md',
    ]);
    expect(fileSystem.readFilePaths).toEqual([
      bootstrapPath,
      bootstrapPath,
    ]);
    expect(fileSystem.writtenFiles).toEqual([]);
    expect(distributionApplier.requests).toEqual([
      {
        mode: 'update',
        targetDirectoryPath: '/project',
        zipPath: '/tmp/specdd-1/specdd.zip',
      },
    ]);
    expect(distributionClient.requests).toEqual([
      {
        version: '1.2.3',
      },
    ]);
    expect(events).toEqual([
      'download',
      'verify',
      'apply',
    ]);
    expect(stdout.messages).toEqual([
      '[info] Updating SpecDD in /project.\n',
      '[info] Installed SpecDD 1.2.3 in /project.\n',
      '[info] SpecDD was updated. Visit https://new.example/changelog to review the changes.\n',
    ]);
  });

  it('skips explicit update when the local bootstrap version matches the requested version', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.3'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: '1.2.3',
    })).resolves.toEqual({
      applyResult: {
        overwrittenPaths: [],
        skippedPaths: [],
        writtenPaths: [],
      },
      localVersion: '1.2.3',
      signerFingerprint: null,
      updated: false,
      version: '1.2.3',
    });
    expect(fileSystem.readFilePaths).toEqual([
      bootstrapPath,
    ]);
    expect(fileSystem.writtenFiles).toEqual([]);
    expect(distributionClient.resolutionRequests).toEqual([]);
    expect(distributionClient.requests).toEqual([]);
    expect(signatureVerifier.requests).toEqual([]);
    expect(distributionApplier.requests).toEqual([]);
    expect(events).toEqual([]);
    expect(stdout.messages).toEqual([
      '[info] SpecDD update is not needed. Local version 1.2.3 already matches requested 1.2.3.\n',
    ]);
  });

  it('skips explicit update when the requested version is numerically equal to the local bootstrap version', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('1.2'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: '1.2.0',
    })).resolves.toMatchObject({
      localVersion: '1.2',
      updated: false,
      version: '1.2.0',
    });
    expect(distributionClient.requests).toEqual([]);
    expect(signatureVerifier.requests).toEqual([]);
    expect(distributionApplier.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('updates to latest when the local bootstrap version is older', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.2', 'https://old.example/changelog'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events, null, () => {
      fileSystem.setFile(bootstrapPath, createBootstrapContent('1.2.3', 'https://new.example/changelog'));
    });
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).resolves.toMatchObject({
      signerFingerprint: 'fd87313256e08c486951f9091372d38569116bc5',
      updated: true,
      version: '1.2.3',
    });
    expect(fileSystem.readFilePaths).toEqual([
      bootstrapPath,
      bootstrapPath,
    ]);
    expect(fileSystem.writtenFiles).toEqual([]);
    expect(distributionApplier.requests).toEqual([
      {
        mode: 'update',
        targetDirectoryPath: '/project',
        zipPath: '/tmp/specdd-1/specdd.zip',
      },
    ]);
    expect(distributionClient.resolutionRequests).toEqual([
      {
        version: 'latest',
      },
    ]);
    expect(distributionClient.requests).toEqual([
      {
        version: '1.2.3',
      },
    ]);
    expect(events).toEqual([
      'resolve',
      'download',
      'verify',
      'apply',
    ]);
    expect(stdout.messages).toEqual([
      '[info] Updating SpecDD in /project.\n',
      '[info] Installed SpecDD 1.2.3 in /project.\n',
      '[info] SpecDD was updated. Visit https://new.example/changelog to review the changes.\n',
    ]);
  });

  it('skips latest update when the local bootstrap version matches latest', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('"1.2.3"'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).resolves.toEqual({
      applyResult: {
        overwrittenPaths: [],
        skippedPaths: [],
        writtenPaths: [],
      },
      localVersion: '1.2.3',
      signerFingerprint: null,
      updated: false,
      version: '1.2.3',
    });
    expect(fileSystem.readFilePaths).toEqual([
      bootstrapPath,
    ]);
    expect(fileSystem.writtenFiles).toEqual([]);
    expect(distributionClient.resolutionRequests).toEqual([
      {
        version: 'latest',
      },
    ]);
    expect(distributionClient.requests).toEqual([]);
    expect(signatureVerifier.requests).toEqual([]);
    expect(distributionApplier.requests).toEqual([]);
    expect(events).toEqual([
      'resolve',
    ]);
    expect(stdout.messages).toEqual([
      '[info] SpecDD update is not needed. Local version 1.2.3 is at or newer than latest 1.2.3.\n',
    ]);
  });

  it('skips latest update when the local bootstrap version is newer than latest', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent("'1.3'"),
      },
    });
    const distributionClient = new FakeDistributionClient(events, null, '1.2.9');
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).resolves.toMatchObject({
      localVersion: '1.3',
      updated: false,
      version: '1.2.9',
    });
    expect(distributionClient.requests).toEqual([]);
    expect(signatureVerifier.requests).toEqual([]);
    expect(distributionApplier.requests).toEqual([]);
    expect(events).toEqual([
      'resolve',
    ]);
  });

  it.each([
    {
      latestVersion: '1.2.0',
      localVersion: '1.2',
    },
    {
      latestVersion: '1.2',
      localVersion: '1.2.0',
    },
  ])('treats missing version parts as zero when comparing $localVersion and $latestVersion', async ({
    latestVersion,
    localVersion,
  }) => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent(localVersion),
      },
    });
    const distributionClient = new FakeDistributionClient(events, null, latestVersion);
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).resolves.toMatchObject({
      localVersion,
      updated: false,
      version: latestVersion,
    });
    expect(distributionClient.requests).toEqual([]);
    expect(signatureVerifier.requests).toEqual([]);
    expect(distributionApplier.requests).toEqual([]);
  });

  it('rejects local bootstrap Version with leading v and suggests the numeric version', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('v1.2.3'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toThrow('Invalid SpecDD version: v1.2.3. Did you mean 1.2.3?');
    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInvalidVersionError);
    expect(distributionClient.resolutionRequests).toEqual([]);
    expect(distributionClient.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects latest release versions with leading v and suggests the numeric version', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.2'),
      },
    });
    const distributionClient = new FakeDistributionClient(events, null, 'v1.2.3');
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toThrow('Invalid SpecDD version: v1.2.3. Did you mean 1.2.3?');
    expect(distributionClient.resolutionRequests).toEqual([
      {
        version: 'latest',
      },
    ]);
    expect(distributionClient.requests).toEqual([]);
    expect(events).toEqual([
      'resolve',
    ]);
  });

  it('raises install error when local bootstrap Version front matter is missing', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: '# Bootstrap\n',
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(distributionClient.resolutionRequests).toEqual([]);
    expect(distributionClient.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('raises install error when local bootstrap front matter closes before Version', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: `---
Homepage: https://specdd.ai
---
Version: 1.2.3
`,
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(distributionClient.resolutionRequests).toEqual([]);
    expect(distributionClient.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('raises invalid version error when local bootstrap Version cannot be compared', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('next'),
      },
    });
    const distributionClient = new FakeDistributionClient(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInvalidVersionError);
    expect(distributionClient.resolutionRequests).toEqual([]);
    expect(distributionClient.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('raises install error when local bootstrap cannot be read for latest update', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      paths: [
        bootstrapPath,
      ],
      readFailure: new Error('read failed'),
    });
    const distributionClient = new FakeDistributionClient(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      distributionClient,
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(distributionClient.resolutionRequests).toEqual([]);
    expect(distributionClient.requests).toEqual([]);
    expect(events).toEqual([]);
  });

  it('raises install error when updated bootstrap Changelog cannot be read', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.2'),
      },
    });
    const distributionApplier = new FakeDistributionApplier(events, null, () => {
      fileSystem.setFile(bootstrapPath, `---
Version: 1.2.3
---
`);
    });
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      distributionApplier,
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: '1.2.3',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(events).toEqual([
      'download',
      'verify',
      'apply',
    ]);
  });

  it('raises install error when bootstrap metadata raises an unexpected error', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
        '/project/.specdd',
      ],
    });
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
      {
        hasBootstrap: async () => true,
        readChangelog: async () => SPECDD_CHANGELOG_URL,
        readVersion: async () => {
          throw new Error('unexpected metadata failure');
        },
      },
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toThrow('unexpected metadata failure');
    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(events).toEqual([]);
  });

  it('raises when update targets an existing directory without bootstrap', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
      ],
    });
    const { logger, stdout } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionTargetNotInitializedError);
    expect(events).toEqual([]);
    expect(stdout.messages).toEqual([]);
  });

  it('raises when update targets a missing directory', async () => {
    const events: string[] = [];
    const fileSystem = new MemoryFileSystem();
    const { logger } = createLogger();
    const installer = createInstaller(
      fileSystem,
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.update({
      currentWorkingDirectoryPath: targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionTargetNotInitializedError);
    expect(fileSystem.checkedDirectoryPaths).toEqual([
      '/project',
    ]);
    expect(fileSystem.checkedExistencePaths).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not apply when signature verification fails', async () => {
    const events: string[] = [];
    const verificationFailure = new Error('signature failed');
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      new MemoryFileSystem({
        directories: [
          targetDirectoryPath,
        ],
      }),
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events, verificationFailure),
      distributionApplier,
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBe(verificationFailure);
    expect(events).toEqual([
      'download',
      'verify',
    ]);
    expect(distributionApplier.requests).toEqual([]);
  });

  it('does not verify or apply when download fails', async () => {
    const events: string[] = [];
    const downloadFailure = new Error('download failed');
    const signatureVerifier = new FakeSignatureVerifier(events);
    const distributionApplier = new FakeDistributionApplier(events);
    const { logger } = createLogger();
    const installer = createInstaller(
      new MemoryFileSystem({
        directories: [
          targetDirectoryPath,
        ],
      }),
      new FakeDistributionClient(events, downloadFailure),
      signatureVerifier,
      distributionApplier,
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBe(downloadFailure);
    expect(events).toEqual([
      'download',
    ]);
    expect(signatureVerifier.requests).toEqual([]);
    expect(distributionApplier.requests).toEqual([]);
  });

  it('raises install error when target directory state cannot be checked', async () => {
    const events: string[] = [];
    const { logger } = createLogger();
    const installer = createInstaller(
      new MemoryFileSystem({
        directories: [
          targetDirectoryPath,
        ],
        directoryFailure: new Error('target check failed'),
      }),
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(events).toEqual([]);
  });

  it('raises install error when target existence cannot be checked', async () => {
    const events: string[] = [];
    const { logger } = createLogger();
    const installer = createInstaller(
      new MemoryFileSystem({
        existenceFailure: new Error('exists failed'),
      }),
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(events).toEqual([]);
  });

  it('raises install error when bootstrap existence cannot be checked', async () => {
    const events: string[] = [];
    const { logger } = createLogger();
    const installer = createInstaller(
      new MemoryFileSystem({
        directories: [
          targetDirectoryPath,
        ],
        existenceFailure: new Error('bootstrap check failed'),
      }),
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(events).toEqual([]);
  });

  it('raises install error when a missing init target cannot be created', async () => {
    const events: string[] = [];
    const { logger } = createLogger();
    const installer = createInstaller(
      new MemoryFileSystem({
        createFailure: new Error('create failed'),
      }),
      new FakeDistributionClient(events),
      new FakeSignatureVerifier(events),
      new FakeDistributionApplier(events),
      logger,
    );

    await expect(installer.init({
      targetDirectoryPath,
      version: 'latest',
    })).rejects.toBeInstanceOf(DistributionInstallError);
    expect(events).toEqual([]);
  });
});
