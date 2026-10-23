import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { saveIntegration } from './integrations/settings.js';

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

function scenario() {
  const database = openMemoryDatabase();
  const config = {
    ...loadConfig({
      NODE_ENV: 'test', AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      READER_ROUTINE_SYNC_INTERVAL_MS: '0',
      READER_FULL_SYNC_INTERVAL_MS: '2592000000',
    }),
    readerSyncTimeoutMs: 80,
  };
  saveIntegration(database, config, 'birchfeed', {
    serverUrl: 'https://resume.example.test', email: 'reader@example.test', apiKey: 'secret',
  });
  const state = { addedFeed: false, stall: false, unread: true, expired: false, repeat: false, failState: false };
  const pages: Array<string | null> = [];
  const item = (id: string) => ({ id, title: id, content: { content: `<p>${id}</p>` },
    origin: { streamId: 'feed/1', title: 'Feed' } });
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
    if (url.pathname.includes('/subscription/list')) return json({ subscriptions: [
      { id: 'feed/1', title: 'Feed', categories: [] },
      ...(state.addedFeed ? [{ id: 'feed/2', title: 'Added', categories: [] }] : []),
    ] });
    if (url.pathname.includes('/unread-count')) return json({ unreadcounts: [] });
    if (url.pathname.includes('/stream/items/ids')) {
      if (state.failState) return new Response('Unavailable state', { status: 404 });
      return json({ itemRefs: url.searchParams.has('xt') && state.unread ? [{ id: 'first' }] : [] });
    }
    if (url.pathname.includes('/stream/contents/')) {
      if (url.searchParams.get('r') !== 'o') throw new Error('Resumable scans must use oldest-first order');
      const token = url.searchParams.get('c');
      pages.push(token);
      if (!token) return json({ items: [item('first')], continuation: 'page-two' });
      if (state.expired) return new Response('Expired continuation', { status: 400 });
      if (state.stall) return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      return json({ items: [item('second')], ...(state.repeat ? { continuation: 'page-two' } : {}) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const app = () => createApp(config, { database, fetchImplementation });
  const retryDue = () => database.prepare(`UPDATE reader_sync_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'`).run();
  return { database, state, pages, app, retryDue, config };
}

describe('resumable reader imports', () => {
  it('keeps a completed page through timeout and pruning, then resumes after an app restart', async () => {
    const test = scenario();
    const app = test.app();
    test.state.stall = true;
    await app.synchronizeReader(new AbortController().signal);
    expect(test.database.prepare('SELECT items_staged, status FROM reader_sync_runs').get())
      .toEqual({ items_staged: 1, status: 'failed' });
    // A failed attempt must not publish a partial collection or delete its pages.
    expect(test.database.prepare('SELECT current_generation_id FROM reader_accounts').get())
      .toEqual({ current_generation_id: null });
    expect(test.database.prepare('SELECT id FROM reader_articles').all()).toEqual([{ id: 'first' }]);
    expect(test.database.prepare('SELECT is_read FROM reader_article_state').get()).toEqual({ is_read: 0 });
    await app.stopReaderSynchronization();

    test.retryDue();
    test.state.stall = false;
    test.state.unread = false;
    const restarted = test.app();
    await restarted.synchronizeReader(new AbortController().signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two']);
    expect(test.database.prepare(`SELECT a.id, s.is_read FROM reader_articles a
      JOIN reader_accounts account ON account.current_generation_id = a.generation_id
      JOIN reader_article_state s ON s.generation_id = a.generation_id AND s.article_id = a.id ORDER BY a.id`).all())
      .toEqual([{ id: 'first', is_read: 1 }, { id: 'second', is_read: 1 }]);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_cache_generations').get()).toEqual({ count: 1 });
    await restarted.stopReaderSynchronization();
  });

  it('honors the failed-full cooldown when changed subscriptions keep promoting routine discovery', async () => {
    const test = scenario();
    const app = test.app();
    const signal = new AbortController().signal;
    await app.synchronizeReader(signal);
    const lastSuccess = test.database.prepare('SELECT last_success_at FROM reader_accounts').get();
    test.state.addedFeed = true;
    test.state.stall = true;
    await app.synchronizeReader(signal);
    const pagesAfterFailure = [...test.pages];
    await app.synchronizeReader(signal);
    await app.synchronizeReader(signal);
    expect((await request(app).post('/api/reader/refresh')).status).toBe(202);
    await app.stopReaderSynchronization();
    expect(test.pages).toEqual(pagesAfterFailure);
    expect(test.database.prepare('SELECT last_success_at FROM reader_accounts').get()).toEqual(lastSuccess);
    expect(test.database.prepare('SELECT last_error FROM reader_accounts').get()).toEqual({ last_error: expect.stringContaining('provider deadline') });
    expect(test.database.prepare(`SELECT COUNT(*) AS count FROM reader_sync_runs WHERE kind = 'full'`).get())
      .toEqual({ count: 2 });
    // Readers keep the previous complete collection until the replacement is ready.
    expect(test.database.prepare(`SELECT COUNT(*) AS count FROM reader_subscriptions s
      JOIN reader_accounts account ON account.current_generation_id = s.generation_id`).get()).toEqual({ count: 1 });
    test.retryDue();
    test.state.stall = false;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([...pagesAfterFailure, 'page-two']);
    expect(test.database.prepare(`SELECT COUNT(*) AS count FROM reader_subscriptions s
      JOIN reader_accounts account ON account.current_generation_id = s.generation_id`).get()).toEqual({ count: 2 });
    await app.stopReaderSynchronization();
  });

  it('abandons an expired continuation and waits for cooldown before starting a new scan', async () => {
    const test = scenario();
    const app = test.app();
    const signal = new AbortController().signal;
    test.state.stall = true;
    await app.synchronizeReader(signal);
    test.retryDue();
    test.state.expired = true;
    test.state.stall = false;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two']);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two']);
    test.retryDue();
    test.state.expired = false;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two', null, 'page-two']);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_articles').get()).toEqual({ count: 2 });
    await app.stopReaderSynchronization();
  });

  it('restarts a paused scan when subscription membership changes instead of mixing structures', async () => {
    const test = scenario();
    const app = test.app();
    const signal = new AbortController().signal;
    test.state.stall = true;
    await app.synchronizeReader(signal);
    test.retryDue();
    test.state.stall = false;
    test.state.addedFeed = true;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two']);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
    expect(test.database.prepare('SELECT current_generation_id FROM reader_accounts').get()).toEqual({ current_generation_id: null });
    test.retryDue();
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', null, 'page-two']);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_subscriptions').get()).toEqual({ count: 2 });
    await app.stopReaderSynchronization();
  });

  it('never publishes a resumed import when authoritative state is incomplete', async () => {
    const test = scenario();
    const app = test.app();
    const signal = new AbortController().signal;
    test.state.stall = true;
    await app.synchronizeReader(signal);
    test.retryDue();
    test.state.stall = false;
    test.state.failState = true;
    await app.synchronizeReader(signal);
    expect(test.database.prepare('SELECT current_generation_id FROM reader_accounts').get()).toEqual({ current_generation_id: null });
    expect(test.database.prepare('SELECT id FROM reader_articles').all()).toEqual([{ id: 'first' }]);
    test.retryDue();
    test.state.failState = false;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two']);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
    await app.stopReaderSynchronization();
  });

  it('discards repeated continuation tokens rather than replaying a paused scan forever', async () => {
    const test = scenario();
    const app = test.app();
    const signal = new AbortController().signal;
    test.state.stall = true;
    await app.synchronizeReader(signal);
    test.retryDue();
    test.state.stall = false;
    test.state.repeat = true;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two']);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
    expect(test.database.prepare('SELECT current_generation_id FROM reader_accounts').get()).toEqual({ current_generation_id: null });
    await app.stopReaderSynchronization();
  });

  it('preserves completed pages when shutdown aborts an active import', async () => {
    const test = scenario();
    test.config.readerSyncTimeoutMs = 5_000;
    const app = test.app();
    test.state.stall = true;
    const work = app.synchronizeReader(new AbortController().signal);
    await vi.waitFor(() => expect(test.pages).toEqual([null, 'page-two']));
    await app.stopReaderSynchronization();
    await work;
    expect(test.database.prepare('SELECT id FROM reader_articles').all()).toEqual([{ id: 'first' }]);
    test.retryDue();
    test.state.stall = false;
    const restarted = test.app();
    await restarted.synchronizeReader(new AbortController().signal);
    expect(test.pages).toEqual([null, 'page-two', 'page-two']);
    expect(test.database.prepare('SELECT status FROM reader_sync_runs ORDER BY rowid DESC LIMIT 1').get())
      .toEqual({ status: 'succeeded' });
    await restarted.stopReaderSynchronization();
  });

  it('starts a separate scan after credentials are replaced instead of reusing old progress', async () => {
    const test = scenario();
    const app = test.app();
    const signal = new AbortController().signal;
    test.state.stall = true;
    await app.synchronizeReader(signal);
    const connected = await request(app).put('/api/settings/rss').send({
      serverUrl: 'https://resume.example.test', email: 'reader@example.test', apiKey: 'replacement-secret',
    });
    expect(connected.status).toBe(200);
    expect(test.database.prepare('SELECT COUNT(*) AS count FROM reader_import_progress').get()).toEqual({ count: 0 });
    test.state.stall = false;
    await app.synchronizeReader(signal);
    expect(test.pages).toEqual([null, 'page-two', null, 'page-two']);
    expect(test.database.prepare(`SELECT COUNT(*) AS count FROM reader_accounts WHERE current_generation_id IS NOT NULL AND invalidated_at IS NULL`).get())
      .toEqual({ count: 1 });
    await app.stopReaderSynchronization();
  });
});
