import { CliError } from '../../cli-error.js';
import { PLUGIN_DEFAULT_VERSION, PLUGIN_DIRECTORY_PATH, PLUGIN_FILE_NAME, PLUGIN_GITHUB_HOST, PLUGIN_SIGNATURE_FILE_NAME, PLUGIN_SOURCE_DIRECTORY_PATH, SPECDD_DIRECTORY_PATH, SPECDD_GITHUB_ORGANIZATION } from '../../constants.js';
import { isValidGitRef } from '../../git-ref.js';

export type PluginSourceDescriptor = {
  readonly repositoryUrl: string;
  readonly originRepositoryUrl: string;
  readonly repositoryCoordinates: string;
  readonly isOfficialRepository: boolean;
  readonly repositoryFilePath: string;
  readonly repositorySignaturePath: string;
  readonly relativeDestination: string;
  readonly gitRef: string | undefined;
  readonly version: string;
};

export class PluginSourceError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'PluginSourceError';
  }
}

export class PluginSource {
  public resolve(repository: string, pluginName: string, version?: string): PluginSourceDescriptor {
    this.validatePluginName(pluginName);
    this.validateVersion(version);

    let repositoryUrl = repository;

    if (repository.startsWith('@')) {
      const parts = repository.slice(1).split('/');

      if (2 !== parts.length) {
        throw new PluginSourceError('GitHub shorthand must be @owner/repository.');
      }

      for (const part of parts) {
        this.validateSegment(part, 'GitHub repository');
      }

      repositoryUrl = `git@${PLUGIN_GITHUB_HOST}:${parts.join('/').replace(/\.git$/, '')}.git`;
    }

    if (/[\s\x00-\x1f\x7f?#\\]/.test(repositoryUrl)) {
      throw new PluginSourceError('Invalid repository address. Use an SSH or HTTPS Git repository.');
    }

    const urlMatch = /^(https|ssh):\/\/([^/]+)\/(.*)$/.exec(repositoryUrl);
    const scpMatch = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9][A-Za-z0-9._-]*):([^/].*)$/.exec(repositoryUrl);
    let host: string;
    let hostname: string;
    let rawPath: string;
    let originPrefix: string;

    if (urlMatch) {
      let url: URL;

      try {
        url = new URL(repositoryUrl);
      } catch {
        throw new PluginSourceError('Invalid repository URL.');
      }

      hostname = url.hostname.toLowerCase();
      host = hostname;
      this.validateHost(host);
      const defaultPort = 'https:' === url.protocol ? '443' : '22';

      if ('' !== url.port && defaultPort !== url.port) {
        host += `~${url.port}`;
      }

      rawPath = urlMatch[3]!;
      const user = 'ssh:' === url.protocol && '' !== url.username ? `${url.username}@` : '';
      originPrefix = `${url.protocol}//${user}${url.host}/`;
    } else if (scpMatch && !repositoryUrl.includes('::')) {
      hostname = scpMatch[2]!.toLowerCase();
      host = hostname;
      this.validateHost(host);
      rawPath = scpMatch[3]!;
      originPrefix = `${scpMatch[1] ?? ''}${host}:`;
    } else {
      throw new PluginSourceError('Invalid repository address. Use GitHub shorthand, SSH, or HTTPS.');
    }

    const originPath = rawPath.replace(/\/+$/, '');
    let repositoryPath: string;

    try {
      repositoryPath = originPath.split('/').map((part) => {
        const segment = urlMatch ? decodeURIComponent(part) : part;
        this.validateSegment(segment, 'repository path');
        return segment;
      }).join('/').replace(/\.git$/, '');
    } catch (error) {
      if (error instanceof PluginSourceError) {
        throw error;
      }

      throw new PluginSourceError('Invalid encoding in repository path.');
    }

    const repositorySegments = repositoryPath.split('/');

    for (const part of repositorySegments) {
      this.validateSegment(part, 'repository path');
    }

    const repositoryCoordinates = `${host}/${repositoryPath}`;

    return {
      repositoryUrl,
      originRepositoryUrl: `${originPrefix}${originPath}`,
      repositoryCoordinates,
      isOfficialRepository: PLUGIN_GITHUB_HOST === hostname && 1 < repositorySegments.length
        && SPECDD_GITHUB_ORGANIZATION === repositorySegments[0]!.toLowerCase(),
      repositoryFilePath: `${PLUGIN_SOURCE_DIRECTORY_PATH}/${pluginName}/${PLUGIN_FILE_NAME}`,
      repositorySignaturePath: `${PLUGIN_SOURCE_DIRECTORY_PATH}/${pluginName}/${PLUGIN_SIGNATURE_FILE_NAME}`,
      relativeDestination: `${PLUGIN_DIRECTORY_PATH.slice(SPECDD_DIRECTORY_PATH.length + 1)}/${repositoryCoordinates}/${pluginName}/${PLUGIN_FILE_NAME}`,
      gitRef: version,
      version: version ?? PLUGIN_DEFAULT_VERSION,
    };
  }

  private validatePluginName(pluginName: string): void {
    this.validateSegment(pluginName, 'plugin name');
  }

  private validateHost(host: string): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(host) || '.' === host || '..' === host || host.endsWith('.')) {
      throw new PluginSourceError('Invalid repository hostname.');
    }

    this.validateSegment(host, 'repository hostname');
  }

  private validateSegment(value: string, label: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(value) || '.' === value || '..' === value || value.endsWith('.')
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
      throw new PluginSourceError(`Invalid ${label}: expected a safe directory name.`);
    }
  }

  private validateVersion(version: string | undefined): void {
    if (undefined === version) {
      return;
    }

    if (!isValidGitRef(version)) {
      throw new PluginSourceError('Invalid plugin version: expected an exact tag, branch, or commit identifier.');
    }
  }
}
