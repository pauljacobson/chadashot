import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader.js';
import { openDatabase, openMemoryDatabase } from './database.js';
import {
  ReaderCache,
  ReaderCacheFencedError,
  readerSubscriptionFingerprint,
  type ReaderCacheIdentity,
  type ReaderCacheImport,
} from './reader-cache.js';

const identity: ReaderCacheIdentity = {
  accountKey: 'account-1',
  providerIdentity: 'provider-1',
  credentialGeneration: 'credentials-1',
};

function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    feedId: 'feed-1',
    folderIds: ['folder-1'],
    title: `Article ${id}`,
    author: null,
    source: 'Feed',
    canonicalUrl: `https://example.test/${id}`,
    publishedAt: '2026-09-08T00:00:00.000Z',
    readingMinutes: 2,
    summary: `Summary ${id}`,
    contentHtml: `<p>Body ${id}</p>`,
    read: false,
    starred: false,
    ...overrides,
  };
}

function snapshot(articles = [article('article-1')]): ReaderSnapshot {
  return {
    generatedAt: '2026-09-08T00:00:00.000Z',
    source: 'google-reader',
    folders: [{ id: 'folder-1', title: 'Folder', unreadCount: articles.filter((item) => !item.read).length }],
    subscriptions: [{
      id: 'feed-1',
      title: 'Feed',
      url: 'https://example.test/feed',
      siteUrl: 'https://example.test',
      iconUrl: null,
      folderIds: ['folder-1'],
      unreadCount: articles.filter((item) => !item.read).length,
    }],
    articles,
  };
}

function begin(cache: ReaderCache, cacheIdentity = identity) {
  const lease = cache.acquireLease(cacheIdentity);
  expect(lease).not.toBeNull();
  return cache.beginImport(lease!);
}

function stage(cache: ReaderCache, run: ReaderCacheImport, value: ReaderSnapshot) {
  cache.stageFolders(run, value.folders);
  cache.stageSubscriptions(run, value.subscriptions);
  for (let offset = 0; offset < value.articles.length; offset += 500) {
    cache.stageArticles(run, value.articles.slice(offset, offset + 500));
  }
}

function publish(cache: ReaderCache, value: ReaderSnapshot, cacheIdentity = identity) {
  const run = begin(cache, cacheIdentity);
  stage(cache, run, value);
  cache.publish(run);
  return run;
}

describe('transactional reader cache', () => {
  it('publishes normalized metadata, bodies, state, and relationships atomically', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const value = snapshot([article('article-1'), article('article-2', { read: true, starred: true })]);

    publish(cache, value);

    expect(cache.readSnapshot(identity)).toMatchObject({
      source: 'google-reader',
      counts: { all: 2, inbox: 1, starred: 1, uncategorized: 0 },
      folders: value.folders,
      subscriptions: value.subscriptions,
      articles: value.articles,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_article_bodies').get()).toEqual({ count: 2 });
    expect(cache.status(identity)).toMatchObject({
      state: 'current',
      versions: { collection: 1, state: 1, body: 1 },
    });
  });

  it('upserts duplicate article IDs within a staged generation', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const run = begin(cache);
    stage(cache, run, snapshot([]));
    cache.stageArticles(run, [article('duplicate', { title: 'Old' })]);
    cache.stageArticles(run, [article('duplicate', { title: 'New', contentHtml: '<p>New body</p>' })]);
    cache.publish(run);

    expect(cache.readSnapshot(identity)?.articles).toEqual([
      expect.objectContaining({ id: 'duplicate', title: 'New', contentHtml: '<p>New body</p>' }),
    ]);
  });

  it('retains every article while enforcing bounded staging transactions', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const articles = Array.from({ length: 1_205 }, (_, index) => article(`article-${index}`));

    const oversizedRun = begin(cache);
    expect(() => cache.stageArticles(oversizedRun, articles.slice(0, 501))).toThrow('exceeds 500');
    cache.fail(oversizedRun, new Error('oversized batch rejected'));

    publish(cache, snapshot(articles));

    expect(cache.readSnapshot(identity)?.articles).toHaveLength(1_205);
  });

  it('keeps the last good generation readable when a later import crashes', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const committed = snapshot([article('committed')]);
    publish(cache, committed);
    const checkpoint = database.prepare('SELECT * FROM reader_sync_checkpoints WHERE account_key = ?').get(identity.accountKey);

    const interrupted = begin(cache);
    cache.stageFolders(interrupted, snapshot([article('partial')]).folders);
    cache.stageSubscriptions(interrupted, snapshot([article('partial')]).subscriptions);
    cache.stageArticles(interrupted, [article('partial')]);
    cache.fail(interrupted, new Error('provider stopped'));

    expect(cache.readSnapshot(identity)?.articles.map((item) => item.id)).toEqual(['committed']);
    expect(database.prepare('SELECT * FROM reader_sync_checkpoints WHERE account_key = ?').get(identity.accountKey)).toEqual(checkpoint);
    expect(cache.status(identity)).toMatchObject({ state: 'stale', error: 'provider stopped' });
  });

  it('recovers an expired lease and fences the old worker from publishing', () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-09-08T00:00:00.000Z');
    const oldWorker = new ReaderCache(database, 'old-worker', 1_000, () => now);
    const oldRun = begin(oldWorker);
    stage(oldWorker, oldRun, snapshot([article('old')]));

    now = new Date('2026-09-08T00:00:02.000Z');
    const recoveredWorker = new ReaderCache(database, 'new-worker', 1_000, () => now);
    const recoveredRun = begin(recoveredWorker);
    stage(recoveredWorker, recoveredRun, snapshot([article('new')]));
    recoveredWorker.publish(recoveredRun);

    let fencedError: unknown;
    try {
      oldWorker.publish(oldRun);
    } catch (error) {
      fencedError = error;
    }
    expect(fencedError).toBeInstanceOf(ReaderCacheFencedError);
    oldWorker.fail(oldRun, fencedError);
    expect(recoveredRun.fenceToken).toBeGreaterThan(oldRun.fenceToken);
    expect(recoveredWorker.readSnapshot(identity)?.articles[0].id).toBe('new');
    expect(recoveredWorker.status(identity)).toMatchObject({ state: 'current', error: null });
  });

  it('does not let a full import race revert a confirmed mutation', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    publish(cache, snapshot([article('article-1', { read: false })]));

    const staleImport = begin(cache);
    stage(cache, staleImport, snapshot([article('article-1', { read: false })]));
    cache.applyConfirmedMutations(identity, [{ articleId: 'article-1', operation: 'read', value: true }]);
    cache.publish(staleImport);

    const result = cache.readSnapshot(identity)!;
    expect(result.articles[0].read).toBe(true);
    expect(result.subscriptions[0].unreadCount).toBe(0);
    expect(result.folders[0].unreadCount).toBe(0);
  });

  it('publishes subscription removals only when the new generation commits', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const first = snapshot();
    first.subscriptions.push({ ...first.subscriptions[0], id: 'removed-feed', title: 'Removed' });
    publish(cache, first);

    const replacement = snapshot();
    publish(cache, replacement);

    expect(cache.readSnapshot(identity)?.subscriptions.map((subscription) => subscription.id)).toEqual(['feed-1']);
  });

  it('isolates a credential change from the prior account generation', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    publish(cache, snapshot(), identity);
    const changedIdentity = { ...identity, accountKey: 'account-2', credentialGeneration: 'credentials-2' };

    expect(cache.readSnapshot(changedIdentity)).toBeNull();
    expect(cache.status(changedIdentity).state).toBe('empty');
  });

  it('does not start another full refresh inside the configured interval', () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-09-08T00:00:00.000Z');
    const cache = new ReaderCache(database, 'worker-1', 45_000, () => now);
    publish(cache, snapshot());

    expect(cache.shouldRefresh(identity, 180_000)).toBe(false);
    now = new Date('2026-09-08T00:03:00.000Z');
    expect(cache.shouldRefresh(identity, 180_000)).toBe(true);
  });

  it('plans routine, state, body, and full work on independent cadences', () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-09-08T00:00:00.000Z');
    const cache = new ReaderCache(database, 'worker-1', 45_000, () => now);
    publish(cache, snapshot());
    const cadence = { routineMs: 180_000, stateMs: 900_000, bodyMs: 21_600_000, fullMs: 86_400_000, overlapSeconds: 21_600 };

    expect(cache.syncPlan(identity, cadence)).toMatchObject({ full: false, routine: false, state: false, body: false });
    now = new Date('2026-09-08T00:03:00.000Z');
    expect(cache.syncPlan(identity, cadence)).toMatchObject({ full: false, routine: true, state: false, body: false });
    now = new Date('2026-09-08T00:15:00.000Z');
    expect(cache.syncPlan(identity, cadence)).toMatchObject({ full: false, routine: true, state: true, body: false });
    now = new Date('2026-09-09T00:00:00.000Z');
    expect(cache.syncPlan(identity, cadence)).toMatchObject({ full: true, routine: true, state: true, body: true });
  });

  it('commits overlapping new-item discovery and its checkpoint atomically', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const initial = snapshot([article('known')]);
    publish(cache, initial);
    const fingerprint = readerSubscriptionFingerprint(initial.subscriptions, initial.folders);
    expect(cache.subscriptionFingerprint(identity)).toBe(fingerprint);
    const lease = cache.acquireLease(identity)!;
    const run = cache.beginIncrementalRun(lease);

    const result = cache.applyRoutineDiscovery(run, [
      article('known'),
      article('backdated', { publishedAt: '2020-01-01T00:00:00.000Z' }),
      article('same-timestamp-a'),
      article('same-timestamp-b'),
      article('same-timestamp-a'),
    ], 1_788_825_600, fingerprint);
    cache.completeIncrementalRun(run);

    expect(result.inserted).toBe(3);
    expect(cache.readSnapshot(identity)?.articles.map((item) => item.id).sort()).toEqual([
      'backdated', 'known', 'same-timestamp-a', 'same-timestamp-b',
    ]);
    expect(cache.status(identity).versions).toEqual({ collection: 2, state: 2, body: 2 });
    expect(database.prepare(`
      SELECT routine_cutoff_seconds, subscription_fingerprint FROM reader_incremental_checkpoints WHERE account_key = ?
    `).get(identity.accountKey)).toEqual({ routine_cutoff_seconds: 1_788_825_600, subscription_fingerprint: fingerprint });
  });

  it('does not advance an incremental checkpoint after an interrupted transaction', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const initial = snapshot([article('known')]);
    publish(cache, initial);
    const before = database.prepare(`SELECT * FROM reader_incremental_checkpoints WHERE account_key = ?`).get(identity.accountKey);
    const lease = cache.acquireLease(identity)!;
    const run = cache.beginIncrementalRun(lease);
    database.prepare(`DELETE FROM reader_sync_leases WHERE account_key = ?`).run(identity.accountKey);

    expect(() => cache.applyRoutineDiscovery(
      run,
      [article('not-committed')],
      1_788_825_600,
      readerSubscriptionFingerprint(initial.subscriptions, initial.folders),
    )).toThrow(ReaderCacheFencedError);

    expect(cache.readSnapshot(identity)?.articles.map((item) => item.id)).toEqual(['known']);
    expect(database.prepare(`SELECT * FROM reader_incremental_checkpoints WHERE account_key = ?`).get(identity.accountKey)).toEqual(before);
  });

  it('reconciles changed bodies and authoritative state without reverting confirmed local writes', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    publish(cache, snapshot([
      article('changed', { read: true, contentHtml: '<p>Old</p>' }),
      article('unchanged', { read: true }),
    ]));
    cache.applyConfirmedMutations(identity, [{ articleId: 'changed', operation: 'read', value: true }]);
    const lease = cache.acquireLease(identity)!;
    const run = cache.beginIncrementalRun(lease, 'body');

    const bodies = cache.applyBodyReconciliation(run, [
      article('changed', { read: false, contentHtml: '<p>Updated</p>' }),
      article('unchanged', { read: false }),
    ], 1_788_825_600);
    const state = cache.applyStateReconciliation(run, new Set(['changed']), new Set(['unchanged']));
    cache.completeIncrementalRun(run);

    expect(bodies).toEqual({ candidates: 2, inserted: 0, changed: 1, unchanged: 1 });
    expect(state.scanned).toBe(2);
    expect(cache.readSnapshot(identity)?.articles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'changed', contentHtml: '<p>Updated</p>', read: true }),
      expect.objectContaining({ id: 'unchanged', read: true, starred: true }),
    ]));
  });

  it('exposes bounded initialization progress and a retryable empty-cache error', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const run = begin(cache);
    cache.stageArticles(run, [article('one'), article('two')]);

    expect(cache.status(identity)).toMatchObject({ state: 'initializing', itemsStaged: 2 });
    cache.fail(run, new Error('temporary provider failure'));
    expect(cache.status(identity)).toMatchObject({ state: 'empty', error: 'temporary provider failure' });
  });

  it('restores a committed generation from a serialized SQLite backup', () => {
    const sourceDatabase = openMemoryDatabase();
    const sourceCache = new ReaderCache(sourceDatabase, 'worker-1');
    publish(sourceCache, snapshot([article('restored')]));
    const backup = sourceDatabase.serialize();
    sourceDatabase.close();

    const restoredDatabase = new Database(backup);
    restoredDatabase.pragma('foreign_keys = ON');
    const restored = new ReaderCache(restoredDatabase, 'worker-2').readSnapshot(identity);
    restoredDatabase.close();

    expect(restored?.articles[0]).toMatchObject({ id: 'restored', contentHtml: '<p>Body restored</p>' });
  });

  it('keeps ten full imports bounded to the current generation and preserves search data', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');

    for (let generation = 1; generation <= 10; generation += 1) {
      publish(cache, snapshot([
        article(`shared-${generation}`, { title: `Searchable generation ${generation}` }),
        article(`retained-${generation}`, { contentHtml: `<p>${'body '.repeat(200)}</p>` }),
      ]));
      await cache.prune({ maxDeletes: 1 });
    }

    expect(database.prepare('SELECT id, status FROM reader_cache_generations').all()).toEqual([
      expect.objectContaining({ status: 'committed' }),
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_articles').get()).toEqual({ count: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_article_bodies').get()).toEqual({ count: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_article_search').get()).toEqual({ count: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_article_search_keys').get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT article_id FROM reader_article_search WHERE reader_article_search MATCH 'Searchable'
    `).all()).toEqual([{ article_id: 'shared-10' }]);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('protects every account current generation and only a correctly leased staging generation', async () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-09-08T00:00:00.000Z');
    const first = new ReaderCache(database, 'first-worker', 1_000, () => now);
    const secondIdentity = { ...identity, accountKey: 'account-2', providerIdentity: 'provider-2' };
    publish(first, snapshot([article('first-current')]), identity);
    publish(first, snapshot([article('first-replacement')]), identity);
    publish(first, snapshot([article('second-current')]), secondIdentity);
    const failed = begin(first, identity);
    first.stageArticles(failed, [article('failed-staging')]);
    first.fail(failed, new Error('provider failed'));
    const active = begin(first, secondIdentity);
    first.stageArticles(active, [article('active-staging')]);

    now = new Date('2026-09-08T00:00:00.500Z');
    const dryRun = await first.prune({ dryRun: true, maxDeletes: 20 });
    expect(dryRun.candidates.map((candidate) => candidate.generationId)).not.toContain(active.generationId);
    expect(dryRun.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountKey: identity.accountKey, reason: 'superseded' }),
      expect.objectContaining({ generationId: failed.generationId, reason: 'failed' }),
    ]));

    now = new Date('2026-09-08T00:00:02.000Z');
    const pruned = await first.prune({ maxDeletes: 20 });
    expect(pruned.deletions).toEqual(expect.arrayContaining([
      expect.objectContaining({ generationId: active.generationId, reason: 'abandoned' }),
      expect.objectContaining({ generationId: failed.generationId, reason: 'failed' }),
    ]));
    const retained = database.prepare(`
      SELECT account_key, id FROM reader_cache_generations ORDER BY account_key
    `).all();
    expect(retained).toHaveLength(2);
    expect(retained).toEqual(expect.arrayContaining([
      expect.objectContaining({ account_key: identity.accountKey }),
      expect.objectContaining({ account_key: secondIdentity.accountKey }),
    ]));
    expect(() => first.stageArticles(active, [article('stale')])).toThrow(ReaderCacheFencedError);
  });

  it('makes dry-run idempotent and uses the generation index for FTS pruning', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    publish(cache, snapshot([article('old')]));
    publish(cache, snapshot([article('current')]));
    const before = database.serialize();

    const first = await cache.prune({ dryRun: true, maxDeletes: 1 });
    const second = await cache.prune({ dryRun: true, maxDeletes: 1 });

    expect(first.candidates).toEqual(second.candidates);
    expect(first.deletions).toEqual([]);
    expect(database.serialize()).toEqual(before);
    const plan = database.prepare(`
      EXPLAIN QUERY PLAN SELECT rowid FROM reader_article_search_keys WHERE generation_id = ?
    `).all(first.candidates[0]!.generationId) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('reader_article_search_keys_generation'))).toBe(true);
  });

  it('reuses freed pages on later full imports instead of growing with generation history', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-reader-reuse-'));
    const database = openDatabase(dataDir);
    const cache = new ReaderCache(database, 'file-worker');
    const value = snapshot(Array.from({ length: 300 }, (_, index) => article(`article-${index}`, {
      contentHtml: `<p>${'production-shaped body '.repeat(200)}</p>`,
    })));

    publish(cache, value);
    publish(cache, value);
    await cache.prune({ maxDeletes: 1 });
    const pageCountAfterPrune = Number(database.pragma('page_count', { simple: true }));
    const freePagesAfterPrune = Number(database.pragma('freelist_count', { simple: true }));
    expect(freePagesAfterPrune).toBeGreaterThan(0);

    publish(cache, value);
    const pageCountAfterReuse = Number(database.pragma('page_count', { simple: true }));
    const freePagesAfterReuse = Number(database.pragma('freelist_count', { simple: true }));
    expect(freePagesAfterReuse).toBeLessThan(freePagesAfterPrune);
    expect(pageCountAfterReuse).toBeLessThanOrEqual(pageCountAfterPrune + 128);
    await cache.prune({ maxDeletes: 1 });

    for (let generation = 4; generation <= 10; generation += 1) {
      publish(cache, value);
      await cache.prune({ maxDeletes: 1 });
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_cache_generations').get()).toEqual({ count: 1 });
    expect(Number(database.pragma('page_count', { simple: true }))).toBeLessThanOrEqual(pageCountAfterPrune + 256);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    database.close();
  }, 20_000);
});
