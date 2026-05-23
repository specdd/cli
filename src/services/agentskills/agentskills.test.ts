import { jest } from '@jest/globals';
import { dirname } from 'node:path';
import JSZip from 'jszip';
import type { FetchClientDependency, FetchResponse } from '../../infrastructure/fetch-client.js';
import type {
  DirectoryCreatorDependency,
  FileExistenceDependency,
  FileReaderDependency,
  FileSystemCreateDirectoryOptions,
  FileWriterDependency,
} from '../../infrastructure/file-system.js';
import type { TempDirectoryDependency } from '../../infrastructure/temp-directory.js';
import { Config } from '../config/config.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import type { SignatureVerificationResult } from '../signature-verifier/signature-verifier.js';
import {
  AgentSkills,
  AgentSkillsAssetNotFoundError,
  AgentSkillsDownloadError,
  AgentSkillsFilesystemError,
  AgentSkillsNoInstallableSkillsError,
  AgentSkillsReleaseNotFoundError,
  AgentSkillsTargetWriteError,
  AgentSkillsUnsafeEntryPathError,
  AgentSkillsZipReadError,
} from './agentskills.js';

type MockResponse = {
  ok: boolean;
  status?: number;
  json?: unknown;
  body?: Uint8Array | string;
};

type AgentSkillsFileSystemDependency = DirectoryCreatorDependency
  & FileExistenceDependency
  & FileReaderDependency
  & FileWriterDependency;

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
      bytes: async () => {
        if (response.body instanceof Uint8Array) {
          return response.body;
        }

        return new TextEncoder().encode(response.body ?? '');
      },
      json: async () => response.json,
      ok: response.ok,
      status: response.status ?? 200,
    };
  }
}

class MemoryFileSystem implements AgentSkillsFileSystemDependency {
  public readonly createDirectoryCalls: Array<{ path: string; recursive: boolean }> = [];

  public readonly events: string[] = [];

  private readonly directories = new Set<string>();

  private readonly files = new Map<string, Uint8Array>();

  private readonly textDecoder = new TextDecoder();

  private throwOnCreateDirectory = false;

  private throwOnTargetCreateDirectory = false;

  private throwOnExists = false;

  private throwOnReadFile = false;

  private throwOnWriteFile = false;

  private throwOnTargetWriteFile = false;

  public constructor(files: ReadonlyMap<string, Uint8Array> = new Map()) {
    for (const [path, data] of files) {
      this.files.set(path, data);
    }
  }

  public failCreateDirectory(): void {
    this.throwOnCreateDirectory = true;
  }

  public failTargetCreateDirectory(): void {
    this.throwOnTargetCreateDirectory = true;
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

  public failTargetWriteFile(): void {
    this.throwOnTargetWriteFile = true;
  }

  public getText(path: string): string | null {
    const data = this.files.get(path);

    if (undefined === data) {
      return null;
    }

    return this.textDecoder.decode(data);
  }

  public hasPathStartingWith(prefix: string): boolean {
    return Array.from(this.files.keys()).some((path) => path.startsWith(prefix));
  }

  public async exists(path: string): Promise<boolean> {
    this.events.push(`exists:${path}`);

    if (this.throwOnExists) {
      throw new Error('exists failed');
    }

    return this.files.has(path);
  }

  public async createDirectory(path: string, options: FileSystemCreateDirectoryOptions): Promise<void> {
    this.events.push(`mkdir:${path}`);

    if (this.throwOnCreateDirectory) {
      throw new Error('create directory failed');
    }

    if (this.throwOnTargetCreateDirectory && path.startsWith('/project/')) {
      throw new Error('create target directory failed');
    }

    this.createDirectoryCalls.push({
      path,
      recursive: options.recursive,
    });
    this.directories.add(path);
  }

  public async readFile(path: string): Promise<Uint8Array> {
    this.events.push(`read:${path}`);

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
    this.events.push(`write:${path}`);

    if (this.throwOnWriteFile) {
      throw new Error('write failed');
    }

    if (this.throwOnTargetWriteFile && path.startsWith('/project/')) {
      throw new Error('target write failed');
    }

    if (path.startsWith('/project/') && !this.directories.has(dirname(path))) {
      throw new Error(`Parent directory was not created: ${dirname(path)}`);
    }

    this.files.set(path, data);
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

class MemorySignatureVerifier {
  public readonly requests: Array<{ signaturePath: string; zipPath: string }> = [];

  private readonly events: string[];

  private readonly failure: Error | null;

  private readonly signerFingerprint: string;

  public constructor(events: string[], failure: Error | null = null, signerFingerprint = 'trusted-fingerprint') {
    this.events = events;
    this.failure = failure;
    this.signerFingerprint = signerFingerprint;
  }

  public async verifyDistribution(
    request: { signaturePath: string; zipPath: string },
  ): Promise<SignatureVerificationResult> {
    this.events.push(`verify:${request.zipPath}:${request.signaturePath}`);
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return {
      signaturePath: request.signaturePath,
      signerFingerprint: this.signerFingerprint,
      zipPath: request.zipPath,
    };
  }
}

const textEncoder = new TextEncoder();
const latestReleaseUrl = 'https://api.github.com/repos/specdd/agentskills/releases/latest';
const explicitReleaseUrl = 'https://api.github.com/repos/specdd/agentskills/releases/tags/v1.2.3';
const zipDownloadUrl = 'https://download.example/agentskills.zip';
const signatureDownloadUrl = 'https://download.example/agentskills.zip.asc';

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

const createZip = async (entries: ReadonlyArray<readonly [string, string]>): Promise<Uint8Array> => {
  const zip = new JSZip();

  for (const [path, content] of entries) {
    zip.file(path, content);
  }

  return zip.generateAsync({
    type: 'uint8array',
  });
};

const releaseWithAssets = (tagName = 'v1.2.3', assets: ReadonlyArray<{ name: string; url: string }> = [
  {
    name: 'agentskills.zip',
    url: zipDownloadUrl,
  },
  {
    name: 'agentskills.zip.asc',
    url: signatureDownloadUrl,
  },
]): unknown => {
  return {
    assets: assets.map((asset) => {
      return {
        browser_download_url: asset.url,
        name: asset.name,
      };
    }),
    tag_name: tagName,
  };
};

const createResponses = (
  zipBytes: Uint8Array,
  releaseUrl = latestReleaseUrl,
  releaseJson: unknown = releaseWithAssets(),
): Record<string, MockResponse> => {
  return {
    [releaseUrl]: {
      json: releaseJson,
      ok: true,
    },
    [zipDownloadUrl]: {
      body: zipBytes,
      ok: true,
    },
    [signatureDownloadUrl]: {
      body: 'signature-content',
      ok: true,
    },
  };
};

const createService = (
  responses: Readonly<Record<string, MockResponse>>,
  fileSystem: MemoryFileSystem,
  signatureVerifier: MemorySignatureVerifier,
  tempDirectory: TempDirectoryDependency = new MemoryTempDirectory(),
): { agentSkills: AgentSkills; fetchClient: MemoryFetchClient; logger: Logger; stdout: MemoryStream } => {
  const fetchClient = new MemoryFetchClient(responses);
  const { logger, stdout } = createLogger();
  const agentSkills = new AgentSkills(logger, fetchClient, fileSystem, tempDirectory, signatureVerifier);

  return {
    agentSkills,
    fetchClient,
    logger,
    stdout,
  };
};

describe('AgentSkills', () => {
  it('downloads, verifies, and deploys latest specdd-prefixed skills into the project skills directory', async () => {
    const zipBytes = await createZip([
      ['.agents/skills/specdd-plan/SKILL.md', 'skill instructions'],
      ['.agents/skills/specdd-plan/references/guide.md', 'new guide'],
      ['.agents/skills/custom-skill/SKILL.md', 'custom'],
      ['random.txt', 'random'],
      ['specdd-incomplete/references/guide.md', 'missing skill file'],
    ]);
    const fileSystem = new MemoryFileSystem(new Map([
      ['/project/.agents/skills/specdd-plan/references/guide.md', textEncoder.encode('old guide')],
      ['/project/.agents/skills/custom-skill/SKILL.md', textEncoder.encode('existing custom')],
    ]));
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills, fetchClient, stdout } = createService(
      createResponses(zipBytes),
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).resolves.toEqual({
      applyResult: {
        ignoredReleasePaths: [
          '.agents/skills/custom-skill/SKILL.md',
          'random.txt',
          'specdd-incomplete/references/guide.md',
        ],
        installedSkillNames: [
          'specdd-plan',
        ],
        overwrittenPaths: [
          '/project/.agents/skills/specdd-plan/references/guide.md',
        ],
        writtenPaths: [
          '/project/.agents/skills/specdd-plan/SKILL.md',
        ],
      },
      installDirectoryPath: '/project/.agents/skills',
      signerFingerprint: 'trusted-fingerprint',
      version: 'v1.2.3',
    });
    expect(fetchClient.urls).toEqual([
      latestReleaseUrl,
      zipDownloadUrl,
      signatureDownloadUrl,
    ]);
    expect(signatureVerifier.requests).toEqual([
      {
        signaturePath: '/tmp/agentskills-1/agentskills.zip.asc',
        zipPath: '/tmp/agentskills-1/agentskills.zip',
      },
    ]);
    expect(fileSystem.getText('/project/.agents/skills/specdd-plan/SKILL.md')).toBe('skill instructions');
    expect(fileSystem.getText('/project/.agents/skills/specdd-plan/references/guide.md')).toBe('new guide');
    expect(fileSystem.getText('/project/.agents/skills/custom-skill/SKILL.md')).toBe('existing custom');
    expect(fileSystem.events).toEqual([
      'write:/tmp/agentskills-1/agentskills.zip',
      'write:/tmp/agentskills-1/agentskills.zip.asc',
      'verify:/tmp/agentskills-1/agentskills.zip:/tmp/agentskills-1/agentskills.zip.asc',
      'read:/tmp/agentskills-1/agentskills.zip',
      'exists:/project/.agents/skills/specdd-plan/SKILL.md',
      'mkdir:/project/.agents/skills/specdd-plan',
      'write:/project/.agents/skills/specdd-plan/SKILL.md',
      'exists:/project/.agents/skills/specdd-plan/references/guide.md',
      'mkdir:/project/.agents/skills/specdd-plan/references',
      'write:/project/.agents/skills/specdd-plan/references/guide.md',
    ]);
    expect(stdout.messages).toContain('[info] Resolved Agent Skills release latest to v1.2.3.\n');
    expect(stdout.messages).toContain('[info] Deployed Agent Skills v1.2.3 to /project/.agents/skills from trusted-fingerprint.\n');
  });

  it('uses explicit versions as release tags and supports top-level skill entries', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events, null, 'fingerprint');
    const { agentSkills, fetchClient } = createService(
      createResponses(zipBytes, explicitReleaseUrl),
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'v1.2.3',
    })).resolves.toMatchObject({
      applyResult: {
        installedSkillNames: [
          'specdd-test',
        ],
      },
      version: 'v1.2.3',
    });
    expect(fetchClient.urls[0]).toBe(explicitReleaseUrl);
    expect(fileSystem.getText('/project/.agents/skills/specdd-test/SKILL.md')).toBe('skill');
  });

  it('raises when a release cannot be found', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      {
        [latestReleaseUrl]: {
          ok: false,
          status: 404,
        },
      },
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsReleaseNotFoundError);
  });

  it('raises when release metadata is malformed', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      {
        [latestReleaseUrl]: {
          json: {},
          ok: true,
        },
      },
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsReleaseNotFoundError);
  });

  it('raises when release metadata is not an object', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      {
        [latestReleaseUrl]: {
          json: null,
          ok: true,
        },
      },
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsReleaseNotFoundError);
  });

  it('raises when release asset metadata is malformed', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      {
        [latestReleaseUrl]: {
          json: {
            assets: [
              null,
            ],
            tag_name: 'v1.2.3',
          },
          ok: true,
        },
      },
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsReleaseNotFoundError);
  });

  it('raises when agentskills.zip is missing', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      {
        [latestReleaseUrl]: {
          json: releaseWithAssets('v1.2.3', [
            {
              name: 'agentskills.zip.asc',
              url: signatureDownloadUrl,
            },
          ]),
          ok: true,
        },
      },
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsAssetNotFoundError);
  });

  it('raises when agentskills.zip.asc is missing', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      {
        [latestReleaseUrl]: {
          json: releaseWithAssets('v1.2.3', [
            {
              name: 'agentskills.zip',
              url: zipDownloadUrl,
            },
          ]),
          ok: true,
        },
      },
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsAssetNotFoundError);
  });

  it('raises when an asset download fails', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const responses = createResponses(zipBytes);

    responses[zipDownloadUrl] = {
      ok: false,
      status: 500,
    };

    const { agentSkills } = createService(responses, fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsDownloadError);
  });

  it('raises when the temporary directory cannot be created', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      createResponses(zipBytes),
      fileSystem,
      signatureVerifier,
      new ThrowingTempDirectory(),
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsFilesystemError);
  });

  it('raises when a downloaded asset cannot be written', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    fileSystem.failWriteFile();

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsFilesystemError);
  });

  it('raises when the release zip cannot be read before applying files', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    fileSystem.failReadFile();

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsZipReadError);
  });

  it('raises when the downloaded release zip is malformed', async () => {
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      createResponses(textEncoder.encode('not a zip')),
      fileSystem,
      signatureVerifier,
    );

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsZipReadError);
  });

  it('does not apply target files when signature verification fails', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events, new Error('signature failed'));
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toThrow('signature failed');
    expect(fileSystem.hasPathStartingWith('/project/.agents/skills')).toBe(false);
    expect(fileSystem.events).toEqual([
      'write:/tmp/agentskills-1/agentskills.zip',
      'write:/tmp/agentskills-1/agentskills.zip.asc',
      'verify:/tmp/agentskills-1/agentskills.zip:/tmp/agentskills-1/agentskills.zip.asc',
    ]);
  });

  it('raises when no valid specdd-prefixed skill with SKILL.md exists', async () => {
    const zipBytes = await createZip([
      ['custom-skill/SKILL.md', 'custom'],
      ['specdd-incomplete/references/guide.md', 'missing skill file'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsNoInstallableSkillsError);
    expect(fileSystem.hasPathStartingWith('/project/.agents/skills')).toBe(false);
  });

  it('rejects unsafe zip entry paths', async () => {
    const zipBytes = await createZip([
      ['../specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsUnsafeEntryPathError);
  });

  it('rejects absolute zip entry paths', async () => {
    const zipBytes = await createZip([
      ['/specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsUnsafeEntryPathError);
  });

  it('rejects Windows drive zip entry paths', async () => {
    const zipBytes = await createZip([
      ['C:/specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsUnsafeEntryPathError);
  });

  it('ignores a specdd-prefixed zip file that is not a skill directory', async () => {
    const zipBytes = await createZip([
      ['specdd-empty', 'not a skill directory'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsNoInstallableSkillsError);
    expect(fileSystem.hasPathStartingWith('/project/.agents/skills')).toBe(false);
  });

  it('raises when a zip entry cannot be read', async () => {
    const loadArchive = jest.spyOn(JSZip.prototype, 'loadAsync').mockImplementation(async function () {
      return {
        forEach: (callback: (relativePath: string, file: JSZip.JSZipObject) => void): void => {
          callback('specdd-test/SKILL.md', {
            async: async () => {
              throw new Error('entry read failed');
            },
            dir: false,
            unsafeOriginalName: 'specdd-test/SKILL.md',
          } as unknown as JSZip.JSZipObject);
        },
      } as JSZip;
    });
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(
      createResponses(textEncoder.encode('zip')),
      fileSystem,
      signatureVerifier,
    );

    try {
      await expect(agentSkills.deploy({
        targetDirectoryPath: '/project',
        version: 'latest',
      })).rejects.toBeInstanceOf(AgentSkillsZipReadError);
    } finally {
      loadArchive.mockRestore();
    }
  });

  it('raises target write errors when target files cannot be checked or written', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    fileSystem.failExists();

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsTargetWriteError);
  });

  it('raises target write errors when target parent directories cannot be created', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    fileSystem.failTargetCreateDirectory();

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsTargetWriteError);
  });

  it('raises target write errors when target files cannot be written', async () => {
    const zipBytes = await createZip([
      ['specdd-test/SKILL.md', 'skill'],
    ]);
    const fileSystem = new MemoryFileSystem();
    const signatureVerifier = new MemorySignatureVerifier(fileSystem.events);
    const { agentSkills } = createService(createResponses(zipBytes), fileSystem, signatureVerifier);

    fileSystem.failTargetWriteFile();

    await expect(agentSkills.deploy({
      targetDirectoryPath: '/project',
      version: 'latest',
    })).rejects.toBeInstanceOf(AgentSkillsTargetWriteError);
  });
});
