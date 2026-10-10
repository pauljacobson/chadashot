import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader.js';
import { openDatabase, openMemoryDatabase } from './database.js';
import { ReaderApi, ReaderCursorError } from './reader-api.js';
import { ReaderCache, type ReaderCacheIdentity, type ReaderCacheImport } from './reader-cache.js';

const identity: ReaderCacheIdentity = {
  accountKey: 'reader-api-account',
  providerIdentity: 'reader-api-provider',
  credentialGeneration: 'reader-api-credentials',
};

function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    feedId: 'feed-1',
    folderIds: ['folder-1'],
    title: `Article ${id}`,
    author: null,
    source: 'Source one',
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

function snapshot(articles: Article[]): ReaderSnapshot {
  const feedIds = [...new Set(articles.map((item) => item.feedId))];
  return {
    generatedAt: '2026-09-08T00:00:00.000Z',
    source: 'google-reader',
    folders: [{ id: 'folder-1', title: 'Folder one', unreadCount: articles.filter((item) => !item.read && item.folderIds.includes('folder-1')).length }],
    subscriptions: feedIds.map((id) => ({
      id,
      title: id === 'feed-1' ? 'Source one' : 'Source two',
      url: `https://example.test/${id}`,
      siteUrl: 'https://example.test',
      iconUrl: null,
      folderIds: id === 'feed-1' ? ['folder-1'] : [],
      unreadCount: articles.filter((item) => item.feedId === id && !item.read).length,
    })),
    articles,
  };
}

function stage(cache: ReaderCache, run: ReaderCacheImport, value: ReaderSnapshot) {
  cache.stageFolders(run, value.folders);
  cache.stageSubscriptions(run, value.subscriptions);
  for (let offset = 0; offset < value.articles.length; offset += 500) {
    cache.stageArticles(run, value.articles.slice(offset, offset + 500));
  }
}

function publish(cache: ReaderCache, value: ReaderSnapshot) {
  const lease = cache.acquireLease(identity)!;
  const run = cache.beginImport(lease);
  stage(cache, run, value);
  cache.publish(run);
}

function query(overrides: Partial<Parameters<ReaderApi['articles']>[1]> = {}) {
  return {
    scope: 'all' as const,
    read: 'all' as const,
    limit: 100,
    ...overrides,
  };
}

describe('paginated reader API', () => {
  it('pages a publication window with image previews and binds cursors to that window', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'edition-worker');
    publish(cache, snapshot([
      article('recent', { publishedAt: '2026-10-10T07:00:00.000Z', contentHtml: '<p>Private body</p><img src="/photo.jpg">', read: true }),
      article('boundary', { publishedAt: '2026-10-09T08:00:00.000Z' }),
      article('old', { publishedAt: '2026-10-09T07:59:59.000Z' }),
      article('future', { publishedAt: '2026-10-10T09:00:00.000Z' }),
    ]));
    const api = new ReaderApi(database, () => new Date('2026-10-10T08:00:00.000Z'));
    const options = query({ publishedSince: '2026-10-09T08:00:00.000Z', limit: 1 });
    const first = api.articles(identity, options);
    expect(first.total).toBe(2);
    expect(first.articles[0]).toMatchObject({ id: 'recent', read: true, previewImageUrl: 'https://example.test/photo.jpg' });
    expect(JSON.stringify(first)).not.toContain('Private body');
    const second = api.articles(identity, { ...options, cursor: first.nextCursor! });
    expect(second.articles.map((item) => item.id)).toEqual(['boundary']);
    expect(second.nextCursor).toBeNull();
    expect(second.etag).not.toBe(first.etag);
    expect(() => api.articles(identity, { ...options, publishedSince: '2026-10-08T08:00:00.000Z', cursor: first.nextCursor! })).toThrow(ReaderCursorError);
    expect(api.articles(identity, query()).articles.every((item) => !('previewImageUrl' in item))).toBe(true);
    database.close();
  });

  it('traverses more than 20,000 articles without duplicates, omissions, or body transfer', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    const articles = Array.from({ length: 20_005 }, (_, index) => article(`article-${String(index).padStart(5, '0')}`, {
      publishedAt: index < 10_000 ? '2026-09-08T00:00:00.000Z' : '2026-09-07T00:00:00.000Z',
      summary: `Synthetic metadata row ${index}`,
      contentHtml: `<p>${'body '.repeat(200)}${index}</p>`,
    }));
    publish(cache, snapshot(articles));
    const api = new ReaderApi(database);
    const ids: string[] = [];
    let cursor: string | undefined;
    let firstPageBytes = 0;

    do {
      const page = api.articles(identity, query({ cursor }));
      if (!cursor) firstPageBytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
      ids.push(...page.articles.map((item) => item.id));
      expect(page.articles.every((item) => !('contentHtml' in item))).toBe(true);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(ids).toHaveLength(20_005);
    expect(new Set(ids).size).toBe(20_005);
    expect(firstPageBytes).toBeLessThanOrEqual(256 * 1_024);
  }, 20_000);

  it('keeps search and scope counts correct beyond the first page', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    publish(cache, snapshot([
      article('one', { title: 'A useful title', read: false }),
      article('two', { author: 'Useful Author', read: true, starred: true }),
      article('three', { feedId: 'feed-2', folderIds: [], source: 'Useful source', read: false }),
      article('four', { feedId: 'feed-2', folderIds: [], summary: 'A useful summary', read: true }),
      article('five', { feedId: 'feed-2', folderIds: [], title: 'Unrelated', read: false }),
    ]));
    const api = new ReaderApi(database);

    const searched = api.articles(identity, query({ search: 'useful', limit: 2 }));
    expect(searched.total).toBe(4);
    expect(searched.articles).toHaveLength(2);
    expect(api.articles(identity, query({ search: 'useful', limit: 2, cursor: searched.nextCursor! })).articles).toHaveLength(2);
    expect(api.articles(identity, query({ search: 'sefu' })).total).toBe(4);
    expect(api.articles(identity, query({ scope: 'uncategorized' })).total).toBe(3);
    expect(api.articles(identity, query({ scope: 'folder', scopeId: 'folder-1', read: 'unread' })).total).toBe(1);
    expect(api.articles(identity, query({ scope: 'feed', scopeId: 'feed-2', read: 'read' })).total).toBe(1);
    expect(api.articles(identity, query({ scope: 'starred' })).articles.map((item) => item.id)).toEqual(['two']);

    const lease = cache.acquireLease(identity)!;
    const bodyRun = cache.beginIncrementalRun(lease, 'body');
    cache.applyBodyReconciliation(bodyRun, [article('one', { title: 'Renamed searchable title' })], 100);
    cache.completeIncrementalRun(bodyRun);
    expect(api.articles(identity, query({ search: 'Renamed' })).articles.map((item) => item.id)).toEqual(['one']);
    const searchKey = database.prepare(`
      SELECT search.rowid AS search_rowid, key.rowid AS key_rowid
      FROM reader_article_search search
      JOIN reader_article_search_keys key
        ON key.generation_id = search.generation_id AND key.article_id = search.article_id
      WHERE search.article_id = 'one'
    `).get() as { search_rowid: number; key_rowid: number };
    expect(searchKey.search_rowid).toBe(searchKey.key_rowid);
  });

  it('rejects malformed, cross-scope, and stale-generation cursors', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    publish(cache, snapshot([article('one'), article('two')]));
    const api = new ReaderApi(database);
    const first = api.articles(identity, query({ limit: 1 }));

    expect(() => api.articles(identity, query({ cursor: 'not-json' }))).toThrow(ReaderCursorError);
    expect(() => api.articles(identity, query({ scope: 'inbox', cursor: first.nextCursor! })))
      .toThrow('does not match');
    cache.applyConfirmedMutations(identity, [{ articleId: 'two', operation: 'read', value: true }]);
    expect(() => api.articles(identity, query({ limit: 1, cursor: first.nextCursor! })))
      .toThrow('restart from the first page');
  });

  it('invalidates only the applicable conditional versions', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    publish(cache, snapshot([article('one')]));
    const api = new ReaderApi(database);
    const metadataBefore = api.articles(identity, query()).etag;
    const navigationBefore = api.navigation(identity).etag;
    const bodyBefore = api.body(identity, 'one')!.etag;

    cache.applyConfirmedMutations(identity, [{ articleId: 'one', operation: 'read', value: true }]);

    expect(api.articles(identity, query()).etag).not.toBe(metadataBefore);
    expect(api.navigation(identity).etag).not.toBe(navigationBefore);
    expect(api.body(identity, 'one')!.etag).toBe(bodyBefore);
  });

  it('replays state, metadata, body invalidations, and deletions in bounded repeatable pages', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    publish(cache, snapshot([article('changed'), article('deleted'), article('state')]));
    const api = new ReaderApi(database);
    const baseline = api.changes(identity, undefined, 2);
    cache.applyConfirmedMutations(identity, [{ articleId: 'state', operation: 'read', value: true }]);
    publish(cache, snapshot([
      article('changed', { title: 'Changed title', contentHtml: '<p>Changed body</p>' }),
      article('state', { read: true }),
      article('new'),
    ]));
    await cache.prune({ maxDeletes: 1 });

    const collected: ReturnType<ReaderApi['changes']>['changes'] = [];
    let token = baseline.token;
    let hasMore = true;
    while (hasMore) {
      const page = api.changes(identity, token, 2);
      collected.push(...page.changes);
      token = page.token;
      hasMore = page.hasMore;
    }

    expect(collected).toEqual(expect.arrayContaining([
      expect.objectContaining({ articleId: 'state', stateChanged: true }),
      expect.objectContaining({ articleId: 'changed', metadataChanged: true, bodyChanged: true }),
      expect.objectContaining({ articleId: 'deleted', kind: 'delete', deleted: true }),
      expect.objectContaining({ articleId: 'new', kind: 'upsert', bodyChanged: true }),
      expect.objectContaining({ kind: 'navigation', articleId: null }),
    ]));
    expect(JSON.stringify(collected)).not.toContain('Changed body');
    expect(api.changes(identity, token, 2).changes).toEqual([]);
  });

  it('expires abandoned delta tokens with an explicit queued-write preservation reset', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    publish(cache, snapshot([article('one')]));
    let now = new Date('2026-09-08T00:00:00.000Z');
    const api = new ReaderApi(database, () => now);
    const baseline = api.changes(identity, undefined, 100);
    now = new Date('2026-09-16T00:00:00.000Z');

    expect(() => api.changes(identity, baseline.token, 100)).toThrow('retain queued writes');
  });

  it('publishes incremental item, body, state, and navigation deltas atomically', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database, 'worker');
    publish(cache, snapshot([article('existing')]));
    const api = new ReaderApi(database);
    let token = api.changes(identity, undefined, 100).token;

    const routineLease = cache.acquireLease(identity)!;
    const routine = cache.beginIncrementalRun(routineLease, 'routine');
    cache.applyRoutineDiscovery(routine, [article('new')], [], [], 100, 'fingerprint');
    cache.completeIncrementalRun(routine);
    const routineDelta = api.changes(identity, token, 100);
    token = routineDelta.token;
    expect(routineDelta.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ articleId: 'new', metadataChanged: true, stateChanged: true, bodyChanged: true }),
      expect.objectContaining({ kind: 'navigation' }),
    ]));
    expect(api.navigation(identity).counts).toMatchObject({ all: 2, inbox: 2 });

    const metadataEtag = api.articles(identity, query()).etag;
    const bodyEtag = api.body(identity, 'existing')!.etag;
    const bodyLease = cache.acquireLease(identity)!;
    const bodyRun = cache.beginIncrementalRun(bodyLease, 'body');
    cache.applyBodyReconciliation(bodyRun, [article('existing', { contentHtml: '<p>Updated body</p>' })], 200);
    cache.completeIncrementalRun(bodyRun);
    const bodyDelta = api.changes(identity, token, 100);
    token = bodyDelta.token;
    expect(bodyDelta.changes).toEqual([
      expect.objectContaining({ articleId: 'existing', metadataChanged: false, stateChanged: false, bodyChanged: true }),
    ]);
    expect(api.articles(identity, query()).etag).toBe(metadataEtag);
    expect(api.body(identity, 'existing')!.etag).not.toBe(bodyEtag);

    const stateLease = cache.acquireLease(identity)!;
    const stateRun = cache.beginIncrementalRun(stateLease, 'state');
    cache.applyStateReconciliation(stateRun, new Set(['new']), new Set());
    cache.completeIncrementalRun(stateRun);
    const stateDelta = api.changes(identity, token, 100);
    expect(stateDelta.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ articleId: 'existing', stateChanged: true, bodyChanged: false }),
      expect.objectContaining({ kind: 'navigation' }),
    ]));
    expect(api.navigation(identity).counts).toMatchObject({ all: 2, inbox: 1 });
  });

  it('keeps list, body, and navigation reads consistent while another connection publishes and prunes', () => {
    function interleavedRead<T>(
      initial: ReaderSnapshot,
      replacement: ReaderSnapshot,
      read: (api: ReaderApi) => T,
    ) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-reader-snapshot-'));
      const writer = openDatabase(dataDir);
      const writerCache = new ReaderCache(writer, 'writer');
      publish(writerCache, initial);
      const reader = new Database(path.join(dataDir, 'chadashot.sqlite'));
      reader.pragma('journal_mode = WAL');
      reader.pragma('foreign_keys = ON');
      let interleaved = false;
      const api = new ReaderApi(reader, () => new Date(), () => {
        if (interleaved) return;
        interleaved = true;
        publish(writerCache, replacement);
        void writerCache.prune({ maxDeletes: 1 });
      });
      const result = read(api);
      return { result, reader, writer };
    }

    const list = interleavedRead(
      snapshot([article('old-one'), article('old-two')]),
      snapshot([article('new-only')]),
      (api) => api.articles(identity, query({ limit: 1 })),
    );
    expect(list.result).toMatchObject({ total: 2, articles: [expect.objectContaining({ id: 'old-two' })] });
    expect(() => new ReaderApi(list.reader).articles(identity, query({ limit: 1, cursor: list.result.nextCursor! })))
      .toThrow('restart from the first page');
    list.reader.close();
    list.writer.close();

    const body = interleavedRead(
      snapshot([article('same', { contentHtml: '<p>Old body</p>' })]),
      snapshot([article('same', { contentHtml: '<p>New body</p>' })]),
      (api) => api.body(identity, 'same'),
    );
    expect(body.result?.contentHtml).toBe('<p>Old body</p>');
    body.reader.close();
    body.writer.close();

    const navigation = interleavedRead(
      snapshot([article('old-one'), article('old-two')]),
      snapshot([article('new-only', { read: true })]),
      (api) => api.navigation(identity),
    );
    expect(navigation.result.counts).toMatchObject({ all: 2, inbox: 2 });
    expect(navigation.result.feeds[0]).toMatchObject({ totalCount: 2, unreadCount: 2 });
    navigation.reader.close();
    navigation.writer.close();
  });
});
