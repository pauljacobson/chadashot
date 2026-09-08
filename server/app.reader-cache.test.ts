import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { saveIntegration } from './integrations/settings.js';

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'development',
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    READER_CACHE_ENABLED: 'true',
    READER_CACHE_REFRESH_INTERVAL_MS: '0',
  });
}

describe('reader cache API', () => {
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
});
