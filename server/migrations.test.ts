import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { currentSchemaVersion, runMigrations } from './migrations.js';

describe('database migrations', () => {
  it('applies every migration once and records the current version', () => {
    const database = new Database(':memory:');
    database.pragma('foreign_keys = ON');

    runMigrations(database);
    runMigrations(database);

    expect(currentSchemaVersion(database)).toEqual({ version: 3 });
    expect(database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'passkey_management_and_recovery' },
      { version: 3, name: 'durable_highlight_anchors' },
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
  });

  it('upgrades a legacy version-one database without losing existing rows', () => {
    const database = new Database(':memory:');
    database.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('user-1', 'Paul', '2026-09-07T00:00:00.000Z');
    `);

    runMigrations(database);

    expect(database.prepare('SELECT id, display_name FROM users').get()).toEqual({ id: 'user-1', display_name: 'Paul' });
    expect(currentSchemaVersion(database)).toEqual({ version: 3 });
  });
});
