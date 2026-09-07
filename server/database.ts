import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

export type AppDatabase = Database.Database;

export function openDatabase(dataDir: string): AppDatabase {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = new Database(path.join(dataDir, 'chadashot.sqlite'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  runMigrations(database);
  return database;
}

export function openMemoryDatabase(): AppDatabase {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runMigrations(database);
  return database;
}

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}
