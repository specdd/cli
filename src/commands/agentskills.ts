import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { CliError } from '../cli-error.js';
import { CLI_HELP_FOOTER } from '../constants.js';
import type { AgentSkills } from '../services/agentskills/agentskills.js';

type AgentSkillsDependency = Pick<AgentSkills, 'deploy'>;

export type AgentSkillsCommandContainer = {
  readonly agentSkills: AgentSkillsDependency;
};

export type CurrentWorkingDirectoryProvider = () => string;

export type HomeDirectoryProvider = () => string;

type AgentSkillsDeployCommandOptions = {
  version: string;
  user?: boolean;
};

export class AgentSkillsDeployTargetConflictError extends CliError {
  public constructor() {
    super('Agent Skills deploy target path cannot be used with --user.');
    this.name = 'AgentSkillsDeployTargetConflictError';
  }
}

export const resolveAgentSkillsDeployTargetPath = (
  currentWorkingDirectoryPath: string,
  homeDirectoryPath: string,
  targetPath: string | undefined,
  useUserDirectory: boolean,
): string => {
  if (useUserDirectory) {
    if (undefined !== targetPath) {
      throw new AgentSkillsDeployTargetConflictError();
    }

    return homeDirectoryPath;
  }

  return resolve(currentWorkingDirectoryPath, targetPath ?? '.');
};

export const createAgentSkillsCommand = (
  container: AgentSkillsCommandContainer,
  getCurrentWorkingDirectory: CurrentWorkingDirectoryProvider = () => process.cwd(),
  getHomeDirectory: HomeDirectoryProvider = () => homedir(),
): Command => {
  const command = new Command('agentskills');
  const deployCommand = new Command('deploy');

  deployCommand
    .description('Deploy SpecDD Agent Skills into a user or project skills directory.')
    .argument('[path]', 'Project directory to install into. Defaults to the current directory.')
    .option('--user', 'Install into the current user home Agent Skills directory.')
    .option('--version <version>', 'Agent Skills release tag to install. Defaults to latest.', 'latest')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .action(async (targetPath: string | undefined, options: AgentSkillsDeployCommandOptions) => {
      await container.agentSkills.deploy({
        targetDirectoryPath: resolveAgentSkillsDeployTargetPath(
          getCurrentWorkingDirectory(),
          getHomeDirectory(),
          targetPath,
          true === options.user,
        ),
        version: options.version,
      });
    });

  command
    .description('Manage SpecDD Agent Skills.')
    .addHelpText(
      'after',
      CLI_HELP_FOOTER,
    )
    .addCommand(deployCommand);

  return command;
};
