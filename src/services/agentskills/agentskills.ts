import { dirname, join, resolve } from 'node:path';
import { posix } from 'node:path';
import JSZip from 'jszip';
import { CliError } from '../../cli-error.js';
import {
  AGENTSKILLS_GITHUB_RELEASE_BASE_URL,
  AGENTSKILLS_RELEASE_ASSET_NAME,
  AGENTSKILLS_SIGNATURE_ASSET_NAME,
  AGENTSKILLS_SKILL_PREFIX,
  AGENTSKILLS_SKILLS_DIRECTORY_PATH,
} from '../../constants.js';
import type { FetchClientDependency } from '../../infrastructure/fetch-client.js';
import type {
  DirectoryCreatorDependency,
  FileExistenceDependency,
  FileReaderDependency,
  FileSystemCreateDirectoryOptions,
  FileWriterDependency,
} from '../../infrastructure/file-system.js';
import type { TempDirectoryDependency } from '../../infrastructure/temp-directory.js';
import type { Logger } from '../logger/logger.js';
import type {
  SignatureVerificationResult,
  SignatureVerifier,
} from '../signature-verifier/signature-verifier.js';

const WINDOWS_DRIVE_PATH_PATTERN = /^[a-zA-Z]:/;
const AGENTSKILLS_SKILL_FILE_NAME = 'SKILL.md';

export type AgentSkillsDeployRequest = {
  version: string;
  targetDirectoryPath: string;
};

export type AgentSkillsApplyResult = {
  installedSkillNames: string[];
  ignoredReleasePaths: string[];
  overwrittenPaths: string[];
  writtenPaths: string[];
};

export type AgentSkillsDeployResult = {
  version: string;
  installDirectoryPath: string;
  signerFingerprint: string;
  applyResult: AgentSkillsApplyResult;
};

type AgentSkillsReleaseDownload = {
  version: string;
  directoryPath: string;
  zipPath: string;
  signaturePath: string;
};

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

type AgentSkillsZipEntry = {
  file: JSZip.JSZipObject;
  normalizedRelativePath: string;
  skillName: string;
  skillRelativePath: string;
  targetPath: string;
};

type AgentSkillsResolvedEntries = {
  entries: AgentSkillsZipEntry[];
  ignoredReleasePaths: string[];
};

type AgentSkillsParsedEntry = {
  normalizedRelativePath: string;
  skillName: string;
  skillRelativePath: string;
};

type AgentSkillsFileSystemDependency = DirectoryCreatorDependency
  & FileExistenceDependency
  & FileReaderDependency
  & FileWriterDependency;

export type SignatureVerifierDependency = Pick<SignatureVerifier, 'verifyDistribution'>;

export class AgentSkillsReleaseNotFoundError extends CliError {
  public constructor(version: string) {
    super(`Agent Skills release not found: ${version}`);
    this.name = 'AgentSkillsReleaseNotFoundError';
  }
}

export class AgentSkillsAssetNotFoundError extends CliError {
  public constructor(assetName: string) {
    super(`Agent Skills release asset not found: ${assetName}`);
    this.name = 'AgentSkillsAssetNotFoundError';
  }
}

export class AgentSkillsDownloadError extends CliError {
  public constructor(assetName: string) {
    super(`Failed to download Agent Skills release asset: ${assetName}`);
    this.name = 'AgentSkillsDownloadError';
  }
}

export class AgentSkillsFilesystemError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentSkillsFilesystemError';
  }
}

export class AgentSkillsZipReadError extends CliError {
  public constructor(zipPath: string) {
    super(`Failed to read Agent Skills release zip: ${zipPath}`);
    this.name = 'AgentSkillsZipReadError';
  }
}

export class AgentSkillsUnsafeEntryPathError extends CliError {
  public constructor(entryPath: string) {
    super(`Agent Skills release zip contains an unsafe entry path: ${entryPath}`);
    this.name = 'AgentSkillsUnsafeEntryPathError';
  }
}

export class AgentSkillsNoInstallableSkillsError extends CliError {
  public constructor() {
    super('Agent Skills release does not contain any installable specdd-* skill with SKILL.md.');
    this.name = 'AgentSkillsNoInstallableSkillsError';
  }
}

export class AgentSkillsTargetWriteError extends CliError {
  public constructor(path: string) {
    super(`Failed to write Agent Skills file: ${path}`);
    this.name = 'AgentSkillsTargetWriteError';
  }
}

export class AgentSkills {
  private readonly logger: Logger;

  private readonly fetchClient: FetchClientDependency;

  private readonly fileSystem: AgentSkillsFileSystemDependency;

  private readonly tempDirectory: TempDirectoryDependency;

  private readonly signatureVerifier: SignatureVerifierDependency;

  public constructor(
    logger: Logger,
    fetchClient: FetchClientDependency,
    fileSystem: AgentSkillsFileSystemDependency,
    tempDirectory: TempDirectoryDependency,
    signatureVerifier: SignatureVerifierDependency,
  ) {
    this.logger = logger;
    this.fetchClient = fetchClient;
    this.fileSystem = fileSystem;
    this.tempDirectory = tempDirectory;
    this.signatureVerifier = signatureVerifier;
  }

  public async deploy(request: AgentSkillsDeployRequest): Promise<AgentSkillsDeployResult> {
    const release = await this.downloadRelease(request.version);
    const verification = await this.verifyRelease(release);
    const installDirectoryPath = join(request.targetDirectoryPath, AGENTSKILLS_SKILLS_DIRECTORY_PATH);
    const applyResult = await this.applyReleaseZip(release.zipPath, installDirectoryPath);

    this.logger.info(`Verified Agent Skills release signature from ${verification.signerFingerprint}.`);
    this.logger.info(
      `Deployed Agent Skills ${release.version} to ${installDirectoryPath} from ${verification.signerFingerprint}.`,
    );

    return {
      applyResult,
      installDirectoryPath,
      signerFingerprint: verification.signerFingerprint,
      version: release.version,
    };
  }

  private async downloadRelease(version: string): Promise<AgentSkillsReleaseDownload> {
    const release = await this.fetchRelease(version);
    const zipAsset = this.findAsset(release, AGENTSKILLS_RELEASE_ASSET_NAME);
    const signatureAsset = this.findAsset(release, AGENTSKILLS_SIGNATURE_ASSET_NAME);
    const directoryPath = await this.createTempDirectory();
    const zipPath = join(directoryPath, AGENTSKILLS_RELEASE_ASSET_NAME);
    const signaturePath = join(directoryPath, AGENTSKILLS_SIGNATURE_ASSET_NAME);

    this.logger.info(`Resolved Agent Skills release ${version} to ${release.tag_name}.`);

    await this.downloadAsset(zipAsset, zipPath);
    await this.downloadAsset(signatureAsset, signaturePath);

    return {
      directoryPath,
      signaturePath,
      version: release.tag_name,
      zipPath,
    };
  }

  private async fetchRelease(version: string): Promise<GitHubRelease> {
    const response = await this.fetchClient.get(this.releaseUrl(version));

    if (!response.ok) {
      throw new AgentSkillsReleaseNotFoundError(version);
    }

    return this.parseRelease(await response.json());
  }

  private releaseUrl(version: string): string {
    if ('latest' === version) {
      return `${AGENTSKILLS_GITHUB_RELEASE_BASE_URL}/latest`;
    }

    return `${AGENTSKILLS_GITHUB_RELEASE_BASE_URL}/tags/${encodeURIComponent(version)}`;
  }

  private parseRelease(value: unknown): GitHubRelease {
    if (!this.isRelease(value)) {
      throw new AgentSkillsReleaseNotFoundError('unknown');
    }

    return value;
  }

  private isRelease(value: unknown): value is GitHubRelease {
    if ('object' !== typeof value || null === value) {
      return false;
    }

    const release = value as {
      readonly assets?: unknown;
      readonly tag_name?: unknown;
    };

    return 'string' === typeof release.tag_name
      && Array.isArray(release.assets)
      && release.assets.every((asset) => this.isReleaseAsset(asset));
  }

  private isReleaseAsset(value: unknown): value is GitHubReleaseAsset {
    if ('object' !== typeof value || null === value) {
      return false;
    }

    const asset = value as Partial<GitHubReleaseAsset>;

    return 'string' === typeof asset.name && 'string' === typeof asset.browser_download_url;
  }

  private findAsset(release: GitHubRelease, assetName: string): GitHubReleaseAsset {
    const asset = release.assets.find((candidate) => assetName === candidate.name);

    if (undefined === asset) {
      throw new AgentSkillsAssetNotFoundError(assetName);
    }

    return asset;
  }

  private async createTempDirectory(): Promise<string> {
    try {
      return await this.tempDirectory.create('agentskills-');
    } catch (error) {
      throw new AgentSkillsFilesystemError(String(error));
    }
  }

  private async downloadAsset(asset: GitHubReleaseAsset, path: string): Promise<void> {
    const response = await this.fetchClient.get(asset.browser_download_url);

    if (!response.ok) {
      throw new AgentSkillsDownloadError(asset.name);
    }

    try {
      await this.fileSystem.writeFile(path, await response.bytes());
    } catch (error) {
      throw new AgentSkillsFilesystemError(String(error));
    }

    this.logger.info(`Downloaded ${asset.name} to ${path}.`);
  }

  private async verifyRelease(release: AgentSkillsReleaseDownload): Promise<SignatureVerificationResult> {
    return this.signatureVerifier.verifyDistribution({
      signaturePath: release.signaturePath,
      zipPath: release.zipPath,
    });
  }

  private async applyReleaseZip(zipPath: string, installDirectoryPath: string): Promise<AgentSkillsApplyResult> {
    const archive = await this.loadArchive(zipPath);
    const resolvedEntries = this.resolveFileEntries(archive, installDirectoryPath);
    const entries = resolvedEntries.entries;
    const validSkillNames = this.findValidSkillNames(entries);

    if (0 === validSkillNames.size) {
      throw new AgentSkillsNoInstallableSkillsError();
    }

    const result: AgentSkillsApplyResult = {
      ignoredReleasePaths: [
        ...resolvedEntries.ignoredReleasePaths,
      ],
      installedSkillNames: Array.from(validSkillNames).sort(),
      overwrittenPaths: [],
      writtenPaths: [],
    };

    for (const entry of entries) {
      if (!validSkillNames.has(entry.skillName)) {
        this.ignoreReleasePath(entry.normalizedRelativePath, result);

        continue;
      }

      await this.applyFileEntry(entry, result);
    }

    return result;
  }

  private async loadArchive(zipPath: string): Promise<JSZip> {
    const zipBytes = await this.readZip(zipPath);

    try {
      return await new JSZip().loadAsync(zipBytes);
    } catch {
      throw new AgentSkillsZipReadError(zipPath);
    }
  }

  private async readZip(zipPath: string): Promise<Uint8Array> {
    try {
      return await this.fileSystem.readFile(zipPath);
    } catch {
      throw new AgentSkillsZipReadError(zipPath);
    }
  }

  private resolveFileEntries(archive: JSZip, installDirectoryPath: string): AgentSkillsResolvedEntries {
    const installRootPath = resolve(installDirectoryPath);
    const entries: AgentSkillsZipEntry[] = [];
    const ignoredReleasePaths: string[] = [];

    archive.forEach((relativePath, file) => {
      const entryPath = file.unsafeOriginalName ?? relativePath;

      if (file.dir) {
        return;
      }

      const normalizedRelativePath = this.normalizeEntryPath(entryPath);
      const parsedEntry = this.parseEntryPath(normalizedRelativePath);

      if (null === parsedEntry) {
        ignoredReleasePaths.push(normalizedRelativePath);
        this.logger.info(`Ignoring Agent Skills release entry ${normalizedRelativePath}.`);

        return;
      }

      const targetPath = resolve(installRootPath, parsedEntry.skillName, ...parsedEntry.skillRelativePath.split('/'));

      entries.push({
        file,
        normalizedRelativePath: parsedEntry.normalizedRelativePath,
        skillName: parsedEntry.skillName,
        skillRelativePath: parsedEntry.skillRelativePath,
        targetPath,
      });
    });

    return {
      entries,
      ignoredReleasePaths,
    };
  }

  private parseEntryPath(normalizedRelativePath: string): AgentSkillsParsedEntry | null {
    const segments = normalizedRelativePath.split('/').filter((segment) => '' !== segment);

    if (this.hasNativeAgentSkillsPrefix(segments)) {
      return this.parseSkillPath(normalizedRelativePath, segments.slice(2));
    }

    return this.parseSkillPath(normalizedRelativePath, segments);
  }

  private normalizeEntryPath(entryPath: string): string {
    const normalizedPath = posix.normalize(entryPath.replaceAll('\\', '/'));

    if (posix.isAbsolute(normalizedPath)) {
      throw new AgentSkillsUnsafeEntryPathError(entryPath);
    }

    if (WINDOWS_DRIVE_PATH_PATTERN.test(normalizedPath)) {
      throw new AgentSkillsUnsafeEntryPathError(entryPath);
    }

    if ('..' === normalizedPath || normalizedPath.startsWith('../')) {
      throw new AgentSkillsUnsafeEntryPathError(entryPath);
    }

    return normalizedPath;
  }

  private hasNativeAgentSkillsPrefix(segments: readonly string[]): boolean {
    return '.agents' === segments[0] && 'skills' === segments[1];
  }

  private parseSkillPath(
    normalizedRelativePath: string,
    segments: readonly string[],
  ): AgentSkillsParsedEntry | null {
    const skillName = segments[0];

    if (undefined === skillName || !skillName.startsWith(AGENTSKILLS_SKILL_PREFIX)) {
      return null;
    }

    const skillRelativePath = segments.slice(1).join('/');

    if ('' === skillRelativePath) {
      return null;
    }

    return {
      normalizedRelativePath,
      skillName,
      skillRelativePath,
    };
  }

  private findValidSkillNames(entries: readonly AgentSkillsZipEntry[]): Set<string> {
    const validSkillNames = new Set<string>();

    for (const entry of entries) {
      if (AGENTSKILLS_SKILL_FILE_NAME === entry.skillRelativePath) {
        validSkillNames.add(entry.skillName);
      }
    }

    return validSkillNames;
  }

  private ignoreReleasePath(path: string, result: AgentSkillsApplyResult): void {
    result.ignoredReleasePaths.push(path);
    this.logger.info(`Ignoring Agent Skills release entry ${path}.`);
  }

  private async applyFileEntry(entry: AgentSkillsZipEntry, result: AgentSkillsApplyResult): Promise<void> {
    const exists = await this.targetExists(entry.targetPath);
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
      throw new AgentSkillsTargetWriteError(targetPath);
    }
  }

  private async readEntryBytes(entry: AgentSkillsZipEntry): Promise<Uint8Array> {
    try {
      return await entry.file.async('uint8array');
    } catch {
      throw new AgentSkillsZipReadError(entry.normalizedRelativePath);
    }
  }

  private async writeTargetFile(targetPath: string, data: Uint8Array): Promise<void> {
    try {
      await this.fileSystem.createDirectory(dirname(targetPath), this.createDirectoryOptions());
      await this.fileSystem.writeFile(targetPath, data);
    } catch {
      throw new AgentSkillsTargetWriteError(targetPath);
    }
  }

  private createDirectoryOptions(): FileSystemCreateDirectoryOptions {
    return {
      recursive: true,
    };
  }
}
