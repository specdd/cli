export type KeyID = {
  toHex(): string;
};

export type PublicKey = {
  armor(): string;
  getFingerprint(): string;
  getKeyIDs(): KeyID[];
  toPublic(): PublicKey;
};

export type PrivateKey = PublicKey;

export type Key = PublicKey;

export type Signature = {
  getSigningKeyIDs(): KeyID[];
};

export type Message = unknown;

export type VerificationResult = {
  signatures: Array<{
    verified: Promise<true>;
  }>;
};

export type KeyPair = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
  revocationCertificate: string;
};

export type UserID = {
  email?: string;
  name?: string;
};

export type GenerateKeyOptions = {
  curve?: 'ed25519Legacy';
  format: 'object';
  type?: 'ecc';
  userIDs: UserID[];
};

export type SignOptions = {
  detached: true;
  format: 'armored';
  message: Message;
  signingKeys: PrivateKey;
};

export type VerifyOptions = {
  expectSigned?: boolean;
  format: 'binary';
  message: Message;
  signature: Signature;
  verificationKeys: PublicKey;
};

export function createMessage(options: { binary: Uint8Array }): Promise<Message>;

export function generateKey(options: GenerateKeyOptions): Promise<KeyPair>;

export function readKey(options: { armoredKey: string }): Promise<Key>;

export function readSignature(options: { armoredSignature: string }): Promise<Signature>;

export function sign(options: SignOptions): Promise<string>;

export function verify(options: VerifyOptions): Promise<VerificationResult>;
