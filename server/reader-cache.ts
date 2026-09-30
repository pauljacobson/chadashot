import crypto from 'node:crypto';
import type {
  Article,
  ArticleMutation,
  Folder,
  ReaderSnapshot,
  ReaderStorageDeferralReason,
  Subscription,
} from '../shared/reader.js';
import type { AppDatabase } from './database.js';
import { newId, nowIso } from './database.js';
import { normalizeGoogleReaderItemId, type GoogleReaderCredentials } from './integrations/google-reader.js';

export const READER_IMPORT_BATCH_SIZE = 500;

export type ReaderCacheIdentity = {
  accountKey: string;
  providerIdentity: string;
  credentialGeneration: string;
};

export type ReaderCacheLease = {
  accountKey: string;
  ownerId: string;
  fenceToken: number;
  expiresAt: string;
};

export type ReaderCacheImport = ReaderCacheLease & {
  generationId: string;
  generationNumber: number;
  runId: string;
  startedAt: string;
};

export type ReaderCacheIncrementalRun = ReaderCacheLease & {
  generationId: null;
  runId: string;
  startedAt: string;
  kind: 'routine' | 'state' | 'body';
};

export type ReaderSyncPlan = {
  full: boolean;
  routine: boolean;
  state: boolean;
  body: boolean;
  deferredUntil: string | null;
  deferralReason: string | null;
  routineSinceSeconds: number;
  bodySinceSeconds: number;
  subscriptionFingerprint: string | null;
};

export type ReaderGenerationPruneCandidate = {
  generationId: string;
  accountKey: string;
  generationNumber: number;
  status: 'staging' | 'committed' | 'failed';
  reason: 'superseded' | 'failed' | 'abandoned';
  articleCount: number | null;
  bodyBytes: number | null;
  startedAt: string;
};

export type ReaderGenerationPruneResult = {
  dryRun: boolean;
  maxDeletes: number;
  candidates: ReaderGenerationPruneCandidate[];
  deletions: Array<ReaderGenerationPruneCandidate & {
    searchRows: number;
    durationMs: number;
    writerWaitMs: number;
    writerLockMs: number;
    phases: {
      protectionCheckMs: number;
      searchCountMs: number;
      searchDeleteMs: number;
      searchKeyDeleteMs: number;
      generationCascadeMs: number;
      commitMs: number;
    };
  }>;
  skipped: Array<{ generationId: string; reason: 'became-protected' }>;
  errors: Array<{ generationId: string; message: string }>;
  durationMs: number;
};

export type ReaderCacheStatus = {
  state: 'empty' | 'initializing' | 'refreshing' | 'current' | 'stale';
  itemsStaged: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  storageDeferral: { until: string; reason: ReaderStorageDeferralReason } | null;
  versions: { collection: number; state: number; body: number };
};

type Clock = () => Date;

export class ReaderCacheFencedError extends Error {
  constructor() {
    super('Reader cache import lost its lease and cannot publish');
    this.name = 'ReaderCacheFencedError';
  }
}

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

export function readerCacheIdentity(userId: string, credentials: GoogleReaderCredentials, credentialGeneration: string): ReaderCacheIdentity {
  const providerIdentity = sha256(`${credentials.serverUrl}\0${credentials.email.trim().toLocaleLowerCase()}`);
  return {
    accountKey: sha256(`${userId}\0google-reader\0${providerIdentity}\0${credentialGeneration}`),
    providerIdentity,
    credentialGeneration,
  };
}

export function readerSubscriptionFingerprint(subscriptions: Subscription[], folders: Folder[] = []) {
  return sha256(JSON.stringify({
    subscriptions: subscriptions
      .map(({ id, folderIds }) => ({
      id,
      folderIds: [...folderIds].sort(),
    }))
      .sort((first, second) => first.id.localeCompare(second.id)),
    folders: folders
      .map(({ id }) => ({ id }))
      .sort((first, second) => first.id.localeCompare(second.id)),
  }));
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

function bytes(...values: Array<string | null | undefined>) {
  return values.reduce<number>((total, value) => total + Buffer.byteLength(value ?? '', 'utf8'), 0);
}

function articleCoreLogicalBytes(article: Omit<Article, 'folderIds' | 'read' | 'starred'>) {
  return bytes(
    article.id,
    article.feedId,
    article.title,
    article.author,
    article.source,
    article.canonicalUrl,
    article.publishedAt,
    article.summary,
    article.contentHtml,
  ) + 112;
}

function articleLogicalBytes(article: Article) {
  return articleCoreLogicalBytes(article) + bytes(...article.folderIds) + (article.folderIds.length * 96);
}

export class ReaderCache {
  constructor(
    private readonly database: AppDatabase,
    private readonly ownerId: string = newId(),
    private readonly leaseMs = 45_000,
    private readonly clock: Clock = () => new Date(),
  ) {}

  private timestamp() {
    return this.clock().toISOString();
  }

  private ensureAccount(identity: ReaderCacheIdentity) {
    this.database.prepare(`
      INSERT INTO reader_accounts (account_key, provider, provider_identity, credential_generation)
      VALUES (?, 'google-reader', ?, ?)
      ON CONFLICT(account_key) DO UPDATE SET
        provider_identity = excluded.provider_identity,
        credential_generation = excluded.credential_generation,
        invalidated_at = NULL
    `).run(identity.accountKey, identity.providerIdentity, identity.credentialGeneration);
  }

  acquireLease(identity: ReaderCacheIdentity): ReaderCacheLease | null {
    const acquire = this.database.transaction(() => {
      this.ensureAccount(identity);
      const timestamp = this.timestamp();
      const existing = this.database.prepare(`
        SELECT owner_id, fence_token, expires_at FROM reader_sync_leases WHERE account_key = ?
      `).get(identity.accountKey) as { owner_id: string; fence_token: number; expires_at: string } | undefined;
      if (existing && existing.owner_id !== this.ownerId && existing.expires_at > timestamp) return null;
      const priorFence = (this.database.prepare(`
        SELECT COALESCE(MAX(fence_token), 0) AS value FROM reader_sync_runs WHERE account_key = ?
      `).get(identity.accountKey) as { value: number }).value;
      const fenceToken = Math.max(existing?.fence_token ?? 0, priorFence) + 1;
      const expiresAt = new Date(this.clock().getTime() + this.leaseMs).toISOString();
      this.database.prepare(`
        INSERT INTO reader_sync_leases (account_key, owner_id, fence_token, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          owner_id = excluded.owner_id,
          fence_token = excluded.fence_token,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at
      `).run(identity.accountKey, this.ownerId, fenceToken, timestamp, timestamp, expiresAt);
      return { accountKey: identity.accountKey, ownerId: this.ownerId, fenceToken, expiresAt };
    });
    return acquire.immediate();
  }

  private assertLease(lease: ReaderCacheLease) {
    const row = this.database.prepare(`
      SELECT 1 FROM reader_sync_leases
      WHERE account_key = ? AND owner_id = ? AND fence_token = ? AND expires_at > ?
    `).get(lease.accountKey, lease.ownerId, lease.fenceToken, this.timestamp());
    if (!row) throw new ReaderCacheFencedError();
  }

  heartbeat(lease: ReaderCacheLease) {
    const timestamp = this.timestamp();
    const expiresAt = new Date(this.clock().getTime() + this.leaseMs).toISOString();
    const result = this.database.prepare(`
      UPDATE reader_sync_leases SET heartbeat_at = ?, expires_at = ?
      WHERE account_key = ? AND owner_id = ? AND fence_token = ? AND expires_at > ?
    `).run(timestamp, expiresAt, lease.accountKey, lease.ownerId, lease.fenceToken, timestamp);
    if (result.changes !== 1) throw new ReaderCacheFencedError();
    lease.expiresAt = expiresAt;
  }

  beginImport(lease: ReaderCacheLease): ReaderCacheImport {
    const begin = this.database.transaction(() => {
      this.assertLease(lease);
      const generationNumber = (this.database.prepare(`
        SELECT COALESCE(MAX(generation_number), 0) + 1 AS value
        FROM reader_cache_generations WHERE account_key = ?
      `).get(lease.accountKey) as { value: number }).value;
      const generationId = newId();
      const runId = newId();
      const startedAt = this.timestamp();
      this.database.prepare(`
        INSERT INTO reader_cache_generations
          (id, account_key, generation_number, status, fence_token, started_at)
        VALUES (?, ?, ?, 'staging', ?, ?)
      `).run(generationId, lease.accountKey, generationNumber, lease.fenceToken, startedAt);
      this.database.prepare(`
        INSERT INTO reader_sync_runs (id, account_key, generation_id, fence_token, status, started_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `).run(runId, lease.accountKey, generationId, lease.fenceToken, startedAt);
      this.database.prepare(`
        UPDATE reader_accounts SET last_attempt_at = ? WHERE account_key = ?
      `).run(startedAt, lease.accountKey);
      return { ...lease, generationId, generationNumber, runId, startedAt };
    });
    return begin.immediate();
  }

  beginIncrementalRun(lease: ReaderCacheLease, kind: ReaderCacheIncrementalRun['kind'] = 'routine'): ReaderCacheIncrementalRun {
    const begin = this.database.transaction(() => {
      this.assertLease(lease);
      const account = this.database.prepare(`SELECT current_generation_id FROM reader_accounts WHERE account_key = ?`)
        .get(lease.accountKey) as { current_generation_id: string | null } | undefined;
      if (!account?.current_generation_id) throw new Error('A committed reader generation is required for incremental synchronization');
      const runId = newId();
      const startedAt = this.timestamp();
      this.database.prepare(`
        INSERT INTO reader_sync_runs (id, account_key, generation_id, fence_token, status, started_at, kind)
        VALUES (?, ?, NULL, ?, 'running', ?, ?)
      `).run(runId, lease.accountKey, lease.fenceToken, startedAt, kind);
      this.database.prepare(`UPDATE reader_accounts SET last_attempt_at = ? WHERE account_key = ?`)
        .run(startedAt, lease.accountKey);
      return { ...lease, generationId: null, runId, startedAt, kind };
    });
    return begin.immediate();
  }

  private currentGenerationId(accountKey: string) {
    return (this.database.prepare(`SELECT current_generation_id AS id FROM reader_accounts WHERE account_key = ?`)
      .get(accountKey) as { id: string | null } | undefined)?.id ?? null;
  }

  private fingerprintGenerationSubscriptions(generationId: string) {
    const rows = this.database.prepare(`
      SELECT id, title, url, site_url, icon_url, unread_count
      FROM reader_subscriptions WHERE generation_id = ? ORDER BY id
    `).all(generationId) as Array<{
      id: string; title: string; url: string; site_url: string | null; icon_url: string | null; unread_count: number;
    }>;
    const folderRows = this.database.prepare(`
      SELECT subscription_id, folder_id FROM reader_subscription_folders WHERE generation_id = ?
    `).all(generationId) as Array<{ subscription_id: string; folder_id: string }>;
    const folders = new Map<string, string[]>();
    for (const row of folderRows) folders.set(row.subscription_id, [...(folders.get(row.subscription_id) ?? []), row.folder_id]);
    const readerFolders = this.database.prepare(`
      SELECT id, title, unread_count FROM reader_folders WHERE generation_id = ? ORDER BY id
    `).all(generationId) as Array<{ id: string; title: string; unread_count: number }>;
    return readerSubscriptionFingerprint(rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      siteUrl: row.site_url,
      iconUrl: row.icon_url,
      folderIds: folders.get(row.id) ?? [],
      unreadCount: row.unread_count,
    })), readerFolders.map((row) => ({ id: row.id, title: row.title, unreadCount: row.unread_count })));
  }

  subscriptionFingerprint(identity: ReaderCacheIdentity) {
    const generationId = this.currentGenerationId(identity.accountKey);
    return generationId ? this.fingerprintGenerationSubscriptions(generationId) : null;
  }

  syncPlan(identity: ReaderCacheIdentity, cadence: {
    routineMs: number;
    stateMs: number;
    bodyMs: number;
    fullMs: number;
    fullRetryMs?: number;
    overlapSeconds: number;
  }): ReaderSyncPlan {
    const checkpoint = this.database.prepare(`
      SELECT checkpoint.routine_cutoff_seconds, checkpoint.body_cutoff_seconds, checkpoint.subscription_fingerprint,
        checkpoint.last_routine_at, checkpoint.last_state_at, checkpoint.last_body_at, checkpoint.last_full_at,
        account.storage_deferred_until, account.storage_deferral_reason
      FROM reader_accounts account
      LEFT JOIN reader_incremental_checkpoints checkpoint ON checkpoint.account_key = account.account_key
      WHERE account.account_key = ?
    `).get(identity.accountKey) as {
      routine_cutoff_seconds: number | null;
      body_cutoff_seconds: number | null;
      subscription_fingerprint: string | null;
      last_routine_at: string | null;
      last_state_at: string | null;
      last_body_at: string | null;
      last_full_at: string | null;
      storage_deferred_until: string | null;
      storage_deferral_reason: string | null;
    } | undefined;
    const now = this.clock().getTime();
    const due = (value: string | null | undefined, interval: number) => !value || now - Date.parse(value) >= interval;
    const deferred = Boolean(checkpoint?.storage_deferred_until && Date.parse(checkpoint.storage_deferred_until) > now);
    const hasGeneration = Boolean(this.currentGenerationId(identity.accountKey));
    // Runs survive pruning (their generation reference becomes NULL), so this
    // cooldown also survives process restarts and failed-staging cleanup.
    const lastFull = this.database.prepare(`
      SELECT status, finished_at FROM reader_sync_runs
      WHERE account_key = ? AND kind = 'full'
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `).get(identity.accountKey) as { status: string; finished_at: string | null } | undefined;
    const maintenanceRetryMs = cadence.fullRetryMs ?? 6 * 60 * 60 * 1_000;
    const retryMs = hasGeneration ? maintenanceRetryMs : Math.min(maintenanceRetryMs, 180_000);
    const retryDue = lastFull?.status !== 'failed' || due(lastFull.finished_at, retryMs);
    const full = !deferred && retryDue && (!hasGeneration || due(checkpoint?.last_full_at, cadence.fullMs));
    return {
      full,
      routine: !deferred && (full || (hasGeneration && due(checkpoint?.last_routine_at, cadence.routineMs))),
      state: !deferred && (full || (hasGeneration && due(checkpoint?.last_state_at, cadence.stateMs))),
      body: !deferred && (full || (hasGeneration && due(checkpoint?.last_body_at, cadence.bodyMs))),
      deferredUntil: deferred ? checkpoint?.storage_deferred_until ?? null : null,
      deferralReason: deferred ? checkpoint?.storage_deferral_reason ?? null : null,
      routineSinceSeconds: Math.max(0, (checkpoint?.routine_cutoff_seconds ?? 0) - cadence.overlapSeconds),
      bodySinceSeconds: Math.max(0, (checkpoint?.body_cutoff_seconds ?? 0) - cadence.overlapSeconds),
      // Recompute from the current generation first. This lets a deployment
      // transition safely from an older fingerprint format without forcing a
      // one-time full import merely because the hash representation changed.
      subscriptionFingerprint: this.subscriptionFingerprint(identity) ?? checkpoint?.subscription_fingerprint ?? null,
    };
  }

  stageFolders(importRun: ReaderCacheImport, folders: Folder[]) {
    for (const batch of chunks(folders, READER_IMPORT_BATCH_SIZE)) {
      const logicalBytes = batch.reduce((total, folder) => total + bytes(folder.id, folder.title) + 16, 0);
      const stage = this.database.transaction(() => {
        this.assertLease(importRun);
        const insert = this.database.prepare(`
          INSERT INTO reader_folders (generation_id, id, title, unread_count) VALUES (?, ?, ?, ?)
          ON CONFLICT(generation_id, id) DO UPDATE SET title = excluded.title, unread_count = excluded.unread_count
        `);
        for (const folder of batch) insert.run(importRun.generationId, folder.id, folder.title, folder.unreadCount);
        this.database.prepare(`UPDATE reader_cache_generations SET logical_bytes = logical_bytes + ? WHERE id = ?`)
          .run(logicalBytes, importRun.generationId);
      });
      stage.immediate();
      this.heartbeat(importRun);
    }
  }

  stageSubscriptions(importRun: ReaderCacheImport, subscriptions: Subscription[]) {
    for (const batch of chunks(subscriptions, READER_IMPORT_BATCH_SIZE)) {
      const logicalBytes = batch.reduce((total, subscription) => total + bytes(
        subscription.id,
        subscription.title,
        subscription.url,
        subscription.siteUrl,
        subscription.iconUrl,
        ...subscription.folderIds,
      ) + 32 + (subscription.folderIds.length * 96), 0);
      const stage = this.database.transaction(() => {
        this.assertLease(importRun);
        const insert = this.database.prepare(`
          INSERT INTO reader_subscriptions
            (generation_id, id, title, url, site_url, icon_url, unread_count)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(generation_id, id) DO UPDATE SET
            title = excluded.title, url = excluded.url, site_url = excluded.site_url,
            icon_url = excluded.icon_url, unread_count = excluded.unread_count
        `);
        const removeFolders = this.database.prepare(`
          DELETE FROM reader_subscription_folders WHERE generation_id = ? AND subscription_id = ?
        `);
        const insertFolder = this.database.prepare(`
          INSERT OR IGNORE INTO reader_subscription_folders (generation_id, subscription_id, folder_id) VALUES (?, ?, ?)
        `);
        for (const subscription of batch) {
          insert.run(
            importRun.generationId,
            subscription.id,
            subscription.title,
            subscription.url,
            subscription.siteUrl,
            subscription.iconUrl,
            subscription.unreadCount,
          );
          removeFolders.run(importRun.generationId, subscription.id);
          for (const folderId of new Set(subscription.folderIds)) {
            insertFolder.run(importRun.generationId, subscription.id, folderId);
          }
        }
        this.database.prepare(`UPDATE reader_cache_generations SET logical_bytes = logical_bytes + ? WHERE id = ?`)
          .run(logicalBytes, importRun.generationId);
      });
      stage.immediate();
      this.heartbeat(importRun);
    }
  }

  stageArticles(importRun: ReaderCacheImport, articles: Article[]) {
    if (articles.length > READER_IMPORT_BATCH_SIZE) {
      throw new Error(`Reader import batch exceeds ${READER_IMPORT_BATCH_SIZE} articles`);
    }
    const logicalBytes = articles.reduce((total, article) => total + articleLogicalBytes(article), 0);
    const stage = this.database.transaction(() => {
      this.assertLease(importRun);
      const insertArticle = this.database.prepare(`
        INSERT INTO reader_articles
          (generation_id, id, feed_id, title, author, source, canonical_url, published_at, reading_minutes, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_id, id) DO UPDATE SET
          feed_id = excluded.feed_id, title = excluded.title, author = excluded.author,
          source = excluded.source, canonical_url = excluded.canonical_url,
          published_at = excluded.published_at, reading_minutes = excluded.reading_minutes,
          summary = excluded.summary
      `);
      const insertBody = this.database.prepare(`
        INSERT INTO reader_article_bodies (generation_id, article_id, content_html) VALUES (?, ?, ?)
        ON CONFLICT(generation_id, article_id) DO UPDATE SET content_html = excluded.content_html
      `);
      const insertState = this.database.prepare(`
        INSERT INTO reader_article_state (generation_id, article_id, is_read, is_starred) VALUES (?, ?, ?, ?)
        ON CONFLICT(generation_id, article_id) DO UPDATE SET
          is_read = excluded.is_read, is_starred = excluded.is_starred
      `);
      const removeFolders = this.database.prepare(`
        DELETE FROM reader_article_folders WHERE generation_id = ? AND article_id = ?
      `);
      const insertFolder = this.database.prepare(`
        INSERT OR IGNORE INTO reader_article_folders (generation_id, article_id, folder_id) VALUES (?, ?, ?)
      `);
      for (const article of articles) {
        insertArticle.run(
          importRun.generationId,
          article.id,
          article.feedId,
          article.title,
          article.author,
          article.source,
          article.canonicalUrl,
          article.publishedAt,
          article.readingMinutes,
          article.summary,
        );
        insertBody.run(importRun.generationId, article.id, article.contentHtml);
        insertState.run(importRun.generationId, article.id, Number(article.read), Number(article.starred));
        removeFolders.run(importRun.generationId, article.id);
        for (const folderId of new Set(article.folderIds)) {
          insertFolder.run(importRun.generationId, article.id, folderId);
        }
      }
      this.database.prepare(`UPDATE reader_sync_runs SET items_staged = items_staged + ? WHERE id = ?`)
        .run(articles.length, importRun.runId);
      this.database.prepare(`UPDATE reader_cache_generations SET logical_bytes = logical_bytes + ? WHERE id = ?`)
        .run(logicalBytes, importRun.generationId);
    });
    stage.immediate();
    this.heartbeat(importRun);
  }

  private rebuildNavigationActivity(generationId: string) {
    this.database.prepare(`DELETE FROM reader_navigation_activity WHERE generation_id = ?`).run(generationId);
    this.database.prepare(`
      INSERT INTO reader_navigation_activity
        (generation_id, kind, id, total_count, unread_count, latest_published_at)
      SELECT subscription.generation_id, 'feed', subscription.id, COUNT(article.id),
        COALESCE(SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END), 0), MAX(article.published_at)
      FROM reader_subscriptions subscription
      LEFT JOIN reader_articles article
        ON article.generation_id = subscription.generation_id AND article.feed_id = subscription.id
      LEFT JOIN reader_article_state state
        ON state.generation_id = article.generation_id AND state.article_id = article.id
      WHERE subscription.generation_id = ?
      GROUP BY subscription.generation_id, subscription.id
    `).run(generationId);
    this.database.prepare(`
      INSERT INTO reader_navigation_activity
        (generation_id, kind, id, total_count, unread_count, latest_published_at)
      SELECT folder.generation_id, 'folder', folder.id, COUNT(DISTINCT article.id),
        COALESCE(SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END), 0), MAX(article.published_at)
      FROM reader_folders folder
      LEFT JOIN reader_article_folders relation
        ON relation.generation_id = folder.generation_id AND relation.folder_id = folder.id
      LEFT JOIN reader_articles article
        ON article.generation_id = relation.generation_id AND article.id = relation.article_id
      LEFT JOIN reader_article_state state
        ON state.generation_id = article.generation_id AND state.article_id = article.id
      WHERE folder.generation_id = ?
      GROUP BY folder.generation_id, folder.id
    `).run(generationId);
    const scopeInsert = this.database.prepare(`
      INSERT INTO reader_navigation_activity
        (generation_id, kind, id, total_count, unread_count, latest_published_at)
      VALUES (?, 'scope', ?, ?, ?, ?)
    `);
    const all = this.database.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
        MAX(article.published_at) AS latest
      FROM reader_articles article JOIN reader_article_state state
        ON state.generation_id = article.generation_id AND state.article_id = article.id
      WHERE article.generation_id = ?
    `).get(generationId) as { total: number; unread: number; latest: string | null };
    scopeInsert.run(generationId, 'all', all.total, all.unread, all.latest);
    scopeInsert.run(generationId, 'inbox', all.unread, all.unread, all.latest);
    const starred = this.database.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
        MAX(article.published_at) AS latest
      FROM reader_articles article JOIN reader_article_state state
        ON state.generation_id = article.generation_id AND state.article_id = article.id
      WHERE article.generation_id = ? AND state.is_starred = 1
    `).get(generationId) as { total: number; unread: number; latest: string | null };
    scopeInsert.run(generationId, 'starred', starred.total, starred.unread, starred.latest);
    const uncategorized = this.database.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END), 0) AS unread,
        MAX(article.published_at) AS latest
      FROM reader_articles article JOIN reader_article_state state
        ON state.generation_id = article.generation_id AND state.article_id = article.id
      WHERE article.generation_id = ? AND NOT EXISTS (
        SELECT 1 FROM reader_subscription_folders relation
        WHERE relation.generation_id = article.generation_id AND relation.subscription_id = article.feed_id
      )
    `).get(generationId) as { total: number; unread: number; latest: string | null };
    scopeInsert.run(generationId, 'uncategorized', uncategorized.total, uncategorized.unread, uncategorized.latest);
  }

  private applyState(generationId: string, mutation: ArticleMutation) {
    const current = this.database.prepare(`
      SELECT s.is_read, s.is_starred, a.feed_id
      FROM reader_article_state s
      JOIN reader_articles a ON a.generation_id = s.generation_id AND a.id = s.article_id
      WHERE s.generation_id = ? AND s.article_id = ?
    `).get(generationId, mutation.articleId) as { is_read: number; is_starred: number; feed_id: string } | undefined;
    if (!current) return;
    if (mutation.operation === 'starred') {
      if (Boolean(current.is_starred) === mutation.value) return;
      this.database.prepare(`
        UPDATE reader_article_state SET is_starred = ? WHERE generation_id = ? AND article_id = ?
      `).run(Number(mutation.value), generationId, mutation.articleId);
      const delta = mutation.value ? 1 : -1;
      this.database.prepare(`
        UPDATE reader_navigation_activity
        SET total_count = MAX(0, total_count + ?), unread_count = MAX(0, unread_count + ?)
        WHERE generation_id = ? AND kind = 'scope' AND id = 'starred'
      `).run(delta, current.is_read ? 0 : delta, generationId);
      return;
    }
    if (Boolean(current.is_read) === mutation.value) return;
    const unreadDelta = mutation.value ? -1 : 1;
    this.database.prepare(`
      UPDATE reader_article_state SET is_read = ? WHERE generation_id = ? AND article_id = ?
    `).run(Number(mutation.value), generationId, mutation.articleId);
    this.database.prepare(`
      UPDATE reader_subscriptions SET unread_count = MAX(0, unread_count + ?)
      WHERE generation_id = ? AND id = ?
    `).run(unreadDelta, generationId, current.feed_id);
    this.database.prepare(`
      UPDATE reader_folders SET unread_count = MAX(0, unread_count + ?)
      WHERE generation_id = ? AND id IN (
        SELECT folder_id FROM reader_article_folders WHERE generation_id = ? AND article_id = ?
      )
    `).run(unreadDelta, generationId, generationId, mutation.articleId);
    this.database.prepare(`
      UPDATE reader_navigation_activity SET unread_count = MAX(0, unread_count + ?)
      WHERE generation_id = ? AND (
        (kind = 'scope' AND id = 'all')
        OR (kind = 'scope' AND id = 'starred' AND ? = 1)
        OR (kind = 'feed' AND id = ?)
        OR (kind = 'folder' AND id IN (
          SELECT folder_id FROM reader_article_folders WHERE generation_id = ? AND article_id = ?
        ))
        OR (kind = 'scope' AND id = 'uncategorized' AND NOT EXISTS (
          SELECT 1 FROM reader_subscription_folders
          WHERE generation_id = ? AND subscription_id = ?
        ))
      )
    `).run(
      unreadDelta,
      generationId,
      current.is_starred,
      current.feed_id,
      generationId,
      mutation.articleId,
      generationId,
      current.feed_id,
    );
    this.database.prepare(`
      UPDATE reader_navigation_activity
      SET total_count = MAX(0, total_count + ?), unread_count = MAX(0, unread_count + ?)
      WHERE generation_id = ? AND kind = 'scope' AND id = 'inbox'
    `).run(unreadDelta, unreadDelta, generationId);
  }

  private articleDeltaPayload(generationId: string, articleId: string) {
    const row = this.database.prepare(`
      SELECT a.id, a.feed_id, a.title, a.author, a.source, a.canonical_url, a.published_at,
        a.reading_minutes, a.summary, s.is_read, s.is_starred
      FROM reader_articles a
      JOIN reader_article_state s ON s.generation_id = a.generation_id AND s.article_id = a.id
      WHERE a.generation_id = ? AND a.id = ?
    `).get(generationId, articleId) as {
      id: string; feed_id: string; title: string; author: string | null; source: string; canonical_url: string;
      published_at: string; reading_minutes: number; summary: string; is_read: number; is_starred: number;
    } | undefined;
    if (!row) return null;
    const folderIds = (this.database.prepare(`
      SELECT folder_id FROM reader_article_folders WHERE generation_id = ? AND article_id = ? ORDER BY folder_id
    `).all(generationId, articleId) as Array<{ folder_id: string }>).map(({ folder_id }) => folder_id);
    return {
      id: row.id,
      feedId: row.feed_id,
      folderIds,
      title: row.title,
      author: row.author,
      source: row.source,
      canonicalUrl: row.canonical_url,
      publishedAt: row.published_at,
      readingMinutes: row.reading_minutes,
      summary: row.summary,
      read: Boolean(row.is_read),
      starred: Boolean(row.is_starred),
    };
  }

  private recordPublishedChanges(
    accountKey: string,
    previousGenerationId: string | null,
    generationId: string,
    versions: { collection: number; state: number; body: number },
    createdAt: string,
  ) {
    if (!previousGenerationId) return;
    const insert = this.database.prepare(`
      INSERT INTO reader_change_log
        (account_key, article_id, metadata_changed, state_changed, body_changed, deleted,
          collection_version, state_version, body_version, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const changed = this.database.prepare(`
      SELECT n.id,
        CASE WHEN o.id IS NULL OR n.feed_id IS NOT o.feed_id OR n.title IS NOT o.title
          OR n.author IS NOT o.author OR n.source IS NOT o.source OR n.canonical_url IS NOT o.canonical_url
          OR n.published_at IS NOT o.published_at OR n.reading_minutes IS NOT o.reading_minutes
          OR n.summary IS NOT o.summary
          OR EXISTS (
            SELECT folder_id FROM reader_article_folders WHERE generation_id = n.generation_id AND article_id = n.id
            EXCEPT SELECT folder_id FROM reader_article_folders WHERE generation_id = o.generation_id AND article_id = o.id
          )
          OR EXISTS (
            SELECT folder_id FROM reader_article_folders WHERE generation_id = o.generation_id AND article_id = o.id
            EXCEPT SELECT folder_id FROM reader_article_folders WHERE generation_id = n.generation_id AND article_id = n.id
          ) THEN 1 ELSE 0 END AS metadata_changed,
        CASE WHEN o.id IS NULL OR ns.is_read IS NOT os.is_read OR ns.is_starred IS NOT os.is_starred
          THEN 1 ELSE 0 END AS state_changed,
        CASE WHEN o.id IS NULL OR nb.content_html IS NOT ob.content_html THEN 1 ELSE 0 END AS body_changed
      FROM reader_articles n
      LEFT JOIN reader_articles o ON o.generation_id = ? AND o.id = n.id
      JOIN reader_article_state ns ON ns.generation_id = n.generation_id AND ns.article_id = n.id
      LEFT JOIN reader_article_state os ON os.generation_id = o.generation_id AND os.article_id = o.id
      JOIN reader_article_bodies nb ON nb.generation_id = n.generation_id AND nb.article_id = n.id
      LEFT JOIN reader_article_bodies ob ON ob.generation_id = o.generation_id AND ob.article_id = o.id
      WHERE n.generation_id = ? AND (
        o.id IS NULL OR n.feed_id IS NOT o.feed_id OR n.title IS NOT o.title OR n.author IS NOT o.author
        OR n.source IS NOT o.source OR n.canonical_url IS NOT o.canonical_url
        OR n.published_at IS NOT o.published_at OR n.reading_minutes IS NOT o.reading_minutes
        OR n.summary IS NOT o.summary OR ns.is_read IS NOT os.is_read OR ns.is_starred IS NOT os.is_starred
        OR nb.content_html IS NOT ob.content_html
        OR EXISTS (
          SELECT folder_id FROM reader_article_folders WHERE generation_id = n.generation_id AND article_id = n.id
          EXCEPT SELECT folder_id FROM reader_article_folders WHERE generation_id = o.generation_id AND article_id = o.id
        )
        OR EXISTS (
          SELECT folder_id FROM reader_article_folders WHERE generation_id = o.generation_id AND article_id = o.id
          EXCEPT SELECT folder_id FROM reader_article_folders WHERE generation_id = n.generation_id AND article_id = n.id
        )
      )
      ORDER BY n.id
    `).all(previousGenerationId, generationId) as Array<{
      id: string; metadata_changed: number; state_changed: number; body_changed: number;
    }>;
    for (const row of changed) {
      insert.run(
        accountKey,
        row.id,
        row.metadata_changed,
        row.state_changed,
        row.body_changed,
        0,
        versions.collection,
        versions.state,
        versions.body,
        JSON.stringify(this.articleDeltaPayload(generationId, row.id)),
        createdAt,
      );
    }
    const removed = this.database.prepare(`
      SELECT old.id FROM reader_articles old
      LEFT JOIN reader_articles current ON current.generation_id = ? AND current.id = old.id
      WHERE old.generation_id = ? AND current.id IS NULL ORDER BY old.id
    `).all(generationId, previousGenerationId) as Array<{ id: string }>;
    for (const row of removed) {
      insert.run(
        accountKey,
        row.id,
        0,
        0,
        0,
        1,
        versions.collection,
        versions.state,
        versions.body,
        null,
        createdAt,
      );
    }
    insert.run(
      accountKey,
      null,
      1,
      0,
      0,
      0,
      versions.collection,
      versions.state,
      versions.body,
      JSON.stringify({ navigationChanged: true }),
      createdAt,
    );
  }

  private recordIncrementalChanges(
    accountKey: string,
    generationId: string,
    changes: Array<{
      articleId: string;
      metadata: boolean;
      state: boolean;
      body: boolean;
    }>,
    versions: { collection: number; state: number; body: number },
    createdAt: string,
    navigationChanged = changes.some((change) => change.metadata || change.state),
  ) {
    const insert = this.database.prepare(`
      INSERT INTO reader_change_log
        (account_key, article_id, metadata_changed, state_changed, body_changed, deleted,
          collection_version, state_version, body_version, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `);
    for (const change of changes) {
      insert.run(
        accountKey,
        change.articleId,
        Number(change.metadata),
        Number(change.state),
        Number(change.body),
        versions.collection,
        versions.state,
        versions.body,
        JSON.stringify(this.articleDeltaPayload(generationId, change.articleId)),
        createdAt,
      );
    }
    if (navigationChanged) {
      this.database.prepare(`
        INSERT INTO reader_change_log
          (account_key, article_id, metadata_changed, collection_version, state_version, body_version, payload_json, created_at)
        VALUES (?, NULL, 1, ?, ?, ?, ?, ?)
      `).run(
        accountKey,
        versions.collection,
        versions.state,
        versions.body,
        JSON.stringify({ navigationChanged: true }),
        createdAt,
      );
    }
  }

  knownArticleIds(identity: ReaderCacheIdentity, candidateIds?: string[]) {
    const generationId = this.currentGenerationId(identity.accountKey);
    if (!generationId) return new Set<string>();
    const normalizedCandidates = candidateIds ? new Set(candidateIds.map(normalizeGoogleReaderItemId)) : null;
    const rows = this.database.prepare(`SELECT id FROM reader_articles WHERE generation_id = ?`).all(generationId) as Array<{ id: string }>;
    return new Set(rows
      .map((row) => normalizeGoogleReaderItemId(row.id))
      .filter((id) => !normalizedCandidates || normalizedCandidates.has(id)));
  }

  private insertNewArticle(generationId: string, article: Article) {
    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO reader_articles
        (generation_id, id, feed_id, title, author, source, canonical_url, published_at, reading_minutes, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generationId,
      article.id,
      article.feedId,
      article.title,
      article.author,
      article.source,
      article.canonicalUrl,
      article.publishedAt,
      article.readingMinutes,
      article.summary,
    ).changes === 1;
    if (!inserted) return false;
    this.database.prepare(`INSERT INTO reader_article_bodies (generation_id, article_id, content_html) VALUES (?, ?, ?)`)
      .run(generationId, article.id, article.contentHtml);
    this.database.prepare(`
      INSERT INTO reader_article_state (generation_id, article_id, is_read, is_starred) VALUES (?, ?, ?, ?)
    `).run(generationId, article.id, Number(article.read), Number(article.starred));
    const insertFolder = this.database.prepare(`
      INSERT OR IGNORE INTO reader_article_folders (generation_id, article_id, folder_id) VALUES (?, ?, ?)
    `);
    for (const folderId of new Set(article.folderIds)) insertFolder.run(generationId, article.id, folderId);
    this.database.prepare(`UPDATE reader_cache_generations SET logical_bytes = logical_bytes + ? WHERE id = ?`)
      .run(articleLogicalBytes(article), generationId);
    if (!article.read) {
      this.database.prepare(`
        UPDATE reader_subscriptions SET unread_count = unread_count + 1 WHERE generation_id = ? AND id = ?
      `).run(generationId, article.feedId);
      this.database.prepare(`
        UPDATE reader_folders SET unread_count = unread_count + 1
        WHERE generation_id = ? AND id IN (
          SELECT folder_id FROM reader_article_folders WHERE generation_id = ? AND article_id = ?
        )
      `).run(generationId, generationId, article.id);
    }
    return true;
  }

  applyRoutineDiscovery(
    run: ReaderCacheIncrementalRun,
    articles: Article[],
    subscriptions: Subscription[],
    folders: Folder[],
    cutoffSeconds: number,
    subscriptionFingerprint: string,
  ) {
    const apply = this.database.transaction(() => {
      this.assertLease(run);
      const generationId = this.currentGenerationId(run.accountKey);
      if (!generationId) throw new Error('Reader cache has no committed generation');
      let inserted = 0;
      const insertedIds: string[] = [];
      for (const article of articles) {
        if (this.insertNewArticle(generationId, article)) {
          inserted += 1;
          insertedIds.push(article.id);
        }
      }
      let metadataChanged = 0;
      const updateSubscription = this.database.prepare(`
        UPDATE reader_subscriptions
        SET title = ?, url = ?, site_url = ?, icon_url = ?
        WHERE generation_id = ? AND id = ?
          AND (title IS NOT ? OR url IS NOT ? OR site_url IS NOT ? OR icon_url IS NOT ?)
      `);
      for (const subscription of subscriptions) {
        metadataChanged += updateSubscription.run(
          subscription.title,
          subscription.url,
          subscription.siteUrl,
          subscription.iconUrl,
          generationId,
          subscription.id,
          subscription.title,
          subscription.url,
          subscription.siteUrl,
          subscription.iconUrl,
        ).changes;
      }
      const updateFolder = this.database.prepare(`
        UPDATE reader_folders SET title = ?
        WHERE generation_id = ? AND id = ? AND title IS NOT ?
      `);
      for (const folder of folders) {
        metadataChanged += updateFolder.run(folder.title, generationId, folder.id, folder.title).changes;
      }
      const timestamp = this.timestamp();
      this.database.prepare(`
        INSERT INTO reader_incremental_checkpoints
          (account_key, routine_cutoff_seconds, subscription_fingerprint, last_routine_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          routine_cutoff_seconds = excluded.routine_cutoff_seconds,
          subscription_fingerprint = excluded.subscription_fingerprint,
          last_routine_at = excluded.last_routine_at
      `).run(run.accountKey, cutoffSeconds, subscriptionFingerprint, timestamp);
      this.database.prepare(`UPDATE reader_sync_runs SET items_staged = ? WHERE id = ?`).run(inserted, run.runId);
      if (inserted > 0 || metadataChanged > 0) {
        this.rebuildNavigationActivity(generationId);
        const versions = this.advanceVersions(run.accountKey, generationId, {
          collection: true,
          state: inserted > 0,
          body: inserted > 0,
        });
        this.recordIncrementalChanges(
          run.accountKey,
          generationId,
          insertedIds.map((articleId) => ({ articleId, metadata: true, state: true, body: true })),
          versions,
          timestamp,
          true,
        );
      }
      return { inserted, metadataChanged };
    });
    return apply.immediate();
  }

  applyBodyReconciliation(run: ReaderCacheIncrementalRun, articles: Article[], cutoffSeconds: number) {
    const apply = this.database.transaction(() => {
      this.assertLease(run);
      const generationId = this.currentGenerationId(run.accountKey);
      if (!generationId) throw new Error('Reader cache has no committed generation');
      let inserted = 0;
      let changed = 0;
      let unchanged = 0;
      const incrementalChanges: Array<{ articleId: string; metadata: boolean; state: boolean; body: boolean }> = [];
      for (const article of articles) {
        const existing = this.database.prepare(`
          SELECT a.feed_id, a.title, a.author, a.source, a.canonical_url, a.published_at,
            a.reading_minutes, a.summary, b.content_html
          FROM reader_articles a JOIN reader_article_bodies b
            ON b.generation_id = a.generation_id AND b.article_id = a.id
          WHERE a.generation_id = ? AND a.id = ?
        `).get(generationId, article.id) as {
          feed_id: string; title: string; author: string | null; source: string; canonical_url: string; published_at: string;
          reading_minutes: number; summary: string; content_html: string;
        } | undefined;
        if (!existing) {
          if (this.insertNewArticle(generationId, article)) {
            inserted += 1;
            incrementalChanges.push({ articleId: article.id, metadata: true, state: true, body: true });
          }
          continue;
        }
        const metadataChanged = existing.feed_id !== article.feedId
          || existing.title !== article.title
          || existing.author !== article.author
          || existing.source !== article.source
          || existing.canonical_url !== article.canonicalUrl
          || existing.published_at !== article.publishedAt
          || existing.reading_minutes !== article.readingMinutes
          || existing.summary !== article.summary;
        const bodyChanged = existing.content_html !== article.contentHtml;
        if (!metadataChanged && !bodyChanged) {
          unchanged += 1;
          continue;
        }
        this.database.prepare(`
          UPDATE reader_articles SET feed_id = ?, title = ?, author = ?, source = ?, canonical_url = ?,
            published_at = ?, reading_minutes = ?, summary = ?
          WHERE generation_id = ? AND id = ?
        `).run(
          article.feedId,
          article.title,
          article.author,
          article.source,
          article.canonicalUrl,
          article.publishedAt,
          article.readingMinutes,
          article.summary,
          generationId,
          article.id,
        );
        this.database.prepare(`
          UPDATE reader_article_bodies SET content_html = ? WHERE generation_id = ? AND article_id = ?
        `).run(article.contentHtml, generationId, article.id);
        const priorLogicalBytes = articleCoreLogicalBytes({
          id: article.id,
          feedId: existing.feed_id,
          title: existing.title,
          author: existing.author,
          source: existing.source,
          canonicalUrl: existing.canonical_url,
          publishedAt: existing.published_at,
          readingMinutes: existing.reading_minutes,
          summary: existing.summary,
          contentHtml: existing.content_html,
        });
        const nextLogicalBytes = articleCoreLogicalBytes(article);
        this.database.prepare(`
          UPDATE reader_cache_generations SET logical_bytes = MAX(0, logical_bytes + ?) WHERE id = ?
        `).run(nextLogicalBytes - priorLogicalBytes, generationId);
        if (metadataChanged) {
          this.database.prepare(`DELETE FROM reader_article_folders WHERE generation_id = ? AND article_id = ?`)
            .run(generationId, article.id);
          const insertFolder = this.database.prepare(`
            INSERT OR IGNORE INTO reader_article_folders (generation_id, article_id, folder_id) VALUES (?, ?, ?)
          `);
          for (const folderId of new Set(article.folderIds)) insertFolder.run(generationId, article.id, folderId);
        }
        incrementalChanges.push({ articleId: article.id, metadata: metadataChanged, state: false, body: bodyChanged });
        changed += 1;
      }
      const timestamp = this.timestamp();
      this.database.prepare(`
        INSERT INTO reader_incremental_checkpoints (account_key, body_cutoff_seconds, last_body_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          body_cutoff_seconds = excluded.body_cutoff_seconds,
          last_body_at = excluded.last_body_at
      `).run(run.accountKey, cutoffSeconds, timestamp);
      if (inserted > 0 || changed > 0) {
        const metadataChanged = incrementalChanges.some((change) => change.metadata);
        const stateChanged = incrementalChanges.some((change) => change.state);
        const bodyChanged = incrementalChanges.some((change) => change.body);
        if (metadataChanged || stateChanged) this.rebuildNavigationActivity(generationId);
        const versions = this.advanceVersions(run.accountKey, generationId, {
          collection: metadataChanged,
          state: stateChanged,
          body: bodyChanged,
        });
        this.recordIncrementalChanges(run.accountKey, generationId, incrementalChanges, versions, timestamp);
      }
      return { candidates: articles.length, inserted, changed, unchanged };
    });
    return apply.immediate();
  }

  applyStateReconciliation(run: ReaderCacheIncrementalRun, unreadIds: Set<string>, starredIds: Set<string>) {
    const apply = this.database.transaction(() => {
      this.assertLease(run);
      const generationId = this.currentGenerationId(run.accountKey);
      if (!generationId) throw new Error('Reader cache has no committed generation');
      const rows = this.database.prepare(`
        SELECT article_id, is_read, is_starred FROM reader_article_state WHERE generation_id = ?
      `).all(generationId) as Array<{ article_id: string; is_read: number; is_starred: number }>;
      let changed = 0;
      const changedIds: string[] = [];
      const update = this.database.prepare(`
        UPDATE reader_article_state SET is_read = ?, is_starred = ? WHERE generation_id = ? AND article_id = ?
      `);
      for (const row of rows) {
        const normalized = normalizeGoogleReaderItemId(row.article_id);
        const read = !unreadIds.has(normalized);
        const starred = starredIds.has(normalized);
        if (Boolean(row.is_read) === read && Boolean(row.is_starred) === starred) continue;
        update.run(Number(read), Number(starred), generationId, row.article_id);
        changed += 1;
        changedIds.push(row.article_id);
      }
      const overrides = this.database.prepare(`
        SELECT article_id, operation, value FROM reader_state_overrides WHERE account_key = ?
      `).all(run.accountKey) as Array<{ article_id: string; operation: ArticleMutation['operation']; value: number }>;
      for (const override of overrides) {
        this.applyState(generationId, {
          articleId: override.article_id,
          operation: override.operation,
          value: Boolean(override.value),
        });
      }
      this.database.prepare(`
        UPDATE reader_subscriptions SET unread_count = (
          SELECT COUNT(*) FROM reader_articles a JOIN reader_article_state s
            ON s.generation_id = a.generation_id AND s.article_id = a.id
          WHERE a.generation_id = reader_subscriptions.generation_id
            AND a.feed_id = reader_subscriptions.id AND s.is_read = 0
        ) WHERE generation_id = ?
      `).run(generationId);
      this.database.prepare(`
        UPDATE reader_folders SET unread_count = (
          SELECT COUNT(*) FROM reader_article_folders af JOIN reader_article_state s
            ON s.generation_id = af.generation_id AND s.article_id = af.article_id
          WHERE af.generation_id = reader_folders.generation_id
            AND af.folder_id = reader_folders.id AND s.is_read = 0
        ) WHERE generation_id = ?
      `).run(generationId);
      const timestamp = this.timestamp();
      this.database.prepare(`
        INSERT INTO reader_incremental_checkpoints (account_key, last_state_at) VALUES (?, ?)
        ON CONFLICT(account_key) DO UPDATE SET last_state_at = excluded.last_state_at
      `).run(run.accountKey, timestamp);
      if (changed > 0) {
        this.rebuildNavigationActivity(generationId);
        const versions = this.advanceVersions(run.accountKey, generationId, { collection: false, state: true, body: false });
        this.recordIncrementalChanges(
          run.accountKey,
          generationId,
          [...new Set(changedIds)].map((articleId) => ({ articleId, metadata: false, state: true, body: false })),
          versions,
          timestamp,
        );
      }
      return { scanned: rows.length, changed };
    });
    return apply.immediate();
  }

  private advanceVersions(
    accountKey: string,
    generationId: string,
    changes: { collection: boolean; state: boolean; body: boolean },
  ) {
    const account = this.database.prepare(`
      SELECT collection_version, state_version, body_version FROM reader_accounts WHERE account_key = ?
    `).get(accountKey) as { collection_version: number; state_version: number; body_version: number };
    const versions = {
      collection: account.collection_version + Number(changes.collection),
      state: account.state_version + Number(changes.state),
      body: account.body_version + Number(changes.body),
    };
    this.database.prepare(`
      UPDATE reader_accounts SET collection_version = ?, state_version = ?, body_version = ? WHERE account_key = ?
    `).run(versions.collection, versions.state, versions.body, accountKey);
    this.database.prepare(`
      UPDATE reader_cache_generations SET collection_version = ?, state_version = ?, body_version = ? WHERE id = ?
    `).run(versions.collection, versions.state, versions.body, generationId);
    this.database.prepare(`
      UPDATE reader_sync_checkpoints SET collection_version = ?, state_version = ?, body_version = ? WHERE account_key = ?
    `).run(versions.collection, versions.state, versions.body, accountKey);
    return versions;
  }

  completeIncrementalRun(run: ReaderCacheIncrementalRun, options: { releaseLease?: boolean } = {}) {
    const complete = this.database.transaction(() => {
      this.assertLease(run);
      const timestamp = this.timestamp();
      this.database.prepare(`UPDATE reader_sync_runs SET status = 'succeeded', finished_at = ? WHERE id = ?`)
        .run(timestamp, run.runId);
      this.database.prepare(`
        UPDATE reader_accounts SET last_success_at = ?, last_error = NULL WHERE account_key = ?
      `).run(timestamp, run.accountKey);
      if (options.releaseLease !== false) {
        this.database.prepare(`
          DELETE FROM reader_sync_leases WHERE account_key = ? AND owner_id = ? AND fence_token = ?
        `).run(run.accountKey, run.ownerId, run.fenceToken);
      }
    });
    complete.immediate();
  }

  publish(importRun: ReaderCacheImport) {
    const publish = this.database.transaction(() => {
      this.assertLease(importRun);
      const generation = this.database.prepare(`
        SELECT status, started_at FROM reader_cache_generations WHERE id = ? AND account_key = ? AND fence_token = ?
      `).get(importRun.generationId, importRun.accountKey, importRun.fenceToken) as { status: string; started_at: string } | undefined;
      if (!generation || generation.status !== 'staging') throw new ReaderCacheFencedError();

      const overrides = this.database.prepare(`
        SELECT article_id, operation, value, revision, confirmed_at
        FROM reader_state_overrides WHERE account_key = ? ORDER BY revision
      `).all(importRun.accountKey) as Array<{
        article_id: string;
        operation: ArticleMutation['operation'];
        value: number;
        revision: number;
        confirmed_at: string;
      }>;
      for (const override of overrides) {
        const mutation = { articleId: override.article_id, operation: override.operation, value: Boolean(override.value) };
        const state = this.database.prepare(`
          SELECT is_read, is_starred FROM reader_article_state WHERE generation_id = ? AND article_id = ?
        `).get(importRun.generationId, override.article_id) as { is_read: number; is_starred: number } | undefined;
        const importedValue = override.operation === 'read' ? Boolean(state?.is_read) : Boolean(state?.is_starred);
        if (state && override.confirmed_at <= generation.started_at && importedValue === mutation.value) {
          this.database.prepare(`
            DELETE FROM reader_state_overrides WHERE account_key = ? AND article_id = ? AND operation = ? AND revision = ?
          `).run(importRun.accountKey, override.article_id, override.operation, override.revision);
        } else {
          this.applyState(importRun.generationId, mutation);
        }
      }

      this.rebuildNavigationActivity(importRun.generationId);

      const account = this.database.prepare(`
        SELECT current_generation_id, collection_version, state_version, body_version
        FROM reader_accounts WHERE account_key = ?
      `).get(importRun.accountKey) as {
        current_generation_id: string | null; collection_version: number; state_version: number; body_version: number;
      };
      const versions = {
        collection: account.collection_version + 1,
        state: account.state_version + 1,
        body: account.body_version + 1,
      };
      const committedAt = this.timestamp();
      this.recordPublishedChanges(
        importRun.accountKey,
        account.current_generation_id,
        importRun.generationId,
        versions,
        committedAt,
      );
      this.database.prepare(`
        UPDATE reader_cache_generations SET
          status = 'committed', committed_at = ?, collection_version = ?, state_version = ?, body_version = ?
        WHERE id = ?
      `).run(committedAt, versions.collection, versions.state, versions.body, importRun.generationId);
      this.database.prepare(`
        UPDATE reader_accounts SET current_generation_id = ?, collection_version = ?, state_version = ?, body_version = ?,
          last_success_at = ?, last_error = NULL, storage_deferred_until = NULL, storage_deferral_reason = NULL
        WHERE account_key = ?
      `).run(importRun.generationId, versions.collection, versions.state, versions.body, committedAt, importRun.accountKey);
      this.database.prepare(`
        INSERT INTO reader_sync_checkpoints
          (account_key, generation_id, collection_version, state_version, body_version, committed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          generation_id = excluded.generation_id, collection_version = excluded.collection_version,
          state_version = excluded.state_version, body_version = excluded.body_version,
          committed_at = excluded.committed_at
      `).run(importRun.accountKey, importRun.generationId, versions.collection, versions.state, versions.body, committedAt);
      const cutoffSeconds = Math.floor(Date.parse(importRun.startedAt) / 1_000);
      const subscriptionFingerprint = this.fingerprintGenerationSubscriptions(importRun.generationId);
      this.database.prepare(`
        INSERT INTO reader_incremental_checkpoints
          (account_key, routine_cutoff_seconds, body_cutoff_seconds, subscription_fingerprint,
            last_routine_at, last_state_at, last_body_at, last_full_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          routine_cutoff_seconds = excluded.routine_cutoff_seconds,
          body_cutoff_seconds = excluded.body_cutoff_seconds,
          subscription_fingerprint = excluded.subscription_fingerprint,
          last_routine_at = excluded.last_routine_at,
          last_state_at = excluded.last_state_at,
          last_body_at = excluded.last_body_at,
          last_full_at = excluded.last_full_at
      `).run(
        importRun.accountKey,
        cutoffSeconds,
        cutoffSeconds,
        subscriptionFingerprint,
        committedAt,
        committedAt,
        committedAt,
        committedAt,
      );
      this.database.prepare(`
        UPDATE reader_sync_runs SET status = 'succeeded', finished_at = ? WHERE id = ?
      `).run(committedAt, importRun.runId);
      this.database.prepare(`
        DELETE FROM reader_sync_leases WHERE account_key = ? AND owner_id = ? AND fence_token = ?
      `).run(importRun.accountKey, importRun.ownerId, importRun.fenceToken);
      return versions;
    });
    return publish.immediate();
  }

  fail(importRun: ReaderCacheImport | ReaderCacheIncrementalRun, error: unknown) {
    const message = error instanceof Error ? error.message : 'Reader import failed';
    const timestamp = this.timestamp();
    const fail = this.database.transaction(() => {
      const stillOwned = Boolean(this.database.prepare(`
        SELECT 1 FROM reader_sync_leases WHERE account_key = ? AND owner_id = ? AND fence_token = ?
      `).get(importRun.accountKey, importRun.ownerId, importRun.fenceToken));
      if (importRun.generationId) {
        this.database.prepare(`
          UPDATE reader_cache_generations SET status = 'failed', failed_at = ?, error = ?
          WHERE id = ? AND status = 'staging'
        `).run(timestamp, message, importRun.generationId);
      }
      this.database.prepare(`
        UPDATE reader_sync_runs SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'running'
      `).run(error instanceof ReaderCacheFencedError ? 'fenced' : 'failed', timestamp, message, importRun.runId);
      if (stillOwned) {
        this.database.prepare(`UPDATE reader_accounts SET last_error = ? WHERE account_key = ?`)
          .run(message, importRun.accountKey);
        this.database.prepare(`
          DELETE FROM reader_sync_leases WHERE account_key = ? AND owner_id = ? AND fence_token = ?
        `).run(importRun.accountKey, importRun.ownerId, importRun.fenceToken);
      }
    });
    fail.immediate();
  }

  deferForStorage(lease: ReaderCacheLease, reason: ReaderStorageDeferralReason, retryAfterMs: number) {
    const defer = this.database.transaction(() => {
      this.assertLease(lease);
      const timestamp = this.timestamp();
      const deferredUntil = new Date(this.clock().getTime() + retryAfterMs).toISOString();
      this.database.prepare(`
        UPDATE reader_accounts SET last_attempt_at = ?, last_error = ?,
          storage_deferred_until = ?, storage_deferral_reason = ?
        WHERE account_key = ?
      `).run(
        timestamp,
        'Reader synchronization is deferred until safe storage headroom is available',
        deferredUntil,
        JSON.stringify(reason),
        lease.accountKey,
      );
      this.database.prepare(`
        DELETE FROM reader_sync_leases WHERE account_key = ? AND owner_id = ? AND fence_token = ?
      `).run(lease.accountKey, lease.ownerId, lease.fenceToken);
      return deferredUntil;
    });
    return defer.immediate();
  }

  clearStorageDeferral(accountKey: string) {
    this.database.prepare(`
      UPDATE reader_accounts SET storage_deferred_until = NULL, storage_deferral_reason = NULL
      WHERE account_key = ?
    `).run(accountKey);
  }

  private pruneCandidates(detailLimit: number): ReaderGenerationPruneCandidate[] {
    const timestamp = this.timestamp();
    const rows = this.database.prepare(`
      SELECT generation.id, generation.account_key, generation.generation_number, generation.status,
        generation.started_at
      FROM reader_cache_generations generation
      JOIN reader_accounts account ON account.account_key = generation.account_key
      WHERE generation.id IS NOT account.current_generation_id
        AND NOT (
          generation.status = 'staging' AND EXISTS (
            SELECT 1 FROM reader_sync_leases lease
            WHERE lease.account_key = generation.account_key
              AND lease.fence_token = generation.fence_token
              AND lease.expires_at > ?
          )
        )
      ORDER BY
        CASE generation.status WHEN 'failed' THEN 0 WHEN 'staging' THEN 1 ELSE 2 END,
        generation.generation_number,
        generation.id
    `).all(timestamp) as Array<{
      id: string;
      account_key: string;
      generation_number: number;
      status: ReaderGenerationPruneCandidate['status'];
      started_at: string;
    }>;
    const candidates: ReaderGenerationPruneCandidate[] = rows.map((row) => ({
      generationId: row.id,
      accountKey: row.account_key,
      generationNumber: row.generation_number,
      status: row.status,
      reason: row.status === 'committed' ? 'superseded' : row.status === 'failed' ? 'failed' : 'abandoned',
      articleCount: null,
      bodyBytes: null,
      startedAt: row.started_at,
    }));
    for (const candidate of candidates.slice(0, detailLimit)) {
      const details = this.database.prepare(`
        SELECT COUNT(article.id) AS article_count,
          COALESCE(SUM(LENGTH(body.content_html)), 0) AS body_bytes
        FROM reader_articles article
        LEFT JOIN reader_article_bodies body
          ON body.generation_id = article.generation_id AND body.article_id = article.id
        WHERE article.generation_id = ?
      `).get(candidate.generationId) as { article_count: number; body_bytes: number };
      candidate.articleCount = details.article_count;
      candidate.bodyBytes = details.body_bytes;
    }
    return candidates;
  }

  async prune(options: {
    dryRun?: boolean;
    maxDeletes?: number;
    includeCandidateDetails?: boolean;
    betweenDeletesMs?: number;
  } = {}): Promise<ReaderGenerationPruneResult> {
    const started = performance.now();
    const dryRun = options.dryRun ?? false;
    const maxDeletes = Math.max(0, Math.floor(options.maxDeletes ?? 1));
    const betweenDeletesMs = Math.max(0, Math.floor(options.betweenDeletesMs ?? 0));
    const candidates = this.pruneCandidates(options.includeCandidateDetails ? Number.POSITIVE_INFINITY : maxDeletes);
    const result: ReaderGenerationPruneResult = {
      dryRun,
      maxDeletes,
      candidates,
      deletions: [],
      skipped: [],
      errors: [],
      durationMs: 0,
    };
    if (dryRun || maxDeletes === 0) {
      result.durationMs = performance.now() - started;
      return result;
    }

    for (const candidate of candidates.slice(0, maxDeletes)) {
      const deleteStarted = performance.now();
      try {
        const writerRequested = performance.now();
        this.database.exec('BEGIN IMMEDIATE');
        const writerAcquired = performance.now();
        try {
          // Recheck the account pointer and lease/fence protection while the
          // writer lock is held. A candidate discovered before publication or
          // lease renewal must never be deleted based on stale observations.
          const protectionStarted = performance.now();
          const deletable = this.database.prepare(`
            SELECT 1
            FROM reader_cache_generations generation
            JOIN reader_accounts account ON account.account_key = generation.account_key
            WHERE generation.id = ?
              AND generation.id IS NOT account.current_generation_id
              AND NOT (
                generation.status = 'staging' AND EXISTS (
                  SELECT 1 FROM reader_sync_leases lease
                  WHERE lease.account_key = generation.account_key
                    AND lease.fence_token = generation.fence_token
                    AND lease.expires_at > ?
                )
              )
          `).get(candidate.generationId, this.timestamp());
          const protectionCheckMs = performance.now() - protectionStarted;
          if (!deletable) {
            this.database.exec('COMMIT');
            result.skipped.push({ generationId: candidate.generationId, reason: 'became-protected' });
            continue;
          }

          const searchCountStarted = performance.now();
          const searchRows = this.database.prepare(`
            SELECT COUNT(*) AS count FROM reader_article_search_keys WHERE generation_id = ?
          `).get(candidate.generationId) as { count: number };
          const searchCountMs = performance.now() - searchCountStarted;
          const searchDeleteStarted = performance.now();
          this.database.prepare(`
            DELETE FROM reader_article_search
            WHERE rowid IN (
              SELECT rowid FROM reader_article_search_keys WHERE generation_id = ?
            )
          `).run(candidate.generationId);
          const searchDeleteMs = performance.now() - searchDeleteStarted;
          const searchKeyDeleteStarted = performance.now();
          this.database.prepare(`DELETE FROM reader_article_search_keys WHERE generation_id = ?`)
            .run(candidate.generationId);
          const searchKeyDeleteMs = performance.now() - searchKeyDeleteStarted;
          const generationCascadeStarted = performance.now();
          const deleted = this.database.prepare(`DELETE FROM reader_cache_generations WHERE id = ?`)
            .run(candidate.generationId);
          const generationCascadeMs = performance.now() - generationCascadeStarted;
          if (deleted.changes !== 1) throw new Error('Reader generation disappeared during pruning');
          const commitStarted = performance.now();
          this.database.exec('COMMIT');
          const commitMs = performance.now() - commitStarted;
          const completed = performance.now();
          result.deletions.push({
            ...candidate,
            searchRows: searchRows.count,
            durationMs: completed - deleteStarted,
            writerWaitMs: writerAcquired - writerRequested,
            writerLockMs: completed - writerAcquired,
            phases: {
              protectionCheckMs,
              searchCountMs,
              searchDeleteMs,
              searchKeyDeleteMs,
              generationCascadeMs,
              commitMs,
            },
          });
        } catch (error) {
          if (this.database.inTransaction) this.database.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        result.errors.push({
          generationId: candidate.generationId,
          message: error instanceof Error ? error.message : 'Unknown reader cache pruning error',
        });
        break;
      }
      const hasAnotherCandidate = result.deletions.length + result.skipped.length < Math.min(candidates.length, maxDeletes);
      if (hasAnotherCandidate && betweenDeletesMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, betweenDeletesMs));
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    result.durationMs = performance.now() - started;
    return result;
  }

  applyConfirmedMutations(identity: ReaderCacheIdentity, mutations: ArticleMutation[]) {
    if (mutations.length === 0) return;
    const apply = this.database.transaction(() => {
      this.ensureAccount(identity);
      const account = this.database.prepare(`
        SELECT current_generation_id, collection_version, state_version, body_version
        FROM reader_accounts WHERE account_key = ?
      `).get(identity.accountKey) as {
        current_generation_id: string | null; collection_version: number; state_version: number; body_version: number;
      };
      let revision = account.state_version;
      const confirmedAt = this.timestamp();
      const insertOverride = this.database.prepare(`
        INSERT INTO reader_state_overrides (account_key, article_id, operation, value, revision, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key, article_id, operation) DO UPDATE SET
          value = excluded.value, revision = excluded.revision, confirmed_at = excluded.confirmed_at
      `);
      for (const mutation of mutations) {
        revision += 1;
        insertOverride.run(identity.accountKey, mutation.articleId, mutation.operation, Number(mutation.value), revision, confirmedAt);
        if (account.current_generation_id) {
          this.applyState(account.current_generation_id, mutation);
          this.database.prepare(`
            INSERT INTO reader_change_log
              (account_key, article_id, state_changed, collection_version, state_version, body_version, payload_json, created_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?)
          `).run(
            identity.accountKey,
            mutation.articleId,
            account.collection_version,
            revision,
            account.body_version,
            JSON.stringify(this.articleDeltaPayload(account.current_generation_id, mutation.articleId)),
            confirmedAt,
          );
        }
      }
      this.database.prepare(`UPDATE reader_accounts SET state_version = ? WHERE account_key = ?`)
        .run(revision, identity.accountKey);
      if (account.current_generation_id) {
        this.database.prepare(`UPDATE reader_cache_generations SET state_version = ? WHERE id = ?`)
          .run(revision, account.current_generation_id);
        this.database.prepare(`UPDATE reader_sync_checkpoints SET state_version = ? WHERE account_key = ?`)
          .run(revision, identity.accountKey);
      }
    });
    apply.immediate();
  }

  invalidate(identity: ReaderCacheIdentity) {
    const timestamp = this.timestamp();
    const invalidate = this.database.transaction(() => {
      this.database.prepare(`UPDATE reader_accounts SET invalidated_at = ? WHERE account_key = ?`)
        .run(timestamp, identity.accountKey);
      this.database.prepare(`DELETE FROM reader_sync_leases WHERE account_key = ?`).run(identity.accountKey);
    });
    invalidate.immediate();
  }

  readSnapshot(identity: ReaderCacheIdentity): ReaderSnapshot | null {
    const read = this.database.transaction(() => {
      const account = this.database.prepare(`
        SELECT current_generation_id, last_success_at FROM reader_accounts
        WHERE account_key = ? AND invalidated_at IS NULL
      `).get(identity.accountKey) as { current_generation_id: string | null; last_success_at: string | null } | undefined;
      if (!account?.current_generation_id) return null;
      const generationId = account.current_generation_id;
      const folderRows = this.database.prepare(`
        SELECT id, title, unread_count FROM reader_folders WHERE generation_id = ? ORDER BY title, id
      `).all(generationId) as Array<{ id: string; title: string; unread_count: number }>;
      const subscriptionRows = this.database.prepare(`
        SELECT id, title, url, site_url, icon_url, unread_count
        FROM reader_subscriptions WHERE generation_id = ? ORDER BY title, id
      `).all(generationId) as Array<{
        id: string; title: string; url: string; site_url: string | null; icon_url: string | null; unread_count: number;
      }>;
      const subscriptionFolderRows = this.database.prepare(`
        SELECT subscription_id, folder_id FROM reader_subscription_folders WHERE generation_id = ?
      `).all(generationId) as Array<{ subscription_id: string; folder_id: string }>;
      const articleRows = this.database.prepare(`
        SELECT a.id, a.feed_id, a.title, a.author, a.source, a.canonical_url, a.published_at,
          a.reading_minutes, a.summary, b.content_html, s.is_read, s.is_starred
        FROM reader_articles a
        JOIN reader_article_bodies b ON b.generation_id = a.generation_id AND b.article_id = a.id
        JOIN reader_article_state s ON s.generation_id = a.generation_id AND s.article_id = a.id
        WHERE a.generation_id = ?
        ORDER BY a.published_at DESC, a.id
      `).all(generationId) as Array<{
        id: string; feed_id: string; title: string; author: string | null; source: string; canonical_url: string;
        published_at: string; reading_minutes: number; summary: string; content_html: string; is_read: number; is_starred: number;
      }>;
      const articleFolderRows = this.database.prepare(`
        SELECT article_id, folder_id FROM reader_article_folders WHERE generation_id = ?
      `).all(generationId) as Array<{ article_id: string; folder_id: string }>;
      const scopeRows = this.database.prepare(`
        SELECT id, total_count FROM reader_navigation_activity
        WHERE generation_id = ? AND kind = 'scope'
      `).all(generationId) as Array<{ id: string; total_count: number }>;
      const scopeCounts = new Map(scopeRows.map((row) => [row.id, row.total_count] as const));
      const subscriptionFolders = new Map<string, string[]>();
      for (const row of subscriptionFolderRows) {
        subscriptionFolders.set(row.subscription_id, [...(subscriptionFolders.get(row.subscription_id) ?? []), row.folder_id]);
      }
      const articleFolders = new Map<string, string[]>();
      for (const row of articleFolderRows) {
        articleFolders.set(row.article_id, [...(articleFolders.get(row.article_id) ?? []), row.folder_id]);
      }
      return {
        generatedAt: account.last_success_at ?? nowIso(),
        source: 'google-reader' as const,
        counts: {
          all: scopeCounts.get('all') ?? 0,
          inbox: scopeCounts.get('inbox') ?? 0,
          starred: scopeCounts.get('starred') ?? 0,
          uncategorized: scopeCounts.get('uncategorized') ?? 0,
        },
        folders: folderRows.map((row) => ({ id: row.id, title: row.title, unreadCount: row.unread_count })),
        subscriptions: subscriptionRows.map((row) => ({
          id: row.id,
          title: row.title,
          url: row.url,
          siteUrl: row.site_url,
          iconUrl: row.icon_url,
          folderIds: subscriptionFolders.get(row.id) ?? [],
          unreadCount: row.unread_count,
        })),
        articles: articleRows.map((row) => ({
          id: row.id,
          feedId: row.feed_id,
          folderIds: articleFolders.get(row.id) ?? [],
          title: row.title,
          author: row.author,
          source: row.source,
          canonicalUrl: row.canonical_url,
          publishedAt: row.published_at,
          readingMinutes: row.reading_minutes,
          summary: row.summary,
          contentHtml: row.content_html,
          read: Boolean(row.is_read),
          starred: Boolean(row.is_starred),
        })),
      } satisfies ReaderSnapshot;
    });
    return read.deferred();
  }

  shouldRefresh(identity: ReaderCacheIdentity, minimumIntervalMs: number) {
    const account = this.database.prepare(`
      SELECT last_attempt_at FROM reader_accounts WHERE account_key = ?
    `).get(identity.accountKey) as { last_attempt_at: string | null } | undefined;
    if (!account?.last_attempt_at) return true;
    return this.clock().getTime() - Date.parse(account.last_attempt_at) >= minimumIntervalMs;
  }

  status(identity: ReaderCacheIdentity): ReaderCacheStatus {
    const account = this.database.prepare(`
      SELECT current_generation_id, collection_version, state_version, body_version,
        last_attempt_at, last_success_at, last_error, storage_deferred_until, storage_deferral_reason
      FROM reader_accounts WHERE account_key = ?
    `).get(identity.accountKey) as {
      current_generation_id: string | null;
      collection_version: number;
      state_version: number;
      body_version: number;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      storage_deferred_until: string | null;
      storage_deferral_reason: string | null;
    } | undefined;
    const running = this.database.prepare(`
      SELECT r.items_staged FROM reader_sync_runs r
      JOIN reader_sync_leases l ON l.account_key = r.account_key AND l.fence_token = r.fence_token
      WHERE r.account_key = ? AND r.status = 'running' AND l.expires_at > ?
      ORDER BY r.started_at DESC LIMIT 1
    `).get(identity.accountKey, this.timestamp()) as { items_staged: number } | undefined;
    const hasSnapshot = Boolean(account?.current_generation_id);
    const state = running
      ? (hasSnapshot ? 'refreshing' : 'initializing')
      : account?.last_error && hasSnapshot
        ? 'stale'
        : account?.last_error ? 'empty'
          : hasSnapshot ? 'current' : 'empty';
    let storageDeferral: ReaderCacheStatus['storageDeferral'] = null;
    if (account?.storage_deferred_until && account.storage_deferral_reason) {
      try {
        const reason = JSON.parse(account.storage_deferral_reason) as ReaderStorageDeferralReason;
        if (reason.code === 'reader_storage_deferred') {
          storageDeferral = { until: account.storage_deferred_until, reason };
        }
      } catch {
        storageDeferral = null;
      }
    }
    return {
      state,
      itemsStaged: running?.items_staged ?? 0,
      lastAttemptAt: account?.last_attempt_at ?? null,
      lastSuccessAt: account?.last_success_at ?? null,
      error: account?.last_error ?? null,
      storageDeferral,
      versions: {
        collection: account?.collection_version ?? 0,
        state: account?.state_version ?? 0,
        body: account?.body_version ?? 0,
      },
    };
  }
}
