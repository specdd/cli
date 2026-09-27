import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { CliError } from '../cli-error.js';
import { isValidGitRef } from '../git-ref.js';
import type { FileSystem } from './file-system.js';
import type { TempDirectory } from './temp-directory.js';

export type GitFileResult = {
  readonly commit: string;
  readonly bytes: Uint8Array;
};

export type GitFileRequest = {
  readonly path: string;
  readonly optional?: boolean;
};

export type GitFilesResult = {
  readonly commit: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
};

export type GitProcessResult = {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number;
};

export type GitProcessOptions = {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
};

export type GitProcessRunner = (args: readonly string[], options: GitProcessOptions) => Promise<GitProcessResult>;

const runGit: GitProcessRunner = async (args, options) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args,], { ...options, stdio: ['ignore', 'pipe', 'pipe',], });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (data: Buffer) => { stdout.push(data); });
    child.stderr.on('data', (data: Buffer) => { stderr.push(data); });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code ?? 1, });
    });
  });
};

export class GitClientError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'GitClientError';
  }
}

export class GitClient {
  public constructor(
    private readonly fileSystem: Pick<FileSystem, 'removePath'>,
    private readonly tempDirectory: Pick<TempDirectory, 'create'>,
    private readonly run: GitProcessRunner = runGit,
  ) {}

  public async readFile(repositoryUrl: string, filePath: string, ref?: string): Promise<GitFileResult> {
    const result = await this.readFiles(repositoryUrl, [{ path: filePath, },], ref);
    return { commit: result.commit, bytes: result.files.get(filePath)!, };
  }

  public async readFiles(repositoryUrl: string, requests: readonly GitFileRequest[], ref?: string): Promise<GitFilesResult> {
    if (0 === requests.length) {
      throw new GitClientError('At least one repository-relative path is required.');
    }

    for (const request of requests) {
      this.validateRequest(repositoryUrl, request.path, ref);
    }
    let directory: string | undefined;
    let result: GitFilesResult | undefined;
    let failure: unknown;

    try {
      directory = await this.tempDirectory.create('specdd-plugin-git-');
      const env = this.environment();
      const config = [
        '-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.https.allow=always',
        '-c', `core.hooksPath=${join(directory, 'disabled-hooks')}`,
      ];
      const execute = async (args: readonly string[], allowFailure = false): Promise<GitProcessResult> => {
        const output = await this.run([...config, ...args,], { env, shell: false, });

        if (!allowFailure && 0 !== output.exitCode) {
          throw new Error(Buffer.from(output.stderr).toString('utf8').trim() || `Git exited with status ${output.exitCode}.`);
        }

        return output;
      };

      // A full bare clone reads branch/tag history without checkout filters, hooks, or other ref namespaces.
      await execute(['clone', '--bare', '--no-local', '--template=', '--', repositoryUrl, directory,]);
      const commit = await this.resolveCommit(directory, ref, execute);
      const files = new Map<string, Uint8Array>();

      for (const request of requests) {
        const tree = await execute(['-C', directory, 'ls-tree', '-z', '--full-tree', commit, '--', request.path,]);
        const entries = Buffer.from(tree.stdout).toString('utf8').split('\0').filter((entry) => '' !== entry);

        if (request.optional && 0 === entries.length) {
          continue;
        }

        const entry = 1 === entries.length ? /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entries[0]!) : null;

        if (!entry || request.path !== entry[3]) {
          throw new Error(`Plugin source must be a regular file at ${commit}:${request.path}.`);
        }

        const blob = await execute(['-C', directory, 'cat-file', 'blob', entry[2]!,]);
        files.set(request.path, blob.stdout);
      }

      result = { commit, files, };
    } catch (error) {
      failure = error;
    }

    if (undefined !== directory) {
      try {
        await this.fileSystem.removePath(directory, { recursive: true, });
      } catch (cleanupError) {
        const original = undefined === failure ? '' : `${this.errorMessage(failure)}; `;
        failure = new Error(`${original}Temporary Git repository cleanup failed: ${this.errorMessage(cleanupError)}`);
      }
    }

    if (undefined !== failure || undefined === result) {
      throw new GitClientError(`Git plugin read failed: ${this.redact(this.errorMessage(failure), repositoryUrl)}`);
    }

    return result;
  }

  private async resolveCommit(
    directory: string,
    ref: string | undefined,
    execute: (args: readonly string[], allowFailure?: boolean) => Promise<GitProcessResult>,
  ): Promise<string> {
    const resolve = async (name: string): Promise<string | undefined> => {
      const output = await execute(['-C', directory, 'rev-parse', '--verify', '--end-of-options', `${name}^{commit}`,], true);
      const commit = Buffer.from(output.stdout).toString('utf8').trim();
      return 0 === output.exitCode && /^[a-f0-9]{40,64}$/.test(commit) ? commit : undefined;
    };

    if (undefined === ref) {
      const head = await resolve('HEAD');

      if (undefined === head) {
        throw new Error('The remote default branch does not resolve to a commit.');
      }

      return head;
    }

    const names = ref.startsWith('refs/') ? [ref,] : [`refs/heads/${ref}`, `refs/tags/${ref}`,];
    const commits: string[] = [];

    for (const name of names) {
      const commit = await resolve(name);

      if (undefined !== commit) {
        commits.push(commit);
      }
    }

    if (/^[a-f0-9]{4,64}$/i.test(ref)) {
      const objects = await execute(['-C', directory, 'rev-parse', `--disambiguate=${ref}`,]);
      const identifiers = Buffer.from(objects.stdout).toString('utf8').trim().split('\n').filter(Boolean);

      if (1 < identifiers.length) {
        throw new Error(`Plugin ref is ambiguous: ${ref}`);
      }

      if (1 === identifiers.length) {
        const commit = await resolve(identifiers[0]!);

        if (undefined !== commit) {
          commits.push(commit);
        }
      }
    }

    if (1 < commits.length) {
      throw new Error(`Plugin ref is ambiguous: ${ref}`);
    }

    if (0 === commits.length) {
      throw new Error(`Plugin ref does not resolve to an available commit: ${ref}`);
    }

    return commits[0]!;
  }

  private validateRequest(repositoryUrl: string, filePath: string, ref: string | undefined): void {
    if (!/^(?:https:\/\/|ssh:\/\/|(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*:[^/:])/.test(repositoryUrl)
      || repositoryUrl.includes('::') || /[\x00-\x20\x7f]/.test(repositoryUrl) || repositoryUrl.startsWith('file:')) {
      throw new GitClientError('Git plugin sources require HTTPS or SSH transport.');
    }

    if (filePath.split('/').some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || '.' === part || '..' === part)) {
      throw new GitClientError('Invalid repository-relative plugin path.');
    }

    if (undefined !== ref && !isValidGitRef(ref)) {
      throw new GitClientError('Invalid plugin ref: expected an exact tag, branch, or commit identifier.');
    }
  }

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_ALLOW_PROTOCOL: 'ssh:https', };

    // Repository selection must stay local to the temporary clone; authentication settings stay inherited.
    for (const key of [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
    ]) {
      delete env[key];
    }

    return env;
  }

  private redact(message: string, repositoryUrl: string): string {
    let result = message;

    if (/^(https|ssh):\/\//.test(repositoryUrl)) {
      try {
        const url = new URL(repositoryUrl);
        const secrets = [url.password, 'https:' === url.protocol ? url.username : '',];

        for (const secret of secrets) {
          if ('' !== secret) {
            result = result.split(secret).join('[redacted]').split(decodeURIComponent(secret)).join('[redacted]');
          }
        }
      } catch {
        return 'Invalid repository URL.';
      }
    }

    return result;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
