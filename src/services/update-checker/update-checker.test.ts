import { join } from 'node:path';
import {
  SPECDD_BOOTSTRAP_PATH,
  SPECDD_CHANGELOG_URL,
} from '../../constants.js';
import type {
  FileExistenceDependency,
  FileReaderDependency,
} from '../../infrastructure/file-system.js';
import { Config } from '../config/config.js';
import { BootstrapMetadata } from '../bootstrap-metadata/bootstrap-metadata.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import { SpecDDVersion } from '../specdd-version/specdd-version.js';
import {
  UpdateCheckError,
  UpdateChecker,
  type UpdateCheckerDistributionClientDependency,
  UpdateCheckInvalidVersionError,
} from './update-checker.js';

type UpdateCheckerFileSystemDependency = FileExistenceDependency & FileReaderDependency;

class MemoryStream implements LoggerStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

class MemoryFileSystem implements UpdateCheckerFileSystemDependency {
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

class FakeDistributionClient implements UpdateCheckerDistributionClientDependency {
  public readonly resolutionRequests: Array<{ version: string }> = [];

  private readonly latestVersion: string;

  public constructor(latestVersion = '1.2.3') {
    this.latestVersion = latestVersion;
  }

  public async resolveReleaseVersion(request: { version: string }): Promise<{ version: string }> {
    this.resolutionRequests.push(request);

    return {
      version: this.latestVersion,
    };
  }
}

const targetDirectoryPath = '/project';
const bootstrapPath = join(targetDirectoryPath, SPECDD_BOOTSTRAP_PATH);

const createBootstrapContent = (version: string): string => {
  return `---
Version: ${version}
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

const createChecker = (
  fileSystem: UpdateCheckerFileSystemDependency,
  distributionClient: UpdateCheckerDistributionClientDependency,
  logger: Logger,
): UpdateChecker => {
  return new UpdateChecker(
    logger,
    distributionClient,
    new SpecDDVersion(),
    new BootstrapMetadata(fileSystem),
  );
};

describe('UpdateChecker', () => {
  it('reports no update when local bootstrap is missing', async () => {
    const fileSystem = new MemoryFileSystem();
    const distributionClient = new FakeDistributionClient('1.2.3');
    const { logger, stdout } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).resolves.toEqual({
      latestVersion: '1.2.3',
      localVersion: null,
      updateAvailable: false,
    });
    expect(fileSystem.checkedExistencePaths).toEqual([
      bootstrapPath,
    ]);
    expect(fileSystem.readFilePaths).toEqual([]);
    expect(distributionClient.resolutionRequests).toEqual([
      {
        version: 'latest',
      },
    ]);
    expect(stdout.messages).toEqual([
      '[info] Local SpecDD version: not found.\n',
      '[info] Latest SpecDD version: 1.2.3.\n',
    ]);
  });

  it('reports no update when local version matches latest', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent('"1.2.3"'),
      },
    });
    const distributionClient = new FakeDistributionClient('1.2.3');
    const { logger, stdout } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).resolves.toEqual({
      latestVersion: '1.2.3',
      localVersion: '1.2.3',
      updateAvailable: false,
    });
    expect(stdout.messages).toEqual([
      '[info] Local SpecDD version: 1.2.3.\n',
      '[info] Latest SpecDD version: 1.2.3.\n',
    ]);
  });

  it('reports available update when local version is older than latest', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent('1.2'),
      },
    });
    const distributionClient = new FakeDistributionClient('1.2.1');
    const { logger, stdout } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).resolves.toEqual({
      latestVersion: '1.2.1',
      localVersion: '1.2',
      updateAvailable: true,
    });
    expect(stdout.messages).toEqual([
      '[info] Local SpecDD version: 1.2.\n',
      '[info] Latest SpecDD version: 1.2.1.\n',
      `[info] SpecDD update is available. Visit ${SPECDD_CHANGELOG_URL} to review the changes.\n`,
    ]);
  });

  it('reports no update when local version is newer than latest', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent("'1.3'"),
      },
    });
    const distributionClient = new FakeDistributionClient('1.2.9');
    const { logger, stdout } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).resolves.toEqual({
      latestVersion: '1.2.9',
      localVersion: '1.3',
      updateAvailable: false,
    });
    expect(stdout.messages).toEqual([
      '[info] Local SpecDD version: 1.3.\n',
      '[info] Latest SpecDD version: 1.2.9.\n',
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
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent(localVersion),
      },
    });
    const distributionClient = new FakeDistributionClient(latestVersion);
    const { logger } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).resolves.toMatchObject({
      latestVersion,
      localVersion,
      updateAvailable: false,
    });
  });

  it('raises update check error when local bootstrap Version front matter is missing', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: '# Bootstrap\n',
      },
    });
    const distributionClient = new FakeDistributionClient();
    const { logger } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toBeInstanceOf(UpdateCheckError);
    expect(distributionClient.resolutionRequests).toEqual([]);
  });

  it('raises update check error when local bootstrap front matter closes before Version', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: `---
Homepage: https://specdd.ai
---
Version: 1.2.3
`,
      },
    });
    const distributionClient = new FakeDistributionClient();
    const { logger } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toBeInstanceOf(UpdateCheckError);
    expect(distributionClient.resolutionRequests).toEqual([]);
  });

  it('rejects local bootstrap Version with leading v and suggests the numeric version', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent('v1.2.3'),
      },
    });
    const distributionClient = new FakeDistributionClient();
    const { logger } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toThrow('Invalid SpecDD version: v1.2.3. Did you mean 1.2.3?');
    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toBeInstanceOf(UpdateCheckInvalidVersionError);
    expect(distributionClient.resolutionRequests).toEqual([]);
  });

  it('rejects invalid latest release versions', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.3'),
      },
    });
    const distributionClient = new FakeDistributionClient('next');
    const { logger, stdout } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toThrow('Invalid SpecDD version: next');
    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toBeInstanceOf(UpdateCheckInvalidVersionError);
    expect(stdout.messages).toEqual([
      '[info] Local SpecDD version: 1.2.3.\n',
      '[info] Local SpecDD version: 1.2.3.\n',
    ]);
  });

  it('raises update check error when local bootstrap existence cannot be checked', async () => {
    const fileSystem = new MemoryFileSystem({
      existenceFailure: new Error('exists failed'),
    });
    const distributionClient = new FakeDistributionClient();
    const { logger } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toBeInstanceOf(UpdateCheckError);
    expect(distributionClient.resolutionRequests).toEqual([]);
  });

  it('raises update check error when local bootstrap cannot be read', async () => {
    const fileSystem = new MemoryFileSystem({
      files: {
        [bootstrapPath]: createBootstrapContent('1.2.3'),
      },
      readFailure: new Error('read failed'),
    });
    const distributionClient = new FakeDistributionClient();
    const { logger } = createLogger();
    const checker = createChecker(fileSystem, distributionClient, logger);

    await expect(checker.check({
      currentWorkingDirectoryPath: targetDirectoryPath,
    })).rejects.toBeInstanceOf(UpdateCheckError);
    expect(distributionClient.resolutionRequests).toEqual([]);
  });
});
