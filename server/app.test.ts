import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, normalizeReaderServerUrl } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { fixtureSnapshot } from './fixtures.js';
import { AppLogger } from './logging.js';

const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'development' });

describe('application API', () => {
  const app = createApp(config, { database: openMemoryDatabase() });

  it('reports health without authentication', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('publishes the selected browser reader path without caching it', async () => {
    const paginated = await request(app).get('/api/reader/config');
    const snapshotApp = createApp(loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      READER_CLIENT_PATH: 'snapshot',
    }), { database: openMemoryDatabase() });
    const snapshot = await request(snapshotApp).get('/api/reader/config');

    expect(paginated.status).toBe(200);
    expect(paginated.body).toEqual({ path: 'paginated' });
    expect(paginated.headers['cache-control']).toBe('no-store');
    expect(snapshot.body).toEqual({ path: 'snapshot' });
  });

  it('returns and exports redacted application logs for an authenticated user', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-api-logs-'));
    const loggingConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      LOG_LEVEL: 'debug',
      LOG_OUTPUT: 'file',
      LOG_FILE_PATH: path.join(directory, 'app.ndjson'),
    });
    const logger = new AppLogger(loggingConfig);
    logger.error('Example integration failure', new Error('token=private-value'));
    const loggingApp = createApp(loggingConfig, { database: openMemoryDatabase(), logger });

    const response = await request(loggingApp).get('/api/logs').query({ level: 'error', search: 'integration' });
    const exported = await request(loggingApp).get('/api/logs/export');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.entries[0]).toMatchObject({
      level: 'error',
      message: 'Example integration failure',
      error: { message: 'token=[REDACTED]' },
    });
    expect(exported.headers['content-disposition']).toContain('chadashot-logs-');
    expect(exported.text).toContain('Example integration failure');
    expect(exported.text).not.toContain('private-value');
  });

  it('returns the fixture-backed reader snapshot', async () => {
    const response = await request(app).get('/api/reader/snapshot').set('Accept-Encoding', 'identity');
    expect(response.status).toBe(200);
    expect(response.headers['x-reader-run-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
    expect(response.body.source).toBe('fixture');
    expect(response.body.articles).toHaveLength(4);
  });

  it('seeds the paginated reader APIs when the isolated fixture is explicitly enabled', async () => {
    const fixtureApp = createApp(config, {
      database: openMemoryDatabase(),
      fixtureSnapshot,
    });

    const status = await request(fixtureApp).get('/api/reader/status');
    const navigation = await request(fixtureApp).get('/api/reader/navigation');
    const articles = await request(fixtureApp).get('/api/reader/articles').query({ scope: 'all', read: 'all', limit: 100 });

    expect(status.body).toMatchObject({ accountKey: 'synthetic-performance-fixture', state: 'current' });
    expect(navigation.body.counts.all).toBe(fixtureSnapshot.articles.length);
    expect(articles.body.articles).toHaveLength(fixtureSnapshot.articles.length);
  });

  it('negotiates Brotli or gzip while preserving the identity snapshot contract', async () => {
    const identity = await request(app).get('/api/reader/snapshot').set('Accept-Encoding', 'identity');
    const gzip = await request(app).get('/api/reader/snapshot').set('Accept-Encoding', 'gzip');
    const brotli = await request(app).get('/api/reader/snapshot').set('Accept-Encoding', 'br');

    expect(identity.headers['content-encoding']).toBeUndefined();
    expect(gzip.headers['content-encoding']).toBe('gzip');
    expect(brotli.headers['content-encoding']).toBe('br');
    expect(gzip.headers.vary).toContain('Accept-Encoding');
    expect(brotli.headers.vary).toContain('Accept-Encoding');
    expect({ ...gzip.body, generatedAt: undefined }).toEqual({ ...identity.body, generatedAt: undefined });
    expect({ ...brotli.body, generatedAt: undefined }).toEqual({ ...identity.body, generatedAt: undefined });
  });

  it('validates article mutations', async () => {
    const invalid = await request(app).post('/api/reader/mutations').send({ articleId: '' });
    expect(invalid.status).toBe(400);

    const valid = await request(app).post('/api/reader/mutations').send({
      articleId: 'fixture-quiet-web',
      operation: 'read',
      value: true,
    });
    expect(valid.status).toBe(200);
    expect(valid.body.synchronized).toBe(true);
  });

  it('validates batch article mutations', async () => {
    const invalid = await request(app).post('/api/reader/mutations/batch').send({ mutations: [] });
    expect(invalid.status).toBe(400);

    const mutations = [
      { articleId: 'fixture-quiet-web', operation: 'read', value: true },
      { articleId: 'fixture-careful-systems', operation: 'read', value: true },
    ];
    const valid = await request(app).post('/api/reader/mutations/batch').send({ mutations });
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ mutations, synchronized: true });
  });

  it('validates and encrypts a Birchfeed connection', async () => {
    const database = openMemoryDatabase();
    const encryptedConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64'),
    });
    const fetchImplementation = async () => new Response('Auth=reader-key\n');
    const connectionApp = createApp(encryptedConfig, { database, fetchImplementation });
    const response = await request(connectionApp).put('/api/settings/rss').send({
      serverUrl: 'https://birchfeed.app/api/greader.php',
      email: 'reader@example.test',
      apiKey: 'birchfeed-secret',
    });
    expect(response.status).toBe(200);
    const stored = database.prepare('SELECT encrypted_config FROM integrations WHERE kind = ?').get('birchfeed') as { encrypted_config: string };
    expect(stored.encrypted_config).not.toContain('birchfeed-secret');
    expect(stored.encrypted_config).not.toContain('birchfeed.app');
  });

  it('disconnects RSS and Readwise without retaining their encrypted credentials', async () => {
    const database = openMemoryDatabase();
    const encryptedConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    });
    const fetchImplementation = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/api/v2/auth/')) return new Response(null, { status: 204 });
      return new Response('', { status: 404 });
    };
    const connectionApp = createApp(encryptedConfig, { database, fetchImplementation });
    await request(connectionApp).put('/api/settings/rss').send({
      serverUrl: 'https://reader.example.test/api/greader.php',
      email: 'reader@example.test',
      apiKey: 'reader-secret',
    });
    await request(connectionApp).put('/api/settings/readwise').send({ token: 'readwise-secret' });

    const rssResponse = await request(connectionApp).delete('/api/settings/rss');
    const statusAfterRss = await request(connectionApp).get('/api/settings/status');
    const readwiseResponse = await request(connectionApp).delete('/api/settings/readwise');
    const status = await request(connectionApp).get('/api/settings/status');

    expect(rssResponse.body).toEqual({ provider: 'google-reader', configured: false, removed: true });
    expect(statusAfterRss.body.readwise.configured).toBe(true);
    expect(readwiseResponse.body).toEqual({ configured: false, removed: true });
    expect(status.body).toEqual({
      rss: { provider: 'google-reader', configured: false, serverUrl: null },
      readwise: { configured: false },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM integrations').get()).toEqual({ count: 0 });
  });

  it('normalizes safe Reader API URLs and rejects insecure remote endpoints', () => {
    expect(normalizeReaderServerUrl('https://reader.example.test/api/greader.php/', config))
      .toBe('https://reader.example.test/api/greader.php');
    expect(() => normalizeReaderServerUrl('http://reader.example.test/api/greader.php', config))
      .toThrow('Server URL must use HTTPS');
    expect(() => normalizeReaderServerUrl('https://user:password@reader.example.test/api/greader.php', config))
      .toThrow('Server URL cannot contain credentials');
  });

  it('adds a subscription to the configured Reader service', async () => {
    const database = openMemoryDatabase();
    const encryptedConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    });
    const fetchImplementation = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/token')) return new Response('write-token');
      if (url.includes('/subscription/quickadd')) return new Response(JSON.stringify({
        numResults: 1, query: 'https://example.test/feed.xml', streamId: 'feed/42', streamName: 'Example feed',
      }), { status: 200 });
      return new Response('', { status: 404 });
    };
    const subscriptionApp = createApp(encryptedConfig, { database, fetchImplementation });
    await request(subscriptionApp).put('/api/settings/rss').send({
      serverUrl: 'https://reader.example.test/api/greader.php',
      email: 'reader@example.test',
      apiKey: 'reader-secret',
    });

    const response = await request(subscriptionApp).post('/api/subscriptions').send({ feedUrl: 'https://example.test/feed.xml' });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      subscription: { id: 'feed/42', title: 'Example feed', url: 'https://example.test/feed.xml' },
      synchronized: true,
    });
  });

  it('saves highlights and documents through separate Readwise actions', async () => {
    const database = openMemoryDatabase();
    const encryptedConfig = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    const fetchImplementation = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/v2/auth/')) return new Response(null, { status: 204 });
      if (url.endsWith('/api/v2/highlights/')) return new Response(JSON.stringify([{ id: 42, modified_highlights: [99] }]), { status: 200 });
      if (url.endsWith('/api/v3/save/')) return new Response(JSON.stringify({ id: 'doc-1', url: 'https://readwise.io/reader/doc-1' }), { status: 201 });
      return new Response('', { status: 404 });
    };
    const readwiseApp = createApp(encryptedConfig, { database, fetchImplementation });
    expect((await request(readwiseApp).put('/api/settings/readwise').send({ token: 'readwise-secret' })).status).toBe(200);

    const article = {
      articleId: 'article-1',
      title: 'Article',
      author: 'Author',
      canonicalUrl: 'https://example.test/article',
    };
    const highlight = await request(readwiseApp).post('/api/readwise/highlights').send({
      ...article,
      text: 'Important text',
      note: 'Keep this',
      startOffset: 12,
      endOffset: 26,
    });
    const persistedHighlights = await request(readwiseApp).get('/api/highlights').query({ articleId: 'article-1' });
    const document = await request(readwiseApp).post('/api/readwise/documents').send(article);
    expect(highlight.status).toBe(201);
    expect(highlight.body).toMatchObject({
      synchronized: true,
      highlight: { text: 'Important text', startOffset: 12, endOffset: 26, readwiseStatus: 'saved', readwiseId: '99' },
    });
    expect(persistedHighlights.body.highlights).toHaveLength(1);
    expect(document.status).toBe(201);
    expect(document.body.document.id).toBe('doc-1');
    expect(database.prepare('SELECT readwise_status FROM highlights').get()).toEqual({ readwise_status: 'saved' });
  });

  it('retains a local highlight when Readwise is not connected', async () => {
    const localApp = createApp(config, { database: openMemoryDatabase() });
    const response = await request(localApp).post('/api/readwise/highlights').send({
      articleId: 'article-local',
      title: 'Article',
      author: null,
      canonicalUrl: 'https://example.test/article',
      text: 'Keep this locally',
      startOffset: 4,
      endOffset: 21,
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      synchronized: false,
      highlight: { text: 'Keep this locally', readwiseStatus: 'pending', startOffset: 4, endOffset: 21 },
    });
    expect(response.body.warning).toContain('connect Readwise');
  });
});
