import { describe, expect, it } from 'vitest';
import type { ReaderSnapshot } from '../shared/reader';
import {
  browserPerformanceSnapshot,
  recordCollectionDiff,
  recordMountedRows,
  recordReaderResponse,
  resetBrowserPerformance,
} from './performance';

const snapshot = (contentHtml = '<p>private article body</p>'): ReaderSnapshot => ({
  generatedAt: '2026-01-01T00:00:00.000Z',
  source: 'fixture',
  folders: [],
  subscriptions: [],
  articles: [{
    id: 'private-id',
    feedId: 'feed:https://private.example/rss',
    folderIds: [],
    title: 'Private title',
    author: null,
    source: 'Private source',
    canonicalUrl: 'https://private.example/article',
    publishedAt: '2026-01-01T00:00:00.000Z',
    readingMinutes: 1,
    summary: 'Private summary',
    contentHtml,
    read: false,
    starred: false,
  }],
});

describe('browser performance measurements', () => {
  it('records counts and byte sizes without retaining content or URLs', () => {
    resetBrowserPerformance();
    recordReaderResponse(new Response('{}', {
      headers: { 'Content-Length': '1', 'X-Reader-Run-Id': '12345678-1234-1234-1234-123456789abc' },
    }), '{"secret":"article text"}');
    recordCollectionDiff(snapshot(), snapshot('<p>changed private body</p>'));
    recordMountedRows(201);

    const result = browserPerformanceSnapshot();
    const serialized = JSON.stringify(result);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'reader-response', browserRequests: 1, browserRequestBytes: 0, encodedBytes: 1, decodedBytes: 25 }),
      expect.objectContaining({ name: 'collection-diff', articles: 1, changedItems: 1, unchangedItems: 0 }),
      expect.objectContaining({ name: 'mounted-rows', mountedRows: 201 }),
    ]));
    expect(result.maximumMountedRows).toBe(201);
    expect(serialized).not.toContain('article text');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('Private title');
  });
});
