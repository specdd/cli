import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { CliError } from '../cli-error.js';
import type { FileSystem } from './file-system.js';
import type { TempDirectory } from './temp-directory.js';

export type GpgIdentityValidity = 'unknown' | 'marginal' | 'never' | 'full' | 'ultimate';
export type GpgFailureReason = 'unknown-key' | 'invalid' | 'expired' | 'revoked' | 'unavailable' | 'verification-error';
type GpgSigner = {
  readonly signerFingerprint: string;
  readonly identityValidity: GpgIdentityValidity;
};
export type GpgVerificationResult = (GpgSigner & { readonly status: 'verified' })
  | (GpgSigner & { readonly status: 'untrusted' }) | {
  readonly status: 'unverified';
  readonly reason: GpgFailureReason;
};

export type GpgProcessResult = {
  readonly stdout: Uint8Array;
  readonly exitCode: number;
};

export type GpgProcessRunner = (args: readonly string[]) => Promise<GpgProcessResult>;

const runGpg: GpgProcessRunner = async (args) => {
  return new Promise((resolve, reject) => {
    execFile('gpg', [...args,], {
      encoding: 'buffer', env: process.env, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error && ('number' !== typeof error.code || error.killed)) {
        reject(error);
        return;
      }

      resolve({ stdout, exitCode: error && 'number' === typeof error.code ? error.code : 0, });
    });
  });
};

export class GpgClientError extends CliError {
  public constructor(message: string) {
    super(message);
    this.name = 'GpgClientError';
  }
}

type SignatureStatus = {
  fingerprint?: string;
  good: boolean;
  identityValidity: GpgIdentityValidity;
  failure?: GpgFailureReason;
};

export class GpgClient {
  public constructor(
    private readonly fileSystem: Pick<FileSystem, 'writeFile' | 'removePath'>,
    private readonly tempDirectory: Pick<TempDirectory, 'create'>,
    private readonly run: GpgProcessRunner = runGpg,
  ) {}

  public async verify(bytes: Uint8Array, signature: Uint8Array): Promise<GpgVerificationResult> {
    let directory: string | undefined;
    let result: GpgVerificationResult | undefined;
    let failure: unknown;

    try {
      directory = await this.tempDirectory.create('specdd-gpg-');
      const dataPath = join(directory, 'data');
      const signaturePath = join(directory, 'signature.asc');
      await this.fileSystem.writeFile(dataPath, bytes);
      await this.fileSystem.writeFile(signaturePath, signature);

      try {
        result = this.parse(await this.run([
          '--batch', '--no-tty', '--no-auto-key-retrieve', '--no-auto-key-import',
          '--no-auto-key-locate', '--no-auto-check-trustdb', '--status-fd=1',
          '--verify', '--', signaturePath, dataPath,
        ]));
      } catch (error) {
        const unavailable = 'object' === typeof error && null !== error && 'code' in error && 'ENOENT' === error.code;
        result = { status: 'unverified', reason: unavailable ? 'unavailable' : 'verification-error', };
      }
    } catch (error) {
      failure = error;
    }

    if (undefined !== directory) {
      try {
        await this.fileSystem.removePath(directory, { recursive: true, });
      } catch (error) {
        const original = undefined === failure ? '' : `${String(failure)}; `;
        failure = new Error(`${original}Temporary signature file cleanup failed: ${String(error)}`);
      }
    }

    if (undefined !== failure || undefined === result) {
      throw new GpgClientError(`System signature verification failed: ${String(failure)}`);
    }

    return result;
  }

  private parse(output: GpgProcessResult): GpgVerificationResult {
    const signatures: SignatureStatus[] = [];
    let current: SignatureStatus = { good: false, identityValidity: 'unknown', };
    signatures.push(current);
    let processFailure = false;

    for (const line of Buffer.from(output.stdout).toString('utf8').split(/\r?\n/)) {
      const match = /^\[GNUPG:\] ([A-Z_]+)(?: (.*))?$/.exec(line);

      if (!match) {
        continue;
      }

      const status = match[1]!;
      const fields = (match[2] ?? '').split(' ');

      switch (status) {
        case 'NEWSIG':
          current = { good: false, identityValidity: 'unknown', };
          signatures.push(current);
          break;
        case 'GOODSIG':
          current.good = true;
          break;
        case 'VALIDSIG':
          if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(fields[0]!)) {
            current.fingerprint = fields[0]!.toLowerCase();
          }
          break;
        case 'TRUST_FULLY': current.identityValidity = 'full'; break;
        case 'TRUST_ULTIMATE': current.identityValidity = 'ultimate'; break;
        case 'TRUST_MARGINAL': current.identityValidity = 'marginal'; break;
        case 'TRUST_NEVER': current.identityValidity = 'never'; break;
        case 'TRUST_UNDEFINED': current.identityValidity = 'unknown'; break;
        case 'REVKEYSIG': current.failure = 'revoked'; break;
        case 'EXPKEYSIG':
        case 'EXPSIG': current.failure = 'expired'; break;
        case 'BADSIG':
        case 'NODATA': current.failure = 'invalid'; break;
        case 'NO_PUBKEY': current.failure = 'unknown-key'; break;
        case 'ERRSIG': current.failure = '9' === fields[5] ? 'unknown-key' : 'verification-error'; break;
        case 'FAILURE':
        case 'ERROR': processFailure = true; break;
      }
    }

    if (0 === output.exitCode && !processFailure) {
      const usable = signatures.filter((signature) => signature.good && signature.fingerprint && !signature.failure);
      const trusted = usable.find((signature) => ['full', 'ultimate',].includes(signature.identityValidity));
      const signer = trusted ?? usable[0];

      if (signer) {
        return {
          status: trusted ? 'verified' : 'untrusted',
          signerFingerprint: signer.fingerprint!,
          identityValidity: signer.identityValidity,
        };
      }
    }

    const reasons: readonly GpgFailureReason[] = ['revoked', 'expired', 'invalid', 'unknown-key',];
    return {
      status: 'unverified',
      reason: reasons.find((reason) => signatures.some((signature) => reason === signature.failure)) ?? 'verification-error',
    };
  }
}
