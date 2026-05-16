import * as openpgp from 'openpgp';
import type { FileReaderDependency } from '../../infrastructure/file-system.js';
import { Config } from '../config/config.js';
import { Logger, type LoggerStream } from '../logger/logger.js';
import {
  SignatureInputNotFoundError,
  SignatureInvalidError,
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
