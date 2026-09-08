import crypto from 'node:crypto';
import type { Article, ArticleMutation, Folder, ReaderSnapshot, Subscription } from '../shared/reader.js';
import type { AppDatabase } from './database.js';
import { newId, nowIso } from './database.js';
import type { GoogleReaderCredentials } from './integrations/google-reader.js';

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

export type ReaderCacheStatus = {
  state: 'empty' | 'initializing' | 'refreshing' | 'current' | 'stale';
  itemsStaged: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
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

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

export class ReaderCache {
  constructor(
    private readonly database: AppDatabase,
    private readonly ownerId = newId(),
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

  stageFolders(importRun: ReaderCacheImport, folders: Folder[]) {
    for (const batch of chunks(folders, READER_IMPORT_BATCH_SIZE)) {
      const stage = this.database.transaction(() => {
        this.assertLease(importRun);
        const insert = this.database.prepare(`
          INSERT INTO reader_folders (generation_id, id, title, unread_count) VALUES (?, ?, ?, ?)
          ON CONFLICT(generation_id, id) DO UPDATE SET title = excluded.title, unread_count = excluded.unread_count
        `);
        for (const folder of batch) insert.run(importRun.generationId, folder.id, folder.title, folder.unreadCount);
      });
      stage.immediate();
      this.heartbeat(importRun);
    }
  }

  stageSubscriptions(importRun: ReaderCacheImport, subscriptions: Subscription[]) {
    for (const batch of chunks(subscriptions, READER_IMPORT_BATCH_SIZE)) {
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
      });
      stage.immediate();
      this.heartbeat(importRun);
    }
  }

  stageArticles(importRun: ReaderCacheImport, articles: Article[]) {
    if (articles.length > READER_IMPORT_BATCH_SIZE) {
      throw new Error(`Reader import batch exceeds ${READER_IMPORT_BATCH_SIZE} articles`);
    }
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
    });
    stage.immediate();
    this.heartbeat(importRun);
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
      this.database.prepare(`
        UPDATE reader_article_state SET is_starred = ? WHERE generation_id = ? AND article_id = ?
      `).run(Number(mutation.value), generationId, mutation.articleId);
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

      const account = this.database.prepare(`
        SELECT collection_version, state_version, body_version FROM reader_accounts WHERE account_key = ?
      `).get(importRun.accountKey) as { collection_version: number; state_version: number; body_version: number };
      const versions = {
        collection: account.collection_version + 1,
        state: account.state_version + 1,
        body: account.body_version + 1,
      };
      const committedAt = this.timestamp();
      this.database.prepare(`
        UPDATE reader_cache_generations SET
          status = 'committed', committed_at = ?, collection_version = ?, state_version = ?, body_version = ?
        WHERE id = ?
      `).run(committedAt, versions.collection, versions.state, versions.body, importRun.generationId);
      this.database.prepare(`
        UPDATE reader_accounts SET current_generation_id = ?, collection_version = ?, state_version = ?, body_version = ?,
          last_success_at = ?, last_error = NULL
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

  fail(importRun: ReaderCacheImport, error: unknown) {
    const message = error instanceof Error ? error.message : 'Reader import failed';
    const timestamp = this.timestamp();
    const fail = this.database.transaction(() => {
      const stillOwned = Boolean(this.database.prepare(`
        SELECT 1 FROM reader_sync_leases WHERE account_key = ? AND owner_id = ? AND fence_token = ?
      `).get(importRun.accountKey, importRun.ownerId, importRun.fenceToken));
      this.database.prepare(`
        UPDATE reader_cache_generations SET status = 'failed', failed_at = ?, error = ?
        WHERE id = ? AND status = 'staging'
      `).run(timestamp, message, importRun.generationId);
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

  applyConfirmedMutations(identity: ReaderCacheIdentity, mutations: ArticleMutation[]) {
    if (mutations.length === 0) return;
    const apply = this.database.transaction(() => {
      this.ensureAccount(identity);
      const account = this.database.prepare(`
        SELECT current_generation_id, state_version FROM reader_accounts WHERE account_key = ?
      `).get(identity.accountKey) as { current_generation_id: string | null; state_version: number };
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
        if (account.current_generation_id) this.applyState(account.current_generation_id, mutation);
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
        last_attempt_at, last_success_at, last_error
      FROM reader_accounts WHERE account_key = ?
    `).get(identity.accountKey) as {
      current_generation_id: string | null;
      collection_version: number;
      state_version: number;
      body_version: number;
      last_attempt_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
    } | undefined;
    const running = this.database.prepare(`
      SELECT r.items_staged FROM reader_sync_runs r
      JOIN reader_sync_leases l ON l.account_key = r.account_key AND l.fence_token = r.fence_token
      WHERE r.account_key = ? AND r.status = 'running' AND l.expires_at > ?
      ORDER BY r.started_at DESC LIMIT 1
    `).get(identity.accountKey, this.timestamp()) as { items_staged: number } | undefined;
    const hasSnapshot = Boolean(account?.current_generation_id);
    const state = account?.last_error && hasSnapshot
      ? 'stale'
      : running
        ? (hasSnapshot ? 'refreshing' : 'initializing')
        : account?.last_error ? 'empty'
          : hasSnapshot ? 'current' : 'empty';
    return {
      state,
      itemsStaged: running?.items_staged ?? 0,
      lastAttemptAt: account?.last_attempt_at ?? null,
      lastSuccessAt: account?.last_success_at ?? null,
      error: account?.last_error ?? null,
      versions: {
        collection: account?.collection_version ?? 0,
        state: account?.state_version ?? 0,
        body: account?.body_version ?? 0,
      },
    };
  }
}
