import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';

const DEVELOPMENT_KEY_FILE = 'development-encryption-key';

function validKey(value: string) {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}

export function ensureDevelopmentEncryptionKey(config: AppConfig): AppConfig {
  if (config.encryptionKey || config.nodeEnv !== 'development') return config;

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(config.dataDir, DEVELOPMENT_KEY_FILE);
  let encryptionKey: string;

  if (fs.existsSync(keyPath)) {
    encryptionKey = fs.readFileSync(keyPath, 'utf8').trim();
    if (!validKey(encryptionKey)) {
      throw new Error(`The local development encryption key at ${keyPath} is invalid`);
    }
  } else {
    encryptionKey = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(keyPath, `${encryptionKey}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }

  return { ...config, encryptionKey };
}
