import { Command } from 'commander';
import { createAgentSkillsCommand } from './commands/agentskills.js';
import { createCheckUpdateCommand } from './commands/check-update.js';
import { createInitCommand } from './commands/init.js';
import { createUpdateCommand } from './commands/update.js';
import { FetchClient } from './infrastructure/fetch-client.js';
import { FileSystem } from './infrastructure/file-system.js';
import { TempDirectory } from './infrastructure/temp-directory.js';
import { Config } from './services/config/config.js';
import { ConfigDefaults } from './services/config/config-defaults.js';
import { EnvironmentReader } from './services/config/readers/environment-reader.js';
import { AgentSkills } from './services/agentskills/agentskills.js';
import { BootstrapMetadata } from './services/bootstrap-metadata/bootstrap-metadata.js';
import { DistributionApplier } from './services/distribution-applier/distribution-applier.js';
import { DistributionClient } from './services/distribution-client/distribution-client.js';
import { DistributionInstaller } from './services/distribution-installer/distribution-installer.js';
import { Logger } from './services/logger/logger.js';
import { SignatureVerifier } from './services/signature-verifier/signature-verifier.js';
import { SpecDDVersion } from './services/specdd-version/specdd-version.js';
import { UpdateChecker } from './services/update-checker/update-checker.js';

export class Container {
  public readonly config: Config;

  public readonly logger: Logger;

  public readonly distributionClient: DistributionClient;

  public readonly specDDVersion: SpecDDVersion;

  public readonly bootstrapMetadata: BootstrapMetadata;

  public readonly updateChecker: UpdateChecker;

  public readonly signatureVerifier: SignatureVerifier;

  public readonly distributionApplier: DistributionApplier;

  public readonly distributionInstaller: DistributionInstaller;

  public readonly agentSkills: AgentSkills;

  public readonly agentSkillsCommand: Command;

  public readonly checkUpdateCommand: Command;

  public readonly initCommand: Command;

  public readonly updateCommand: Command;

  public constructor() {
    const fetchClient = new FetchClient();

    const fileSystem = new FileSystem();

    const tempDirectory = new TempDirectory();

    const environmentReader = new EnvironmentReader(process.env);

    this.config = new Config([
      environmentReader,
    ], new ConfigDefaults());

    this.logger = new Logger(this.config);

    this.specDDVersion = new SpecDDVersion();

    this.bootstrapMetadata = new BootstrapMetadata(fileSystem);

    this.distributionClient = new DistributionClient(
      this.logger,
      fetchClient,
      fileSystem,
      tempDirectory,
    );

    this.updateChecker = new UpdateChecker(
      this.logger,
      this.distributionClient,
      this.specDDVersion,
      this.bootstrapMetadata,
    );

    this.signatureVerifier = new SignatureVerifier(
      this.logger,
      fileSystem,
    );

    this.distributionApplier = new DistributionApplier(
      this.logger,
      fileSystem,
    );

    this.distributionInstaller = new DistributionInstaller(
      this.logger,
      fileSystem,
      this.specDDVersion,
      this.bootstrapMetadata,
      this.distributionClient,
      this.signatureVerifier,
      this.distributionApplier,
    );

    this.agentSkills = new AgentSkills(
      this.logger,
      fetchClient,
      fileSystem,
      tempDirectory,
      this.signatureVerifier,
    );

    this.agentSkillsCommand = createAgentSkillsCommand(this);

    this.checkUpdateCommand = createCheckUpdateCommand(this);

    this.initCommand = createInitCommand(this);

    this.updateCommand = createUpdateCommand(this);
  }
}
