import fs from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from './database.js';
import type { ReaderStorageDeferralReason } from '../shared/reader.js';

const MIB = 1_024 * 1_024;

/**
 * The guard deliberately overestimates the next full generation. It accounts
 * for duplicated FTS/index content, WAL growth that cannot consume SQLite free
 * pages, and a maintenance reserve for the web process and follow-up cleanup.
 */
export const READER_STORAGE_POLICY = {
  minimumStagedGenerationBytes: 512 * MIB,
  stagedGenerationMultiplier: 2.5,
  minimumWalReserveBytes: 256 * MIB,
  walFraction: 0.35,
  maintenanceReserveBytes: 128 * MIB,
  storageRetryBackoffMs: 15 * 60 * 1_000,
} as const;

export type ReaderStorageMetrics = {
  databasePath: string | null;
  pageSizeBytes: number;
  pageCount: number;
  freePageCount: number;
  allocatedDatabaseBytes: number;
  reusableDatabaseBytes: number;
  databaseFileBytes: number;
  walBytes: number;
  filesystemAvailableBytes: number;
  currentGenerationLogicalBytes: number;
  estimatedStagedGenerationBytes: number;
  additionalFilesystemBytes: number;
  walReserveBytes: number;
  maintenanceReserveBytes: number;
  importRequiredFilesystemBytes: number;
  cleanupRequiredFilesystemBytes: number;
  canImport: boolean;
  canPrune: boolean;
};

function pragmaNumber(database: AppDatabase, name: 'page_size' | 'page_count' | 'freelist_count') {
  return Number(database.pragma(name, { simple: true }));
}

function fileBytes(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function filesystemAvailableBytes(databasePath: string) {
  const stats = fs.statfsSync(path.dirname(databasePath), { bigint: true });
  const available = stats.bavail * stats.bsize;
  return Number(available > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : available);
}

export function currentGenerationLogicalBytes(database: AppDatabase, accountKey?: string) {
  const hasStoredEstimate = (database.prepare(`PRAGMA table_info('reader_cache_generations')`).all() as Array<{ name: string }>)
    .some((column) => column.name === 'logical_bytes');
  if (hasStoredEstimate) {
    const statement = database.prepare(`
      SELECT COALESCE(MAX(generation.logical_bytes), 0) AS bytes
      FROM reader_accounts account
      JOIN reader_cache_generations generation ON generation.id = account.current_generation_id
      ${accountKey ? 'WHERE account.account_key = @accountKey' : ''}
    `);
    return ((accountKey ? statement.get({ accountKey }) : statement.get()) as { bytes: number }).bytes;
  }
  const row = database.prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (
      SELECT SUM(
        LENGTH(article.id) + LENGTH(article.feed_id) + LENGTH(article.title)
        + LENGTH(COALESCE(article.author, '')) + LENGTH(article.source)
        + LENGTH(article.canonical_url) + LENGTH(article.published_at)
        + LENGTH(article.summary) + 32
      ) AS bytes
      FROM reader_articles article
      JOIN reader_accounts account ON account.current_generation_id = article.generation_id
      UNION ALL
      SELECT SUM(LENGTH(body.content_html) + LENGTH(body.article_id) + 16)
      FROM reader_article_bodies body
      JOIN reader_accounts account ON account.current_generation_id = body.generation_id
      UNION ALL
      SELECT SUM(LENGTH(subscription.id) + LENGTH(subscription.title) + LENGTH(subscription.url)
        + LENGTH(COALESCE(subscription.site_url, '')) + LENGTH(COALESCE(subscription.icon_url, '')) + 32)
      FROM reader_subscriptions subscription
      JOIN reader_accounts account ON account.current_generation_id = subscription.generation_id
      UNION ALL
      SELECT SUM(LENGTH(folder.id) + LENGTH(folder.title) + 16)
      FROM reader_folders folder
      JOIN reader_accounts account ON account.current_generation_id = folder.generation_id
      UNION ALL
      SELECT COUNT(*) * 64
      FROM reader_article_state state
      JOIN reader_accounts account ON account.current_generation_id = state.generation_id
      UNION ALL
      SELECT COUNT(*) * 96
      FROM reader_article_folders relation
      JOIN reader_accounts account ON account.current_generation_id = relation.generation_id
      UNION ALL
      SELECT COUNT(*) * 96
      FROM reader_subscription_folders relation
      JOIN reader_accounts account ON account.current_generation_id = relation.generation_id
    )
  `).get() as { bytes: number };
  return row.bytes;
}

export function evaluateReaderStorage(input: {
  databasePath: string | null;
  pageSizeBytes: number;
  pageCount: number;
  freePageCount: number;
  databaseFileBytes: number;
  walBytes: number;
  filesystemAvailableBytes: number;
  currentGenerationLogicalBytes: number;
}): ReaderStorageMetrics {
  const allocatedDatabaseBytes = input.pageSizeBytes * input.pageCount;
  const reusableDatabaseBytes = input.pageSizeBytes * input.freePageCount;
  const estimatedStagedGenerationBytes = Math.max(
    READER_STORAGE_POLICY.minimumStagedGenerationBytes,
    Math.ceil(input.currentGenerationLogicalBytes * READER_STORAGE_POLICY.stagedGenerationMultiplier),
  );
  const additionalFilesystemBytes = Math.max(0, estimatedStagedGenerationBytes - reusableDatabaseBytes);
  const walReserveBytes = Math.max(
    READER_STORAGE_POLICY.minimumWalReserveBytes,
    Math.ceil(estimatedStagedGenerationBytes * READER_STORAGE_POLICY.walFraction),
  );
  const importRequiredFilesystemBytes = additionalFilesystemBytes
    + walReserveBytes
    + READER_STORAGE_POLICY.maintenanceReserveBytes;
  // Deleting a generation can rewrite a production-shaped generation into the
  // WAL. SQLite free pages cannot satisfy that filesystem-side requirement.
  const cleanupRequiredFilesystemBytes = estimatedStagedGenerationBytes
    + READER_STORAGE_POLICY.maintenanceReserveBytes;
  return {
    ...input,
    allocatedDatabaseBytes,
    reusableDatabaseBytes,
    estimatedStagedGenerationBytes,
    additionalFilesystemBytes,
    walReserveBytes,
    maintenanceReserveBytes: READER_STORAGE_POLICY.maintenanceReserveBytes,
    importRequiredFilesystemBytes,
    cleanupRequiredFilesystemBytes,
    canImport: input.filesystemAvailableBytes >= importRequiredFilesystemBytes,
    canPrune: input.filesystemAvailableBytes >= cleanupRequiredFilesystemBytes,
  };
}

export function readReaderStorageMetrics(
  database: AppDatabase,
  availableBytesOverride?: number,
  accountKey?: string,
): ReaderStorageMetrics {
  const databasePath = database.name === ':memory:' || database.name === '' ? null : path.resolve(database.name);
  return evaluateReaderStorage({
    databasePath,
    pageSizeBytes: pragmaNumber(database, 'page_size'),
    pageCount: pragmaNumber(database, 'page_count'),
    freePageCount: pragmaNumber(database, 'freelist_count'),
    databaseFileBytes: databasePath ? fileBytes(databasePath) : 0,
    walBytes: databasePath ? fileBytes(`${databasePath}-wal`) : 0,
    filesystemAvailableBytes: availableBytesOverride
      ?? (databasePath ? filesystemAvailableBytes(databasePath) : Number.MAX_SAFE_INTEGER),
    currentGenerationLogicalBytes: currentGenerationLogicalBytes(database, accountKey),
  });
}

export function storageDeferralReason(metrics: ReaderStorageMetrics) {
  return {
    code: 'reader_storage_deferred',
    availableBytes: metrics.filesystemAvailableBytes,
    requiredBytes: metrics.importRequiredFilesystemBytes,
    reusableDatabaseBytes: metrics.reusableDatabaseBytes,
    walReserveBytes: metrics.walReserveBytes,
  } satisfies ReaderStorageDeferralReason;
}
