import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createPerformanceFixture } from './performance-fixture.js';
import {
  ReaderPerformanceRun,
  ReaderSnapshotComparison,
  sendMeasuredReaderSnapshot,
} from './reader-performance.js';
import { AppLogger, readAppLogs } from './logging.js';

describe('reader performance measurements', () => {
  it('accounts for phases and keeps encoded and decoded provider bytes distinct', async () => {
    const run = new ReaderPerformanceRun();
    await run.measure('authentication', async () => {
      run.providerRequestStarted('authentication');
      run.providerResponseCompleted('authentication', new Response('decoded body', {
        headers: { 'Content-Encoding': 'gzip', 'Content-Length': '7' },
      }), 12);
    });
    run.recordItems('contentPages', 1_000, 1);

    const result = run.result({
      articles: 1_000,
      subscriptions: 10,
      changedItems: 1_000,
      unchangedItems: 0,
      comparison: 'no-prior-run',
    });

    expect(result.provider).toMatchObject({ requests: 1, completedResponses: 1, encodedBytes: 7, decodedBytes: 12, retries: 0 });
    expect(result.phases.authentication.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.phases.contentPages).toMatchObject({ pages: 1, items: 1_000 });
    expect(result.triggers.coalesced).toBe(0);
  });

  it('reports changed and unchanged items without exposing article data', () => {
    const comparison = new ReaderSnapshotComparison();
    const fixture = createPerformanceFixture(3);

    const first = comparison.compare('user', fixture);
    const second = comparison.compare('user', fixture);

    expect(first).toMatchObject({ changedItems: 3, unchangedItems: 0, comparison: 'no-prior-run' });
    expect(second).toMatchObject({ changedItems: 0, unchangedItems: 3, comparison: 'prior-run' });
    expect(JSON.stringify(second)).not.toContain('Synthetic article');
    expect(JSON.stringify(second)).not.toContain('example.invalid');
  });

  it('logs completed response bytes without logging fixture bodies or URLs', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chadashot-performance-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'development',
      LOG_LEVEL: 'debug',
      LOG_OUTPUT: 'file',
      LOG_FILE_PATH: path.join(directory, 'app.ndjson'),
    });
    const logger = new AppLogger(config);
    const fixture = createPerformanceFixture(3);
    const run = new ReaderPerformanceRun();
    const synchronization = run.result({
      articles: fixture.articles.length,
      subscriptions: fixture.subscriptions.length,
      changedItems: fixture.articles.length,
      unchangedItems: 0,
      comparison: 'no-prior-run',
    });
    const app = express().get('/snapshot', (_request, response) => {
      sendMeasuredReaderSnapshot(response, logger, fixture, synchronization);
    });

    const response = await request(app).get('/snapshot');
    const logText = fs.readFileSync(config.logFilePath, 'utf8');
    const entry = readAppLogs(config).entries[0];

    expect(response.status).toBe(200);
    expect(response.headers['x-reader-run-id']).toBe(synchronization.runId);
    expect(entry).toMatchObject({
      message: 'Reader synchronization measured',
      data: { response: { completed: true, disconnected: false, encodedBytes: Number(response.headers['content-length']) } },
    });
    expect(logText).not.toContain('Synthetic article');
    expect(logText).not.toContain('example.invalid');
  });
});
