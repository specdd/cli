import {
  createMessage,
  readKey,
  readSignature,
  verify,
  type PublicKey,
  type Signature,
} from 'openpgp';
import { CliError } from '../../cli-error.js';
import type { FileReaderDependency } from '../../infrastructure/file-system.js';
import type { Logger } from '../logger/logger.js';
import {
  TRUSTED_RELEASE_SIGNING_KEYS,
  type TrustedReleaseSigningKey,
} from './trusted-keys.js';

export type SignatureVerificationRequest = {
  zipPath: string;
  signaturePath: string;
};

export type SignatureVerificationResult = {
  zipPath: string;
  signaturePath: string;
  signerFingerprint: string;
};

type LoadedTrustedKey = {
  fingerprint: string;
  keyIds: readonly string[];
  publicKey: PublicKey;
};

export class SignatureInputNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Signature input file not found: ${path}`);
    this.name = 'SignatureInputNotFoundError';
  }
}

export class SignaturePublicKeyLoadError extends CliError {
  public constructor(fingerprint: string) {
    super(`Failed to load trusted SpecDD signing public key: ${fingerprint}`);
    this.name = 'SignaturePublicKeyLoadError';
  }
}

export class SignatureUnknownSignerError extends CliError {
  public constructor(signerKeyId: string) {
    super(`SpecDD distribution signature was made by an unknown signer: ${signerKeyId}`);
    this.name = 'SignatureUnknownSignerError';
  }
}

export class SignatureInvalidError extends CliError {
  public constructor() {
    super('SpecDD distribution signature is invalid.');
    this.name = 'SignatureInvalidError';
  }
}

export class SignatureVerificationError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'SignatureVerificationError';
  }
}

export class SignatureVerifier {
  private readonly logger: Logger;

  private readonly fileSystem: FileReaderDependency;

  private readonly trustedKeys: readonly TrustedReleaseSigningKey[];

  private readonly textDecoder = new TextDecoder();

  public constructor(
    logger: Logger,
    fileSystem: FileReaderDependency,
    trustedKeys: readonly TrustedReleaseSigningKey[] = TRUSTED_RELEASE_SIGNING_KEYS,
  ) {
    this.logger = logger;
    this.fileSystem = fileSystem;
    this.trustedKeys = trustedKeys;
  }

  public async verifyDistribution(
    request: SignatureVerificationRequest,
  ): Promise<SignatureVerificationResult> {
    this.logger.debug(`Verifying SpecDD distribution signature for ${request.zipPath}.`);

    const zipBytes = await this.readInputFile(request.zipPath);
    const signatureBytes = await this.readInputFile(request.signaturePath);
    const signature = await this.readSignature(signatureBytes);
    const trustedKeys = await this.loadTrustedKeys();
    const signer = this.findTrustedSigner(signature, trustedKeys);

    await this.verifyDetachedSignature(zipBytes, signature, signer.publicKey);

    this.logger.info(`Verified SpecDD distribution signature from ${signer.fingerprint}.`);

    return {
      signaturePath: request.signaturePath,
      signerFingerprint: signer.fingerprint,
      zipPath: request.zipPath,
    };
  }

  private async readInputFile(path: string): Promise<Uint8Array> {
    try {
      return await this.fileSystem.readFile(path);
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        throw new SignatureInputNotFoundError(path);
      }

      throw new SignatureVerificationError(String(error));
    }
  }

  private isFileNotFoundError(error: unknown): boolean {
    return error instanceof Error && 'ENOENT' === (error as NodeJS.ErrnoException).code;
  }

  private async readSignature(signatureBytes: Uint8Array): Promise<Signature> {
    try {
      return await readSignature({
        armoredSignature: this.textDecoder.decode(signatureBytes),
      });
    } catch {
      throw new SignatureInvalidError();
    }
  }

  private async loadTrustedKeys(): Promise<LoadedTrustedKey[]> {
    const loadedKeys: LoadedTrustedKey[] = [];

    for (const trustedKey of this.trustedKeys) {
      loadedKeys.push(await this.loadTrustedKey(trustedKey));
    }

    return loadedKeys;
  }

  private async loadTrustedKey(trustedKey: TrustedReleaseSigningKey): Promise<LoadedTrustedKey> {
    const expectedFingerprint = this.normalizeFingerprint(trustedKey.fingerprint);
    let publicKey: PublicKey;

    try {
      publicKey = (await readKey({
        armoredKey: trustedKey.armoredPublicKey,
      })).toPublic();
    } catch {
      throw new SignaturePublicKeyLoadError(expectedFingerprint);
    }

    const fingerprint = this.normalizeFingerprint(publicKey.getFingerprint());

    if (expectedFingerprint !== fingerprint) {
      throw new SignaturePublicKeyLoadError(expectedFingerprint);
    }

    return {
      fingerprint,
      keyIds: publicKey.getKeyIDs().map((keyId) => keyId.toHex().toLowerCase()),
      publicKey,
    };
  }

  private findTrustedSigner(signature: Signature, trustedKeys: readonly LoadedTrustedKey[]): LoadedTrustedKey {
    const signingKeyIds = signature.getSigningKeyIDs().map((keyId) => keyId.toHex().toLowerCase());
    const signer = trustedKeys.find((trustedKey) => {
      return trustedKey.keyIds.some((keyId) => signingKeyIds.includes(keyId));
    });

    if (undefined === signer) {
      throw new SignatureUnknownSignerError(signingKeyIds.join(', '));
    }

    return signer;
  }

  private async verifyDetachedSignature(
    zipBytes: Uint8Array,
    signature: Signature,
    publicKey: PublicKey,
  ): Promise<void> {
    try {
      const message = await createMessage({
        binary: zipBytes,
      });
      const verification = await verify({
        expectSigned: true,
        format: 'binary',
        message,
        signature,
        verificationKeys: publicKey,
      });

      await verification.signatures[0]!.verified;
    } catch {
      throw new SignatureInvalidError();
    }
  }

  private normalizeFingerprint(fingerprint: string): string {
    return fingerprint.replaceAll(' ', '').toLowerCase();
  }
}
