import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { ensureDevelopmentEncryptionKey } from './development-encryption.js';

describe('local development encryption', () => {
  it('creates and reuses a private key in the ignored data directory', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-key-'));
    const config = loadConfig({ NODE_ENV: 'development', DATA_DIR: dataDir });
    const first = ensureDevelopmentEncryptionKey(config);
    const second = ensureDevelopmentEncryptionKey(config);
    const keyPath = path.join(dataDir, 'development-encryption-key');

    expect(first.encryptionKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(second.encryptionKey).toBe(first.encryptionKey);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('does not invent keys for test mode', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(ensureDevelopmentEncryptionKey(config).encryptionKey).toBeNull();
  });
});
