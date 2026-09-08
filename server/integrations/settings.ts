import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import { nowIso } from '../database.js';
import { decryptSecret, encryptSecret } from '../secrets.js';
import { BIRCHFEED_API_URL, type GoogleReaderCredentials } from './google-reader.js';
import type { ReadwiseCredentials } from './readwise.js';

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

export function deleteIntegration(database: AppDatabase, kind: IntegrationKind) {
  return database.prepare('DELETE FROM integrations WHERE kind = ?').run(kind).changes > 0;
}

export function loadBirchfeed(database: AppDatabase, config: AppConfig) {
  return loadBirchfeedWithGeneration(database, config)?.credentials ?? null;
}

export function loadBirchfeedWithGeneration(database: AppDatabase, config: AppConfig) {
  const row = database.prepare('SELECT encrypted_config, updated_at FROM integrations WHERE kind = ?').get('birchfeed') as {
    encrypted_config: string;
    updated_at: string;
  } | undefined;
  if (!row) return null;
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY must be configured before connecting external services');
  const stored = decryptSecret<GoogleReaderCredentials | Omit<GoogleReaderCredentials, 'serverUrl'>>(row.encrypted_config, config.encryptionKey);
  return {
    credentials: { serverUrl: BIRCHFEED_API_URL, ...stored },
    generation: crypto.createHash('sha256').update(row.updated_at).update('\0').update(row.encrypted_config).digest('base64url'),
  };
}

export function loadReadwise(database: AppDatabase, config: AppConfig) {
  return loadIntegration<ReadwiseCredentials>(database, config, 'readwise');
}
