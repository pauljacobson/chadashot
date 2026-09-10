import { describe, expect, it, vi } from 'vitest';
import type { Article, ReaderMarkReadJobRequest, ReaderSnapshot } from '../shared/reader.js';
import { openMemoryDatabase } from './database.js';
import { MarkReadJobConflictError, MarkReadJobService } from './mark-read-jobs.js';
import { ReaderApi } from './reader-api.js';
import { ReaderCache, type ReaderCacheIdentity, type ReaderCacheImport } from './reader-cache.js';

const identity: ReaderCacheIdentity = {
  accountKey: 'mark-read-account',
  providerIdentity: 'provider',
  credentialGeneration: 'credentials',
};

function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    feedId: 'feed-1',
    folderIds: ['folder-1'],
    title: `Article ${id}`,
    author: null,
    source: 'Synthetic feed',
    canonicalUrl: `https://example.test/${id}`,
    publishedAt: '2026-09-08T00:00:00.000Z',
    readingMinutes: 1,
    summary: '',
    contentHtml: '',
    read: false,
    starred: false,
    ...overrides,
  };
}

function snapshot(articles: Article[]): ReaderSnapshot {
  return {
    generatedAt: '2026-09-08T00:00:00.000Z',
    source: 'google-reader',
    folders: [{ id: 'folder-1', title: 'Folder', unreadCount: articles.filter((item) => !item.read && item.folderIds.includes('folder-1')).length }],
    subscriptions: [
      { id: 'feed-1', title: 'Feed one', url: 'https://example.test/1', siteUrl: null, iconUrl: null, folderIds: ['folder-1'], unreadCount: articles.filter((item) => item.feedId === 'feed-1' && !item.read).length },
      { id: 'feed-2', title: 'Feed two', url: 'https://example.test/2', siteUrl: null, iconUrl: null, folderIds: [], unreadCount: articles.filter((item) => item.feedId === 'feed-2' && !item.read).length },
    ],
    articles,
  };
}

function stage(cache: ReaderCache, run: ReaderCacheImport, value: ReaderSnapshot) {
  cache.stageFolders(run, value.folders);
  cache.stageSubscriptions(run, value.subscriptions);
  for (let offset = 0; offset < value.articles.length; offset += 500) cache.stageArticles(run, value.articles.slice(offset, offset + 500));
}

function publish(cache: ReaderCache, value: ReaderSnapshot) {
  const run = cache.beginImport(cache.acquireLease(identity)!);
  stage(cache, run, value);
  cache.publish(run);
}

function requestFor(database: ReturnType<typeof openMemoryDatabase>, overrides: Partial<ReaderMarkReadJobRequest> = {}): ReaderMarkReadJobRequest {
  const account = database.prepare(`
    SELECT current_generation_id, collection_version, state_version FROM reader_accounts WHERE account_key = ?
  `).get(identity.accountKey) as { current_generation_id: string; collection_version: number; state_version: number };
  return {
    idempotencyKey: crypto.randomUUID(),
    accountKey: identity.accountKey,
    generation: account.current_generation_id,
    collectionVersion: account.collection_version,
    stateVersion: account.state_version,
    scope: { kind: 'all' },
    coverage: 'complete',
    ...overrides,
  };
}

describe('durable mark-read jobs', () => {
  it('finishes 20,005 targets in bounded provider chunks without expanding the browser request', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot(Array.from({ length: 20_005 }, (_, index) => article(`article-${index}`))));
    const service = new MarkReadJobService(database, cache);
    const submitted: number[] = [];
    const request = requestFor(database);

    const accepted = service.accept(identity, request);
    const duplicate = service.accept(identity, request);
    const completed = await service.run(identity, accepted.id, async (mutations) => { submitted.push(mutations.length); });

    expect(duplicate.id).toBe(accepted.id);
    expect(accepted.targetCount).toBe(20_005);
    expect(completed).toMatchObject({ status: 'completed', targetCount: 20_005, completedCount: 20_005, supersededCount: 0 });
    expect(Math.max(...submitted)).toBeLessThanOrEqual(300);
    expect(submitted.reduce((total, count) => total + count, 0)).toBe(20_005);
    expect(JSON.stringify(request).length).toBeLessThan(1_000);
  }, 30_000);

  it('resumes after a mid-job failure without losing or repeating confirmed targets', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot(Array.from({ length: 425 }, (_, index) => article(`article-${index}`))));
    const service = new MarkReadJobService(database, cache);
    const accepted = service.accept(identity, requestFor(database));
    let providerCalls = 0;

    const failed = await service.run(identity, accepted.id, async () => {
      providerCalls += 1;
      if (providerCalls === 2) throw new Error('Ambiguous provider timeout');
    });
    expect(failed).toMatchObject({ status: 'failed', completedCount: 300, targetCount: 425 });

    const restarted = new MarkReadJobService(database, cache);
    const completed = await restarted.run(identity, accepted.id, async () => { providerCalls += 1; });
    expect(completed).toMatchObject({ status: 'completed', completedCount: 425, attempts: 2 });
    expect(providerCalls).toBe(3);
  });

  it('resumes an accepted job after a simulated process restart', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot([article('accepted-before-crash')]));
    const accepted = new MarkReadJobService(database, cache).accept(identity, requestFor(database));
    const submit = vi.fn(async () => undefined);

    const [completed] = await new MarkReadJobService(database, cache).resume(identity, submit);

    expect(completed).toMatchObject({ id: accepted.id, status: 'completed', completedCount: 1 });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps a 429-failed chunk durable until an explicit retry succeeds', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot([article('rate-limited')]));
    const service = new MarkReadJobService(database, cache);
    const accepted = service.accept(identity, requestFor(database));

    const failed = await service.run(identity, accepted.id, async () => { throw new Error('RSS service request failed (429)'); });
    expect(failed).toMatchObject({ status: 'failed', completedCount: 0, error: 'RSS service request failed (429)' });
    expect(database.prepare(`SELECT status, attempts FROM reader_mark_read_job_targets WHERE job_id = ?`).get(accepted.id))
      .toEqual({ status: 'pending', attempts: 1 });

    const completed = await service.run(identity, accepted.id, async () => undefined);
    expect(completed).toMatchObject({ status: 'completed', completedCount: 1, attempts: 2 });
  });

  it('freezes membership across later arrivals, folder movement, and a new generation', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot([article('original')]));
    const service = new MarkReadJobService(database, cache);
    const jobRequest = requestFor(database, { scope: { kind: 'folder', id: 'folder-1' } });
    const accepted = service.accept(identity, jobRequest);
    publish(cache, snapshot([
      article('original', { folderIds: [], feedId: 'feed-2' }),
      article('late', { publishedAt: '2020-01-01T00:00:00.000Z' }),
    ]));
    await cache.prune({ maxDeletes: 10 });
    const submitted: string[] = [];

    await service.run(identity, accepted.id, async (mutations) => submitted.push(...mutations.map((mutation) => mutation.articleId)));
    const articles = new ReaderApi(database).articles(identity, { scope: 'all', read: 'all', limit: 100 }).articles;

    expect(submitted).toEqual(['original']);
    expect(database.prepare(`SELECT generation_id FROM reader_mark_read_jobs WHERE id = ?`).get(accepted.id))
      .toEqual({ generation_id: jobRequest.generation });
    expect(database.prepare(`SELECT id FROM reader_cache_generations WHERE id = ?`).get(jobRequest.generation)).toBeUndefined();
    expect(articles.find((item) => item.id === 'original')?.read).toBe(true);
    expect(articles.find((item) => item.id === 'late')?.read).toBe(false);
  });

  it('preserves a newer manual unread override when an older bulk job replays', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot([article('manual')]));
    const service = new MarkReadJobService(database, cache);
    const accepted = service.accept(identity, requestFor(database));
    cache.applyConfirmedMutations(identity, [{ articleId: 'manual', operation: 'read', value: false }]);
    const submit = vi.fn(async () => undefined);

    const completed = await service.run(identity, accepted.id, submit);

    expect(completed).toMatchObject({ status: 'completed', completedCount: 0, supersededCount: 1 });
    expect(submit).not.toHaveBeenCalled();
    expect(new ReaderApi(database).articles(identity, { scope: 'all', read: 'all', limit: 100 }).articles[0]?.read).toBe(false);
  });

  it('reasserts a newer unread toggle that arrives while a provider chunk is in flight', async () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot([article('racing')]));
    const service = new MarkReadJobService(database, cache);
    const accepted = service.accept(identity, requestFor(database));
    const submittedValues: boolean[] = [];

    const completed = await service.run(identity, accepted.id, async (mutations) => {
      submittedValues.push(mutations[0]!.value);
      if (mutations[0]!.value) cache.applyConfirmedMutations(identity, [{ articleId: 'racing', operation: 'read', value: false }]);
    });

    expect(submittedValues).toEqual([true, false]);
    expect(completed).toMatchObject({ status: 'completed', completedCount: 0, supersededCount: 1 });
    expect(new ReaderApi(database).articles(identity, { scope: 'all', read: 'all', limit: 100 }).articles[0]?.read).toBe(false);
  });

  it('rejects reused keys with different semantics and stale collection boundaries', () => {
    const database = openMemoryDatabase();
    const cache = new ReaderCache(database);
    publish(cache, snapshot([article('one')]));
    const service = new MarkReadJobService(database, cache);
    const request = requestFor(database);
    service.accept(identity, request);

    expect(() => service.accept(identity, { ...request, search: 'different' })).toThrow(MarkReadJobConflictError);
    publish(cache, snapshot([article('one'), article('new')]));
    expect(() => service.accept(identity, { ...request, idempotencyKey: crypto.randomUUID() })).toThrow('boundary');
  });
});
