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
  READER_IMPORT_RESUME_MAX_AGE_MS,
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
  it('resumes a checkpoint from disk after a crash and fences the previous writer', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-import-resume-'));
    let now = new Date('2026-10-23T00:00:00.000Z');
    let database = openDatabase(directory);
    const cache = new ReaderCache(database, 'before-crash', 45_000, () => now);
    const value = snapshot([article('first'), article('second')]);
    const first = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportStructure(first.run, value.folders, value.subscriptions);
    cache.stageImportPage(first.run, [article('first')], 'next-page');
    expect(() => cache.publish(first.run)).toThrow('incomplete');
    database.close();

    now = new Date(now.getTime() + 60_000);
    database = openDatabase(directory);
    const restarted = new ReaderCache(database, 'after-crash', 45_000, () => now);
    expect((await restarted.prune({ maxDeletes: 100 })).deletions).toEqual([]);
    const resumed = restarted.beginResumableImport(restarted.acquireLease(identity)!);
    expect(resumed.run.generationId).toBe(first.run.generationId);
    expect(resumed.checkpoint).toEqual({ continuation: 'next-page', contentComplete: false });
    expect(resumed.itemsStaged).toBe(1);
    const staleWriter = new ReaderCache(database, 'before-crash', 45_000, () => now);
    expect(() => staleWriter.stageImportPage(first.run, [article('stale')], null)).toThrow(ReaderCacheFencedError);
    // Even a late error handler from the old process must not destroy new progress.
    staleWriter.fail(first.run, new ReaderCacheFencedError());
    restarted.stageImportStructure(resumed.run, value.folders, value.subscriptions);
    restarted.stageImportPage(resumed.run, [article('first'), article('second')], null);
    restarted.applyConfirmedMutations(identity, [
      { articleId: 'first', operation: 'starred', value: true },
      { articleId: 'second', operation: 'read', value: true },
    ]);
    restarted.reconcileImportState(resumed.run, new Set(['second']), new Set());
    restarted.publish(resumed.run);
    expect(restarted.readSnapshot(identity)!.articles.map(({ id, read, starred }) => ({ id, read, starred })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([{ id: 'first', read: true, starred: true }, { id: 'second', read: true, starred: false }]);
    expect(restarted.readSnapshot(identity)!.subscriptions[0].unreadCount).toBe(0);
    expect(restarted.readSnapshot(identity)!.folders[0].unreadCount).toBe(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
    database.close();
  });

  it('rolls back all page batches and the continuation when a later batch cannot be staged', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    const { run } = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportPage(run, [article('saved')], 'next');
    database.exec(`CREATE TRIGGER reject_article BEFORE INSERT ON reader_article_bodies
      WHEN new.article_id = 'rejected' BEGIN SELECT RAISE(ABORT, 'disk write failed'); END`);
    expect(() => cache.stageImportPage(run, [
      ...Array.from({ length: 500 }, (_, index) => article(`page-${index}`)), article('rejected'),
    ], 'later')).toThrow('disk write failed');
    expect(database.prepare('SELECT id FROM reader_articles').all()).toEqual([{ id: 'saved' }]);
    expect(database.prepare('SELECT continuation, pages_staged FROM reader_import_progress').get())
      .toEqual({ continuation: 'next', pages_staged: 1 });
    expect(database.prepare('SELECT items_staged FROM reader_sync_runs').get()).toEqual({ items_staged: 1 });
  });

  it('bounds abandoned resume data by age and removes invalidated account progress', async () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-10-23T00:00:00.000Z');
    const cache = new ReaderCache(database, 'worker', 45_000, () => now);
    const { run } = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportPage(run, [article('saved')], 'next');
    cache.fail(run, new Error('timeout'), true);
    expect((await cache.prune()).deletions).toEqual([]);
    now = new Date(now.getTime() + READER_IMPORT_RESUME_MAX_AGE_MS + 1);
    expect((await cache.prune()).deletions.map((entry) => entry.generationId)).toEqual([run.generationId]);
    const replacement = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportPage(replacement.run, [article('saved')], 'next');
    cache.fail(replacement.run, new Error('timeout'), true);
    cache.invalidate(identity);
    expect((await cache.prune()).deletions.map((entry) => entry.generationId)).toEqual([replacement.run.generationId]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
  });

  it('remembers continuation cycles across separate attempts', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    const first = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportPage(first.run, [article('first')], 'token-a');
    cache.fail(first.run, new Error('timeout'), true);
    const second = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportPage(second.run, [article('second')], 'token-b');
    cache.fail(second.run, new Error('timeout'), true);
    const third = cache.beginResumableImport(cache.acquireLease(identity)!);
    expect(() => cache.stageImportPage(third.run, [article('third')], 'token-a')).toThrow('repeating continuation');
    expect(database.prepare('SELECT id FROM reader_articles ORDER BY id').all()).toEqual([{ id: 'first' }, { id: 'second' }]);
  });

  it('does not keep scheduling full imports for expired progress after a replacement succeeds', () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-10-23T00:00:00.000Z');
    const cache = new ReaderCache(database, 'worker', 45_000, () => now);
    publish(cache, snapshot());
    const abandoned = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportPage(abandoned.run, [article('partial')], 'next');
    cache.fail(abandoned.run, new Error('timeout'), true);
    now = new Date(now.getTime() + READER_IMPORT_RESUME_MAX_AGE_MS + 1);
    const replacement = cache.beginResumableImport(cache.acquireLease(identity)!);
    cache.stageImportStructure(replacement.run, snapshot().folders, snapshot().subscriptions);
    cache.stageImportPage(replacement.run, [article('replacement')], null);
    cache.publish(replacement.run);
    // Auto-pruning may be disabled or deferred; old progress must not force work.
    expect(cache.syncPlan(identity, { routineMs: 180_000, stateMs: 900_000, bodyMs: 21_600_000,
      fullMs: 86_400_000, overlapSeconds: 21_600 })).toMatchObject({ full: false });
  });

  it('fingerprints subscription structure without volatile provider metadata', () => {
    const value = snapshot();
    const initial = readerSubscriptionFingerprint(value.subscriptions, value.folders);
    const metadataChanged = readerSubscriptionFingerprint(
      value.subscriptions.map((subscription) => ({
        ...subscription,
        title: 'Renamed feed',
        url: 'https://changed.example.test/feed',
        siteUrl: 'https://changed.example.test',
        iconUrl: 'https://changed.example.test/icon.png',
        unreadCount: 42,
      })),
      value.folders.map((folder) => ({ ...folder, title: 'Renamed folder', unreadCount: 42 })),
    );
    const membershipChanged = readerSubscriptionFingerprint(
      value.subscriptions.map((subscription) => ({ ...subscription, folderIds: ['folder-2'] })),
      value.folders,
    );

    expect(metadataChanged).toBe(initial);
    expect(membershipChanged).not.toBe(initial);
  });

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

  it('prefers the current structural fingerprint over a legacy checkpoint hash', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const value = snapshot();
    publish(cache, value);
    database.prepare(`
      UPDATE reader_incremental_checkpoints SET subscription_fingerprint = ? WHERE account_key = ?
    `).run('legacy-metadata-sensitive-hash', identity.accountKey);

    const plan = cache.syncPlan(identity, {
      routineMs: 180_000,
      stateMs: 900_000,
      bodyMs: 21_600_000,
      fullMs: 86_400_000,
      overlapSeconds: 21_600,
    });

    expect(plan.subscriptionFingerprint).toBe(readerSubscriptionFingerprint(value.subscriptions, value.folders));
  });

  it('allows routine discovery after a failed overdue full import, including after restart', () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-09-22T00:00:00.000Z');
    const cache = new ReaderCache(database, 'worker-1', 45_000, () => now);
    publish(cache, snapshot());
    now = new Date('2026-09-24T00:00:00.000Z');
    const run = begin(cache);
    cache.stageArticles(run, [article('unpublished')]);
    cache.fail(run, new Error('provider deadline'));
    const restarted = new ReaderCache(database, 'worker-2', 45_000, () => now);
    const cadence = { routineMs: 180_000, stateMs: 900_000, bodyMs: 21_600_000, fullMs: 86_400_000, fullRetryMs: 21_600_000, overlapSeconds: 21_600 };

    expect(restarted.syncPlan(identity, cadence)).toMatchObject({ full: false, routine: true });
    const incremental = restarted.beginIncrementalRun(restarted.acquireLease(identity)!, 'routine');
    const value = snapshot();
    restarted.applyRoutineDiscovery(incremental, [article('fresh')], value.subscriptions, value.folders, Math.floor(now.getTime() / 1_000), readerSubscriptionFingerprint(value.subscriptions, value.folders));
    restarted.completeIncrementalRun(incremental);
    expect(restarted.readSnapshot(identity)!.articles.map((item) => item.id).sort()).toEqual(['article-1', 'fresh']);
    expect(restarted.syncPlan(identity, cadence).full).toBe(false);
    now = new Date(now.getTime() + 21_600_000);
    expect(restarted.syncPlan(identity, cadence).full).toBe(true);
  });

  it('backs off failed first imports without attempting incremental work on an empty cache', () => {
    const database = openMemoryDatabase();
    let now = new Date('2026-09-24T00:00:00.000Z');
    const cache = new ReaderCache(database, 'worker-1', 45_000, () => now);
    cache.fail(begin(cache), new Error('provider deadline'));
    const cadence = { routineMs: 180_000, stateMs: 900_000, bodyMs: 21_600_000, fullMs: 86_400_000, fullRetryMs: 21_600_000, overlapSeconds: 21_600 };
    expect(cache.syncPlan(identity, cadence)).toMatchObject({ full: false, routine: false, state: false, body: false });
    // A first import has nothing usable to serve and needs a shorter retry.
    now = new Date(now.getTime() + 180_000);
    expect(cache.syncPlan(identity, cadence).full).toBe(true);
  });

  it('reports a live retry as refreshing even if the preceding attempt failed', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    publish(cache, snapshot());
    cache.fail(begin(cache), new Error('provider deadline'));
    const run = cache.beginIncrementalRun(cache.acquireLease(identity)!, 'routine');
    expect(cache.status(identity)).toMatchObject({ state: 'refreshing', error: 'provider deadline' });
    cache.completeIncrementalRun(run);
    expect(cache.status(identity)).toMatchObject({ state: 'current', error: null });
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
    ], initial.subscriptions, initial.folders, 1_788_825_600, fingerprint);
    cache.completeIncrementalRun(run);

    expect(result).toEqual({ inserted: 3, metadataChanged: 0 });
    expect(cache.readSnapshot(identity)?.articles.map((item) => item.id).sort()).toEqual([
      'backdated', 'known', 'same-timestamp-a', 'same-timestamp-b',
    ]);
    expect(cache.status(identity).versions).toEqual({ collection: 2, state: 2, body: 2 });
    expect(database.prepare(`
      SELECT routine_cutoff_seconds, subscription_fingerprint FROM reader_incremental_checkpoints WHERE account_key = ?
    `).get(identity.accountKey)).toEqual({ routine_cutoff_seconds: 1_788_825_600, subscription_fingerprint: fingerprint });
  });

  it('refreshes subscription metadata without replacing the current generation', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    const initial = snapshot([article('known')]);
    const published = publish(cache, initial);
    const lease = cache.acquireLease(identity)!;
    const run = cache.beginIncrementalRun(lease);
    const changedSubscriptions = initial.subscriptions.map((subscription) => ({
      ...subscription,
      title: 'Renamed feed',
      siteUrl: 'https://changed.example.test',
      iconUrl: 'https://changed.example.test/icon.png',
    }));
    const changedFolders = initial.folders.map((folder) => ({ ...folder, title: 'Renamed folder' }));

    const result = cache.applyRoutineDiscovery(
      run,
      [],
      changedSubscriptions,
      changedFolders,
      1_788_825_600,
      readerSubscriptionFingerprint(changedSubscriptions, changedFolders),
    );
    cache.completeIncrementalRun(run);

    expect(result).toEqual({ inserted: 0, metadataChanged: 2 });
    expect(cache.readSnapshot(identity)).toMatchObject({
      folders: [expect.objectContaining({ title: 'Renamed folder' })],
      subscriptions: [expect.objectContaining({
        title: 'Renamed feed',
        siteUrl: 'https://changed.example.test',
        iconUrl: 'https://changed.example.test/icon.png',
      })],
    });
    expect(cache.status(identity).versions).toEqual({ collection: 2, state: 1, body: 1 });
    expect(database.prepare('SELECT current_generation_id FROM reader_accounts WHERE account_key = ?')
      .get(identity.accountKey)).toEqual({ current_generation_id: published.generationId });
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
      initial.subscriptions,
      initial.folders,
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

  it('prunes the complete obsolete backlog one generation per transaction', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker-1');
    for (let generation = 1; generation <= 6; generation += 1) {
      publish(cache, snapshot([article(`generation-${generation}`)]));
    }

    const result = await cache.prune({ maxDeletes: 100, betweenDeletesMs: 0 });

    expect(result.deletions).toHaveLength(5);
    expect(result.deletions.every((deletion) => (
      deletion.writerWaitMs >= 0
      && deletion.writerLockMs >= 0
      && deletion.phases.commitMs >= 0
      && deletion.phases.generationCascadeMs >= 0
    ))).toBe(true);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_cache_generations').get()).toEqual({ count: 1 });
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
