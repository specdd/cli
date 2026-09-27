import { Command } from 'commander';
import { CLI_HELP_FOOTER } from '../../constants.js';

export type PluginCommandContainer = {
  readonly pluginAddCommand: Command;
  readonly pluginListCommand: Command;
  readonly pluginUpdateCommand: Command;
};

export const createPluginCommand = (container: PluginCommandContainer): Command => {
  return new Command('plugin')
    .description('Manage SpecDD plugins.')
    .addHelpText('after', CLI_HELP_FOOTER)
    .addCommand(container.pluginAddCommand)
    .addCommand(container.pluginListCommand)
    .addCommand(container.pluginUpdateCommand);
};
