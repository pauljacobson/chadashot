import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses the local development identity outside production', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.authMode).toBe('development');
    expect(config.logOutput).toBe('both');
    expect(config.logFilePath).toBe(`${config.dataDir}/logs/app.ndjson`);
    expect(config.s3Backup).toBeNull();
  });

  it('accepts complete S3-compatible backup settings and rejects partial settings', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      BACKUP_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      BACKUP_S3_BUCKET: 'chadashot-backups',
      BACKUP_S3_ACCESS_KEY_ID: 'access-key',
      BACKUP_S3_SECRET_ACCESS_KEY: 'secret-key',
      BACKUP_S3_PREFIX: '/private/chadashot/',
    });
    expect(config.s3Backup).toMatchObject({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'chadashot-backups',
      prefix: 'private/chadashot',
      intervalHours: 24,
    });
    expect(() => loadConfig({
      NODE_ENV: 'development',
      BACKUP_S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    })).toThrow('S3 backups require endpoint, bucket, access key ID, and secret access key');
  });

  it('uses passkeys in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://chadashot.app',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    });
    expect(config.authMode).toBe('passkey');
    expect(config.relyingPartyId).toBe('chadashot.app');
  });

  it('refuses the development identity in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'development' })).toThrow(
      'AUTH_MODE=development is forbidden in production',
    );
  });

  it('requires a valid encryption key in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://chadashot.app' })).toThrow(
      'ENCRYPTION_KEY is required in production',
    );
    expect(() => loadConfig({
      NODE_ENV: 'production',
      APP_ORIGIN: 'https://chadashot.app',
      ENCRYPTION_KEY: 'too-short',
    })).toThrow('ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64');
  });
});
