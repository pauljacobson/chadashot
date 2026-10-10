import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { loadBirchfeedWithGeneration, saveIntegration } from './integrations/settings.js';
import { ReaderCache, readerCacheIdentity } from './reader-cache.js';

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function article(id: string, index: number): Article {
  return {
    id,
    feedId: 'feed/1',
    folderIds: [],
    title: `Article ${index}`,
    author: 'Author',
    source: 'Feed',
    canonicalUrl: `https://example.test/articles/${index}`,
    publishedAt: '2026-09-08T00:00:00.000Z',
    readingMinutes: 2,
    summary: `Metadata only ${index}`,
    contentHtml: `<p>Private body ${index}</p>`,
    read: false,
    starred: index === 0,
  };
}

function seed() {
  const database = openMemoryDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'development',
    ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    READER_CACHE_ENABLED: 'true',
  });
  const credentials = {
    serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
  };
  saveIntegration(database, config, 'birchfeed', credentials);
  const integration = loadBirchfeedWithGeneration(database, config)!;
  const identity = readerCacheIdentity('development-user', credentials, integration.generation);
  const articles = Array.from({ length: 125 }, (_, index) => article(
    index === 0 ? 'tag:google.com,2005:reader/item/abc' : `article-${String(index).padStart(3, '0')}`,
    index,
  ));
  const snapshot: ReaderSnapshot = {
    generatedAt: '2026-09-08T00:00:00.000Z',
    source: 'google-reader',
    folders: [],
    subscriptions: [{
      id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', siteUrl: 'https://example.test', iconUrl: null,
      folderIds: [], unreadCount: articles.length,
    }],
    articles,
  };
  const cache = new ReaderCache(database, 'seed-worker');
  const lease = cache.acquireLease(identity)!;
  const run = cache.beginImport(lease);
  cache.stageFolders(run, snapshot.folders);
  cache.stageSubscriptions(run, snapshot.subscriptions);
  cache.stageArticles(run, snapshot.articles);
  cache.publish(run);
  return { database, config, identity, cache };
}

describe('paginated reader HTTP contract', () => {
  it('accepts publication-window queries and rejects malformed dates', async () => {
    const { database, config } = seed();
    const app = createApp(config, { database });
    const page = await request(app).get('/api/reader/articles').query({ scope: 'all', publishedSince: '2026-09-08T00:00:00.000Z' });
    expect(page.status).toBe(200);
    expect(page.body.total).toBe(125);
    expect(page.body.articles[0]).toHaveProperty('previewImageUrl', null);
    expect(JSON.stringify(page.body)).not.toContain('Private body');
    expect((await request(app).get('/api/reader/articles').query({ publishedSince: 'not-a-date' })).status).toBe(400);
  });

  it('serves conditional metadata, navigation, and separately authorized bodies', async () => {
    const { database, config } = seed();
    const app = createApp(config, { database });

    const page = await request(app).get('/api/reader/articles?scope=all&read=all&limit=100');
    expect(page.status).toBe(200);
    expect(page.body.accountKey).toEqual(expect.any(String));
    expect(page.body.total).toBe(125);
    expect(page.body.articles).toHaveLength(100);
    expect(page.body.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(page.body)).not.toContain('Private body');
    expect(Buffer.byteLength(page.text, 'utf8')).toBeLessThanOrEqual(256 * 1_024);
    expect((await request(app)
      .get('/api/reader/articles?scope=all&read=all&limit=100')
      .set('If-None-Match', page.headers.etag)).status).toBe(304);

    const navigation = await request(app).get('/api/reader/navigation');
    expect(navigation.body).toMatchObject({ counts: { all: 125, inbox: 125, starred: 1 } });
    expect((await request(app).get('/api/reader/navigation').set('If-None-Match', navigation.headers.etag)).status).toBe(304);

    const articleId = encodeURIComponent('tag:google.com,2005:reader/item/abc');
    const body = await request(app).get(`/api/reader/articles/${articleId}/body`);
    expect(body.status).toBe(200);
    expect(body.body).toMatchObject({ accountKey: page.body.accountKey, articleId: 'tag:google.com,2005:reader/item/abc', contentHtml: '<p>Private body 0</p>' });
    expect((await request(app).get(`/api/reader/articles/${articleId}/body`).set('If-None-Match', body.headers.etag)).status).toBe(304);
    expect((await request(app).get('/api/reader/status')).body).toMatchObject({ state: 'current' });

    const mismatchedMutation = await request(app)
      .post('/api/reader/mutations')
      .set('X-Reader-Account-Key', 'another-account')
      .send({ articleId: 'article-001', operation: 'read', value: true });
    expect(mismatchedMutation.status).toBe(409);
    expect(mismatchedMutation.body).toMatchObject({ error: 'reader_account_changed', preserveQueuedWrites: true });
  });

  it('returns recoverable reset responses for stale cursors and delta tokens', async () => {
    const { database, config, identity, cache } = seed();
    const app = createApp(config, { database });
    const first = await request(app).get('/api/reader/articles?scope=all&limit=1');
    const baseline = await request(app).get('/api/reader/changes');

    cache.applyConfirmedMutations(identity, [{ articleId: 'article-001', operation: 'read', value: true }]);

    const stale = await request(app).get('/api/reader/articles').query({ scope: 'all', limit: 1, cursor: first.body.nextCursor });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'reader_cursor_expired', reset: true, preserveQueuedWrites: true });
    const delta = await request(app).get('/api/reader/changes').query({ token: baseline.body.token });
    expect(delta.status).toBe(200);
    expect(delta.body.changes).toEqual([
      expect.objectContaining({ kind: 'upsert', articleId: 'article-001', stateChanged: true }),
    ]);
    const malformed = await request(app).get('/api/reader/articles?scope=all&cursor=not-json');
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: 'invalid_reader_cursor', reset: false });
  });

  it('accepts one compact mark-read job and exposes durable completion status', async () => {
    const { database, config } = seed();
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/reader/api/0/token')) return new Response('write-token');
      if (url.endsWith('/reader/api/0/edit-tag')) return new Response('OK');
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(config, { database, fetchImplementation });
    const page = await request(app).get('/api/reader/articles?scope=all&limit=1');
    const body = {
      idempotencyKey: crypto.randomUUID(),
      accountKey: page.body.accountKey,
      generation: page.body.generation,
      collectionVersion: page.body.versions.collection,
      stateVersion: page.body.versions.state,
      scope: { kind: 'all' },
      coverage: 'complete',
    };

    const accepted = await request(app).post('/api/reader/mark-read-jobs').send(body);
    expect(accepted.status).toBe(202);
    expect(accepted.body).toMatchObject({ status: 'accepted', targetCount: 125 });
    const duplicate = await request(app).post('/api/reader/mark-read-jobs').send(body);
    expect(duplicate.body.id).toBe(accepted.body.id);

    await vi.waitFor(async () => {
      const status = await request(app).get(`/api/reader/mark-read-jobs/${accepted.body.id}`);
      expect(status.body).toMatchObject({ status: 'completed', completedCount: 125, targetCount: 125 });
    });
    const jobs = await request(app).get('/api/reader/mark-read-jobs');
    expect(jobs.body.jobs[0]).toMatchObject({ id: accepted.body.id, status: 'completed' });
    const edit = fetchImplementation.mock.calls.find(([input]) => String(input).endsWith('/reader/api/0/edit-tag'));
    expect(String((edit?.[1]?.body as URLSearchParams).getAll('i').length)).toBe('125');
  });

  it('schedules an explicit refresh without blocking on provider traversal', async () => {
    const { database, config } = seed();
    const fetchImplementation = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', htmlUrl: 'https://example.test', categories: [],
      }] });
      if (url.includes('/unread-count')) return jsonResponse({ unreadcounts: [] });
      if (url.includes('/stream/items/ids')) return jsonResponse({ itemRefs: [] });
      if (url.includes('/stream/contents/')) return jsonResponse({ items: [] });
      throw new Error(`Unexpected URL: ${url}`);
    };
    const app = createApp(config, { database, fetchImplementation });

    const refresh = await request(app).post('/api/reader/refresh');
    expect(refresh.status).toBe(202);
    expect(refresh.body).toMatchObject({ status: 'scheduled' });
    await vi.waitFor(() => {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reader_sync_runs`).get()).toEqual({ count: 2 });
    });
    await vi.waitFor(() => {
      expect(database.prepare(`SELECT kind, status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1`).get())
        .toEqual({ kind: 'routine', status: 'succeeded' });
    });
  });
});
