import { jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FileSystem } from './file-system.js';
import { GitClient, GitClientError, type GitProcessRunner } from './git-client.js';

const execute = promisify(execFile);

describe('GitClient', () => {
  let root: string;
  let repository: string;
  let firstCommit: string;
  let lastCommit: string;
  let client: GitClient;
  let runner: ReturnType<typeof jest.fn<GitProcessRunner>>;
  let directories: string[];
  const remote = 'git@example.test:team/plugins.git';
  const filePath = '.plugins/review/plugin.md';
  const firstBytes = Buffer.from([35, 32, 80, 13, 10, 0, 255,]);
  const fileSystem = new FileSystem();

  const git = async (...args: string[]): Promise<string> => {
    const result = await execute('git', [
      '-c', 'user.name=SpecDD Test', '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { cwd: repository, });
    return result.stdout.trim();
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'specdd-git-test-'));
    repository = join(root, 'remote');
    await mkdir(repository);
    await git('init', '--initial-branch=main', '--template=');
    await mkdir(join(repository, '.plugins/review'), { recursive: true, });
    await writeFile(join(repository, filePath), firstBytes);
    await git('add', '.');
    await git('commit', '-m', 'first');
    firstCommit = await git('rev-parse', 'HEAD');
    await git('tag', '-a', 'v1.2.0', '-m', 'release');
    await git('branch', 'feature/review');
    await writeFile(join(repository, filePath), 'latest bytes\n');
    await mkdir(join(repository, '.plugins/linked'));
    await symlink('../review/plugin.md', join(repository, '.plugins/linked/plugin.md'));
    await git('add', '.');
    await git('commit', '-m', 'second');
    lastCommit = await git('rev-parse', 'HEAD');
    directories = [];
    runner = jest.fn<GitProcessRunner>(async (args, options) => {
      const translated = args.map((arg) => remote === arg ? repository : arg);
      return new Promise((resolve, reject) => {
        execFile('git', ['-c', 'protocol.file.allow=always', ...translated,], {
          ...options, env: { ...options.env, GIT_ALLOW_PROTOCOL: 'file', }, encoding: 'buffer',
        }, (error, stdout, stderr) => {
          if (error && 'number' !== typeof error.code) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr, exitCode: error && 'number' === typeof error.code ? error.code : 0, });
        });
      });
    });
    client = new GitClient(fileSystem, {
      create: async () => {
        const path = await mkdtemp(join(root, 'clone-'));
        directories.push(path);
        return path;
      },
    }, runner);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true, });
  });

  it('reads default-branch bytes and removes the temporary bare repository', async () => {
    const result = await client.readFile(remote, filePath);
    expect(result.commit).toBe(lastCommit);
    expect(Buffer.from(result.bytes).toString()).toBe('latest bytes\n');
    expect(directories).toHaveLength(1);
    expect(await fileSystem.exists(directories[0]!)).toBe(false);
    const commands = runner.mock.calls.map(([args]) => args);
    expect(commands.some((args) => args.includes('--bare'))).toBe(true);
    expect(commands.flat()).not.toContain('checkout');
  });

  it('reads required and optional files from one commit and one clone', async () => {
    const signaturePath = `${filePath}.asc`;
    await writeFile(join(repository, signaturePath), 'detached signature\r\n');
    await git('add', '.');
    await git('commit', '-m', 'signature');
    const signedCommit = await git('rev-parse', 'HEAD');
    const result = await client.readFiles(remote, [{ path: filePath, }, { path: signaturePath, optional: true, },]);
    expect(result.commit).toBe(signedCommit);
    expect(Buffer.from(result.files.get(filePath)!)).toEqual(Buffer.from('latest bytes\n'));
    expect(Buffer.from(result.files.get(signaturePath)!)).toEqual(Buffer.from('detached signature\r\n'));
    expect(directories).toHaveLength(1);
    const treeCalls = runner.mock.calls.filter(([args]) => args.includes('ls-tree'));
    expect(treeCalls).toHaveLength(2);
    expect(treeCalls.every(([args]) => args.includes(signedCommit))).toBe(true);
    const older = await client.readFiles(remote, [{ path: filePath, }, { path: signaturePath, optional: true, },], firstCommit);
    expect(older.files.has(signaturePath)).toBe(false);
    expect(Buffer.from(older.files.get(filePath)!)).toEqual(firstBytes);
  });

  it.each(['.plugins/linked/plugin.md', '.plugins/review',])('rejects non-regular optional path %s', async (path) => {
    await expect(client.readFiles(remote, [{ path: filePath, }, { path, optional: true, },])).rejects.toThrow('regular file');
  });

  it('does not turn optional path read failures into absent files', async () => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation(async (args, options) => args.includes('ls-tree')
      ? { stdout: Buffer.alloc(0), stderr: Buffer.from('read failed'), exitCode: 1, }
      : original(args, options));
    await expect(client.readFiles(remote, [{ path: `${filePath}.asc`, optional: true, },])).rejects.toThrow('read failed');
  });

  it('rejects an empty file request before invoking Git', async () => {
    await expect(client.readFiles(remote, [])).rejects.toThrow('At least one');
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(['v1.2.0', 'feature/review', 'refs/tags/v1.2.0',])('resolves %s to exact commit bytes', async (ref) => {
    const result = await client.readFile(remote, filePath, ref);
    expect(result.commit).toBe(firstCommit);
    expect(Buffer.from(result.bytes)).toEqual(firstBytes);
  });

  it('retrieves an older reachable commit by full and abbreviated identifier', async () => {
    expect((await client.readFile(remote, filePath, firstCommit)).commit).toBe(firstCommit);
    expect((await client.readFile(remote, filePath, firstCommit.slice(0, 10))).commit).toBe(firstCommit);
  });

  it('does not fetch commits reachable only through pull-request refs', async () => {
    const tree = await git('rev-parse', 'HEAD^{tree}');
    const pullCommit = await git('commit-tree', tree, '-p', lastCommit, '-m', 'pull request only');
    await git('update-ref', 'refs/pull/1/head', pullCommit);
    expect(await git('ls-remote', repository, 'refs/pull/1/head')).toContain(pullCommit);
    await expect(client.readFile(remote, filePath, pullCommit)).rejects.toThrow('does not resolve to an available commit');
    await expect(client.readFile(remote, filePath, 'refs/pull/1/head')).rejects.toThrow('does not resolve to an available commit');
  });

  it('rejects ambiguous branch/tag names', async () => {
    await git('branch', 'v1.2.0');
    await expect(client.readFile(remote, filePath, 'v1.2.0')).rejects.toThrow('ambiguous');
  });

  it.each(['missing', 'HEAD~1', '-bad', 'main:path', 'main^{tree}',])('rejects unavailable or invalid ref %s', async (ref) => {
    await expect(client.readFile(remote, filePath, ref)).rejects.toBeInstanceOf(GitClientError);
    for (const directory of directories) {
      expect(await fileSystem.exists(directory)).toBe(false);
    }
  });

  it.each(['.plugins/missing/plugin.md', '.plugins/linked/plugin.md', '.plugins/review',])('rejects non-regular source %s', async (path) => {
    await expect(client.readFile(remote, path)).rejects.toBeInstanceOf(GitClientError);
  });

  it('inherits the SSH agent and caller SSH overrides', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env, SSH_AUTH_SOCK: '/agent/socket', GIT_SSH_COMMAND: 'ssh -F /custom/config', GIT_SSH: '/custom/ssh',
    });
    await client.readFile(remote, filePath);
    for (const [, options] of runner.mock.calls) {
      expect(options.shell).toBe(false);
      expect(options.env.GIT_ALLOW_PROTOCOL).toBe('ssh:https');
      expect(options.env).toMatchObject({
        SSH_AUTH_SOCK: '/agent/socket', GIT_SSH_COMMAND: 'ssh -F /custom/config', GIT_SSH: '/custom/ssh',
      });
    }
  });

  it('reads through the native runner and configured SSH transport', async () => {
    const ssh = join(root, 'fixture-ssh');
    await writeFile(ssh, '#!/bin/sh\n[ "$SSH_AUTH_SOCK" = "/agent/socket" ] || exit 77\nexec git-upload-pack "$SPECDD_TEST_REMOTE"\n', { mode: 0o700, });
    jest.replaceProperty(process, 'env', {
      ...process.env, GIT_SSH: ssh, GIT_SSH_COMMAND: undefined, GIT_SSH_VARIANT: 'ssh',
      SSH_AUTH_SOCK: '/agent/socket', SPECDD_TEST_REMOTE: repository,
    });
    const native = new GitClient(fileSystem, { create: async () => mkdtemp(join(root, 'native-')), });
    const result = await native.readFile(remote, filePath, 'v1.2.0');
    expect(result.commit).toBe(firstCommit);
    expect(Buffer.from(result.bytes)).toEqual(firstBytes);
  });

  it('reports a remote with no resolvable default branch', async () => {
    await git('symbolic-ref', 'HEAD', 'refs/heads/missing');
    await expect(client.readFile(remote, filePath)).rejects.toThrow('default branch');
  });

  it('rejects traversal in the requested source path before invoking Git', async () => {
    await expect(client.readFile(remote, '../plugin.md')).rejects.toThrow('repository-relative');
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports a commit prefix matching multiple objects as ambiguous', async () => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation(async (args, options) => {
      if (args.includes(`--disambiguate=${firstCommit.slice(0, 4)}`)) {
        return { stdout: Buffer.from(`${firstCommit}\n${lastCommit}\n`), stderr: Buffer.alloc(0), exitCode: 0, };
      }
      return original(args, options);
    });
    await expect(client.readFile(remote, filePath, firstCommit.slice(0, 4))).rejects.toThrow('ambiguous');
  });

  it('reports authentication failures without retrying over HTTPS and cleans up', async () => {
    runner.mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.from('Permission denied (publickey).'), exitCode: 128, });
    await expect(client.readFile(remote, filePath)).rejects.toThrow('Permission denied');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(await fileSystem.exists(directories[0]!)).toBe(false);
  });

  it('redacts credential-bearing URLs and their secrets from Git errors', async () => {
    runner.mockResolvedValue({ stdout: Buffer.alloc(0), stderr: Buffer.from('https://token:secret@host/repo failed: secret token'), exitCode: 128, });
    try {
      await client.readFile('https://token:secret@host/repo', filePath);
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(GitClientError);
      expect((error as Error).message).not.toContain('secret');
      expect((error as Error).message).not.toContain('token');
    }
  });

  it.each([
    'https://private-token:private-secret@[invalid-host/repo',
    'https://private-token:private-secret%ZZ@host/repo',
  ])('uses a safe error when credentials cannot be parsed or decoded: %s', async (repositoryUrl) => {
    runner.mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(`Cannot access ${repositoryUrl}: private-token private-secret private-secret%ZZ`),
      exitCode: 128,
    });
    const failure: unknown = await client.readFile(repositoryUrl, filePath).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitClientError);
    if (!(failure instanceof GitClientError)) {
      throw new Error('Expected malformed credential diagnostics to fail safely.');
    }

    expect(failure.message).toBe('Git plugin read failed: Invalid repository URL.');
    expect(failure.message).not.toContain('private-token');
    expect(failure.message).not.toContain('private-secret');
    expect(failure.message).not.toContain('%ZZ');
    expect(runner).toHaveBeenCalledTimes(1);
    expect(await fileSystem.exists(directories[0]!)).toBe(false);
  });

  it('rejects local and external helper transports before invoking Git', async () => {
    await expect(client.readFile('file:///tmp/repo', filePath)).rejects.toThrow();
    await expect(client.readFile('ext::command', filePath)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports a missing Git executable through the native runner', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, PATH: root, });
    const native = new GitClient(fileSystem, { create: async () => mkdtemp(join(root, 'native-')), });
    await expect(native.readFile(remote, filePath)).rejects.toThrow('Git');
  });

  it('reports cleanup failure alongside the original failure', async () => {
    runner.mockRejectedValue(new Error('Git operation failed'));
    jest.spyOn(fileSystem, 'removePath').mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(client.readFile(remote, filePath)).rejects.toThrow(/Git operation failed.*cleanup failed/s);
  });
});
