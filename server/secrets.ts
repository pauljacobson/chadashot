import crypto from 'node:crypto';

type EncryptedEnvelope = {
  version: 1;
  iv: string;
  ciphertext: string;
  tag: string;
};

function decodeKey(encodedKey: string) {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must contain 32 bytes');
  return key;
}

export function encryptSecret(value: unknown, encodedKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', decodeKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    version: 1,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  return JSON.stringify(envelope);
}

export function decryptSecret<T>(encrypted: string, encodedKey: string): T {
  const envelope = JSON.parse(encrypted) as EncryptedEnvelope;
  if (envelope.version !== 1) throw new Error('Unsupported encrypted secret version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', decodeKey(encodedKey), Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')) as T;
}

export function hashOpaqueToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}
