import { CliError } from '../../cli-error.js';
import {
  SPECDD_CHANGELOG_URL,
} from '../../constants.js';
import type { BootstrapMetadata } from '../bootstrap-metadata/bootstrap-metadata.js';
import { BootstrapMetadataError } from '../bootstrap-metadata/bootstrap-metadata.js';
import type { DistributionClient } from '../distribution-client/distribution-client.js';
import type { Logger } from '../logger/logger.js';
import type { SpecDDVersion } from '../specdd-version/specdd-version.js';

export type UpdateCheckRequest = {
  currentWorkingDirectoryPath: string;
};

export type UpdateCheckResult = {
  updateAvailable: boolean;
  localVersion: string | null;
  latestVersion: string;
};

export type UpdateCheckerDistributionClientDependency = Pick<DistributionClient, 'resolveReleaseVersion'>;

export type UpdateCheckerSpecDDVersionDependency = Pick<SpecDDVersion, 'compare' | 'isValid' | 'suggest'>;

export type UpdateCheckerBootstrapMetadataDependency = Pick<BootstrapMetadata, 'hasBootstrap' | 'readVersion'>;

export class UpdateCheckError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'UpdateCheckError';
  }
}

export class UpdateCheckInvalidVersionError extends CliError {
  public constructor(version: string, suggestion: string | null = null) {
    if (null !== suggestion) {
      super(`Invalid SpecDD version: ${version}. Did you mean ${suggestion}?`);
      this.name = 'UpdateCheckInvalidVersionError';

      return;
    }

    super(`Invalid SpecDD version: ${version}`);
    this.name = 'UpdateCheckInvalidVersionError';
  }
}

export class UpdateChecker {
  private readonly logger: Logger;

  private readonly distributionClient: UpdateCheckerDistributionClientDependency;

  private readonly specDDVersion: UpdateCheckerSpecDDVersionDependency;

  private readonly bootstrapMetadata: UpdateCheckerBootstrapMetadataDependency;

  public constructor(
    logger: Logger,
    distributionClient: UpdateCheckerDistributionClientDependency,
    specDDVersion: UpdateCheckerSpecDDVersionDependency,
    bootstrapMetadata: UpdateCheckerBootstrapMetadataDependency,
  ) {
    this.logger = logger;
    this.distributionClient = distributionClient;
    this.specDDVersion = specDDVersion;
    this.bootstrapMetadata = bootstrapMetadata;
  }

  public async check(request: UpdateCheckRequest): Promise<UpdateCheckResult> {
    const localVersion = await this.readLocalBootstrapVersion(request.currentWorkingDirectoryPath);

    this.logLocalVersion(localVersion);

    const latestVersion = await this.resolveLatestVersion();

    this.logger.info(`Latest SpecDD version: ${latestVersion}.`);

    if (!this.isUpdateAvailable(localVersion, latestVersion)) {
      return {
        latestVersion,
        localVersion,
        updateAvailable: false,
      };
    }

    this.logger.info(`SpecDD update is available. Visit ${SPECDD_CHANGELOG_URL} to review the changes.`);

    return {
      latestVersion,
      localVersion,
      updateAvailable: true,
    };
  }

  private async readLocalBootstrapVersion(targetDirectoryPath: string): Promise<string | null> {
    if (!await this.hasLocalBootstrap(targetDirectoryPath)) {
      return null;
    }

    let version: string;

    try {
      version = await this.bootstrapMetadata.readVersion(targetDirectoryPath);
    } catch (error) {
      throw this.updateCheckErrorFrom(error);
    }

    this.assertValidVersion(version);

    return version;
  }

  private async hasLocalBootstrap(targetDirectoryPath: string): Promise<boolean> {
    try {
      return await this.bootstrapMetadata.hasBootstrap(targetDirectoryPath);
    } catch (error) {
      throw this.updateCheckErrorFrom(error);
    }
  }

  private updateCheckErrorFrom(error: unknown): UpdateCheckError {
    if (error instanceof BootstrapMetadataError) {
      return new UpdateCheckError(error.message);
    }

    return new UpdateCheckError(String(error));
  }

  private async resolveLatestVersion(): Promise<string> {
    const release = await this.distributionClient.resolveReleaseVersion({
      version: 'latest',
    });

    this.assertValidVersion(release.version);

    return release.version;
  }

  private logLocalVersion(localVersion: string | null): void {
    if (null === localVersion) {
      this.logger.info('Local SpecDD version: not found.');

      return;
    }

    this.logger.info(`Local SpecDD version: ${localVersion}.`);
  }

  private assertValidVersion(version: string): void {
    if (this.specDDVersion.isValid(version)) {
      return;
    }

    throw new UpdateCheckInvalidVersionError(version, this.specDDVersion.suggest(version));
  }

  private isUpdateAvailable(localVersion: string | null, latestVersion: string): boolean {
    if (null === localVersion) {
      return false;
    }

    return 0 > this.specDDVersion.compare(localVersion, latestVersion);
  }
}
