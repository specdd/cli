import { jest } from '@jest/globals';
import * as openpgp from 'openpgp';
import type { GpgClient } from '../../infrastructure/gpg-client.js';
import { Config } from '../config/config.js';
import { Logger } from '../logger/logger.js';
import {
  SignatureInvalidError, SignatureKeyValidityError, SignaturePublicKeyLoadError, SignatureUnknownSignerError,
  SignatureVerifier,
} from '../signature-verifier/signature-verifier.js';
import { PluginSignatureVerifier } from './plugin-signature-verifier.js';

describe('PluginSignatureVerifier', () => {
  const bytes = Buffer.from('plugin\r\n');
  const signature = Buffer.from('signature');
  const fingerprint = 'a'.repeat(40);
  const vendor = jest.fn<SignatureVerifier['verifyBytes']>();
  const system = jest.fn<GpgClient['verify']>();
  const verifier = new PluginSignatureVerifier({ verifyBytes: vendor, }, { verify: system, });

  beforeEach(() => {
    vendor.mockReset().mockRejectedValue(new SignatureUnknownSignerError('unknown'));
    system.mockReset().mockResolvedValue({ status: 'unverified', reason: 'unknown-key', });
  });

  it('reports missing signatures without invoking either backend', async () => {
    expect(await verifier.verify(bytes)).toEqual({ status: 'unsigned', });
    expect(vendor).not.toHaveBeenCalled();
    expect(system).not.toHaveBeenCalled();
  });

  it('accepts pinned vendor signatures without GnuPG', async () => {
    vendor.mockResolvedValue(fingerprint);
    expect(await verifier.verify(bytes, signature)).toEqual({ status: 'verified', source: 'vendor', signerFingerprint: fingerprint, });
    expect(vendor).toHaveBeenCalledWith(bytes, signature);
    expect(system).not.toHaveBeenCalled();
  });

  it('accepts a trusted system signature', async () => {
    system.mockResolvedValue({ status: 'verified', signerFingerprint: fingerprint, identityValidity: 'full', });
    expect(await verifier.verify(bytes, signature)).toEqual({ status: 'verified', source: 'system', signerFingerprint: fingerprint, });
    expect(system).toHaveBeenCalledWith(bytes, signature);
  });

  it('accepts a pinned signature under vendor-only verification', async () => {
    vendor.mockResolvedValue(fingerprint);
    expect(await verifier.verify(bytes, signature, { vendorOnly: true, })).toEqual({
      status: 'verified', source: 'vendor', signerFingerprint: fingerprint,
    });
    expect(system).not.toHaveBeenCalled();
  });

  it('reports a missing vendor-only signature without invoking a backend', async () => {
    expect(await verifier.verify(bytes, undefined, { vendorOnly: true, })).toEqual({ status: 'unsigned', });
    expect(vendor).not.toHaveBeenCalled();
    expect(system).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown-vendor', new SignatureUnknownSignerError('unknown'),],
    ['invalid', new SignatureInvalidError(),],
    ['expired', new SignatureKeyValidityError('expired'),],
    ['revoked', new SignatureKeyValidityError('revoked'),],
  ] as const)('rejects %s vendor-only verification without consulting a trusted system key', async (reason, error) => {
    vendor.mockRejectedValue(error);
    system.mockResolvedValue({ status: 'verified', signerFingerprint: fingerprint, identityValidity: 'ultimate', });
    expect(await verifier.verify(bytes, signature, { vendorOnly: true, })).toEqual({ status: 'unverified', reason, });
    expect(system).not.toHaveBeenCalled();
  });

  it('propagates broken embedded keys under vendor-only verification', async () => {
    const failure = new SignaturePublicKeyLoadError(fingerprint);
    vendor.mockRejectedValue(failure);
    await expect(verifier.verify(bytes, signature, { vendorOnly: true, })).rejects.toBe(failure);
    expect(system).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'marginal', 'never',] as const)('preserves valid signatures with %s identity validity', async (identityValidity) => {
    const result = { status: 'untrusted', signerFingerprint: fingerprint, identityValidity, } as const;
    system.mockResolvedValue(result);
    expect(await verifier.verify(bytes, signature)).toEqual(result);
  });

  it.each(['invalid', 'unknown-key', 'expired', 'revoked', 'unavailable', 'verification-error',] as const)
    ('preserves the system failure reason %s', async (reason) => {
      vendor.mockRejectedValue(new SignatureInvalidError());
      system.mockResolvedValue({ status: 'unverified', reason, });
      expect(await verifier.verify(bytes, signature)).toEqual({ status: 'unverified', reason, });
    });

  it.each(['expired', 'revoked',] as const)('does not bypass known %s vendor keys through the local keyring', async (reason) => {
    vendor.mockRejectedValue(new SignatureKeyValidityError(reason));
    expect(await verifier.verify(bytes, signature)).toEqual({ status: 'unverified', reason, });
    expect(system).not.toHaveBeenCalled();
  });

  it.each([false, true,])('does not fall back to a stale local key after real subkey revocation (vendorOnly: %s)', async (vendorOnly) => {
    const keys = await openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', subkeys: [{ sign: true, },],
      userIDs: [{ name: 'Revoked vendor subkey', },],
    });
    const detached = await openpgp.sign({
      message: await openpgp.createMessage({ binary: bytes, }), signingKeys: keys.privateKey,
      detached: true, format: 'armored',
    });
    keys.publicKey.subkeys[0] = await keys.publicKey.subkeys[0]!.revoke(keys.privateKey.keyPacket);
    const pinned = new SignatureVerifier(new Logger(new Config()), {
      readFile: async () => { throw new Error('Unexpected signature file read.'); },
    }, [{ fingerprint: keys.publicKey.getFingerprint(), armoredPublicKey: keys.publicKey.armor(), },]);
    const guarded = new PluginSignatureVerifier(pinned, { verify: system, });
    system.mockResolvedValue({ status: 'verified', signerFingerprint: fingerprint, identityValidity: 'ultimate', });

    expect(await guarded.verify(bytes, Buffer.from(detached), { vendorOnly, })).toEqual({ status: 'unverified', reason: 'revoked', });
    expect(system).not.toHaveBeenCalled();
  });

  it('propagates bundled key configuration errors', async () => {
    const failure = new SignaturePublicKeyLoadError(fingerprint);
    vendor.mockRejectedValue(failure);
    await expect(verifier.verify(bytes, signature)).rejects.toBe(failure);
    expect(system).not.toHaveBeenCalled();
  });
});
