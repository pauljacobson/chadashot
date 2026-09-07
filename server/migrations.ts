import type { AppDatabase } from './database.js';

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS passkey_credentials (
        credential_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_challenges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'login', 'register')),
        challenge TEXT NOT NULL,
        display_name TEXT,
        user_id TEXT,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS integrations (
        kind TEXT PRIMARY KEY CHECK (kind IN ('birchfeed', 'readwise')),
        encrypted_config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS highlights (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL,
        text TEXT NOT NULL,
        note TEXT,
        readwise_status TEXT NOT NULL CHECK (readwise_status IN ('pending', 'saved', 'failed')),
        readwise_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS highlights_article_id ON highlights(article_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_challenges_expires_at ON auth_challenges(expires_at);
    `,
  },
  {
    version: 2,
    name: 'passkey_management_and_recovery',
    sql: `
      ALTER TABLE passkey_credentials ADD COLUMN name TEXT NOT NULL DEFAULT 'Passkey';

      CREATE TABLE recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        used_at TEXT
      );

      CREATE INDEX recovery_codes_user_id ON recovery_codes(user_id);
    `,
  },
  {
    version: 3,
    name: 'durable_highlight_anchors',
    sql: `
      ALTER TABLE highlights ADD COLUMN start_offset INTEGER;
      ALTER TABLE highlights ADD COLUMN end_offset INTEGER;
      ALTER TABLE highlights ADD COLUMN readwise_error TEXT;
    `,
  },
];

function ensureMigrationTable(database: AppDatabase) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function runMigrations(database: AppDatabase) {
  ensureMigrationTable(database);
  const applied = new Set((database.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
    .map((row) => row.version));
  const apply = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, new Date().toISOString());
    database.prepare(`
      INSERT INTO app_metadata (key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(migration.version));
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
}

export function currentSchemaVersion(database: AppDatabase) {
  ensureMigrationTable(database);
  return database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get() as { version: number };
}
