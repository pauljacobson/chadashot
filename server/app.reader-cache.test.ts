import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { saveIntegration } from './integrations/settings.js';
import { clearGoogleReaderSessionCache } from './integrations/google-reader.js';

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'development',
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    READER_CACHE_ENABLED: 'true',
    READER_FULL_SYNC_INTERVAL_MS: '0',
  });
}

describe('reader cache API', () => {
  beforeEach(() => clearGoogleReaderSessionCache());

  it('prepares fresh articles without device requests or active passkey sessions', async () => {
    const database = openMemoryDatabase();
    const appConfig = loadConfig({
      NODE_ENV: 'test', AUTH_MODE: 'passkey', APP_ORIGIN: 'https://reader.example.test',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      READER_CACHE_AUTO_PRUNE: 'false', READER_ROUTINE_SYNC_INTERVAL_MS: '0',
      READER_FULL_SYNC_INTERVAL_MS: '2592000000',
    });
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    let fresh = false;
    const article = (id: string) => ({ id, title: id, content: { content: '<p>Body</p>' },
      categories: [], origin: { streamId: 'feed/1', title: 'Feed' } });
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.pathname.includes('/subscription/list')) return jsonResponse({ subscriptions: [
        { id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', categories: [] },
      ] });
      if (url.pathname.includes('/unread-count')) return jsonResponse({ unreadcounts: [] });
      if (url.pathname.endsWith('/stream/items/contents')) return jsonResponse({
        items: new URLSearchParams(String(init?.body)).getAll('i').map(article),
      });
      if (url.pathname.includes('/stream/items/ids')) return jsonResponse({
        itemRefs: fresh && url.searchParams.has('ot') ? [{ id: 'new' }] : [],
      });
      if (url.pathname.includes('/stream/contents/')) return jsonResponse({ items: [article('old')] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, { database, fetchImplementation });
    const signal = new AbortController().signal;
    await app.synchronizeReader(signal);
    expect(fetchImplementation).not.toHaveBeenCalled(); // No owner exists yet.
    database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
      .run('owner', 'Reader', new Date().toISOString());
    await app.synchronizeReader(signal);
    fresh = true;
    await app.synchronizeReader(signal);
    expect(database.prepare('SELECT id FROM reader_articles ORDER BY id').all())
      .toEqual([{ id: 'new' }, { id: 'old' }]);
    expect(database.prepare('SELECT kind, status FROM reader_sync_runs ORDER BY rowid').all())
      .toEqual([{ kind: 'full', status: 'succeeded' }, { kind: 'routine', status: 'succeeded' }]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect((await request(app).get('/api/reader/status')).status).toBe(401);
    await app.stopReaderSynchronization();
  });

  it('keeps routine synchronization incremental when provider metadata changes', async () => {
    const database = openMemoryDatabase();
    const appConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      READER_CACHE_ENABLED: 'true',
      READER_CACHE_AUTO_PRUNE: 'false',
      READER_ROUTINE_SYNC_INTERVAL_MS: '0',
      READER_STATE_SYNC_INTERVAL_MS: String(24 * 60 * 60 * 1_000),
      READER_BODY_SYNC_INTERVAL_MS: String(7 * 24 * 60 * 60 * 1_000),
      READER_FULL_SYNC_INTERVAL_MS: String(30 * 24 * 60 * 60 * 1_000),
    });
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    let siteUrl = 'https://initial.example.test';
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.pathname.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1',
        title: 'Feed',
        url: 'https://example.test/feed',
        htmlUrl: siteUrl,
        categories: [],
      }] });
      if (url.pathname.includes('/unread-count')) return jsonResponse({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
      if (url.pathname.includes('/stream/items/ids')) return jsonResponse({ itemRefs: [] });
      if (url.pathname.includes('/stream/contents/')) return jsonResponse({ items: [{
        id: 'article-1',
        title: 'Article',
        content: { content: '<p>Body</p>' },
        categories: [],
        origin: { streamId: 'feed/1', title: 'Feed' },
      }] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, { database, fetchImplementation });

    expect((await request(app).get('/api/reader/snapshot')).status).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT kind, status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1').get())
        .toEqual({ kind: 'full', status: 'succeeded' });
    });

    siteUrl = 'https://changed.example.test';
    expect((await request(app).get('/api/reader/snapshot')).status).toBe(200);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_runs').get()).toEqual({ count: 2 });
      expect(database.prepare('SELECT kind, status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1').get())
        .toEqual({ kind: 'routine', status: 'succeeded' });
    });

    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_cache_generations').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT site_url FROM reader_subscriptions').get())
      .toEqual({ site_url: 'https://changed.example.test' });
  });

  it('uses ID discovery to download only unknown bodies during a routine refresh', async () => {
    const database = openMemoryDatabase();
    const appConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      READER_CACHE_ENABLED: 'true',
      READER_ROUTINE_SYNC_INTERVAL_MS: '0',
      READER_STATE_SYNC_INTERVAL_MS: String(24 * 60 * 60 * 1_000),
      READER_BODY_SYNC_INTERVAL_MS: String(7 * 24 * 60 * 60 * 1_000),
      READER_FULL_SYNC_INTERVAL_MS: String(30 * 24 * 60 * 60 * 1_000),
    });
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    const selectiveBodies: string[][] = [];
    let includeNewFeed = false;
    const providerArticle = (id: string, feedId = 'feed/1') => ({
      id, title: id, content: { content: `<p>${id}</p>` }, categories: [],
      origin: { streamId: feedId, title: feedId === 'feed/1' ? 'Feed' : 'New feed' },
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.pathname.includes('/subscription/list')) return jsonResponse({ subscriptions: [
        { id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', categories: [] },
        ...(includeNewFeed ? [{ id: 'feed/2', title: 'New feed', url: 'https://example.test/new', categories: [] }] : []),
      ] });
      if (url.pathname.includes('/unread-count')) return jsonResponse({ unreadcounts: [{ id: 'feed/1', count: 2 }] });
      if (url.pathname.endsWith('/stream/items/contents')) {
        const ids = new URLSearchParams(String(init?.body)).getAll('i');
        selectiveBodies.push(ids);
        return jsonResponse({ items: ids.map((id) => providerArticle(id)) });
      }
      if (url.pathname.includes('/stream/items/ids')) {
        if (url.searchParams.has('ot')) return jsonResponse({ itemRefs: [
          { id: 'article-1' }, { id: 'article-2' }, ...(includeNewFeed ? [{ id: 'backfilled' }] : []),
        ] });
        return jsonResponse({ itemRefs: [] });
      }
      if (url.pathname.includes('/stream/contents/')) return jsonResponse({ items: includeNewFeed
        ? [providerArticle('article-1'), providerArticle('article-2'), providerArticle('backfilled', 'feed/2')]
        : [providerArticle('article-1')] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, { database, fetchImplementation });

    expect((await request(app).get('/api/reader/snapshot')).status).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM reader_articles').get()).toEqual({ count: 1 });
      expect(database.prepare(`SELECT status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1`).get()).toEqual({ status: 'succeeded' });
      expect(database.prepare(`SELECT COUNT(*) AS count FROM reader_sync_leases`).get()).toEqual({ count: 0 });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await request(app).get('/api/reader/status')).status).toBe(200);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_runs').get()).toEqual({ count: 2 });
    });
    await vi.waitFor(() => {
      expect(database.prepare(`SELECT status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1`).get()).not.toEqual({ status: 'running' });
    });
    expect(database.prepare('SELECT kind, status, error FROM reader_sync_runs ORDER BY rowid').all()).toEqual([
      { kind: 'full', status: 'succeeded', error: null },
      { kind: 'routine', status: 'succeeded', error: null },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_articles').get()).toEqual({ count: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(selectiveBodies).toEqual([['article-2']]);

    includeNewFeed = true;
    expect((await request(app).get('/api/reader/snapshot')).status).toBe(200);
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT COUNT(*) AS count FROM reader_articles a
        JOIN reader_accounts account ON account.current_generation_id = a.generation_id
      `).get()).toEqual({ count: 3 });
    });
    expect(selectiveBodies).toEqual([['article-2']]);
    expect(database.prepare(`SELECT kind, status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1`).get())
      .toEqual({ kind: 'full', status: 'succeeded' });
  });

  it('returns bounded initialization state, then serves cache while refresh stalls or fails', async () => {
    const database = openMemoryDatabase();
    const appConfig = config();
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    let mode: 'complete' | 'stall' | 'fail' = 'complete';
    let failStalledRequest: (() => void) | undefined;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', categories: [],
      }] });
      if (url.includes('/unread-count')) return jsonResponse({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
      if (url.includes('/stream/items/ids')) return jsonResponse({ itemRefs: [] });
      if (url.includes('/stream/contents/')) {
        if (mode === 'fail') throw new TypeError('provider unavailable');
        if (mode === 'stall') return new Promise<Response>((_resolve, reject) => {
          failStalledRequest = () => reject(new TypeError('provider unavailable'));
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        return jsonResponse({ items: [{
          id: 'article-1', title: 'Article', content: { content: '<p>Body</p>' }, categories: [],
          origin: { streamId: 'feed/1', title: 'Feed' },
        }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, { database, fetchImplementation });

    const initializing = await request(app).get('/api/reader/snapshot');
    expect(initializing.status).toBe(202);
    expect(initializing.headers['retry-after']).toBe('2');
    expect(initializing.body).toMatchObject({ status: 'initializing', progress: { itemsStaged: 0 } });
    expect(Number(initializing.headers['content-length'])).toBeLessThan(512);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT current_generation_id FROM reader_accounts').get())
        .toEqual(expect.objectContaining({ current_generation_id: expect.any(String) }));
    });

    mode = 'stall';
    const startedAt = performance.now();
    const cachedWhileStalled = await request(app).get('/api/reader/snapshot');
    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(cachedWhileStalled.status).toBe(200);
    expect(cachedWhileStalled.body).toMatchObject({
      articles: [expect.objectContaining({ id: 'article-1', contentHtml: '<p>Body</p>' })],
      cacheStatus: { state: 'refreshing', versions: { collection: 1, state: 1, body: 1 } },
    });

    mode = 'fail';
    failStalledRequest!();
    await vi.waitFor(() => {
      expect(database.prepare('SELECT last_error FROM reader_accounts').get())
        .toEqual(expect.objectContaining({ last_error: expect.any(String) }));
    }, { timeout: 6_000 });

    const cachedAfterFailure = await request(app).get('/api/reader/snapshot');
    expect(cachedAfterFailure.status).toBe(200);
    expect(cachedAfterFailure.body.cacheStatus).toMatchObject({
      state: 'stale',
      error: expect.stringContaining('Could not reach the RSS service'),
    });
    expect(cachedAfterFailure.body.articles[0].id).toBe('article-1');
  });

  it('publishes fresh articles incrementally after a failed full rebuild', async () => {
    const database = openMemoryDatabase();
    const appConfig = loadConfig({
      NODE_ENV: 'test', AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      READER_CACHE_AUTO_PRUNE: 'false', READER_FULL_SYNC_INTERVAL_MS: '0',
      READER_ROUTINE_SYNC_INTERVAL_MS: '0',
      READER_STATE_SYNC_INTERVAL_MS: '86400000', READER_BODY_SYNC_INTERVAL_MS: '604800000',
    });
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    let failFull = false;
    let fullRequests = 0;
    const providerArticle = (id: string) => ({
      id, title: id, content: { content: `<p>${id}</p>` }, categories: [],
      origin: { streamId: 'feed/1', title: 'Feed' },
    });
    const app = createApp(appConfig, { database, fetchImplementation: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.pathname.includes('/subscription/list')) return jsonResponse({ subscriptions: [{ id: 'feed/1', title: 'Feed', categories: [] }] });
      if (url.pathname.includes('/unread-count')) return jsonResponse({ unreadcounts: [] });
      if (url.pathname.endsWith('/stream/items/contents')) return jsonResponse({ items: [providerArticle('fresh')] });
      if (url.pathname.includes('/stream/items/ids')) return jsonResponse({ itemRefs: url.searchParams.has('ot') ? [{ id: 'fresh' }] : [] });
      if (url.pathname.includes('/stream/contents/')) {
        fullRequests += 1;
        if (failFull) throw new Error('full provider deadline');
        return jsonResponse({ items: [providerArticle('old')] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    } });
    await request(app).get('/api/reader/status');
    await vi.waitFor(() => expect(database.prepare('SELECT status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1').get()).toEqual({ status: 'succeeded' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    failFull = true;
    await request(app).post('/api/reader/refresh');
    await vi.waitFor(() => expect(database.prepare('SELECT status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1').get()).toEqual({ status: 'failed' }));
    const requestsAfterFailure = fullRequests;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await request(app).post('/api/reader/refresh');
    await vi.waitFor(() => expect(database.prepare('SELECT kind, status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1').get()).toEqual({ kind: 'routine', status: 'succeeded' }));
    const page = await request(app).get('/api/reader/articles?scope=all');
    expect(page.body.articles.map((article: { id: string }) => article.id).sort()).toEqual(['fresh', 'old']);
    expect(fullRequests).toBe(requestsAfterFailure);
  });

  it('updates committed cached state only after a provider mutation succeeds', async () => {
    const database = openMemoryDatabase();
    const appConfig = config();
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/token')) return new Response('write-token');
      if (url.endsWith('/edit-tag')) return new Response('OK');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', categories: [],
      }] });
      if (url.includes('/unread-count')) return jsonResponse({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
      if (url.includes('/stream/items/ids')) {
        const state = new URL(url).searchParams.get('s');
        return jsonResponse({ itemRefs: state?.endsWith('/starred') ? [] : [{ id: 'article-1' }] });
      }
      if (url.includes('/stream/contents/')) return jsonResponse({ items: [{
        id: 'article-1', title: 'Article', categories: [], origin: { streamId: 'feed/1', title: 'Feed' },
      }] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, { database, fetchImplementation });
    await request(app).get('/api/reader/snapshot');
    await vi.waitFor(() => expect(database.prepare('SELECT current_generation_id FROM reader_accounts').get()).toBeTruthy());

    const mutation = await request(app).post('/api/reader/mutations').send({
      articleId: 'article-1', operation: 'read', value: true,
    });
    const cached = await request(app).get('/api/reader/snapshot');

    expect(mutation.status).toBe(200);
    expect(cached.body.articles[0].read).toBe(true);
    expect(cached.body.subscriptions[0].unreadCount).toBe(0);
    expect(cached.body.cacheStatus.versions.state).toBeGreaterThan(1);
  });

  it('defers a full import without an empty collection and resumes after storage recovers', async () => {
    const database = openMemoryDatabase();
    const appConfig = config();
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    let availableBytes = 0;
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', categories: [],
      }] });
      if (url.includes('/unread-count')) return jsonResponse({ unreadcounts: [] });
      if (url.includes('/stream/items/ids')) return jsonResponse({ itemRefs: [] });
      if (url.includes('/stream/contents/')) return jsonResponse({ items: [{
        id: 'article-1', title: 'Article', categories: [], origin: { streamId: 'feed/1', title: 'Feed' },
      }] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, {
      database,
      fetchImplementation,
      readerStorageAvailableBytes: () => availableBytes,
    });

    const initializing = await request(app).get('/api/reader/snapshot');
    expect(initializing.status).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare(`
        SELECT storage_deferred_until, storage_deferral_reason FROM reader_accounts
      `).get()).toEqual(expect.objectContaining({
        storage_deferred_until: expect.any(String),
        storage_deferral_reason: expect.stringContaining('reader_storage_deferred'),
      }));
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_leases').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_runs').get()).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_checkpoints').get()).toEqual({ count: 0 });
    const deferred = await request(app).get('/api/reader/status');
    expect(deferred.body).toMatchObject({
      state: 'empty',
      storageDeferral: {
        until: expect.any(String),
        reason: expect.objectContaining({ code: 'reader_storage_deferred' }),
      },
    });

    availableBytes = Number.MAX_SAFE_INTEGER;
    expect((await request(app).post('/api/reader/refresh')).status).toBe(202);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT current_generation_id FROM reader_accounts').get())
        .toEqual(expect.objectContaining({ current_generation_id: expect.any(String) }));
    });
    expect(database.prepare(`
      SELECT storage_deferred_until, storage_deferral_reason FROM reader_accounts
    `).get()).toEqual({ storage_deferred_until: null, storage_deferral_reason: null });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const checkpoint = database.prepare('SELECT * FROM reader_sync_checkpoints').get();
    availableBytes = 0;
    const cachedDuringDeferral = await request(app).get('/api/reader/snapshot');
    expect(cachedDuringDeferral.status).toBe(200);
    expect(cachedDuringDeferral.body.articles).toEqual([expect.objectContaining({ id: 'article-1' })]);
    await vi.waitFor(() => {
      expect(database.prepare('SELECT storage_deferred_until FROM reader_accounts').get())
        .toEqual(expect.objectContaining({ storage_deferred_until: expect.any(String) }));
    });
    expect(database.prepare('SELECT * FROM reader_sync_checkpoints').get()).toEqual(checkpoint);
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_leases').get()).toEqual({ count: 0 });
  });

  it('keeps publication successful when best-effort pruning fails', async () => {
    const database = openMemoryDatabase();
    const appConfig = config();
    saveIntegration(database, appConfig, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1', title: 'Feed', url: 'https://example.test/feed', categories: [],
      }] });
      if (url.includes('/unread-count')) return jsonResponse({ unreadcounts: [] });
      if (url.includes('/stream/items/ids')) return jsonResponse({ itemRefs: [] });
      if (url.includes('/stream/contents/')) return jsonResponse({ items: [{
        id: 'article-1', title: 'Article', categories: [], origin: { streamId: 'feed/1', title: 'Feed' },
      }] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const app = createApp(appConfig, { database, fetchImplementation });
    await request(app).get('/api/reader/snapshot');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_runs WHERE status = ?').get('succeeded'))
        .toEqual({ count: 1 });
    });
    database.exec(`
      CREATE TRIGGER test_forbid_generation_delete
      BEFORE DELETE ON reader_cache_generations BEGIN
        SELECT RAISE(ABORT, 'test pruning failure');
      END;
    `);

    await request(app).get('/api/reader/snapshot');
    await vi.waitFor(() => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM reader_sync_runs WHERE status = ?').get('succeeded'))
        .toEqual({ count: 2 });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const account = database.prepare(`
      SELECT current_generation_id, last_error FROM reader_accounts
    `).get() as { current_generation_id: string; last_error: string | null };
    expect(account.last_error).toBeNull();
    expect(database.prepare(`SELECT generation_number, status FROM reader_cache_generations WHERE id = ?`)
      .get(account.current_generation_id)).toEqual({ generation_number: 2, status: 'committed' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM reader_cache_generations').get()).toEqual({ count: 2 });
    expect(database.prepare('SELECT generation_id FROM reader_sync_checkpoints').get())
      .toEqual({ generation_id: account.current_generation_id });
  });
});
