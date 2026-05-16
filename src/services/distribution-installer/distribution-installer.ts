import { join } from 'node:path';
import { CliError } from '../../cli-error.js';
import {
  SPECDD_GITIGNORE_PATH,
  SPECDD_LOCAL_BOOTSTRAP_GITIGNORE_CONTENT,
} from '../../constants.js';
import type {
  DirectoryCheckerDependency,
  DirectoryCreatorDependency,
  FileExistenceDependency,
  FileWriterDependency,
} from '../../infrastructure/file-system.js';
import type { BootstrapMetadata } from '../bootstrap-metadata/bootstrap-metadata.js';
import { BootstrapMetadataError } from '../bootstrap-metadata/bootstrap-metadata.js';
import type {
  DistributionApplyResult,
  DistributionApplier,
} from '../distribution-applier/distribution-applier.js';
import type { DistributionClient } from '../distribution-client/distribution-client.js';
import type { SignatureVerifier } from '../signature-verifier/signature-verifier.js';
import type { Logger } from '../logger/logger.js';
import type { SpecDDVersion } from '../specdd-version/specdd-version.js';

export type DistributionInitRequest = {
  version: string;
  targetDirectoryPath: string;
};

export type DistributionUpdateRequest = {
  version: string;
  currentWorkingDirectoryPath: string;
};

export type DistributionInstalledResult = {
  updated: true;
  version: string;
  signerFingerprint: string;
  applyResult: DistributionApplyResult;
};

export type DistributionNotNeededResult = {
  updated: false;
  version: string;
  localVersion: string;
  signerFingerprint: null;
  applyResult: DistributionApplyResult;
};

export type DistributionInstallResult = DistributionInstalledResult | DistributionNotNeededResult;

export type DistributionClientDependency = Pick<DistributionClient, 'downloadRelease' | 'resolveReleaseVersion'>;

export type SignatureVerifierDependency = Pick<SignatureVerifier, 'verifyDistribution'>;

export type DistributionApplierDependency = Pick<DistributionApplier, 'applyDistribution'>;

export type SpecDDVersionDependency = Pick<SpecDDVersion, 'compare' | 'isValid' | 'suggest'>;

export type BootstrapMetadataDependency = Pick<BootstrapMetadata, 'hasBootstrap' | 'readChangelog' | 'readVersion'>;

type DistributionInstallerFileSystemDependency = DirectoryCheckerDependency
  & DirectoryCreatorDependency
  & FileExistenceDependency
  & FileWriterDependency;

export class DistributionTargetAlreadyInitializedError extends CliError {
  public constructor(targetDirectoryPath: string) {
    super(`SpecDD target is already initialized: ${targetDirectoryPath}`);
    this.name = 'DistributionTargetAlreadyInitializedError';
  }
}

export class DistributionTargetNotInitializedError extends CliError {
  public constructor(targetDirectoryPath: string) {
    super(`SpecDD target is not initialized: ${targetDirectoryPath}`);
    this.name = 'DistributionTargetNotInitializedError';
  }
}

export class DistributionInstallError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'DistributionInstallError';
  }
}

export class DistributionInvalidVersionError extends CliError {
  public constructor(version: string, suggestion: string | null = null) {
    if (null !== suggestion) {
      super(`Invalid SpecDD version: ${version}. Did you mean ${suggestion}?`);
      this.name = 'DistributionInvalidVersionError';

      return;
    }

    super(`Invalid SpecDD version: ${version}`);
    this.name = 'DistributionInvalidVersionError';
  }
}

export class DistributionInstaller {
  private readonly logger: Logger;

  private readonly fileSystem: DistributionInstallerFileSystemDependency;

  private readonly specDDVersion: SpecDDVersionDependency;

  private readonly bootstrapMetadata: BootstrapMetadataDependency;

  private readonly distributionClient: DistributionClientDependency;

  private readonly signatureVerifier: SignatureVerifierDependency;

  private readonly distributionApplier: DistributionApplierDependency;

  private readonly textEncoder = new TextEncoder();

  public constructor(
    logger: Logger,
    fileSystem: DistributionInstallerFileSystemDependency,
    specDDVersion: SpecDDVersionDependency,
    bootstrapMetadata: BootstrapMetadataDependency,
    distributionClient: DistributionClientDependency,
    signatureVerifier: SignatureVerifierDependency,
    distributionApplier: DistributionApplierDependency,
  ) {
    this.logger = logger;
    this.fileSystem = fileSystem;
    this.specDDVersion = specDDVersion;
    this.bootstrapMetadata = bootstrapMetadata;
    this.distributionClient = distributionClient;
    this.signatureVerifier = signatureVerifier;
    this.distributionApplier = distributionApplier;
  }

  public async init(request: DistributionInitRequest): Promise<DistributionInstallResult> {
    this.validateRequestedVersion(request.version);

    if (!await this.isDirectory(request.targetDirectoryPath)) {
      await this.createMissingTargetDirectory(request.targetDirectoryPath);
    }

    if (await this.hasBootstrapFile(request.targetDirectoryPath)) {
      throw new DistributionTargetAlreadyInitializedError(request.targetDirectoryPath);
    }

    this.logger.info(`Initializing SpecDD in ${request.targetDirectoryPath}.`);

    const result = await this.install(request.version, request.targetDirectoryPath);

    await this.ensureLocalBootstrapGitignore(request.targetDirectoryPath);

    return result;
  }

  public async update(request: DistributionUpdateRequest): Promise<DistributionInstallResult> {
    this.validateRequestedVersion(request.version);

    if (!await this.isInitialized(request.currentWorkingDirectoryPath)) {
      throw new DistributionTargetNotInitializedError(request.currentWorkingDirectoryPath);
    }

    const localVersion = await this.readLocalBootstrapVersion(request.currentWorkingDirectoryPath);

    if ('latest' === request.version) {
      const latestRelease = await this.distributionClient.resolveReleaseVersion({
        version: 'latest',
      });

      this.assertValidVersion(latestRelease.version);

      if (this.isLocalVersionCurrent(localVersion, latestRelease.version)) {
        this.logger.info(
          `SpecDD update is not needed. Local version ${localVersion} is at or newer than latest ${latestRelease.version}.`,
        );

        await this.ensureLocalBootstrapGitignore(request.currentWorkingDirectoryPath);

        return {
          applyResult: this.emptyApplyResult(),
          localVersion,
          signerFingerprint: null,
          updated: false,
          version: latestRelease.version,
        };
      }

      this.logger.info(`Updating SpecDD in ${request.currentWorkingDirectoryPath}.`);

      return this.installUpdate(latestRelease.version, request.currentWorkingDirectoryPath);
    }

    if (0 === this.specDDVersion.compare(localVersion, request.version)) {
      this.logger.info(
        `SpecDD update is not needed. Local version ${localVersion} already matches requested ${request.version}.`,
      );

      await this.ensureLocalBootstrapGitignore(request.currentWorkingDirectoryPath);

      return {
        applyResult: this.emptyApplyResult(),
        localVersion,
        signerFingerprint: null,
        updated: false,
        version: request.version,
      };
    }

    this.logger.info(`Updating SpecDD in ${request.currentWorkingDirectoryPath}.`);

    return this.installUpdate(request.version, request.currentWorkingDirectoryPath);
  }

  private async install(version: string, targetDirectoryPath: string): Promise<DistributionInstallResult> {
    const release = await this.distributionClient.downloadRelease({
      version,
    });

    this.assertValidVersion(release.version);

    const verification = await this.signatureVerifier.verifyDistribution({
      signaturePath: release.signaturePath,
      zipPath: release.zipPath,
    });
    const applyResult = await this.distributionApplier.applyDistribution({
      targetDirectoryPath,
      zipPath: release.zipPath,
    });

    this.logger.info(`Installed SpecDD ${release.version} in ${targetDirectoryPath}.`);

    return {
      applyResult,
      signerFingerprint: verification.signerFingerprint,
      updated: true,
      version: release.version,
    };
  }

  private async installUpdate(version: string, targetDirectoryPath: string): Promise<DistributionInstallResult> {
    const result = await this.install(version, targetDirectoryPath);

    await this.ensureLocalBootstrapGitignore(targetDirectoryPath);
    await this.logChangelogInvitation(targetDirectoryPath);

    return result;
  }

  private async isInitialized(targetDirectoryPath: string): Promise<boolean> {
    const targetExists = await this.isDirectory(targetDirectoryPath);

    if (!targetExists) {
      return false;
    }

    return this.hasBootstrapFile(targetDirectoryPath);
  }

  private async hasBootstrapFile(targetDirectoryPath: string): Promise<boolean> {
    try {
      return await this.bootstrapMetadata.hasBootstrap(targetDirectoryPath);
    } catch (error) {
      throw this.installErrorFrom(error);
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return await this.fileSystem.isDirectory(path);
    } catch (error) {
      throw new DistributionInstallError(String(error));
    }
  }

  private async createMissingTargetDirectory(path: string): Promise<void> {
    if (await this.pathExists(path)) {
      throw new DistributionInstallError(`SpecDD init target is not a directory: ${path}`);
    }

    try {
      await this.fileSystem.createDirectory(path, {
        recursive: true,
      });
    } catch (error) {
      throw new DistributionInstallError(String(error));
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      return await this.fileSystem.exists(path);
    } catch (error) {
      throw new DistributionInstallError(String(error));
    }
  }

  private async ensureLocalBootstrapGitignore(targetDirectoryPath: string): Promise<void> {
    const gitignorePath = join(targetDirectoryPath, SPECDD_GITIGNORE_PATH);

    if (await this.pathExists(gitignorePath)) {
      this.logger.debug(`Leaving existing ${gitignorePath} unchanged.`);

      return;
    }

    try {
      await this.fileSystem.writeFile(
        gitignorePath,
        this.textEncoder.encode(SPECDD_LOCAL_BOOTSTRAP_GITIGNORE_CONTENT),
      );
    } catch (error) {
      throw new DistributionInstallError(String(error));
    }

    this.logger.info(`Added ${gitignorePath} to ignore bootstrap.local.md.`);
  }

  private async readLocalBootstrapVersion(targetDirectoryPath: string): Promise<string> {
    let version: string;

    try {
      version = await this.bootstrapMetadata.readVersion(targetDirectoryPath);
    } catch (error) {
      throw this.installErrorFrom(error);
    }

    this.assertValidVersion(version);

    return version;
  }

  private async readLocalBootstrapChangelog(targetDirectoryPath: string): Promise<string> {
    try {
      return await this.bootstrapMetadata.readChangelog(targetDirectoryPath);
    } catch (error) {
      throw this.installErrorFrom(error);
    }
  }

  private async logChangelogInvitation(targetDirectoryPath: string): Promise<void> {
    const changelog = await this.readLocalBootstrapChangelog(targetDirectoryPath);

    this.logger.info(`SpecDD was updated. Visit ${changelog} to review the changes.`);
  }

  private validateRequestedVersion(version: string): void {
    if ('latest' === version) {
      return;
    }

    this.assertValidVersion(version);
  }

  private assertValidVersion(version: string): void {
    if (this.specDDVersion.isValid(version)) {
      return;
    }

    throw new DistributionInvalidVersionError(version, this.specDDVersion.suggest(version));
  }

  private isLocalVersionCurrent(localVersion: string, latestVersion: string): boolean {
    return 0 <= this.specDDVersion.compare(localVersion, latestVersion);
  }

  private emptyApplyResult(): DistributionApplyResult {
    return {
      overwrittenPaths: [],
      skippedPaths: [],
      writtenPaths: [],
    };
  }

  private installErrorFrom(error: unknown): DistributionInstallError {
    if (error instanceof BootstrapMetadataError) {
      return new DistributionInstallError(error.message);
    }

    return new DistributionInstallError(String(error));
  }
}
