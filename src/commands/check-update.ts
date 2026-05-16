import { Command } from 'commander';
import { CLI_HELP_FOOTER } from '../constants.js';
import type { UpdateChecker } from '../services/update-checker/update-checker.js';

type UpdateCheckerDependency = Pick<UpdateChecker, 'check'>;

export type CheckUpdateCommandContainer = {
  readonly updateChecker: UpdateCheckerDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

export type ExitCodeSetter = (exitCode: number) => void;

export const createCheckUpdateCommand = (
  container: CheckUpdateCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
  setExitCode: ExitCodeSetter = (exitCode) => {
    process.exitCode = exitCode;
  },
): Command => {
  const command = new Command('check-update');

  command
    .description('Check whether a newer SpecDD release is available for the current project.')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async () => {
      const result = await container.updateChecker.check({
        currentWorkingDirectoryPath: getCurrentWorkingDirectory(),
      });

      setExitCode(result.updateAvailable ? 1 : 0);
    });

  return command;
};
