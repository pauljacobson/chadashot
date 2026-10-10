import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { currentSchemaVersion, runMigrations } from './migrations.js';

describe('database migrations', () => {
  it('applies every migration once and records the current version', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');

    runMigrations(database);
    runMigrations(database);

    expect(currentSchemaVersion(database)).toEqual({ version: 12 });
    expect(database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'passkey_management_and_recovery' },
      { version: 3, name: 'durable_highlight_anchors' },
      { version: 4, name: 'transactional_reader_cache' },
      { version: 5, name: 'incremental_reader_checkpoints' },
      { version: 6, name: 'paginated_reader_api' },
      { version: 7, name: 'repair_reader_navigation_activity' },
      { version: 8, name: 'durable_mark_read_jobs' },
      { version: 9, name: 'reader_highlight_delivery' },
      { version: 10, name: 'bounded_reader_cache_generations' },
      { version: 11, name: 'account_preferences' },
      { version: 12, name: 'article_thumbnails' },
    ]);
    expect(database.prepare("PRAGMA table_info('passkey_credentials')").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'name' })]),
    );
    expect(database.prepare("PRAGMA table_info('highlights')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'start_offset' }),
        expect.objectContaining({ name: 'end_offset' }),
        expect.objectContaining({ name: 'reader_document_id' }),
        expect.objectContaining({ name: 'idempotency_key' }),
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
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reader_mark_read_jobs'").get())
      .toEqual({ name: 'reader_mark_read_jobs' });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reader_article_search_keys'").get())
      .toEqual({ name: 'reader_article_search_keys' });
  });

  it('upgrades a legacy version-one database without losing existing rows', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('user-1', 'Paul', '2026-09-07T00:00:00.000Z');
    `);

    runMigrations(database);

    expect(database.prepare('SELECT id, display_name FROM users').get()).toEqual({ id: 'user-1', display_name: 'Paul' });
    expect(currentSchemaVersion(database)).toEqual({ version: 12 });
  });

  it('repairs a database where the paginated migration was recorded without its navigation table', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    runMigrations(database);
    database.exec(`
      DROP TABLE reader_navigation_activity;
      DELETE FROM schema_migrations WHERE version = 7;
    `);

    runMigrations(database);

    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reader_navigation_activity'").get())
      .toEqual({ name: 'reader_navigation_activity' });
    expect(currentSchemaVersion(database)).toEqual({ version: 12 });
  });

  it('preserves every mark-read job and target while removing the physical generation dependency', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');
    runMigrations(database, 9);
    database.exec(`
      INSERT INTO reader_accounts
        (account_key, provider, provider_identity, credential_generation, current_generation_id)
      VALUES ('account', 'google-reader', 'provider', 'credential', NULL);
      INSERT INTO reader_cache_generations
        (id, account_key, generation_number, status, fence_token, started_at, committed_at)
      VALUES ('historical', 'account', 1, 'committed', 1, '2026-09-08T00:00:00.000Z', '2026-09-08T00:01:00.000Z');
      UPDATE reader_accounts SET current_generation_id = 'historical' WHERE account_key = 'account';

      INSERT INTO reader_mark_read_jobs
        (id, account_key, idempotency_key, generation_id, collection_version, state_version_boundary,
          scope_kind, status, target_count, completed_count, superseded_count, attempts, error,
          created_at, started_at, finished_at)
      VALUES
        ('accepted', 'account', 'key-accepted', 'historical', 1, 2, 'all', 'accepted', 2, 0, 0, 0, NULL,
          '2026-09-08T01:00:00.000Z', NULL, NULL),
        ('running', 'account', 'key-running', 'historical', 1, 2, 'all', 'running', 2, 1, 0, 2, NULL,
          '2026-09-08T01:00:00.000Z', '2026-09-08T01:01:00.000Z', NULL),
        ('completed', 'account', 'key-completed', 'historical', 1, 2, 'all', 'completed', 2, 1, 1, 1, NULL,
          '2026-09-08T01:00:00.000Z', '2026-09-08T01:01:00.000Z', '2026-09-08T01:02:00.000Z'),
        ('failed', 'account', 'key-failed', 'historical', 1, 2, 'all', 'failed', 2, 0, 0, 3, 'provider failed',
          '2026-09-08T01:00:00.000Z', '2026-09-08T01:01:00.000Z', '2026-09-08T01:02:00.000Z');

      INSERT INTO reader_mark_read_job_targets (job_id, article_id, ordinal, status, attempts, last_error)
      VALUES
        ('accepted', 'a', 0, 'pending', 0, NULL),
        ('accepted', 'b', 1, 'pending', 0, NULL),
        ('running', 'a', 0, 'confirmed', 1, NULL),
        ('running', 'b', 1, 'pending', 1, 'retry'),
        ('completed', 'a', 0, 'confirmed', 1, NULL),
        ('completed', 'b', 1, 'superseded', 0, NULL),
        ('failed', 'a', 0, 'pending', 3, 'provider failed'),
        ('failed', 'b', 1, 'pending', 3, 'provider failed');
    `);
    const jobsBefore = database.prepare('SELECT * FROM reader_mark_read_jobs ORDER BY id').all();
    const targetsBefore = database.prepare('SELECT * FROM reader_mark_read_job_targets ORDER BY job_id, ordinal').all();

    runMigrations(database);
    database.exec(`
      UPDATE reader_accounts SET current_generation_id = NULL WHERE account_key = 'account';
      DELETE FROM reader_cache_generations WHERE id = 'historical';
    `);

    expect(database.prepare('SELECT * FROM reader_mark_read_jobs ORDER BY id').all()).toEqual(jobsBefore);
    expect(database.prepare('SELECT * FROM reader_mark_read_job_targets ORDER BY job_id, ordinal').all()).toEqual(targetsBefore);
    expect(database.prepare("PRAGMA foreign_key_list('reader_mark_read_jobs')").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ table: 'reader_cache_generations' })]));
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(() => database.prepare(`
      INSERT INTO reader_mark_read_jobs
        (id, account_key, idempotency_key, generation_id, collection_version, state_version_boundary,
          scope_kind, status, created_at)
      VALUES ('duplicate', 'account', 'key-accepted', 'historical', 1, 2, 'all', 'accepted', '2026-09-08T02:00:00.000Z')
    `).run()).toThrow();
  });
});
