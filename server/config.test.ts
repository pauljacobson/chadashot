import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses the local development identity outside production', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.authMode).toBe('development');
    expect(config.logOutput).toBe('both');
    expect(config.logFilePath).toBe(`${config.dataDir}/logs/app.ndjson`);
    expect(config.readerSyncTimeoutMs).toBe(120_000);
    expect(config.readerCacheEnabled).toBe(true);
    expect(config.readerSyncLeaseMs).toBe(45_000);
    expect(config.readerCacheRefreshIntervalMs).toBe(180_000);
  });

  it('keeps the migrated schema while allowing the legacy reader path to be selected', () => {
    const config = loadConfig({ NODE_ENV: 'development', READER_CACHE_ENABLED: 'false' });
    expect(config.readerCacheEnabled).toBe(false);
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
