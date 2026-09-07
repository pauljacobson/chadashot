import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import { nowIso } from '../database.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import type { GoogleReaderCredentials } from './google-reader.js';

type IntegrationKind = 'birchfeed' | 'readwise';

export function hasIntegration(database: AppDatabase, kind: IntegrationKind) {
  return Boolean(database.prepare('SELECT 1 FROM integrations WHERE kind = ?').get(kind));
}

export function loadIntegration<T>(database: AppDatabase, config: AppConfig, kind: IntegrationKind): T | null {
  const row = database.prepare('SELECT encrypted_config FROM integrations WHERE kind = ?').get(kind) as { encrypted_config: string } | undefined;
  if (!row) return null;
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY must be configured before connecting external services');
  return decryptSecret<T>(row.encrypted_config, config.encryptionKey);
}

export function saveIntegration<T>(database: AppDatabase, config: AppConfig, kind: IntegrationKind, value: T) {
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY must be configured before connecting external services');
  database.prepare(`
    INSERT INTO integrations (kind, encrypted_config, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET encrypted_config = excluded.encrypted_config, updated_at = excluded.updated_at
  `).run(kind, encryptSecret(value, config.encryptionKey), nowIso());
}

export function loadBirchfeed(database: AppDatabase, config: AppConfig) {
  return loadIntegration<GoogleReaderCredentials>(database, config, 'birchfeed');
}
