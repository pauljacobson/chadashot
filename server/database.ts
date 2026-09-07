import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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
`;

export type AppDatabase = Database.Database;

export function openDatabase(dataDir: string): AppDatabase {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(dataDir, 'chadashot.sqlite'));
  database.pragma('busy_timeout = 5000');
  database.exec(schema);
  database.prepare('INSERT OR IGNORE INTO app_metadata (key, value) VALUES (?, ?)').run('schema_version', '1');
  return database;
}

export function openMemoryDatabase(): AppDatabase {
  const database = new Database(':memory:');
  database.exec(schema);
  return database;
}

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
