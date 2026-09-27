import { jest } from '@jest/globals';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as openpgp from 'openpgp';
import { FileSystem } from './file-system.js';
import { GpgClient, GpgClientError, type GpgProcessRunner } from './gpg-client.js';

const fingerprint = 'a'.repeat(40);
const data = Buffer.from([35, 32, 65, 13, 10, 0, 255,]);
const signature = Buffer.from('detached signature\r\n');
const valid = `NEWSIG\nGOODSIG AAAAAAAAAAAAAAAA Claimed name\nVALIDSIG ${fingerprint} 2026-01-01 0 0 4 0 1 10 00 ${fingerprint}`;
const statusBytes = (status: string): Buffer => Buffer.from(status.split('\n').map((line) => `[GNUPG:] ${line}`).join('\n'));

describe('GpgClient', () => {
  let root: string;
  let directory: string;
  let fileSystem: FileSystem;
  let client: GpgClient;
  const run = jest.fn<GpgProcessRunner>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'specdd-gpg-test-'));
    directory = join(root, 'verification');
    fileSystem = new FileSystem();
    client = new GpgClient(fileSystem, { create: async () => { await mkdir(directory); return directory; }, }, run);
    run.mockReset().mockResolvedValue({ stdout: statusBytes(`${valid}\nTRUST_FULLY 0 pgp`), exitCode: 0, });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true, });
  });

  it.each(['FULLY', 'ULTIMATE',])('accepts valid signatures with TRUST_%s', async (trust) => {
    run.mockImplementation(async (args) => {
      expect(args).toEqual([
        '--batch', '--no-tty', '--no-auto-key-retrieve', '--no-auto-key-import',
        '--no-auto-key-locate', '--no-auto-check-trustdb', '--status-fd=1',
        '--verify', '--', join(directory, 'signature.asc'), join(directory, 'data'),
      ]);
      expect(await readFile(join(directory, 'data'))).toEqual(data);
      expect(await readFile(join(directory, 'signature.asc'))).toEqual(signature);
      return { stdout: statusBytes(`${valid}\nTRUST_${trust} 0 pgp`), exitCode: 0, };
    });
    expect(await client.verify(data, signature)).toEqual({
      status: 'verified', signerFingerprint: fingerprint, identityValidity: 'FULLY' === trust ? 'full' : 'ultimate',
    });
    expect(await fileSystem.exists(directory)).toBe(false);
  });

  it.each([
    ['TRUST_UNDEFINED 0 pgp', 'unknown',], ['TRUST_MARGINAL 0 pgp', 'marginal',], ['TRUST_NEVER 0 pgp', 'never',], ['', 'unknown',],
  ])('keeps signature validity separate from %s', async (trust, identityValidity) => {
    run.mockResolvedValue({ stdout: statusBytes(`${valid}\n${trust}`), exitCode: 0, });
    expect(await client.verify(data, signature)).toEqual({ status: 'untrusted', signerFingerprint: fingerprint, identityValidity, });
  });

  it.each([
    ['EXPKEYSIG A Name', 'expired',], ['EXPSIG A Name', 'expired',], ['REVKEYSIG A Name', 'revoked',],
    ['BADSIG A Name', 'invalid',], ['NODATA 1', 'invalid',], ['NO_PUBKEY A', 'unknown-key',],
    ['ERRSIG A 1 10 00 0 9', 'unknown-key',], ['ERRSIG A 1 10 00 0 4', 'verification-error',],
  ])('reports %s even with VALIDSIG and full trust', async (failure, reason) => {
    run.mockResolvedValue({ stdout: statusBytes(`${valid}\nTRUST_FULLY 0 pgp\n${failure}`), exitCode: 0, });
    expect(await client.verify(data, signature)).toEqual({ status: 'unverified', reason, });
  });

  it.each([
    `${valid}\nTRUST_FULLY 0 pgp\nFAILURE verify 1`,
    `${valid}\nTRUST_FULLY 0 pgp\nERROR verify 1`,
    `NEWSIG\nVALIDSIG ${fingerprint}\nTRUST_FULLY 0 pgp`,
    'NEWSIG\nGOODSIG short Name\nVALIDSIG 1234\nTRUST_FULLY 0 pgp',
  ])('rejects unsuccessful or incomplete status records', async (output) => {
    run.mockResolvedValue({ stdout: statusBytes(output), exitCode: 0, });
    expect(await client.verify(data, signature)).toEqual({ status: 'unverified', reason: 'verification-error', });
  });

  it('does not trust human-readable output or a zero exit code alone', async () => {
    run.mockResolvedValue({ stdout: Buffer.from('Good signature from trusted vendor'), exitCode: 0, });
    expect(await client.verify(data, signature)).toEqual({ status: 'unverified', reason: 'verification-error', });
  });

  it('does not combine trust and validity across signatures', async () => {
    run.mockResolvedValue({ stdout: statusBytes(`${valid}\nNEWSIG\nTRUST_FULLY 0 pgp`), exitCode: 0, });
    expect(await client.verify(data, signature)).toEqual({ status: 'untrusted', signerFingerprint: fingerprint, identityValidity: 'unknown', });
  });

  it('selects a trusted signature from multiple independently checked signatures', async () => {
    const secondFingerprint = 'b'.repeat(64);
    run.mockResolvedValue({
      stdout: statusBytes(`${valid}\nTRUST_MARGINAL 0 pgp\n${valid.replaceAll(fingerprint, secondFingerprint)}\nTRUST_FULLY 0 pgp\nFUTURE_STATUS 123`),
      exitCode: 0,
    });
    expect(await client.verify(data, signature)).toMatchObject({ status: 'verified', signerFingerprint: secondFingerprint, });
  });

  it('requires successful completion despite good status records', async () => {
    run.mockResolvedValue({ stdout: statusBytes(`${valid}\nTRUST_ULTIMATE 0 pgp`), exitCode: 1, });
    expect(await client.verify(data, signature)).toEqual({ status: 'unverified', reason: 'verification-error', });
  });

  it.each(['ENOENT', 'EACCES', 'ETIMEDOUT',])('handles process error %s and cleans temporary files', async (code) => {
    run.mockRejectedValue(Object.assign(new Error('cannot run'), { code, }));
    expect(await client.verify(data, signature)).toEqual({ status: 'unverified', reason: 'ENOENT' === code ? 'unavailable' : 'verification-error', });
    expect(await fileSystem.exists(directory)).toBe(false);
  });

  it('reports temporary file failures and removes the temporary directory', async () => {
    jest.spyOn(fileSystem, 'writeFile').mockRejectedValue(new Error('disk full'));
    await expect(client.verify(data, signature)).rejects.toThrow('disk full');
    expect(run).not.toHaveBeenCalled();
    expect(await fileSystem.exists(directory)).toBe(false);
  });

  it('reports directory creation failures', async () => {
    const failure = new GpgClient(fileSystem, { create: async () => { throw new Error('no space'); }, }, run);
    await expect(failure.verify(data, signature)).rejects.toBeInstanceOf(GpgClientError);
  });

  it('retains the original failure when cleanup also fails', async () => {
    jest.spyOn(fileSystem, 'writeFile').mockRejectedValue(new Error('disk full'));
    jest.spyOn(fileSystem, 'removePath').mockRejectedValue(new Error('cleanup failed'));
    await expect(client.verify(data, signature)).rejects.toThrow(/disk full.*cleanup failed/);
  });

  it('reports cleanup failure after successful verification', async () => {
    jest.spyOn(fileSystem, 'removePath').mockRejectedValue(new Error('cleanup failed'));
    await expect(client.verify(data, signature)).rejects.toThrow('cleanup failed');
  });

  it('reports missing GnuPG through the native process runner', async () => {
    jest.replaceProperty(process, 'env', { ...process.env, PATH: root, });
    const native = new GpgClient(fileSystem, { create: async () => { await mkdir(directory); return directory; }, });
    expect(await native.verify(data, signature)).toEqual({ status: 'unverified', reason: 'unavailable', });
  });
});

const describeInstalledGpg = 0 === spawnSync('gpg', ['--version',]).status ? describe : describe.skip;

describeInstalledGpg('GpgClient with an isolated real keyring', () => {
  const execute = promisify(execFile);

  it('verifies exact bytes and local identity validity without accessing the user keyring', async () => {
    const root = await mkdtemp(join(tmpdir(), 'specdd-gpg-integration-'));
    const keyring = join(root, 'keyring');
    await mkdir(keyring, { mode: 0o700, });
    await writeFile(join(keyring, 'common.conf'), '');
    const keys = await openpgp.generateKey({ type: 'ecc', curve: 'ed25519Legacy', format: 'object', userIDs: [{ name: 'Fixture', },], });
    const detached = Buffer.from(await openpgp.sign({
      message: await openpgp.createMessage({ binary: data, }), signingKeys: keys.privateKey, detached: true, format: 'armored',
    }));
    const signerFingerprint = keys.publicKey.getFingerprint();
    const client = new GpgClient(new FileSystem(), { create: async () => mkdtemp(join(root, 'verification-')), });
    jest.replaceProperty(process, 'env', { ...process.env, GNUPGHOME: keyring, });
    const gpg = async (...args: string[]): Promise<void> => {
      await execute('gpg', ['--homedir', keyring, '--batch', ...args,], { env: process.env, });
    };

    try {
      expect(await client.verify(data, detached)).toMatchObject({ status: 'unverified', reason: 'unknown-key', });
      await writeFile(join(root, 'public.asc'), keys.publicKey.armor());
      await gpg('--no-autostart', '--import', join(root, 'public.asc'));
      await gpg('--check-trustdb');
      expect(await client.verify(data, detached)).toMatchObject({ status: 'untrusted', signerFingerprint, identityValidity: 'unknown', });
      await writeFile(join(root, 'trust.txt'), `${signerFingerprint}:6:\n`);
      await gpg('--import-ownertrust', join(root, 'trust.txt'));
      await gpg('--check-trustdb');
      expect(await client.verify(data, detached)).toMatchObject({ status: 'verified', signerFingerprint, identityValidity: 'ultimate', });
      expect(await client.verify(Buffer.from('altered bytes'), detached)).toMatchObject({ status: 'unverified', reason: 'invalid', });
      expect(await client.verify(data, Buffer.from('malformed'))).toMatchObject({ status: 'unverified', reason: 'invalid', });
    } finally {
      jest.restoreAllMocks();
      await rm(root, { recursive: true, force: true, });
    }
  });
});
