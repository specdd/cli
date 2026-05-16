import { join } from 'node:path';
import { CliError } from '../../cli-error.js';
import {
  SPECDD_DISTRIBUTION_ASSET_NAME,
  SPECDD_GITHUB_RELEASE_BASE_URL,
  SPECDD_SIGNATURE_ASSET_NAME,
} from '../../constants.js';
import type { FetchClientDependency } from '../../infrastructure/fetch-client.js';
import type { FileWriterDependency } from '../../infrastructure/file-system.js';
import type { TempDirectoryDependency } from '../../infrastructure/temp-directory.js';
import type { Logger } from '../logger/logger.js';

export type DistributionReleaseRequest = {
  version: string;
};

export type DistributionReleaseDownload = {
  version: string;
  directoryPath: string;
  zipPath: string;
  signaturePath: string;
};

export type DistributionReleaseVersion = {
  version: string;
};

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

export class DistributionReleaseNotFoundError extends CliError {
  public constructor(version: string) {
    super(`SpecDD release not found: ${version}`);
    this.name = 'DistributionReleaseNotFoundError';
  }
}

export class DistributionAssetNotFoundError extends CliError {
  public constructor(assetName: string) {
    super(`SpecDD release asset not found: ${assetName}`);
    this.name = 'DistributionAssetNotFoundError';
  }
}

export class DistributionDownloadError extends CliError {
  public constructor(assetName: string) {
    super(`Failed to download SpecDD release asset: ${assetName}`);
    this.name = 'DistributionDownloadError';
  }
}

export class DistributionFilesystemError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'DistributionFilesystemError';
  }
}

export class DistributionClient {
  private readonly logger: Logger;

  private readonly fetchClient: FetchClientDependency;

  private readonly fileSystem: FileWriterDependency;

  private readonly tempDirectory: TempDirectoryDependency;

  public constructor(
    logger: Logger,
    fetchClient: FetchClientDependency,
    fileSystem: FileWriterDependency,
    tempDirectory: TempDirectoryDependency,
  ) {
    this.logger = logger;
    this.fetchClient = fetchClient;
    this.fileSystem = fileSystem;
    this.tempDirectory = tempDirectory;
  }

  public async downloadRelease(request: DistributionReleaseRequest): Promise<DistributionReleaseDownload> {
    const release = await this.fetchRelease(request.version);
    const zipAsset = this.findAsset(release, SPECDD_DISTRIBUTION_ASSET_NAME);
    const signatureAsset = this.findAsset(release, SPECDD_SIGNATURE_ASSET_NAME);
    const directoryPath = await this.createTempDirectory();
    const zipPath = join(directoryPath, SPECDD_DISTRIBUTION_ASSET_NAME);
    const signaturePath = join(directoryPath, SPECDD_SIGNATURE_ASSET_NAME);

    this.logger.info(`Resolved SpecDD release ${request.version} to ${release.tag_name}.`);

    await this.downloadAsset(zipAsset, zipPath);
    await this.downloadAsset(signatureAsset, signaturePath);

    return {
      directoryPath,
      signaturePath,
      version: release.tag_name,
      zipPath,
    };
  }

  public async resolveReleaseVersion(request: DistributionReleaseRequest): Promise<DistributionReleaseVersion> {
    const release = await this.fetchRelease(request.version);

    this.logger.info(`Resolved SpecDD release ${request.version} to ${release.tag_name}.`);

    return {
      version: release.tag_name,
    };
  }

  private async fetchRelease(version: string): Promise<GitHubRelease> {
    const url = this.releaseUrl(version);
    const response = await this.fetchClient.get(url);

    if (!response.ok) {
      throw new DistributionReleaseNotFoundError(version);
    }

    return this.parseRelease(await response.json());
  }

  private releaseUrl(version: string): string {
    if ('latest' === version) {
      return `${SPECDD_GITHUB_RELEASE_BASE_URL}/latest`;
    }

    return `${SPECDD_GITHUB_RELEASE_BASE_URL}/tags/${encodeURIComponent(version)}`;
  }

  private parseRelease(value: unknown): GitHubRelease {
    if (!this.isRelease(value)) {
      throw new DistributionReleaseNotFoundError('unknown');
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
      throw new DistributionAssetNotFoundError(assetName);
    }

    return asset;
  }

  private async createTempDirectory(): Promise<string> {
    try {
      return await this.tempDirectory.create('specdd-');
    } catch (error) {
      throw new DistributionFilesystemError(String(error));
    }
  }

  private async downloadAsset(asset: GitHubReleaseAsset, path: string): Promise<void> {
    const response = await this.fetchClient.get(asset.browser_download_url);

    if (!response.ok) {
      throw new DistributionDownloadError(asset.name);
    }

    try {
      await this.fileSystem.writeFile(path, await response.bytes());
    } catch (error) {
      throw new DistributionFilesystemError(String(error));
    }

    this.logger.info(`Downloaded ${asset.name} to ${path}.`);
  }
}
