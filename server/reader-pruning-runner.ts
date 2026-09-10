import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { AppDatabase } from './database.js';
import { ReaderCache, type ReaderGenerationPruneResult } from './reader-cache.js';
import { readReaderStorageMetrics, type ReaderStorageMetrics } from './reader-storage.js';

export type BackgroundReaderPruneResult = {
  outcome: 'completed' | 'insufficient-cleanup-headroom';
  before: ReaderStorageMetrics;
  after: ReaderStorageMetrics;
  pruning: ReaderGenerationPruneResult | null;
};

function workerUrl() {
  const extension = path.extname(fileURLToPath(import.meta.url));
  return new URL(`./reader-prune-worker${extension}`, import.meta.url);
}

function pruneInWorker(databasePath: string, maxDeletes: number) {
  return new Promise<ReaderGenerationPruneResult>((resolve, reject) => {
    const worker = new Worker(workerUrl(), { workerData: { databasePath, maxDeletes } });
    worker.once('message', (message: { ok: true; result: ReaderGenerationPruneResult } | { ok: false; error: string }) => {
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Reader pruning worker exited with code ${code}`));
    });
  });
}

export async function runBackgroundReaderPrune(
  database: AppDatabase,
  maxDeletes = 1,
): Promise<BackgroundReaderPruneResult> {
  const before = readReaderStorageMetrics(database);
  if (!before.canPrune) {
    return { outcome: 'insufficient-cleanup-headroom', before, after: before, pruning: null };
  }
  const pruning = before.databasePath
    ? await pruneInWorker(before.databasePath, maxDeletes)
    : await new ReaderCache(database).prune({ maxDeletes });
  const after = readReaderStorageMetrics(database);
  return { outcome: 'completed', before, after, pruning };
}
