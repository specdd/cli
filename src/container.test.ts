import { Command } from 'commander';
import { Config } from './services/config/config.js';
import { BootstrapMetadata } from './services/bootstrap-metadata/bootstrap-metadata.js';
import { DistributionApplier } from './services/distribution-applier/distribution-applier.js';
import { DistributionClient } from './services/distribution-client/distribution-client.js';
import { DistributionInstaller } from './services/distribution-installer/distribution-installer.js';
import { Logger } from './services/logger/logger.js';
import { SignatureVerifier } from './services/signature-verifier/signature-verifier.js';
import { SpecDDVersion } from './services/specdd-version/specdd-version.js';
import { UpdateChecker } from './services/update-checker/update-checker.js';
import { Container } from './container.js';

describe('Container', () => {
  it('builds and exposes shared application services', () => {
    const container = new Container();

    expect(container.config).toBeInstanceOf(Config);
    expect(container.logger).toBeInstanceOf(Logger);
    expect(container.distributionClient).toBeInstanceOf(DistributionClient);
    expect(container.specDDVersion).toBeInstanceOf(SpecDDVersion);
    expect(container.bootstrapMetadata).toBeInstanceOf(BootstrapMetadata);
    expect(container.updateChecker).toBeInstanceOf(UpdateChecker);
    expect(container.signatureVerifier).toBeInstanceOf(SignatureVerifier);
    expect(container.distributionApplier).toBeInstanceOf(DistributionApplier);
    expect(container.distributionInstaller).toBeInstanceOf(DistributionInstaller);
    expect(container.checkUpdateCommand).toBeInstanceOf(Command);
    expect(container.checkUpdateCommand.name()).toBe('check-update');
    expect(container.initCommand).toBeInstanceOf(Command);
    expect(container.initCommand.name()).toBe('init');
    expect(container.updateCommand).toBeInstanceOf(Command);
    expect(container.updateCommand.name()).toBe('update');
  });
});
