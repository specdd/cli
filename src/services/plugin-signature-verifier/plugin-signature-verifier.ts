import type { GpgClient, GpgVerificationResult } from '../../infrastructure/gpg-client.js';
import {
  SignatureInvalidError,
  SignatureKeyValidityError,
  SignatureUnknownSignerError,
  type SignatureVerifier,
} from '../signature-verifier/signature-verifier.js';

export type PluginSignatureResult = {
  readonly status: 'verified';
  readonly source: 'vendor' | 'system';
  readonly signerFingerprint: string;
} | { readonly status: 'unsigned' }
  | { readonly status: 'unverified'; readonly reason: 'unknown-vendor' }
  | Exclude<GpgVerificationResult, { status: 'verified' }>;

export type PluginSignatureVerificationOptions = {
  readonly vendorOnly?: boolean;
};

export class PluginSignatureVerifier {
  public constructor(
    private readonly vendor: Pick<SignatureVerifier, 'verifyBytes'>,
    private readonly system: Pick<GpgClient, 'verify'>,
  ) {}

  public async verify(
    bytes: Uint8Array,
    signature?: Uint8Array,
    options: PluginSignatureVerificationOptions = {},
  ): Promise<PluginSignatureResult> {
    if (undefined === signature) {
      return { status: 'unsigned', };
    }

    try {
      const signerFingerprint = await this.vendor.verifyBytes(bytes, signature);
      return { status: 'verified', source: 'vendor', signerFingerprint, };
    } catch (error) {
      if (error instanceof SignatureKeyValidityError) {
        return { status: 'unverified', reason: error.reason, };
      }

      if (!(error instanceof SignatureUnknownSignerError) && !(error instanceof SignatureInvalidError)) {
        throw error;
      }

      if (options.vendorOnly) {
        return { status: 'unverified', reason: error instanceof SignatureUnknownSignerError ? 'unknown-vendor' : 'invalid', };
      }
    }

    const result = await this.system.verify(bytes, signature);

    if ('verified' === result.status) {
      return { status: 'verified', source: 'system', signerFingerprint: result.signerFingerprint, };
    }

    return result;
  }
}
