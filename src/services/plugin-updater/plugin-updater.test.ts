import { jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { CliError } from '../../cli-error.js';
import { FileSystem } from '../../infrastructure/file-system.js';
import { GitClient } from '../../infrastructure/git-client.js';
import type { PluginSignatureVerifier } from '../plugin-signature-verifier/plugin-signature-verifier.js';
import { PluginInstaller } from '../plugin-installer/plugin-installer.js';
import { PluginRegistry, type PluginRegistryEntry } from '../plugin-registry/plugin-registry.js';
import { PluginSource } from '../plugin-source/plugin-source.js';
import { PluginUpdater, PluginUpdateError } from './plugin-updater.js';

const registration = (name: string, version = 'latest', repository = 'acme/repo'): PluginRegistryEntry => ({
  src: `plugins/github.com/${repository}/${name}/plugin.md`,
  origin: `git@github.com:${repository}.git#${'a'.repeat(40)}`,
  sig: 'b'.repeat(64),
  version,
});

describe('PluginUpdater', () => {
  const read = jest.fn<PluginRegistry['read']>();
  const refresh = jest.fn<PluginInstaller['refresh']>();
  const info = jest.fn<(message: string) => void>();
  const registry = new PluginRegistry(new FileSystem());
  const updater = new PluginUpdater(new PluginSource(), {
    read,
    resolveSourcePath: (path, src) => registry.resolveSourcePath(path, src),
  }, { refresh, }, { info, });

  beforeEach(() => {
    read.mockReset().mockResolvedValue([]);
    refresh.mockReset().mockResolvedValue({
      outcome: 'replaced', pluginPath: '/project/plugin.md', registryPath: '/project/.specdd/plugins.json',
      commit: 'c'.repeat(40), version: 'latest',
    });
    info.mockClear();
  });

  it('updates every registration in order using its recorded version and repository', async () => {
    read.mockResolvedValue([
      registration('review'), registration('lint', 'v1.2.0'), registration('test', 'abc1234'),
    ]);
    expect(await updater.update({ targetDirectoryPath: '/project', })).toHaveLength(3);
    expect(read).toHaveBeenCalledWith('/project/.specdd/plugins.json');
    expect(refresh.mock.calls.map(([{ registration: _registration, ...request }]) => request)).toEqual([
      { targetDirectoryPath: '/project', repository: 'git@github.com:acme/repo.git', pluginName: 'review', version: undefined, },
      { targetDirectoryPath: '/project', repository: 'git@github.com:acme/repo.git', pluginName: 'lint', version: 'v1.2.0', },
      { targetDirectoryPath: '/project', repository: 'git@github.com:acme/repo.git', pluginName: 'test', version: 'abc1234', },
    ]);
    expect(info).toHaveBeenCalledWith('Updated 3 plugin(s).');
  });

  it.each([undefined, 'v2.0.0', 'latest', 'refs/tags/latest',])('updates only the named plugin with override %s', async (version) => {
    read.mockResolvedValue([registration('review', 'v1.0.0'), registration('lint'),]);
    await updater.update({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName: 'review', version, });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      targetDirectoryPath: '/project', repository: 'git@github.com:acme/repo.git', pluginName: 'review',
      version: version ?? 'v1.0.0', registration: registration('review', 'v1.0.0'),
    });
  });

  it('accepts origins without commit fragments and explicit HTTPS origins', async () => {
    read.mockResolvedValue([{ ...registration('review'), origin: 'https://github.com/acme/repo.git', },]);
    await updater.update({ targetDirectoryPath: '/project', });
    expect(refresh.mock.calls[0]?.[0].repository).toBe('https://github.com/acme/repo.git');
  });

  it('uses the recorded version rather than a SHA-256 origin commit', async () => {
    read.mockResolvedValue([{ ...registration('review', 'main'), origin: `ssh://git@github.com/acme/repo.git#${'d'.repeat(64)}`, },]);
    await updater.update({ targetDirectoryPath: '/project', });
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({ repository: 'ssh://git@github.com/acme/repo.git', version: 'main', });
  });

  it('treats an empty registry as a no-op', async () => {
    expect(await updater.update({ targetDirectoryPath: '/project', })).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('No managed plugins installed.');
  });

  it('rejects an uninstalled coordinate without falling back to the same name in another repository', async () => {
    await expect(updater.update({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName: 'review', })).rejects.toThrow('not installed');
    read.mockResolvedValue([registration('review', 'latest', 'other/repo'),]);
    await expect(updater.update({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName: 'review', }))
      .rejects.toThrow('github.com/acme/repo/review');
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    '@acme/repo',
    'git@github.com:acme/repo.git',
    'ssh://git@github.com/acme/repo.git',
    'https://GITHUB.COM/acme/repo.git/',
  ])('selects only the matching coordinate for %s and fetches from its recorded SSH origin', async (repository) => {
    const selected = registration('review', 'v1');
    read.mockResolvedValue([registration('review', 'v2', 'other/repo'), selected,]);
    await updater.update({ targetDirectoryPath: '/project', repository, pluginName: 'review', });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      targetDirectoryPath: '/project', repository: 'git@github.com:acme/repo.git', pluginName: 'review',
      version: 'v1', registration: selected,
    });
  });

  it('distinguishes nested namespaces and nondefault ports in coordinates', async () => {
    const selected = {
      ...registration('review'), src: 'plugins/gitlab.com~2222/team/subgroup/repo/review/plugin.md',
      origin: `ssh://git@gitlab.com:2222/team/subgroup/repo.git#${'a'.repeat(40)}`,
    };
    read.mockResolvedValue([
      { ...selected, src: 'plugins/gitlab.com/team/subgroup/repo/review/plugin.md', origin: 'git@gitlab.com:team/subgroup/repo.git', },
      selected,
    ]);
    await updater.update({ targetDirectoryPath: '/project', repository: 'ssh://git@gitlab.com:2222/team/subgroup/repo.git', pluginName: 'review', });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.[0].registration).toEqual(selected);
  });

  it.each(['../review', '', 'a/b', 'NUL', 'review.',])('rejects unsafe requested name %s before reading', async (pluginName) => {
    await expect(updater.update({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName, })).rejects.toBeInstanceOf(CliError);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a relative project directory', async () => {
    await expect(updater.update({ targetDirectoryPath: '.', })).rejects.toThrow('absolute');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { repository: '@acme/repo', },
    { pluginName: 'review', },
    { version: 'v2', },
    { repository: '@acme/repo', version: 'v2', },
    { pluginName: 'review', version: 'v2', },
  ])('rejects incomplete coordinates before reading: %j', async (target) => {
    await expect(updater.update({ targetDirectoryPath: '/project', ...target, })).rejects.toThrow('repository and plugin name');
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['review', '@acme', 'https://host/../repo', 'file:///tmp/repo',])('rejects invalid repository %s before reading', async (repository) => {
    await expect(updater.update({ targetDirectoryPath: '/project', repository, pluginName: 'review', })).rejects.toBeInstanceOf(CliError);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects an invalid version override before reading', async () => {
    await expect(updater.update({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName: 'review', version: 'main~1', }))
      .rejects.toBeInstanceOf(CliError);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    { origin: 'manual', },
    { origin: 'git@github.com:acme/repo.git#not-a-commit', },
    { version: 'main~1', },
    { src: 'plugins/github.com/acme/repo/review/instructions.md', },
    { src: 'plugins/github.com/acme/repo/NUL/plugin.md', },
    { src: 'plugins/github.com/other/repo/review/plugin.md', },
  ])('prevalidates all selected registrations before any installation: %j', async (invalid) => {
    read.mockResolvedValue([registration('lint'), { ...registration('review'), ...invalid, },]);
    await expect(updater.update({ targetDirectoryPath: '/project', })).rejects.toBeInstanceOf(CliError);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores source metadata of unselected entries', async () => {
    read.mockResolvedValue([registration('review'), { ...registration('lint'), origin: 'manual', },]);
    await updater.update({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName: 'review', });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each(['plugins-other/review/plugin.md', '../review/plugin.md', 'plugins/../review/plugin.md', 'plugins', 'plugins/..',])
    ('skips paths outside the managed directory: %s', async (src) => {
      read.mockResolvedValue([{ ...registration('review'), src, origin: 'manual', },]);
      expect(await updater.update({ targetDirectoryPath: '/project', })).toEqual([]);
      expect(refresh).not.toHaveBeenCalled();
    });

  it('propagates registry errors', async () => {
    const error = new Error('registry failed');
    read.mockRejectedValue(error);
    await expect(updater.update({ targetDirectoryPath: '/project', })).rejects.toBe(error);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stops after the first installer failure without undoing completed plugins', async () => {
    read.mockResolvedValue([registration('review'), registration('lint'), registration('test'),]);
    const error = new Error('Git authentication failed');
    refresh.mockResolvedValueOnce({ outcome: 'unchanged', pluginPath: '/review', registryPath: '/registry', commit: 'a'.repeat(40), version: 'latest', })
      .mockRejectedValueOnce(error);
    await expect(updater.update({ targetDirectoryPath: '/project', })).rejects.toBe(error);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(info).not.toHaveBeenCalled();
  });

  it('uses a CLI error for selection failures', () => {
    expect(new PluginUpdateError('unknown plugin')).toBeInstanceOf(CliError);
  });
});

describe('plugin update installation integration', () => {
  let fixture: string;
  let root: string;
  let registryPath: string;
  let registry: PluginRegistry;
  let installer: PluginInstaller;
  let updater: PluginUpdater;
  const gitRead = jest.fn<GitClient['readFile']>();
  const logger = { info: jest.fn<(message: string) => void>(), debug: jest.fn<(message: string) => void>(), warn: jest.fn(), };
  const confirm = jest.fn<() => Promise<boolean>>();
  const verify = jest.fn<PluginSignatureVerifier['verify']>();
  const readFiles: GitClient['readFiles'] = async (repository, files, ref) => {
    const file = await gitRead(repository, files[0]!.path, ref);
    return { commit: file.commit, files: new Map([[files[0]!.path, file.bytes,],]), };
  };
  const original = { bytes: Buffer.from('original\r\n'), commit: 'a'.repeat(40), };
  const updated = { bytes: Buffer.from('updated\r\n'), commit: 'c'.repeat(40), };
  const pluginPath = (name: string): string => join(root, '.specdd/plugins/github.com/acme/repo', name, 'plugin.md');

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'specdd-plugin-update-'));
    root = join(fixture, 'project');
    await mkdir(join(root, '.specdd'), { recursive: true, });
    await writeFile(join(root, '.specdd/bootstrap.md'), 'bootstrap');
    registryPath = join(root, '.specdd/plugins.json');
    const fileSystem = new FileSystem();
    const source = new PluginSource();
    registry = new PluginRegistry(fileSystem, () => join(fixture, 'home'));
    gitRead.mockReset().mockResolvedValue(original);
    logger.info.mockClear();
    verify.mockReset().mockResolvedValue({ status: 'verified', source: 'vendor', signerFingerprint: 'a'.repeat(40), });
    confirm.mockReset().mockResolvedValue(false);
    installer = new PluginInstaller(source, registry, { readFiles, }, fileSystem, logger, { verify, }, { confirm, });
    updater = new PluginUpdater(source, registry, installer, logger);
  });

  afterEach(async () => { await rm(fixture, { recursive: true, force: true, }); });

  const install = async (pluginName: string, version?: string): Promise<void> => {
    await installer.add({ targetDirectoryPath: root, repository: '@acme/repo', pluginName, version, });
  };

  it.each(['absolute', 'relative', 'home',])('skips an external %s source for all and named updates', async (kind) => {
    const external = join(fixture, 'home', 'review', 'plugin.md');
    await mkdir(dirname(external), { recursive: true, });
    await writeFile(external, original.bytes);
    const src = 'absolute' === kind ? external : 'relative' === kind ? relative(dirname(registryPath), external) : '~/review/plugin.md';
    const entry = { ...registration('review'), src, sig: createHash('sha256').update(original.bytes).digest('hex'), note: 'keep', };
    await writeFile(registryPath, JSON.stringify([entry,]));
    gitRead.mockResolvedValue(updated);

    expect(await updater.update({ targetDirectoryPath: root, })).toEqual([]);
    await expect(updater.update({ targetDirectoryPath: root, repository: '@acme/repo', pluginName: 'review', })).rejects.toThrow('not installed');
    expect(await readFile(external)).toEqual(original.bytes);
    expect(await registry.read(registryPath)).toEqual([entry,]);
    expect(gitRead).not.toHaveBeenCalled();
    expect(await readdir(join(root, '.specdd'))).toEqual(['bootstrap.md', 'plugins.json',]);
  });

  it('updates a managed plugin while preserving an external registration with the same name', async () => {
    await install('review');
    const external = join(fixture, 'home/review/plugin.md');
    await mkdir(dirname(external), { recursive: true, });
    await writeFile(external, 'local edits');
    const entry = { ...registration('review'), src: external, origin: 'manual', version: 'local', };
    await writeFile(registryPath, JSON.stringify([entry, ...(await registry.read(registryPath)),]));
    gitRead.mockReset().mockResolvedValue(updated);
    await updater.update({ targetDirectoryPath: root, repository: '@acme/repo', pluginName: 'review', });
    expect(await readFile(pluginPath('review'))).toEqual(updated.bytes);
    expect(await readFile(external, 'utf8')).toBe('local edits');
    expect((await registry.read(registryPath))[0]).toEqual(entry);
    expect(gitRead).toHaveBeenCalledTimes(1);
    gitRead.mockClear();
    await updater.update({ targetDirectoryPath: root, });
    expect(gitRead).toHaveBeenCalledTimes(1);
    expect((await registry.read(registryPath))[0]).toEqual(entry);
  });

  it('updates latest while keeping pinned versions, registry order, path spelling, and metadata', async () => {
    await install('review');
    await install('lint', 'v1.0.0');
    const entries = await registry.read(registryPath);
    entries[0] = { ...entries[0]!, src: pluginPath('review'), note: 'preserve', };
    await writeFile(registryPath, JSON.stringify(entries));
    gitRead.mockReset().mockImplementation(async (_repository, _file, version) => undefined === version ? updated : original);

    const results = await updater.update({ targetDirectoryPath: root, });
    expect(results.map((result) => result.outcome)).toEqual(['replaced', 'unchanged',]);
    expect(await readFile(pluginPath('review'))).toEqual(updated.bytes);
    expect(await readFile(pluginPath('lint'))).toEqual(original.bytes);
    const after = await registry.read(registryPath);
    expect(after[0]).toMatchObject({ src: pluginPath('review'), version: 'latest', origin: `git@github.com:acme/repo.git#${updated.commit}`, note: 'preserve', });
    expect(after[0]?.sig).not.toBe(entries[0]?.sig);
    expect(after[1]).toEqual(entries[1]);
  });

  it('changes only the named version and restores a missing registered file', async () => {
    await install('review', 'v1.0.0');
    await install('lint');
    const before = await registry.read(registryPath);
    await rm(pluginPath('review'));
    gitRead.mockReset().mockResolvedValue(updated);
    await updater.update({ targetDirectoryPath: root, repository: '@acme/repo', pluginName: 'review', version: 'v2.0.0', });
    const after = await registry.read(registryPath);
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ version: 'v2.0.0', src: before[0]?.src, });
    expect(after[1]).toEqual(before[1]);
    expect(await readFile(pluginPath('review'))).toEqual(updated.bytes);
    expect(gitRead).toHaveBeenCalledWith('git@github.com:acme/repo.git', '.plugins/review/plugin.md', 'v2.0.0');
  });

  it('updates one repository-qualified plugin when two repositories share the name', async () => {
    await install('review', 'v1');
    await installer.add({ targetDirectoryPath: root, repository: '@other/repo', pluginName: 'review', version: 'v1', });
    const before = await registry.read(registryPath);
    gitRead.mockReset().mockResolvedValue(updated);
    await updater.update({ targetDirectoryPath: root, repository: '@other/repo', pluginName: 'review', version: 'v2', });

    expect(await readFile(pluginPath('review'))).toEqual(original.bytes);
    expect(await readFile(join(root, '.specdd/plugins/github.com/other/repo/review/plugin.md'))).toEqual(updated.bytes);
    const after = await registry.read(registryPath);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({ version: 'v2', origin: `git@github.com:other/repo.git#${updated.commit}`, });
    expect(gitRead).toHaveBeenCalledTimes(1);
    expect(gitRead).toHaveBeenCalledWith('git@github.com:other/repo.git', '.plugins/review/plugin.md', 'v2');
  });

  it('retains completed updates and stops before overwriting local edits', async () => {
    await install('review');
    await install('lint');
    await install('test');
    await writeFile(pluginPath('lint'), 'local edits');
    gitRead.mockReset().mockResolvedValue(updated);
    await expect(updater.update({ targetDirectoryPath: root, })).rejects.toThrow('local modifications');
    expect(await readFile(pluginPath('review'))).toEqual(updated.bytes);
    expect(await readFile(pluginPath('lint'), 'utf8')).toBe('local edits');
    expect(await readFile(pluginPath('test'))).toEqual(original.bytes);
    expect(gitRead).toHaveBeenCalledTimes(1);
  });

  it('requires signature confirmation during updates and stops on refusal', async () => {
    await install('review');
    await install('lint');
    const before = await readFile(registryPath);
    gitRead.mockReset().mockResolvedValue(updated);
    verify.mockResolvedValue({ status: 'unsigned', });
    await expect(updater.update({ targetDirectoryPath: root, })).rejects.toThrow('cancelled');
    expect(await readFile(pluginPath('review'))).toEqual(original.bytes);
    expect(await readFile(pluginPath('lint'))).toEqual(original.bytes);
    expect(await readFile(registryPath)).toEqual(before);
    expect(gitRead).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each(['all', 'targeted',])('enforces official vendor signatures from the recorded origin for %s updates', async (selection) => {
    const installed = await installer.add({ targetDirectoryPath: root, repository: '@specdd/any-repo', pluginName: 'review', });
    const before = await readFile(registryPath);
    gitRead.mockReset().mockResolvedValue(updated);
    verify.mockClear().mockResolvedValue({ status: 'unsigned', });
    confirm.mockResolvedValue(true);
    const request = 'all' === selection ? { targetDirectoryPath: root, }
      : { targetDirectoryPath: root, repository: 'https://github.com/specdd/any-repo', pluginName: 'review', };
    await expect(updater.update(request)).rejects.toThrow('embedded SpecDD signing keys');
    expect(verify).toHaveBeenCalledWith(updated.bytes, undefined, { vendorOnly: true, });
    expect(gitRead).toHaveBeenCalledWith('git@github.com:specdd/any-repo.git', '.plugins/review/plugin.md', undefined);
    expect(await readFile(installed.pluginPath)).toEqual(original.bytes);
    expect(await readFile(registryPath)).toEqual(before);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('rolls back file changes if the registry update fails', async () => {
    await install('review');
    const before = await readFile(registryPath);
    jest.spyOn(registry, 'upsert').mockRejectedValue(new Error('disk full'));
    gitRead.mockResolvedValue(updated);
    await expect(updater.update({ targetDirectoryPath: root, })).rejects.toThrow('disk full');
    expect(await readFile(pluginPath('review'))).toEqual(original.bytes);
    expect(await readFile(registryPath)).toEqual(before);
  });

  it('does not create files when the registry and bootstrap are missing', async () => {
    await rm(join(root, '.specdd'), { recursive: true, });
    expect(await updater.update({ targetDirectoryPath: root, })).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect(gitRead).not.toHaveBeenCalled();
  });
});

describe('plugin update repository provenance with native Git', () => {
  const execute = promisify(execFile);
  const originalBytes = Buffer.from('original plugin\r\n');
  const updatedBytes = Buffer.from('updated plugin\r\n');
  let fixture: string;
  let project: string;
  let remote: string;
  let remotePlugin: string;
  let transportLog: string;
  let firstCommit: string;
  let fileSystem: FileSystem;
  let gitClient: GitClient;
  let registry: PluginRegistry;
  let installer: PluginInstaller;
  let updater: PluginUpdater;
  const confirm = jest.fn<() => Promise<boolean>>();

  const git = async (...args: string[]): Promise<string> => {
    const result = await execute('git', [
      '-c', 'user.name=SpecDD Test', '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args,
    ], { cwd: remote, env: process.env, });
    return result.stdout.trim();
  };

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'specdd-plugin-update-git-'));
    project = join(fixture, 'project');
    remote = join(fixture, 'remote/team/plugins');
    remotePlugin = join(remote, '.plugins/review/plugin.md');
    await mkdir(dirname(remotePlugin), { recursive: true, });
    await mkdir(join(project, '.specdd'), { recursive: true, });
    await writeFile(join(project, '.specdd/bootstrap.md'), 'bootstrap');
    await git('init', '--initial-branch=main', '--template=');
    await writeFile(remotePlugin, originalBytes);
    await git('add', '.');
    await git('commit', '-m', 'first');
    firstCommit = await git('rev-parse', 'HEAD');
    transportLog = join(fixture, 'transport.log');
    await writeFile(transportLog, '');
    const ssh = join(fixture, 'fixture-ssh');
    await writeFile(ssh, [
      '#!/bin/sh',
      'for argument in "$@"; do requested="$argument"; done',
      'printf "%s\\n" "$requested" >> "$SPECDD_TEST_TRANSPORT_LOG"',
      '[ "$requested" = "git-upload-pack \'$SPECDD_TEST_REPOSITORY_PATH\'" ] || exit 77',
      'exec git-upload-pack "$SPECDD_TEST_REMOTE"',
      '',
    ].join('\n'), { mode: 0o700, });
    jest.replaceProperty(process, 'env', {
      ...process.env, GIT_SSH: ssh, GIT_SSH_COMMAND: undefined, GIT_SSH_VARIANT: 'ssh',
      SPECDD_TEST_REMOTE: remote, SPECDD_TEST_TRANSPORT_LOG: transportLog,
    });
    fileSystem = new FileSystem();
    gitClient = new GitClient(fileSystem, { create: async () => mkdtemp(join(fixture, 'clone-')), });
    registry = new PluginRegistry(fileSystem);
    const source = new PluginSource();
    const logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), };
    const verify = jest.fn<PluginSignatureVerifier['verify']>().mockResolvedValue({ status: 'unsigned', });
    confirm.mockReset().mockResolvedValue(true);
    installer = new PluginInstaller(source, registry, gitClient, fileSystem, logger, { verify, }, { confirm, });
    updater = new PluginUpdater(source, registry, installer, logger);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(fixture, { recursive: true, force: true, });
  });

  it.each([
    ['git@example.test:team/plugins', 'team/plugins',],
    ['ssh://git@example.test/team/plugins', '/team/plugins',],
  ])('updates the original extensionless repository recorded from %s', async (repository, repositoryPath) => {
    process.env.SPECDD_TEST_REPOSITORY_PATH = repositoryPath;
    const registryPath = join(project, '.specdd/plugins.json');
    const installed = await installer.add({ targetDirectoryPath: project, repository, pluginName: 'review', });
    expect(await readFile(installed.pluginPath)).toEqual(originalBytes);
    expect((await registry.read(registryPath))[0]?.origin).toBe(`${repository}#${firstCommit}`);

    await writeFile(remotePlugin, updatedBytes);
    await git('add', '.');
    await git('commit', '-m', 'second');
    const updatedCommit = await git('rev-parse', 'HEAD');
    const results = await updater.update({ targetDirectoryPath: project, });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'replaced', commit: updatedCommit, pluginPath: installed.pluginPath, });
    expect(await readFile(installed.pluginPath)).toEqual(updatedBytes);
    expect((await registry.read(registryPath))[0]).toMatchObject({ origin: `${repository}#${updatedCommit}`, version: 'latest', });
    const expectedCommand = `git-upload-pack '${repositoryPath}'`;
    expect((await readFile(transportLog, 'utf8')).trim().split('\n')).toEqual([expectedCommand, expectedCommand,]);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await fileSystem.exists(join(project, '.specdd/plugins.lock'))).toBe(false);
  });

  it('rejects percent-encoded SCP paths before Git or project writes for add and update', async () => {
    const read = jest.spyOn(gitClient, 'readFiles');
    const write = jest.spyOn(fileSystem, 'writeFileAtomic');
    const lock = jest.spyOn(fileSystem, 'withExclusiveLock');
    const request = { targetDirectoryPath: project, repository: 'git@example.test:team/r%65po.git', pluginName: 'review', };
    await expect(installer.add(request)).rejects.toThrow('Invalid repository path');
    await expect(updater.update(request)).rejects.toThrow('Invalid repository path');
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(transportLog, 'utf8')).toBe('');
    expect(await readdir(join(project, '.specdd'))).toEqual(['bootstrap.md',]);
  });
});
