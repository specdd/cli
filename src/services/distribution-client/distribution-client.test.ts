import type { FetchClientDependency, FetchResponse } from '../../infrastructure/fetch-client.js';
import type { FileWriterDependency } from '../../infrastructure/file-system.js';
import type { TempDirectoryDependency } from '../../infrastructure/temp-directory.js';
import { Config } from '../config/config.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import {
  DistributionAssetNotFoundError,
  DistributionClient,
  DistributionDownloadError,
  DistributionFilesystemError,
  DistributionReleaseNotFoundError,
} from './distribution-client.js';

type MockResponse = {
  ok: boolean;
  status?: number;
  json?: unknown;
  body?: string;
};

class MemoryStream implements LoggerStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

class MemoryFetchClient implements FetchClientDependency {
  public readonly urls: string[] = [];

  private readonly responses: Readonly<Record<string, MockResponse>>;

  public constructor(responses: Readonly<Record<string, MockResponse>>) {
    this.responses = responses;
  }

  public async get(url: string): Promise<FetchResponse> {
    this.urls.push(url);

    const response = this.responses[url];

    if (undefined === response) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    return {
      bytes: async () => new TextEncoder().encode(response.body ?? ''),
      json: async () => response.json,
      ok: response.ok,
      status: response.status ?? 200,
    };
  }
}

class MemoryFileSystem implements FileWriterDependency {
  public readonly files = new Map<string, string>();

  public async writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, new TextDecoder().decode(data));
  }
}

class ThrowingFileSystem implements FileWriterDependency {
  public async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    throw new Error('write failed');
  }
}

class MemoryTempDirectory implements TempDirectoryDependency {
  public readonly prefixes: string[] = [];

  private index = 0;

  public async create(prefix: string): Promise<string> {
    this.prefixes.push(prefix);
    this.index += 1;

    return `/tmp/${prefix}${this.index}`;
  }
}

class ThrowingTempDirectory implements TempDirectoryDependency {
  public async create(_prefix: string): Promise<string> {
    throw new Error('temp failed');
  }
}

const release = {
  assets: [
    {
      browser_download_url: 'https://download.example/specdd.zip',
      name: 'specdd.zip',
    },
    {
      browser_download_url: 'https://download.example/specdd.zip.asc',
      name: 'specdd.zip.asc',
    },
  ],
  tag_name: '1.2.3',
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

const createClient = (
  responses: Readonly<Record<string, MockResponse>>,
  logger: Logger,
  fileSystem: FileWriterDependency = new MemoryFileSystem(),
  tempDirectory: TempDirectoryDependency = new MemoryTempDirectory(),
): DistributionClient => {
  return new DistributionClient(logger, new MemoryFetchClient(responses), fileSystem, tempDirectory);
};

describe('DistributionClient', () => {
  it('resolves latest release version without downloading assets', async () => {
    const { logger, stdout } = createLogger();
    const fetchClient = new MemoryFetchClient({
      'https://api.github.com/repos/specdd/specdd/releases/latest': {
        json: release,
        ok: true,
      },
    });
    const fileSystem = new MemoryFileSystem();
    const tempDirectory = new MemoryTempDirectory();
    const client = new DistributionClient(logger, fetchClient, fileSystem, tempDirectory);

    await expect(client.resolveReleaseVersion({ version: 'latest' })).resolves.toEqual({
      version: '1.2.3',
    });
    expect(fetchClient.urls).toEqual([
      'https://api.github.com/repos/specdd/specdd/releases/latest',
    ]);
    expect(fileSystem.files.size).toBe(0);
    expect(tempDirectory.prefixes).toEqual([]);
    expect(stdout.messages).toEqual([
      '[info] Resolved SpecDD release latest to 1.2.3.\n',
    ]);
  });

  it('downloads latest release assets to a unique temporary directory', async () => {
    const fileSystem = new MemoryFileSystem();
    const tempDirectory = new MemoryTempDirectory();
    const { logger, stdout } = createLogger();
    const fetchClient = new MemoryFetchClient({
      'https://api.github.com/repos/specdd/specdd/releases/latest': {
        json: release,
        ok: true,
      },
      'https://download.example/specdd.zip': {
        body: 'zip-content',
        ok: true,
      },
      'https://download.example/specdd.zip.asc': {
        body: 'signature-content',
        ok: true,
      },
    });
    const client = new DistributionClient(logger, fetchClient, fileSystem, tempDirectory);

    await expect(client.downloadRelease({ version: 'latest' })).resolves.toEqual({
      directoryPath: '/tmp/specdd-1',
      signaturePath: '/tmp/specdd-1/specdd.zip.asc',
      version: '1.2.3',
      zipPath: '/tmp/specdd-1/specdd.zip',
    });
    expect(fetchClient.urls).toEqual([
      'https://api.github.com/repos/specdd/specdd/releases/latest',
      'https://download.example/specdd.zip',
      'https://download.example/specdd.zip.asc',
    ]);
    expect(tempDirectory.prefixes).toEqual(['specdd-']);
    expect(fileSystem.files.get('/tmp/specdd-1/specdd.zip')).toBe('zip-content');
    expect(fileSystem.files.get('/tmp/specdd-1/specdd.zip.asc')).toBe('signature-content');
    expect(stdout.messages).toEqual([
      '[info] Resolved SpecDD release latest to 1.2.3.\n',
      '[info] Downloaded specdd.zip to /tmp/specdd-1/specdd.zip.\n',
      '[info] Downloaded specdd.zip.asc to /tmp/specdd-1/specdd.zip.asc.\n',
    ]);
  });

  it('uses explicit release versions as release tags', async () => {
    const { logger } = createLogger();
    const fetchClient = new MemoryFetchClient({
      'https://api.github.com/repos/specdd/specdd/releases/tags/1.2.3': {
        json: release,
        ok: true,
      },
      'https://download.example/specdd.zip': {
        ok: true,
      },
      'https://download.example/specdd.zip.asc': {
        ok: true,
      },
    });
    const client = new DistributionClient(
      logger,
      fetchClient,
      new MemoryFileSystem(),
      new MemoryTempDirectory(),
    );

    await expect(client.downloadRelease({ version: '1.2.3' })).resolves.toMatchObject({
      version: '1.2.3',
    });
    expect(fetchClient.urls[0]).toBe('https://api.github.com/repos/specdd/specdd/releases/tags/1.2.3');
  });

  it('raises when a release cannot be found', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/tags/9.9.9': {
          ok: false,
          status: 404,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: '9.9.9' })).rejects.toBeInstanceOf(
      DistributionReleaseNotFoundError,
    );
  });

  it('raises when release metadata is malformed', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: {},
          ok: true,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionReleaseNotFoundError,
    );
  });

  it('raises when release metadata is not an object', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: null,
          ok: true,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionReleaseNotFoundError,
    );
  });

  it('raises when release asset metadata is malformed', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: {
            assets: [
              {
                name: 'specdd.zip',
              },
              {
                browser_download_url: 'https://download.example/specdd.zip.asc',
                name: 'specdd.zip.asc',
              },
            ],
            tag_name: '1.2.3',
          },
          ok: true,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionReleaseNotFoundError,
    );
  });

  it('raises when release asset metadata is not an object', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: {
            assets: [
              null,
            ],
            tag_name: '1.2.3',
          },
          ok: true,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionReleaseNotFoundError,
    );
  });

  it('raises when specdd.zip is missing', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: {
            assets: [
              {
                browser_download_url: 'https://download.example/specdd.zip.asc',
                name: 'specdd.zip.asc',
              },
            ],
            tag_name: '1.2.3',
          },
          ok: true,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionAssetNotFoundError,
    );
  });

  it('raises when specdd.zip.asc is missing', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: {
            assets: [
              {
                browser_download_url: 'https://download.example/specdd.zip',
                name: 'specdd.zip',
              },
            ],
            tag_name: '1.2.3',
          },
          ok: true,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionAssetNotFoundError,
    );
  });

  it('raises when an asset download fails', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: release,
          ok: true,
        },
        'https://download.example/specdd.zip': {
          ok: false,
          status: 500,
        },
      },
      logger,
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionDownloadError,
    );
  });

  it('raises when the temporary directory cannot be created', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: release,
          ok: true,
        },
      },
      logger,
      new MemoryFileSystem(),
      new ThrowingTempDirectory(),
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionFilesystemError,
    );
  });

  it('raises when a downloaded asset cannot be written', async () => {
    const { logger } = createLogger();
    const client = createClient(
      {
        'https://api.github.com/repos/specdd/specdd/releases/latest': {
          json: release,
          ok: true,
        },
        'https://download.example/specdd.zip': {
          body: 'zip-content',
          ok: true,
        },
      },
      logger,
      new ThrowingFileSystem(),
    );

    await expect(client.downloadRelease({ version: 'latest' })).rejects.toBeInstanceOf(
      DistributionFilesystemError,
    );
  });
});
