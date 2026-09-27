import { resolve } from 'node:path';
import { Command } from 'commander';
import { CliError } from '../../cli-error.js';
import { CLI_HELP_FOOTER } from '../../constants.js';
import type { PluginUpdater } from '../../services/plugin-updater/plugin-updater.js';

export type PluginUpdateCommandContainer = {
  readonly pluginUpdater: Pick<PluginUpdater, 'update'>;
};

export const createPluginUpdateCommand = (
  container: PluginUpdateCommandContainer,
  getCurrentWorkingDirectory: () => string = () => process.cwd(),
): Command => {
  return new Command('update')
    .description('Update managed SpecDD plugins from their recorded repositories.')
    .argument('[repository]', 'GitHub @owner/repository shorthand, SSH address, or HTTPS URL. Omit both repository and plugin name for all managed plugins.')
    .argument('[pluginname]', 'Plugin directory name, as for add. Required with a repository.')
    .argument('[version]', 'Branch, tag, or commit reachable from a branch or tag. Defaults to the selected plugin\'s recorded version.')
    .allowExcessArguments(false)
    .addHelpText('after', CLI_HELP_FOOTER)
    .action(async (repository: string | undefined, pluginName: string | undefined, version: string | undefined) => {
      if (undefined !== repository && undefined === pluginName) {
        throw new CliError('Provide both repository and plugin name, or neither to update all managed plugins.');
      }

      await container.pluginUpdater.update({
        targetDirectoryPath: resolve(getCurrentWorkingDirectory()), repository, pluginName, version,
      });
    });
};
