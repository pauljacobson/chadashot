import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, hashOpaqueToken } from './secrets.js';

describe('encrypted integration secrets', () => {
  const key = crypto.randomBytes(32).toString('base64');

  it('round-trips structured credentials without storing plaintext', () => {
    const value = { token: 'private-token', email: 'reader@example.test' };
    const encrypted = encryptSecret(value, key);
    expect(encrypted).not.toContain(value.token);
    expect(decryptSecret(encrypted, key)).toEqual(value);
  });

  it('rejects an incorrect key', () => {
    const encrypted = encryptSecret({ token: 'private-token' }, key);
    const otherKey = crypto.randomBytes(32).toString('base64');
    expect(() => decryptSecret(encrypted, otherKey)).toThrow();
  });

  it('hashes session tokens before persistence', () => {
    expect(hashOpaqueToken('session-token')).not.toContain('session-token');
    expect(hashOpaqueToken('session-token')).toBe(hashOpaqueToken('session-token'));
  });
});
