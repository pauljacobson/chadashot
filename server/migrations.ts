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
  {
    version: 4,
    name: 'transactional_reader_cache',
    sql: `
      CREATE TABLE reader_accounts (
        account_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_identity TEXT NOT NULL,
        credential_generation TEXT NOT NULL,
        current_generation_id TEXT,
        collection_version INTEGER NOT NULL DEFAULT 0,
        state_version INTEGER NOT NULL DEFAULT 0,
        body_version INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        invalidated_at TEXT
      );

      CREATE TABLE reader_cache_generations (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL REFERENCES reader_accounts(account_key) ON DELETE CASCADE,
        generation_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('staging', 'committed', 'failed')),
        fence_token INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        committed_at TEXT,
        failed_at TEXT,
        error TEXT,
        collection_version INTEGER,
        state_version INTEGER,
        body_version INTEGER,
        UNIQUE(account_key, generation_number)
      );

      CREATE TABLE reader_folders (
        generation_id TEXT NOT NULL REFERENCES reader_cache_generations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        unread_count INTEGER NOT NULL,
        PRIMARY KEY(generation_id, id)
      ) WITHOUT ROWID;

      CREATE TABLE reader_subscriptions (
        generation_id TEXT NOT NULL REFERENCES reader_cache_generations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        site_url TEXT,
        icon_url TEXT,
        unread_count INTEGER NOT NULL,
        PRIMARY KEY(generation_id, id)
      ) WITHOUT ROWID;

      CREATE TABLE reader_subscription_folders (
        generation_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        PRIMARY KEY(generation_id, subscription_id, folder_id),
        FOREIGN KEY(generation_id, subscription_id) REFERENCES reader_subscriptions(generation_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE reader_articles (
        generation_id TEXT NOT NULL REFERENCES reader_cache_generations(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        feed_id TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        source TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        published_at TEXT NOT NULL,
        reading_minutes INTEGER NOT NULL,
        summary TEXT NOT NULL,
        PRIMARY KEY(generation_id, id)
      ) WITHOUT ROWID;

      CREATE TABLE reader_article_bodies (
        generation_id TEXT NOT NULL,
        article_id TEXT NOT NULL,
        content_html TEXT NOT NULL,
        PRIMARY KEY(generation_id, article_id),
        FOREIGN KEY(generation_id, article_id) REFERENCES reader_articles(generation_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE reader_article_state (
        generation_id TEXT NOT NULL,
        article_id TEXT NOT NULL,
        is_read INTEGER NOT NULL CHECK (is_read IN (0, 1)),
        is_starred INTEGER NOT NULL CHECK (is_starred IN (0, 1)),
        PRIMARY KEY(generation_id, article_id),
        FOREIGN KEY(generation_id, article_id) REFERENCES reader_articles(generation_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE reader_article_folders (
        generation_id TEXT NOT NULL,
        article_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        PRIMARY KEY(generation_id, article_id, folder_id),
        FOREIGN KEY(generation_id, article_id) REFERENCES reader_articles(generation_id, id) ON DELETE CASCADE
      ) WITHOUT ROWID;

      CREATE TABLE reader_sync_runs (
        id TEXT PRIMARY KEY,
        account_key TEXT NOT NULL REFERENCES reader_accounts(account_key) ON DELETE CASCADE,
        generation_id TEXT REFERENCES reader_cache_generations(id) ON DELETE SET NULL,
        fence_token INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'fenced')),
        items_staged INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );

      CREATE TABLE reader_sync_checkpoints (
        account_key TEXT PRIMARY KEY REFERENCES reader_accounts(account_key) ON DELETE CASCADE,
        generation_id TEXT NOT NULL REFERENCES reader_cache_generations(id) ON DELETE CASCADE,
        collection_version INTEGER NOT NULL,
        state_version INTEGER NOT NULL,
        body_version INTEGER NOT NULL,
        committed_at TEXT NOT NULL
      );

      CREATE TABLE reader_sync_leases (
        account_key TEXT PRIMARY KEY REFERENCES reader_accounts(account_key) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        fence_token INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE reader_state_overrides (
        account_key TEXT NOT NULL REFERENCES reader_accounts(account_key) ON DELETE CASCADE,
        article_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('read', 'starred')),
        value INTEGER NOT NULL CHECK (value IN (0, 1)),
        revision INTEGER NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY(account_key, article_id, operation)
      ) WITHOUT ROWID;

      CREATE INDEX reader_articles_scope ON reader_articles(generation_id, feed_id, published_at DESC, id);
      CREATE INDEX reader_articles_published ON reader_articles(generation_id, published_at DESC, id);
      CREATE INDEX reader_article_folders_scope ON reader_article_folders(generation_id, folder_id, article_id);
      CREATE INDEX reader_generations_account_status ON reader_cache_generations(account_key, status, generation_number DESC);
      CREATE INDEX reader_sync_runs_account_started ON reader_sync_runs(account_key, started_at DESC);
    `,
  },
  {
    version: 5,
    name: 'incremental_reader_checkpoints',
    sql: `
      ALTER TABLE reader_sync_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'full'
        CHECK (kind IN ('full', 'routine', 'state', 'body'));

      CREATE TABLE reader_incremental_checkpoints (
        account_key TEXT PRIMARY KEY REFERENCES reader_accounts(account_key) ON DELETE CASCADE,
        routine_cutoff_seconds INTEGER,
        body_cutoff_seconds INTEGER,
        subscription_fingerprint TEXT,
        last_routine_at TEXT,
        last_state_at TEXT,
        last_body_at TEXT,
        last_full_at TEXT
      );
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
