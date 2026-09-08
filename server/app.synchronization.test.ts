import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openMemoryDatabase } from './database.js';
import { saveIntegration } from './integrations/settings.js';
import { AppLogger, readAppLogs } from './logging.js';

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function encryptedConfig(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  return {
    ...loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    }),
    readerCacheEnabled: false,
    ...overrides,
  };
}

function providerResponse(input: string | URL | Request) {
  const url = String(input);
  if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
  if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{ id: 'feed/1', title: 'Feed', categories: [] }] });
  if (url.includes('/unread-count')) return jsonResponse({ unreadcounts: [] });
  if (url.includes('/stream/items/ids')) return jsonResponse({ itemRefs: [] });
  if (url.includes('/stream/contents/')) return jsonResponse({ items: [{
    id: 'article-1', title: 'Article', categories: [], origin: { streamId: 'feed/1', title: 'Feed' },
  }] });
  throw new Error(`Unexpected URL: ${url}`);
}

describe('reader synchronization safeguards', () => {
  it('coalesces ten overlapping snapshots into one provider traversal', async () => {
    const config = encryptedConfig();
    const database = openMemoryDatabase();
    saveIntegration(database, config, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-coalescing-'));
    const loggingConfig = { ...config, logLevel: 'debug' as const, logOutput: 'file' as const, logFilePath: path.join(directory, 'app.ndjson') };
    const logger = new AppLogger(loggingConfig);
    let releaseContent!: () => void;
    let contentStarted!: () => void;
    const started = new Promise<void>((resolve) => { contentStarted = resolve; });
    const contentGate = new Promise<void>((resolve) => { releaseContent = resolve; });
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/stream/contents/')) {
        contentStarted();
        await contentGate;
      }
      return providerResponse(input);
    });
    const app = createApp(loggingConfig, { database, fetchImplementation, logger });

    const callers = Array.from({ length: 10 }, () => request(app).get('/api/reader/snapshot').set('Accept-Encoding', 'identity'));
    const responsesPromise = Promise.all(callers);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseContent();
    const responses = await responsesPromise;

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.headers['x-reader-run-id'])).size).toBe(1);
    expect(fetchImplementation.mock.calls.filter(([input]) => String(input).endsWith('/accounts/ClientLogin'))).toHaveLength(1);
    expect(fetchImplementation.mock.calls.filter(([input]) => String(input).includes('/stream/contents/'))).toHaveLength(1);
    const measurements = readAppLogs(loggingConfig).entries.filter((entry) => entry.message === 'Reader synchronization measured');
    expect(measurements).toHaveLength(10);
    expect(measurements.every((entry) => (
      (entry.data?.synchronization as { triggers?: { coalesced?: number } } | undefined)?.triggers?.coalesced === 9
    ))).toBe(true);
  });

  it('rejects an old result after credentials change and lets the new generation synchronize', async () => {
    const config = encryptedConfig();
    const database = openMemoryDatabase();
    saveIntegration(database, config, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'old@example.test', apiKey: 'old-secret',
    });
    let firstContent = true;
    let contentStarted!: () => void;
    const started = new Promise<void>((resolve) => { contentStarted = resolve; });
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/stream/contents/') && firstContent) {
        firstContent = false;
        contentStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return providerResponse(input);
    });
    const app = createApp(config, { database, fetchImplementation });

    const oldRequest = request(app).get('/api/reader/snapshot').then((response) => response);
    await started;
    const changed = await request(app).put('/api/settings/rss').send({
      serverUrl: 'https://reader.example.test', email: 'new@example.test', apiKey: 'new-secret',
    });
    const oldResponse = await oldRequest;
    const newResponse = await request(app).get('/api/reader/snapshot');

    expect(changed.status).toBe(200);
    expect(oldResponse.status).toBe(409);
    expect(newResponse.status).toBe(200);
    expect(newResponse.body.articles).toHaveLength(1);
  });

  it('returns a defined gateway timeout when a provider ignores cancellation', async () => {
    const config = encryptedConfig({ readerSyncTimeoutMs: 10 });
    const database = openMemoryDatabase();
    saveIntegration(database, config, 'birchfeed', {
      serverUrl: 'https://reader.example.test', email: 'reader@example.test', apiKey: 'secret',
    });
    const app = createApp(config, { database, fetchImplementation: async () => new Promise<Response>(() => undefined) });

    const response = await request(app).get('/api/reader/snapshot');

    expect(response.status).toBe(504);
    expect(response.body.error).toContain('provider deadline');
  });
});
