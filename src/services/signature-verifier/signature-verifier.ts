import {
  createMessage,
  readKey,
  readSignature,
  verify,
  type PublicKey,
  type Signature,
  type SigningKey,
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

export class SignatureKeyValidityError extends CliError {
  public constructor(public readonly reason: 'expired' | 'revoked') {
    super(`SpecDD signing key is ${reason}.`);
    this.name = 'SignatureKeyValidityError';
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
    const signerFingerprint = await this.verifyBytes(zipBytes, signatureBytes);

    this.logger.info(`Verified SpecDD distribution signature from ${signerFingerprint}.`);

    return {
      signaturePath: request.signaturePath,
      signerFingerprint,
      zipPath: request.zipPath,
    };
  }

  public async verifyBytes(bytes: Uint8Array, signatureBytes: Uint8Array): Promise<string> {
    const signature = await this.readSignature(signatureBytes);
    const trustedKeys = await this.loadTrustedKeys();
    const signingKeyIds = signature.getSigningKeyIDs().map((keyId) => keyId.toHex().toLowerCase());
    const signers = trustedKeys.filter((key) => key.keyIds.some((keyId) => signingKeyIds.includes(keyId)));

    if (0 === signers.length) {
      throw new SignatureUnknownSignerError(signingKeyIds.join(', '));
    }

    let validityError: SignatureKeyValidityError | undefined;

    for (const signer of signers) {
      try {
        await this.verifyDetachedSignature(bytes, signature, signer.publicKey);
        return signer.fingerprint;
      } catch (error) {
        if (error instanceof SignatureKeyValidityError) {
          validityError = error;
        }
      }
    }

    throw validityError ?? new SignatureInvalidError();
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

  private async verifyDetachedSignature(
    zipBytes: Uint8Array,
    signature: Signature,
    publicKey: PublicKey,
  ): Promise<void> {
    try {
      await this.checkKeyValidity(publicKey);
      const message = await createMessage({
        binary: zipBytes,
      });
      const verification = await verify({
        // Check each signature below; early rejection would hide revoked signing subkeys.
        expectSigned: false,
        format: 'binary',
        message,
        signature,
        verificationKeys: publicKey,
      });

      const results = await Promise.allSettled(verification.signatures.map(async (signed) => {
        const key = publicKey.getKeys(signed.keyID)[0];

        if (key) {
          await this.checkKeyValidity(key);
        }

        await signed.verified;
        await publicKey.getSigningKey(signed.keyID);
      }));

      if (results.some((result) => 'fulfilled' === result.status)) {
        return;
      }

      const invalidKey = results.find((result) => 'rejected' === result.status && result.reason instanceof SignatureKeyValidityError);

      if (invalidKey && 'rejected' === invalidKey.status) {
        throw invalidKey.reason;
      }

      throw new SignatureInvalidError();
    } catch (error) {
      if (error instanceof SignatureKeyValidityError) {
        throw error;
      }

      throw new SignatureInvalidError();
    }
  }

  private async checkKeyValidity(key: SigningKey): Promise<void> {
    if (await key.isRevoked()) {
      throw new SignatureKeyValidityError('revoked');
    }

    const expiration = await key.getExpirationTime();

    if (expiration instanceof Date && Date.now() >= expiration.getTime()) {
      throw new SignatureKeyValidityError('expired');
    }
  }

  private normalizeFingerprint(fingerprint: string): string {
    return fingerprint.replaceAll(' ', '').toLowerCase();
  }
}
