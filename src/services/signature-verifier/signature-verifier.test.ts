import * as openpgp from 'openpgp';
import type { FileReaderDependency } from '../../infrastructure/file-system.js';
import { Config } from '../config/config.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import {
  SignatureInputNotFoundError,
  SignatureInvalidError,
  SignatureKeyValidityError,
  SignaturePublicKeyLoadError,
  SignatureUnknownSignerError,
  SignatureVerificationError,
  SignatureVerifier,
} from './signature-verifier.js';
import type { TrustedReleaseSigningKey } from './trusted-keys.js';

type SigningFixture = {
  signature: string;
  trustedKey: TrustedReleaseSigningKey;
};

class MemoryStream implements LoggerStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

class MemoryFileSystem implements FileReaderDependency {
  private readonly files: ReadonlyMap<string, Uint8Array>;

  public constructor(files: ReadonlyMap<string, Uint8Array>) {
    this.files = files;
  }

  public async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);

    if (undefined === file) {
      const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';

      throw error;
    }

    return file;
  }
}

class ThrowingFileSystem implements FileReaderDependency {
  public async readFile(_path: string): Promise<Uint8Array> {
    throw new Error('read failed');
  }
}

const textEncoder = new TextEncoder();
const zipPath = '/tmp/specdd.zip';
const signaturePath = '/tmp/specdd.zip.asc';
const zipBytes = textEncoder.encode('zip-content');

const createLogger = (): { logger: Logger; stdout: MemoryStream } => {
  const stdout = new MemoryStream();
  const logger = new Logger(new Config(), {
    colorLevel: 0,
    stdout,
  });

  return {
    logger,
    stdout,
  };
};

const createSigningFixture = async (signedBytes: Uint8Array = zipBytes): Promise<SigningFixture> => {
  const keyPair = await openpgp.generateKey({
    curve: 'ed25519Legacy',
    format: 'object',
    type: 'ecc',
    userIDs: [
      {
        email: 'test@example.test',
        name: 'Test',
      },
    ],
  });
  const message = await openpgp.createMessage({
    binary: signedBytes,
  });
  const signature = await openpgp.sign({
    detached: true,
    format: 'armored',
    message,
    signingKeys: keyPair.privateKey,
  });

  return {
    signature,
    trustedKey: {
      armoredPublicKey: keyPair.publicKey.armor(),
      fingerprint: keyPair.publicKey.getFingerprint(),
    },
  };
};

const createFileSystem = (
  signature: string,
  distributionBytes: Uint8Array = zipBytes,
): MemoryFileSystem => {
  return new MemoryFileSystem(new Map([
    [zipPath, distributionBytes],
    [signaturePath, textEncoder.encode(signature)],
  ]));
};

describe('SignatureVerifier', () => {
  it('verifies exact plugin bytes through the byte-oriented API', async () => {
    const bytes = new Uint8Array([0, 35, 13, 10, 255,]);
    const fixture = await createSigningFixture(bytes);
    const verifier = new SignatureVerifier(createLogger().logger, new ThrowingFileSystem(), [fixture.trustedKey,]);
    expect(await verifier.verifyBytes(bytes, textEncoder.encode(fixture.signature))).toBe(fixture.trustedKey.fingerprint);
    await expect(verifier.verifyBytes(new Uint8Array([0, 35, 10, 255,]), textEncoder.encode(fixture.signature)))
      .rejects.toBeInstanceOf(SignatureInvalidError);
  });

  it('accepts a trusted signature after an unknown signature in the same detached message', async () => {
    const keys = await Promise.all([1, 2,].map(async (number) => openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', userIDs: [{ name: `Fixture ${number}`, },],
    })));
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: zipBytes, }), signingKeys: keys.map((key) => key.privateKey),
      detached: true, format: 'armored',
    });
    const trusted = keys[1]!.publicKey;
    const verifier = new SignatureVerifier(createLogger().logger, new ThrowingFileSystem(), [{
      fingerprint: trusted.getFingerprint(), armoredPublicKey: trusted.armor(),
    },]);
    expect(await verifier.verifyBytes(zipBytes, textEncoder.encode(signature))).toBe(trusted.getFingerprint());
  });

  it.each(['expired', 'revoked',] as const)('rejects a cryptographically valid signature from an %s bundled key', async (reason) => {
    const date = new Date('2020-01-01T00:00:00Z');
    const keys = await openpgp.generateKey({
      date, keyExpirationTime: 'expired' === reason ? 60 : 0,
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', userIDs: [{ name: 'Old signer', },],
    });
    const signature = await openpgp.sign({
      date: new Date(date.getTime() + 30_000), message: await openpgp.createMessage({ binary: zipBytes, }),
      signingKeys: keys.privateKey, detached: true, format: 'armored',
    });
    const publicKey = 'revoked' === reason
      ? (await openpgp.revokeKey({ key: keys.publicKey, revocationCertificate: keys.revocationCertificate, format: 'object', })).publicKey
      : keys.publicKey;
    const verifier = new SignatureVerifier(createLogger().logger, new ThrowingFileSystem(), [{
      fingerprint: publicKey.getFingerprint(), armoredPublicKey: publicKey.armor(),
    },]);
    await expect(verifier.verifyBytes(zipBytes, textEncoder.encode(signature))).rejects.toEqual(new SignatureKeyValidityError(reason));
  });

  it('reports expiration of a signing subkey even when the primary key remains valid', async () => {
    const date = new Date('2020-01-01T00:00:00Z');
    const keys = await openpgp.generateKey({
      date, subkeys: [{ sign: true, keyExpirationTime: 60, },],
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', userIDs: [{ name: 'Subkey signer', },],
    });
    const signature = await openpgp.sign({
      date: new Date(date.getTime() + 30_000), message: await openpgp.createMessage({ binary: zipBytes, }),
      signingKeys: keys.privateKey, detached: true, format: 'armored',
    });
    const verifier = new SignatureVerifier(createLogger().logger, new ThrowingFileSystem(), [{
      fingerprint: keys.publicKey.getFingerprint(), armoredPublicKey: keys.publicKey.armor(),
    },]);
    await expect(verifier.verifyBytes(zipBytes, textEncoder.encode(signature))).rejects.toEqual(new SignatureKeyValidityError('expired'));
  });

  it.each(['bytes', 'distribution',])('preserves signing-subkey revocation during %s verification', async (api) => {
    const keys = await openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', subkeys: [{ sign: true, },],
      userIDs: [{ name: 'Revoked subkey signer', },],
    });
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: zipBytes, }), signingKeys: keys.privateKey,
      detached: true, format: 'armored',
    });
    keys.publicKey.subkeys[0] = await keys.publicKey.subkeys[0]!.revoke(keys.privateKey.keyPacket);
    const verifier = new SignatureVerifier(createLogger().logger, createFileSystem(signature), [{
      fingerprint: keys.publicKey.getFingerprint(), armoredPublicKey: keys.publicKey.armor(),
    },]);
    const result = 'bytes' === api
      ? verifier.verifyBytes(zipBytes, textEncoder.encode(signature))
      : verifier.verifyDistribution({ zipPath, signaturePath, });
    await expect(result).rejects.toEqual(new SignatureKeyValidityError('revoked'));
  });

  it('accepts an eligible sibling subkey when another co-signing subkey is revoked', async () => {
    const keys = await openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', subkeys: [{ sign: true, }, { sign: true, },],
      userIDs: [{ name: 'Rotated subkey signer', },],
    });
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: zipBytes, }),
      signingKeys: [keys.privateKey, keys.privateKey,], signingKeyIDs: keys.privateKey.getKeyIDs().slice(1),
      detached: true, format: 'armored',
    });
    keys.publicKey.subkeys[0] = await keys.publicKey.subkeys[0]!.revoke(keys.privateKey.keyPacket);
    const verifier = new SignatureVerifier(createLogger().logger, new ThrowingFileSystem(), [{
      fingerprint: keys.publicKey.getFingerprint(), armoredPublicKey: keys.publicKey.armor(),
    },]);
    expect(await verifier.verifyBytes(zipBytes, textEncoder.encode(signature))).toBe(keys.publicKey.getFingerprint());
    await expect(verifier.verifyBytes(textEncoder.encode('altered bytes'), textEncoder.encode(signature))).rejects.toThrow();
  });

  it('accepts a rotated vendor key when the first co-signer uses a revoked subkey', async () => {
    const keys = await Promise.all([1, 2,].map(async (number) => openpgp.generateKey({
      type: 'ecc', curve: 'ed25519Legacy', format: 'object', subkeys: [{ sign: true, },],
      userIDs: [{ name: `Rotated vendor ${number}`, },],
    })));
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: zipBytes, }), signingKeys: keys.map((key) => key.privateKey),
      detached: true, format: 'armored',
    });
    const first = keys[0]!;
    first.publicKey.subkeys[0] = await first.publicKey.subkeys[0]!.revoke(first.privateKey.keyPacket);
    const verifier = new SignatureVerifier(createLogger().logger, new ThrowingFileSystem(), keys.map((key) => ({
      fingerprint: key.publicKey.getFingerprint(), armoredPublicKey: key.publicKey.armor(),
    })));
    expect(await verifier.verifyBytes(zipBytes, textEncoder.encode(signature))).toBe(keys[1]!.publicKey.getFingerprint());
  });

  it('verifies a detached distribution signature from a trusted key', async () => {
    const fixture = await createSigningFixture();
    const fileSystem = createFileSystem(fixture.signature);
    const { logger, stdout } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [fixture.trustedKey]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).resolves.toEqual({
      signaturePath,
      signerFingerprint: fixture.trustedKey.fingerprint,
      zipPath,
    });
    expect(stdout.messages).toEqual([
      `[info] Verified SpecDD distribution signature from ${fixture.trustedKey.fingerprint}.\n`,
    ]);
  });

  it('raises when the zip file is missing', async () => {
    const fixture = await createSigningFixture();
    const fileSystem = new MemoryFileSystem(new Map([
      [signaturePath, textEncoder.encode(fixture.signature)],
    ]));
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [fixture.trustedKey]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignatureInputNotFoundError);
  });

  it('raises when the signature file is missing', async () => {
    const fixture = await createSigningFixture();
    const fileSystem = new MemoryFileSystem(new Map([
      [zipPath, zipBytes],
    ]));
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [fixture.trustedKey]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignatureInputNotFoundError);
  });

  it('raises when an input file cannot be read', async () => {
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, new ThrowingFileSystem(), []);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignatureVerificationError);
  });

  it('raises when the detached signature is malformed', async () => {
    const fileSystem = createFileSystem('not a pgp signature');
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, []);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignatureInvalidError);
  });

  it('raises when a bundled public key cannot be loaded', async () => {
    const fixture = await createSigningFixture();
    const fileSystem = createFileSystem(fixture.signature);
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [
      {
        armoredPublicKey: 'not a pgp public key',
        fingerprint: fixture.trustedKey.fingerprint,
      },
    ]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignaturePublicKeyLoadError);
  });

  it('raises when a bundled public key does not match its pinned fingerprint', async () => {
    const fixture = await createSigningFixture();
    const fileSystem = createFileSystem(fixture.signature);
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [
      {
        armoredPublicKey: fixture.trustedKey.armoredPublicKey,
        fingerprint: '0000000000000000000000000000000000000000',
      },
    ]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignaturePublicKeyLoadError);
  });

  it('raises when the signature is made by an untrusted key', async () => {
    const signerFixture = await createSigningFixture();
    const trustedFixture = await createSigningFixture();
    const fileSystem = createFileSystem(signerFixture.signature);
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [trustedFixture.trustedKey]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignatureUnknownSignerError);
  });

  it('raises when the detached signature does not match the zip bytes', async () => {
    const fixture = await createSigningFixture();
    const fileSystem = createFileSystem(fixture.signature, textEncoder.encode('tampered-content'));
    const { logger } = createLogger();
    const verifier = new SignatureVerifier(logger, fileSystem, [fixture.trustedKey]);

    await expect(verifier.verifyDistribution({
      signaturePath,
      zipPath,
    })).rejects.toBeInstanceOf(SignatureInvalidError);
  });
});
