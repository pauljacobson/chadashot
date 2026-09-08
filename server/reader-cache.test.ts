import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader.js';
import { openMemoryDatabase } from './database.js';
import {
  ReaderCache,
  ReaderCacheFencedError,
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
});
