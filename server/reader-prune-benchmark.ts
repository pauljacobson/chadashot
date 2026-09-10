import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { ReaderApi } from './reader-api.js';
import { runBackgroundReaderPrune } from './reader-pruning-runner.js';
import { readReaderStorageMetrics } from './reader-storage.js';
import type { ReaderCacheIdentity } from './reader-cache.js';

const budgets = {
  writerLockMs: 10_000,
  webProcessBlockingMs: 100,
  readerLatencyP95Ms: 250,
} as const;

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function main() {
  const dataDirIndex = process.argv.indexOf('--data-dir');
  const dataDir = dataDirIndex >= 0 ? process.argv[dataDirIndex + 1] : undefined;
  if (!dataDir) throw new Error('Usage: npm run benchmark:reader-cache-prune -- --data-dir PATH');

  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
  const database = openDatabase(config.dataDir);
  const identities = database.prepare(`
    SELECT account_key, provider_identity, credential_generation
    FROM reader_accounts WHERE current_generation_id IS NOT NULL
  `).all() as Array<{
    account_key: string;
    provider_identity: string;
    credential_generation: string;
  }>;
  const reader = new ReaderApi(database);
  const readerLatencies: number[] = [];
  const eventLoopDelays: number[] = [];
  const initialStorage = readReaderStorageMetrics(database);
  let peakWalBytes = initialStorage.walBytes;
  let minimumFilesystemAvailableBytes = initialStorage.filesystemAvailableBytes;
  let sampling = true;
  const sample = (async () => {
    while (sampling) {
      const scheduled = performance.now();
      await delay(10);
      eventLoopDelays.push(Math.max(0, performance.now() - scheduled - 10));
      for (const row of identities) {
        const identity: ReaderCacheIdentity = {
          accountKey: row.account_key,
          providerIdentity: row.provider_identity,
          credentialGeneration: row.credential_generation,
        };
        const started = performance.now();
        reader.navigation(identity);
        reader.articles(identity, { scope: 'all', read: 'all', limit: 100 });
        readerLatencies.push(performance.now() - started);
      }
      const storage = readReaderStorageMetrics(database);
      peakWalBytes = Math.max(peakWalBytes, storage.walBytes);
      minimumFilesystemAvailableBytes = Math.min(minimumFilesystemAvailableBytes, storage.filesystemAvailableBytes);
    }
  })();

  const before = readReaderStorageMetrics(database);
  const result = await runBackgroundReaderPrune(database, 1);
  sampling = false;
  await sample;
  const after = readReaderStorageMetrics(database);
  const writerLockMs = result.pruning?.deletions[0]?.writerLockMs ?? 0;
  const measurements = {
    candidateGenerations: result.pruning?.candidates.length ?? 0,
    deletedGenerations: result.pruning?.deletions.length ?? 0,
    deletedArticles: result.pruning?.deletions[0]?.articleCount ?? 0,
    deletedBodyBytes: result.pruning?.deletions[0]?.bodyBytes ?? 0,
    deletedSearchRows: result.pruning?.deletions[0]?.searchRows ?? 0,
    writerLockMs,
    webProcessBlockingMaxMs: Math.max(0, ...eventLoopDelays),
    readerLatencyP95Ms: percentile(readerLatencies, 0.95),
    readerLatencyMaxMs: Math.max(0, ...readerLatencies),
    peakWalBytes,
    peakFilesystemConsumptionBytes: Math.max(0, before.filesystemAvailableBytes - minimumFilesystemAvailableBytes),
    minimumFilesystemAvailableBytes,
    filesystemAvailableBytes: after.filesystemAvailableBytes,
    pageCountBefore: before.pageCount,
    pageCountAfter: after.pageCount,
    freePageCountBefore: before.freePageCount,
    freePageCountAfter: after.freePageCount,
  };
  const gates = {
    writerLock: writerLockMs <= budgets.writerLockMs,
    webProcessBlocking: measurements.webProcessBlockingMaxMs <= budgets.webProcessBlockingMs,
    readerLatency: measurements.readerLatencyP95Ms <= budgets.readerLatencyP95Ms,
    cleanupHeadroom: before.canPrune,
  };
  process.stdout.write(`${JSON.stringify({ budgets, measurements, gates, outcome: result.outcome }, null, 2)}\n`);
  if (result.outcome !== 'completed' || result.pruning?.errors.length || Object.values(gates).includes(false)) {
    process.exitCode = 1;
  }
  database.close();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Reader cache pruning benchmark failed'}\n`);
  process.exitCode = 1;
});
