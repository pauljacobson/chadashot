import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses the local development identity outside production', () => {
    const config = loadConfig({ NODE_ENV: 'development' });
    expect(config.authMode).toBe('development');
  });

  it('uses passkeys in production', () => {
    const config = loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://chadashot.app' });
    expect(config.authMode).toBe('passkey');
  });

  it('refuses the development identity in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'development' })).toThrow(
      'AUTH_MODE=development is forbidden in production',
    );
  });
});
