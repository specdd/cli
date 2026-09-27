import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError } from '../../cli-error.js';
import { PLUGIN_DEFAULT_VERSION, PLUGIN_DIRECTORY_PATH, PLUGIN_FILE_NAME, PLUGIN_REGISTRY_PATH } from '../../constants.js';
import type { Logger } from '../logger/logger.js';
import type { PluginAddResult, PluginInstaller, PluginRefreshRequest } from '../plugin-installer/plugin-installer.js';
import type { PluginRegistry, PluginRegistryEntry } from '../plugin-registry/plugin-registry.js';
import type { PluginSource, PluginSourceDescriptor } from '../plugin-source/plugin-source.js';

export type PluginUpdateRequest = {
  readonly targetDirectoryPath: string;
  readonly repository?: string | undefined;
  readonly pluginName?: string | undefined;
  readonly version?: string | undefined;
};

export class PluginUpdateError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'PluginUpdateError';
  }
}

export class PluginUpdater {
  public constructor(
    private readonly source: Pick<PluginSource, 'resolve'>,
    private readonly registry: Pick<PluginRegistry, 'read' | 'resolveSourcePath'>,
    private readonly installer: Pick<PluginInstaller, 'refresh'>,
    private readonly logger: Pick<Logger, 'info'>,
  ) {}

  public async update(request: PluginUpdateRequest): Promise<PluginAddResult[]> {
    if (!isAbsolute(request.targetDirectoryPath)) {
      throw new PluginUpdateError('Plugin updates require an absolute project directory.');
    }

    let requestedSource: PluginSourceDescriptor | undefined;

    if (undefined !== request.repository || undefined !== request.pluginName || undefined !== request.version) {
      if (undefined === request.repository || undefined === request.pluginName) {
        throw new PluginUpdateError('Provide both repository and plugin name to select a plugin or override its version.');
      }

      requestedSource = this.source.resolve(request.repository, request.pluginName, request.version);
    }

    const root = resolve(request.targetDirectoryPath);
    const registryPath = join(root, PLUGIN_REGISTRY_PATH);
    const entries = await this.registry.read(registryPath);
    const managed = entries.filter((entry) => this.isManaged(root, registryPath, entry));
    const requestedPath = undefined === requestedSource ? undefined : resolve(dirname(registryPath), requestedSource.relativeDestination);
    const selected = undefined === requestedPath ? managed : managed.filter((entry) => (
      requestedPath === this.registry.resolveSourcePath(registryPath, entry.src)
    ));

    if (undefined !== requestedSource && 0 === selected.length) {
      throw new PluginUpdateError(`Managed plugin is not installed: ${requestedSource.repositoryCoordinates}/${request.pluginName}`);
    }

    const installations = selected.map((entry) => this.prepare(root, registryPath, entry, request.version));

    if (0 === installations.length) {
      this.logger.info('No managed plugins installed.');
      return [];
    }

    const results: PluginAddResult[] = [];

    for (const installation of installations) {
      results.push(await this.installer.refresh(installation));
    }

    this.logger.info(`Updated ${results.length} plugin(s).`);
    return results;
  }

  private isManaged(root: string, registryPath: string, entry: PluginRegistryEntry): boolean {
    const path = this.registry.resolveSourcePath(registryPath, entry.src);
    const relativePath = relative(join(root, PLUGIN_DIRECTORY_PATH), path);
    return '' !== relativePath && !isAbsolute(relativePath) && '..' !== relativePath && !relativePath.startsWith(`..${sep}`);
  }

  private prepare(root: string, registryPath: string, entry: PluginRegistryEntry, override: string | undefined): PluginRefreshRequest {
    const pluginPath = this.registry.resolveSourcePath(registryPath, entry.src);
    const pluginName = basename(dirname(pluginPath));

    if (PLUGIN_FILE_NAME !== basename(pluginPath)) {
      throw new PluginUpdateError(`Cannot infer plugin name: src must end with <pluginname>/${PLUGIN_FILE_NAME}: ${entry.src}`);
    }

    const separator = entry.origin.indexOf('#');
    const repository = -1 === separator ? entry.origin : entry.origin.slice(0, separator);

    if (-1 !== separator && !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(entry.origin.slice(separator + 1))) {
      throw new PluginUpdateError(`Invalid recorded Git commit for plugin ${pluginName}.`);
    }

    const version = override ?? (PLUGIN_DEFAULT_VERSION === entry.version ? undefined : entry.version);
    const source = this.source.resolve(repository, pluginName, version);

    if (pluginPath !== resolve(dirname(registryPath), source.relativeDestination)) {
      throw new PluginUpdateError(`Plugin source does not match its managed installation path: ${entry.src}`);
    }

    return { targetDirectoryPath: root, repository, pluginName, version, registration: entry, };
  }
}
