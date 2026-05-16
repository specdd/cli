import { Command } from 'commander';
import { CLI_HELP_FOOTER } from '../constants.js';
import type { DistributionInstaller } from '../services/distribution-installer/distribution-installer.js';

type DistributionInstallerDependency = Pick<DistributionInstaller, 'update'>;

export type UpdateCommandContainer = {
  readonly distributionInstaller: DistributionInstallerDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

type UpdateCommandOptions = {
  version: string;
};

export const createUpdateCommand = (
  container: UpdateCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
): Command => {
  const command = new Command('update');

  command
    .description('Update SpecDD files in the current project.')
    .option('--version <version>', 'SpecDD release version to install. Defaults to latest.', 'latest')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async (options: UpdateCommandOptions) => {
      await container.distributionInstaller.update({
        currentWorkingDirectoryPath: getCurrentWorkingDirectory(),
        version: options.version,
      });
    });

  return command;
};
