import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FileSystem } from '../../infrastructure/file-system.js';
import type { GitClient } from '../../infrastructure/git-client.js';
import { PluginSignatureVerifier, type PluginSignatureResult } from '../plugin-signature-verifier/plugin-signature-verifier.js';
import { SignatureUnknownSignerError } from '../signature-verifier/signature-verifier.js';
import type { GpgClient } from '../../infrastructure/gpg-client.js';
import { PluginSource } from '../plugin-source/plugin-source.js';
import { PluginRegistry } from '../plugin-registry/plugin-registry.js';
import { PluginInstaller, PluginInstallError, type PluginAddRequest } from './plugin-installer.js';

describe('PluginInstaller', () => {
  let root: string;
  let path: string;
  let registryPath: string;
  let fileSystem: FileSystem;
  let registry: PluginRegistry;
  let installer: PluginInstaller;
  let request: PluginAddRequest;
  const commit = 'a'.repeat(40);
  const bytes = Buffer.from([35, 32, 80, 108, 117, 103, 105, 110, 13, 10, 255,]);
  const sig = createHash('sha256').update(bytes).digest('hex');
  const gitRead = jest.fn<GitClient['readFile']>();
  const verify = jest.fn<PluginSignatureVerifier['verify']>();
  const confirm = jest.fn<() => Promise<boolean>>();
  const warn = jest.fn();
  let signature: Uint8Array | undefined;
  const readFiles = jest.fn<GitClient['readFiles']>(async (repository, files, ref) => {
    const file = await gitRead(repository, files[0]!.path, ref);
    const contents = new Map([[files[0]!.path, file.bytes,],]);
    if (undefined !== signature) {
      contents.set(files[1]!.path, signature);
    }
    return { commit: file.commit, files: contents, };
  });
  const info = jest.fn<(message: string) => void>();
  const debug = jest.fn<(message: string) => void>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'specdd-plugin-install-'));
    await mkdir(join(root, '.specdd'));
    await writeFile(join(root, '.specdd/bootstrap.md'), 'bootstrap');
    path = join(root, '.specdd/plugins/github.com/acme/repo/review/plugin.md');
    registryPath = join(root, '.specdd/plugins.json');
    fileSystem = new FileSystem();
    registry = new PluginRegistry(fileSystem);
    gitRead.mockReset().mockResolvedValue({ commit, bytes, });
    info.mockClear();
    readFiles.mockClear();
    warn.mockClear();
    signature = undefined;
    verify.mockReset().mockResolvedValue({ status: 'verified', source: 'vendor', signerFingerprint: 'a'.repeat(40), });
    confirm.mockReset().mockResolvedValue(false);
    installer = new PluginInstaller(new PluginSource(), registry, { readFiles, }, fileSystem, { info, debug, warn, }, { verify, }, { confirm, });
    request = { targetDirectoryPath: root, repository: '@acme/repo', pluginName: 'review', };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, });
  });

  it('installs exact blob bytes and records SSH origin, latest version, and checksum', async () => {
    const result = await installer.add(request);
    expect(result).toMatchObject({ outcome: 'installed', commit, version: 'latest', pluginPath: path, registryPath, });
    expect(await readFile(path)).toEqual(bytes);
    expect(await registry.read(registryPath)).toEqual([{
      src: 'plugins/github.com/acme/repo/review/plugin.md',
      origin: `git@github.com:acme/repo.git#${commit}`, sig, version: 'latest',
    },]);
    expect(gitRead).toHaveBeenCalledWith('git@github.com:acme/repo.git', '.plugins/review/plugin.md', undefined);
    expect(info.mock.calls.map(([message]) => message).join('\n')).toContain(path);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('passes the optional signature and the exact downloaded bytes to verification', async () => {
    signature = Buffer.from('armored signature');
    await installer.add(request);
    expect(readFiles).toHaveBeenCalledWith('git@github.com:acme/repo.git', [
      { path: '.plugins/review/plugin.md', }, { path: '.plugins/review/plugin.md.asc', optional: true, },
    ], undefined);
    expect(verify).toHaveBeenCalledWith(bytes, signature, { vendorOnly: false, });
  });

  it.each(['@specdd/repo', 'git@github.com:specdd/repo.git', 'https://github.com/specdd/repo',])
    ('requires embedded vendor verification for %s', async (repository) => {
      signature = Buffer.from('vendor signature');
      const result = await installer.add({ ...request, repository, });
      expect(verify).toHaveBeenCalledWith(bytes, signature, { vendorOnly: true, });
      expect(await readFile(result.pluginPath)).toEqual(bytes);
      expect(confirm).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

  it.each<PluginSignatureResult>([
    { status: 'unsigned', },
    { status: 'unverified', reason: 'unknown-vendor', },
    { status: 'unverified', reason: 'invalid', },
    { status: 'unverified', reason: 'expired', },
    { status: 'unverified', reason: 'revoked', },
    { status: 'verified', source: 'system', signerFingerprint: 'f'.repeat(40), },
    { status: 'untrusted', identityValidity: 'marginal', signerFingerprint: 'f'.repeat(40), },
  ])('fails official installation without an override for $status $reason $source', async (result) => {
    verify.mockResolvedValue(result);
    confirm.mockResolvedValue(true);
    await expect(installer.add({ ...request, repository: '@specdd/repo', })).rejects.toThrow('requires a valid signature from the embedded SpecDD signing keys');
    expect(confirm).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(await fileSystem.exists(join(root, '.specdd/plugins/github.com/specdd/repo/review/plugin.md'))).toBe(false);
    expect(await fileSystem.exists(registryPath)).toBe(false);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('never falls back to system trust when installing an official source', async () => {
    signature = Buffer.from('third-party signature');
    const system = jest.fn<GpgClient['verify']>().mockResolvedValue({
      status: 'verified', signerFingerprint: 'f'.repeat(40), identityValidity: 'ultimate',
    });
    const verifier = new PluginSignatureVerifier({ verifyBytes: async () => { throw new SignatureUnknownSignerError('unknown'); }, }, { verify: system, });
    const guarded = new PluginInstaller(new PluginSource(), registry, { readFiles, }, fileSystem, { info, debug, warn, }, verifier, { confirm, });
    await expect(guarded.add({ ...request, repository: '@specdd/repo', })).rejects.toThrow('not made by an embedded SpecDD signing key');
    expect(system).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(await fileSystem.exists(registryPath)).toBe(false);
  });

  it('rejects unchanged official installations when vendor verification fails', async () => {
    const official = { ...request, repository: '@specdd/repo', };
    const installed = await installer.add(official);
    const before = await readFile(registryPath);
    verify.mockResolvedValue({ status: 'unsigned', });
    await expect(installer.add(official)).rejects.toThrow('embedded SpecDD signing keys');
    expect(await readFile(installed.pluginPath)).toEqual(bytes);
    expect(await readFile(registryPath)).toEqual(before);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('warns and cancels unsigned installation without writing files or leaving a lock', async () => {
    verify.mockResolvedValue({ status: 'unsigned', });
    await expect(installer.add(request)).rejects.toThrow('explicit interactive confirmation');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT signed'), { force: true, });
    expect(await fileSystem.exists(path)).toBe(false);
    expect(await fileSystem.exists(registryPath)).toBe(false);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('installs unsigned bytes after explicit confirmation', async () => {
    verify.mockResolvedValue({ status: 'unsigned', });
    confirm.mockResolvedValue(true);
    await installer.add(request);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('requires verification and consent even when installed bytes are unchanged', async () => {
    await installer.add(request);
    const before = await readFile(registryPath);
    verify.mockResolvedValue({ status: 'unsigned', });
    await expect(installer.add(request)).rejects.toThrow('cancelled');
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(registryPath)).toEqual(before);
  });

  it.each(['unknown', 'marginal', 'never',] as const)('explains valid signatures with %s identity validity', async (identityValidity) => {
    verify.mockResolvedValue({ status: 'untrusted', signerFingerprint: 'f'.repeat(40), identityValidity, });
    await expect(installer.add(request)).rejects.toBeInstanceOf(PluginInstallError);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('The plugin\'s signature is valid.');
    expect(message).toContain('f'.repeat(40));
    expect(message).toContain(`Identity validity: ${identityValidity}`);
    expect(message).toContain(commit);
    expect(message).not.toContain('NOT signed');
    expect(message).toContain('never' === identityValidity ? 'reports this signing identity as untrusted' : 'not established sufficient trust');
  });

  it.each([
    ['invalid', 'does not match',], ['expired', 'expired',], ['revoked', 'revoked',],
    ['unknown-key', 'not available',], ['unavailable', 'GnuPG is unavailable',], ['verification-error', 'verification failed',],
  ] as const)('explains verification failure %s and requires consent', async (reason, text) => {
    verify.mockResolvedValue({ status: 'unverified', reason, });
    await expect(installer.add(request)).rejects.toBeInstanceOf(PluginInstallError);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(text), { force: true, });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await fileSystem.exists(path)).toBe(false);
  });

  it('preserves existing plugin and registry contents when refresh is refused', async () => {
    await installer.add(request);
    const before = await readFile(registryPath);
    const registration = (await registry.read(registryPath))[0]!;
    gitRead.mockResolvedValue({ commit: 'b'.repeat(40), bytes: Buffer.from('updated'), });
    verify.mockResolvedValue({ status: 'unsigned', });
    await expect(installer.refresh({ ...request, registration, })).rejects.toThrow('cancelled');
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(registryPath)).toEqual(before);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('protects local edits made while awaiting confirmation', async () => {
    await installer.add(request);
    const before = await readFile(registryPath);
    verify.mockResolvedValue({ status: 'unsigned', });
    confirm.mockImplementation(async () => { await writeFile(path, 'edited while prompting'); return true; });
    await expect(installer.add(request)).rejects.toThrow('local modifications');
    expect(await readFile(path, 'utf8')).toBe('edited while prompting');
    expect(await readFile(registryPath)).toEqual(before);
  });

  it('propagates verifier failures without offering an override', async () => {
    verify.mockRejectedValue(new Error('broken trust configuration'));
    await expect(installer.add(request)).rejects.toThrow('broken trust configuration');
    expect(confirm).not.toHaveBeenCalled();
    expect(await fileSystem.exists(path)).toBe(false);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it.each(['missing', 'src', 'origin', 'sig', 'version',])('refuses a refresh when the selected registration changed: %s', async (field) => {
    await installer.add(request);
    const registration = (await registry.read(registryPath))[0]!;
    const changes: Record<string, string> = {
      src: `./${registration.src}`, origin: 'git@github.com:other/repo.git', sig: 'c'.repeat(64), version: 'v2',
    };
    const entries = 'missing' === field ? [] : [{ ...registration, [field]: changes[field], },];
    await writeFile(registryPath, JSON.stringify(entries));
    gitRead.mockClear();
    await expect(installer.refresh({ ...request, registration, })).rejects.toThrow('registration changed');
    expect(gitRead).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(bytes);
    expect(await registry.read(registryPath)).toEqual(entries);
  });

  it.each(['verification', 'confirmation',].flatMap((stage) => (
    ['missing', 'src', 'origin', 'sig', 'version',].map((field) => ({ stage, field, }))
  )))('preserves a registration changed during $stage: $field', async ({ stage, field }) => {
    await installer.add(request);
    const registration = (await registry.read(registryPath))[0]!;
    const changes: Record<string, string> = {
      src: `./${registration.src}`, origin: 'git@github.com:other/repo.git', sig: 'c'.repeat(64), version: 'v2',
    };
    const edited = JSON.stringify('missing' === field ? [] : [{ ...registration, [field]: changes[field], },]);
    const edit = async (): Promise<void> => { await writeFile(registryPath, edited); };
    gitRead.mockResolvedValue({ commit: 'b'.repeat(40), bytes: Buffer.from('updated'), });
    const write = jest.spyOn(fileSystem, 'writeFileAtomic');

    if ('verification' === stage) {
      verify.mockImplementation(async () => {
        await edit();
        return { status: 'verified', source: 'vendor', signerFingerprint: 'a'.repeat(40), };
      });
    } else {
      verify.mockResolvedValue({ status: 'unsigned', });
      confirm.mockImplementation(async () => { await edit(); return true; });
    }

    await expect(installer.refresh({ ...request, registration, })).rejects.toThrow('registration changed');
    expect(write).not.toHaveBeenCalled();
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(registryPath, 'utf8')).toBe(edited);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('rejects a removed registration before returning an otherwise unchanged result', async () => {
    await installer.add(request);
    const registration = (await registry.read(registryPath))[0]!;
    verify.mockImplementation(async () => {
      await rm(registryPath);
      return { status: 'verified', source: 'vendor', signerFingerprint: 'a'.repeat(40), };
    });
    await expect(installer.refresh({ ...request, registration, })).rejects.toThrow('registration changed');
    expect(await readFile(path)).toEqual(bytes);
    expect(await fileSystem.exists(registryPath)).toBe(false);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('rejects a registration that appears during a new installation', async () => {
    const edited = JSON.stringify([{
      src: 'plugins/github.com/acme/repo/review/plugin.md', origin: 'manual', sig, version: 'local',
    },]);
    verify.mockImplementation(async () => {
      await writeFile(registryPath, edited);
      return { status: 'verified', source: 'vendor', signerFingerprint: 'a'.repeat(40), };
    });
    await expect(installer.add(request)).rejects.toThrow('registration changed');
    expect(await fileSystem.exists(path)).toBe(false);
    expect(await readFile(registryPath, 'utf8')).toBe(edited);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('preserves unrelated registrations and metadata edited during verification', async () => {
    await installer.add(request);
    const registration = (await registry.read(registryPath))[0]!;
    const external = { src: '~/unavailable/plugin.md', origin: 'manual', sig, version: 'local', };
    gitRead.mockResolvedValue({ commit: 'b'.repeat(40), bytes: Buffer.from('updated'), });
    verify.mockImplementation(async () => {
      await writeFile(registryPath, JSON.stringify([external, { ...registration, note: 'edited', },]));
      return { status: 'verified', source: 'vendor', signerFingerprint: 'a'.repeat(40), };
    });
    expect((await installer.refresh({ ...request, registration, })).outcome).toBe('replaced');
    const entries = await registry.read(registryPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(external);
    expect(entries[1]).toMatchObject({ src: registration.src, note: 'edited', });
    expect(await readFile(path, 'utf8')).toBe('updated');
  });

  it.each([false, true,])('rolls back a late registration conflict with an existing file: %s', async (existing) => {
    if (existing) {
      await installer.add(request);
    }
    const registration = (await registry.read(registryPath))[0];
    const replacement = Buffer.from('replacement');
    const edited = JSON.stringify(existing ? [] : [{
      src: 'plugins/github.com/acme/repo/review/plugin.md', origin: 'manual', sig, version: 'local',
    },]);
    const write = fileSystem.writeFileAtomic.bind(fileSystem);
    jest.spyOn(fileSystem, 'writeFileAtomic').mockImplementation(async (target, data) => {
      await write(target, data);
      if (path === target && replacement.equals(data)) {
        await writeFile(registryPath, edited);
      }
    });
    gitRead.mockResolvedValue({ commit: 'b'.repeat(40), bytes: replacement, });
    const installation = undefined === registration ? installer.add(request) : installer.refresh({ ...request, registration, });
    await expect(installation).rejects.toThrow('registration changed');
    if (existing) {
      expect(await readFile(path)).toEqual(bytes);
    } else {
      expect(await fileSystem.exists(path)).toBe(false);
    }
    expect(await readFile(registryPath, 'utf8')).toBe(edited);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it('rejects refresh destinations outside the managed installation path', async () => {
    const registration = { src: '~/review/plugin.md', origin: 'git@github.com:acme/repo.git', sig, version: 'latest', };
    await expect(installer.refresh({ ...request, registration, })).rejects.toThrow('managed installation path');
    expect(gitRead).not.toHaveBeenCalled();
    expect(await fileSystem.exists(registryPath)).toBe(false);
  });

  it.each(['v1.2.0', 'abc1234', 'latest',])('preserves explicit version %s', async (version) => {
    await installer.add({ ...request, version, });
    expect((await registry.read(registryPath))[0]?.version).toBe(version);
    expect(gitRead).toHaveBeenCalledWith('git@github.com:acme/repo.git', '.plugins/review/plugin.md', version);
  });

  it('does not rewrite an unchanged installation but records a new requested version', async () => {
    await installer.add(request);
    const write = jest.spyOn(fileSystem, 'writeFileAtomic');
    expect((await installer.add(request)).outcome).toBe('unchanged');
    expect(write).not.toHaveBeenCalled();
    await installer.add({ ...request, version: 'v1.2.0', });
    expect((await registry.read(registryPath))[0]?.version).toBe('v1.2.0');
    expect(await registry.read(registryPath)).toHaveLength(1);
  });

  it('replaces intact registered content and restores missing registered files', async () => {
    await installer.add(request);
    gitRead.mockResolvedValue({ commit: 'b'.repeat(40), bytes: Buffer.from('updated'), });
    expect((await installer.add(request)).outcome).toBe('replaced');
    expect(await readFile(path, 'utf8')).toBe('updated');
    await rm(path);
    await installer.add(request);
    expect(await readFile(path, 'utf8')).toBe('updated');
  });

  it('preserves unrelated external entries without reading or writing their files', async () => {
    const external = { src: '~/unavailable/plugin.md', origin: 'manual', version: 'local', sig, note: 'keep', };
    await writeFile(registryPath, JSON.stringify([external,]));
    await installer.add(request);
    expect((await registry.read(registryPath))[0]).toEqual(external);
  });

  it('protects local modifications before downloading', async () => {
    await installer.add(request);
    const previousRegistry = await readFile(registryPath);
    await writeFile(path, 'local edit');
    gitRead.mockClear();
    await expect(installer.add(request)).rejects.toBeInstanceOf(PluginInstallError);
    expect(gitRead).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe('local edit');
    expect(await readFile(registryPath)).toEqual(previousRegistry);
  });

  it('refuses unregistered destination files', async () => {
    await mkdir(dirname(path), { recursive: true, });
    await writeFile(path, 'unregistered');
    await expect(installer.add(request)).rejects.toThrow('unregistered');
    expect(await readFile(path, 'utf8')).toBe('unregistered');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('rejects missing initialization and malformed registries before downloading', async () => {
    await rm(join(root, '.specdd/bootstrap.md'));
    await expect(installer.add(request)).rejects.toThrow('bootstrap');
    await writeFile(join(root, '.specdd/bootstrap.md'), 'bootstrap');
    await writeFile(registryPath, '{}');
    await expect(installer.add(request)).rejects.toThrow('registry');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('rejects a relative project root', async () => {
    await expect(installer.add({ ...request, targetDirectoryPath: '.', })).rejects.toThrow('absolute');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('prevents a source descriptor from redirecting writes outside the project', async () => {
    const source = new PluginSource();
    jest.spyOn(source, 'resolve').mockReturnValue({
      ...source.resolve('@acme/repo', 'review'), relativeDestination: '../../external/plugin.md',
    });
    const guarded = new PluginInstaller(source, registry, { readFiles, }, fileSystem, { info, debug, warn, }, { verify, }, { confirm, });
    await expect(guarded.add(request)).rejects.toThrow('outside the project');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('detects a registered file removed during the download', async () => {
    await installer.add(request);
    const before = await readFile(registryPath);
    gitRead.mockImplementation(async () => {
      await rm(path);
      return { commit, bytes, };
    });
    await expect(installer.add(request)).rejects.toThrow('changed during download');
    expect(await readFile(registryPath)).toEqual(before);
    expect(await fileSystem.exists(path)).toBe(false);
  });

  it('reports filesystem errors during preflight', async () => {
    jest.spyOn(fileSystem, 'lstat').mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES', }));
    await expect(installer.add(request)).rejects.toThrow('permission denied');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('rejects a non-directory ancestor of the managed destination', async () => {
    await writeFile(join(root, '.specdd/plugins'), 'occupied');
    await expect(installer.add(request)).rejects.toThrow('ancestor is not a directory');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it.each(['.specdd/plugins', '.specdd/plugins.json', '.specdd/plugins.lock',])('rejects redirected write path %s', async (relativePath) => {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, relativePath));
    await expect(installer.add(request)).rejects.toBeInstanceOf(PluginInstallError);
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('rejects a symlinked plugin file', async () => {
    await mkdir(dirname(path), { recursive: true, });
    await writeFile(join(root, 'outside'), 'external');
    await symlink(join(root, 'outside'), path);
    await expect(installer.add(request)).rejects.toThrow();
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('external');
  });

  it('rejects a destination directory', async () => {
    await mkdir(path, { recursive: true, });
    await expect(installer.add(request)).rejects.toThrow();
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('reports contention without deleting another installation lock', async () => {
    const lock = join(root, '.specdd/plugins.lock');
    await writeFile(lock, 'other');
    await expect(installer.add(request)).rejects.toThrow('lock');
    expect(await readFile(lock, 'utf8')).toBe('other');
    expect(gitRead).not.toHaveBeenCalled();
  });

  it('leaves project state unchanged on Git failure', async () => {
    gitRead.mockRejectedValue(new Error('missing source file'));
    await expect(installer.add(request)).rejects.toThrow('missing source file');
    expect(await fileSystem.exists(path)).toBe(false);
    expect(await fileSystem.exists(registryPath)).toBe(false);
    expect(await fileSystem.exists(join(root, '.specdd/plugins.lock'))).toBe(false);
  });

  it.each([false, true,])('rolls back registry failures with an existing file: %s', async (existing) => {
    if (existing) {
      await installer.add(request);
    }
    const before = existing ? await readFile(registryPath) : undefined;
    jest.spyOn(registry, 'upsert').mockRejectedValue(new Error('registry disk full'));
    gitRead.mockResolvedValue({ commit: 'b'.repeat(40), bytes: Buffer.from('replacement'), });
    await expect(installer.add(request)).rejects.toThrow('registry disk full');
    if (existing) {
      expect(await readFile(path)).toEqual(bytes);
      expect(await readFile(registryPath)).toEqual(before);
    } else {
      expect(await fileSystem.exists(path)).toBe(false);
      expect(await fileSystem.exists(registryPath)).toBe(false);
    }
  });

  it('reports rollback failure and the affected path', async () => {
    jest.spyOn(registry, 'upsert').mockRejectedValue(new Error('registry failed'));
    jest.spyOn(fileSystem, 'removePath').mockRejectedValue(new Error('rollback failed'));
    await expect(installer.add(request)).rejects.toThrow(path);
  });
});
