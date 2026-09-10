import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { ReaderCache } from './reader-cache.js';

type PruneWorkerInput = {
  databasePath: string;
  maxDeletes: number;
};

if (!isMainThread) {
  const input = workerData as PruneWorkerInput;
  const database = new Database(input.databasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  try {
    const result = await new ReaderCache(database).prune({ maxDeletes: input.maxDeletes });
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown reader pruning worker error',
    });
  } finally {
    database.close();
  }
}
