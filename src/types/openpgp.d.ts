export type KeyID = {
  toHex(): string;
};

export type PublicKey = {
  readonly subkeys: Subkey[];
  armor(): string;
  getFingerprint(): string;
  getKeyIDs(): KeyID[];
  toPublic(): PublicKey;
  getKeys(keyID?: KeyID): SigningKey[];
  getSigningKey(keyID?: KeyID): Promise<SigningKey>;
  getExpirationTime(): Promise<Date | number | null>;
  isRevoked(): Promise<boolean>;
};

export type SigningKey = {
  getExpirationTime(): Promise<Date | number | null>;
  isRevoked(): Promise<boolean>;
};

export type Subkey = SigningKey & {
  revoke(primaryKey: PrivateKey['keyPacket']): Promise<Subkey>;
};

export type PrivateKey = PublicKey & {
  readonly keyPacket: unknown;
};

export type Key = PublicKey;

export type Signature = {
  getSigningKeyIDs(): KeyID[];
};

export type Message = unknown;

export type VerificationResult = {
  signatures: Array<{
    keyID: KeyID;
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
  date?: Date;
  keyExpirationTime?: number;
  subkeys?: Array<{ sign?: boolean; keyExpirationTime?: number }>;
  curve?: 'ed25519Legacy';
  format: 'object';
  type?: 'ecc';
  userIDs: UserID[];
};

export type SignOptions = {
  date?: Date;
  detached: true;
  format: 'armored';
  message: Message;
  signingKeys: PrivateKey | PrivateKey[];
  signingKeyIDs?: KeyID[];
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

export function revokeKey(options: {
  key: PublicKey;
  revocationCertificate: string;
  format: 'object';
}): Promise<{ publicKey: PublicKey }>;
