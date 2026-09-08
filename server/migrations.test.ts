import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { currentSchemaVersion, runMigrations } from './migrations.js';

describe('database migrations', () => {
  it('applies every migration once and records the current version', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');

    runMigrations(database);
    runMigrations(database);

    expect(currentSchemaVersion(database)).toEqual({ version: 6 });
    expect(database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'passkey_management_and_recovery' },
      { version: 3, name: 'durable_highlight_anchors' },
      { version: 4, name: 'transactional_reader_cache' },
      { version: 5, name: 'incremental_reader_checkpoints' },
      { version: 6, name: 'paginated_reader_api' },
    ]);
    expect(database.prepare("PRAGMA table_info('passkey_credentials')").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'name' })]),
    );
    expect(database.prepare("PRAGMA table_info('highlights')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'start_offset' }),
        expect.objectContaining({ name: 'end_offset' }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info('reader_cache_generations')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'status' }),
        expect.objectContaining({ name: 'fence_token' }),
        expect.objectContaining({ name: 'collection_version' }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info('reader_incremental_checkpoints')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'routine_cutoff_seconds' }),
        expect.objectContaining({ name: 'last_state_at' }),
        expect.objectContaining({ name: 'last_full_at' }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info('reader_change_log')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sequence' }),
        expect.objectContaining({ name: 'payload_json' }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info('reader_navigation_activity')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'kind' }),
        expect.objectContaining({ name: 'latest_published_at' }),
      ]),
    );
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reader_article_search'").get())
      .toEqual({ name: 'reader_article_search' });
  });

  it('upgrades a legacy version-one database without losing existing rows', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('user-1', 'Paul', '2026-09-07T00:00:00.000Z');
    `);

    runMigrations(database);

    expect(database.prepare('SELECT id, display_name FROM users').get()).toEqual({ id: 'user-1', display_name: 'Paul' });
    expect(currentSchemaVersion(database)).toEqual({ version: 6 });
  });
});
