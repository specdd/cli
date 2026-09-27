import { resolve } from 'node:path';
import { Command } from 'commander';
import { CLI_HELP_FOOTER } from '../../constants.js';
import type { PluginInstaller } from '../../services/plugin-installer/plugin-installer.js';

export type PluginAddCommandContainer = {
  readonly pluginInstaller: Pick<PluginInstaller, 'add'>;
};

export const createPluginAddCommand = (
  container: PluginAddCommandContainer,
  getCurrentWorkingDirectory: () => string = () => process.cwd(),
): Command => {
  return new Command('add')
    .description('Install a named plugin from a Git repository into the current SpecDD project.')
    .argument('<repository>', 'GitHub @owner/repository shorthand (SSH), SSH address, or HTTPS URL.')
    .argument('<pluginname>', 'Plugin directory name under .plugins in the repository.')
    .argument('[version]', 'Branch, tag, or commit reachable from a branch or tag. Defaults to the remote default branch; records latest.')
    .allowExcessArguments(false)
    .addHelpText('after', CLI_HELP_FOOTER)
    .action(async (repository: string, pluginName: string, version: string | undefined) => {
      await container.pluginInstaller.add({
        targetDirectoryPath: resolve(getCurrentWorkingDirectory()), repository, pluginName, version,
      });
    });
};
