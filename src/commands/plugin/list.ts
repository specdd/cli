import { resolve } from 'node:path';
import { Command } from 'commander';
import { CliError } from '../../cli-error.js';
import { CLI_HELP_FOOTER, PLUGIN_REGISTRY_PATH } from '../../constants.js';
import type { PluginRegistry, PluginRegistryEntry } from '../../services/plugin-registry/plugin-registry.js';

export type PluginListCommandContainer = {
  readonly pluginRegistry: Pick<PluginRegistry, 'read'>;
};

export type PluginListResult = {
  readonly rootDirectoryPath: string;
  readonly registryPath: string;
  readonly plugins: readonly PluginRegistryEntry[];
};

export type PluginListOutputFormat = 'text' | 'json' | 'json-extended';

type PluginListCommandOptions = {
  readonly output: string;
};

export class PluginListInvalidFormatError extends CliError {
  public constructor(format: string) {
    super(`Unsupported plugin list output format: ${format}`);
    this.name = 'PluginListInvalidFormatError';
  }
}

export const resolvePluginListOutputFormat = (format: string): PluginListOutputFormat => {
  if ('text' === format || 'json' === format || 'json-extended' === format) {
    return format;
  }

  throw new PluginListInvalidFormatError(format);
};

export const renderPluginList = (result: PluginListResult, format: string): string => {
  const outputFormat = resolvePluginListOutputFormat(format);

  if ('json-extended' === outputFormat) {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  if ('json' === outputFormat) {
    return `${JSON.stringify({
      rootDirectoryPath: result.rootDirectoryPath,
      registryPath: result.registryPath,
      plugins: result.plugins.map(({ src, origin, sig, version }) => ({ src, origin, sig, version, })),
    }, null, 2)}\n`;
  }

  if (0 === result.plugins.length) {
    return 'No plugins installed.\n';
  }

  return `${result.plugins.map((entry) => (
    `${entry.src}\n  Version: ${entry.version}\n  Origin: ${entry.origin}\n  SHA-256: ${entry.sig}`
  )).join('\n\n')}\n`;
};

export const createPluginListCommand = (
  container: PluginListCommandContainer,
  getCurrentWorkingDirectory: () => string = () => process.cwd(),
  writeOutput: (message: string) => void = (message) => { process.stdout.write(message); },
): Command => {
  return new Command('list')
    .description('List installed SpecDD plugins.')
    .allowExcessArguments(false)
    .option('--format, --output <format>', 'Output format: text, json, or json-extended.', 'text')
    .addHelpText('after', CLI_HELP_FOOTER)
    .action(async (options: PluginListCommandOptions) => {
      const format = resolvePluginListOutputFormat(options.output);
      const rootDirectoryPath = resolve(getCurrentWorkingDirectory());
      const registryPath = resolve(rootDirectoryPath, PLUGIN_REGISTRY_PATH);
      const plugins = await container.pluginRegistry.read(registryPath);

      writeOutput(renderPluginList({ rootDirectoryPath, registryPath, plugins, }, format));
    });
};
