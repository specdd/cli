import { resolve } from 'node:path';
import { Command } from 'commander';
import { CLI_HELP_FOOTER } from '../constants.js';
import type { DistributionInstaller } from '../services/distribution-installer/distribution-installer.js';

type DistributionInstallerDependency = Pick<DistributionInstaller, 'init'>;

export type InitCommandContainer = {
  readonly distributionInstaller: DistributionInstallerDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

type InitCommandOptions = {
  version: string;
};

export const resolveInitTargetPath = (
  currentWorkingDirectoryPath: string,
  targetPath: string | undefined,
): string => {
  return resolve(currentWorkingDirectoryPath, targetPath ?? '.');
};

export const createInitCommand = (
  container: InitCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
): Command => {
  const command = new Command('init');

  command
    .description('Initialize SpecDD in the current directory or a target directory.')
    .argument('[path]', 'Directory to initialize. Defaults to the current directory.')
    .option('--version <version>', 'SpecDD release version to install. Defaults to latest.', 'latest')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async (targetPath: string | undefined, options: InitCommandOptions) => {
      await container.distributionInstaller.init({
        targetDirectoryPath: resolveInitTargetPath(getCurrentWorkingDirectory(), targetPath),
        version: options.version,
      });
    });

  return command;
};
