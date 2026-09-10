import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, type AppDatabase } from './database.js';
import { ReaderCache } from './reader-cache.js';
import { readReaderStorageMetrics } from './reader-storage.js';

type Options = {
  dryRun: boolean;
  maxDeletes: number;
  dataDir: string;
};

function usage() {
  return [
    'Usage: npm run reader-cache:prune -- [--dry-run] [--max-delete N] [--data-dir PATH]',
    '',
    'Dry-run opens the existing database read-only and never runs migrations.',
    'A write run deletes at most one generation per transaction.',
  ].join('\n');
}

function parseOptions(arguments_: string[]): Options {
  const options: Options = {
    dryRun: false,
    maxDeletes: 1,
    dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--max-delete') {
      const value = Number(arguments_[index + 1]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('--max-delete must be a non-negative integer');
      options.maxDeletes = value;
      index += 1;
    } else if (argument === '--data-dir') {
      const value = arguments_[index + 1];
      if (!value) throw new Error('--data-dir requires a path');
      options.dataDir = path.resolve(value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function openReadOnly(dataDir: string): AppDatabase {
  const databasePath = path.join(dataDir, 'chadashot.sqlite');
  if (!fs.existsSync(databasePath)) throw new Error(`Reader database does not exist: ${databasePath}`);
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  return database;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const database = options.dryRun ? openReadOnly(options.dataDir) : openDatabase(options.dataDir);
  try {
    const before = readReaderStorageMetrics(database);
    if (!options.dryRun && !before.canPrune) {
      process.stdout.write(`${JSON.stringify({
        mode: 'delete',
        outcome: 'insufficient-cleanup-headroom',
        storage: {
          filesystemAvailableBytes: before.filesystemAvailableBytes,
          cleanupRequiredFilesystemBytes: before.cleanupRequiredFilesystemBytes,
          reusableDatabaseBytes: before.reusableDatabaseBytes,
          walBytes: before.walBytes,
        },
      }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    const pruning = await new ReaderCache(database).prune({
      dryRun: options.dryRun,
      maxDeletes: options.maxDeletes,
      includeCandidateDetails: true,
    });
    const after = readReaderStorageMetrics(database);
    const integrity = options.dryRun
      ? null
      : database.prepare('PRAGMA foreign_key_check').all();
    process.stdout.write(`${JSON.stringify({
      mode: options.dryRun ? 'dry-run' : 'delete',
      before,
      pruning,
      after,
      foreignKeyViolations: integrity,
    }, null, 2)}\n`);
    if (pruning.errors.length > 0 || (integrity?.length ?? 0) > 0) process.exitCode = 1;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Reader cache pruning failed'}\n`);
  process.exitCode = 1;
});
