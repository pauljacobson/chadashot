// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderArticleMetadata, ReaderNavigation } from '../shared/reader';
import { clearOfflineData, loadCachedReader, queuedArticleMutations, queuedMarkReadJobs, saveReaderArticlePage, saveReaderNavigation } from './offlineStore';
import { useReader } from './useReader';

const navigation: ReaderNavigation = {
  accountKey: 'account-1', generation: 'generation-1', versions: { collection: 1, state: 1, body: 1 },
  counts: { all: 10, inbox: 9, starred: 0, uncategorized: 10 }, folders: [],
  feeds: ['feed-1', 'feed-2'].map((id) => ({
    id, title: id, url: `https://example.test/${id}`, siteUrl: null, iconUrl: null,
    folderIds: [], unreadCount: id === 'feed-1' ? 8 : 1, totalCount: id === 'feed-1' ? 9 : 1, latestPublishedAt: null,
  })),
};

function article(id: string, feedId = 'feed-1', read = false): ReaderArticleMetadata {
  return { id, feedId, read, folderIds: [], title: id, author: null, source: feedId,
    canonicalUrl: `https://example.test/${id}`, publishedAt: '2026-10-10T00:00:00.000Z',
    readingMinutes: 1, summary: id, starred: false };
}

async function savePage(articles: ReaderArticleMetadata[], reset = false) {
  await saveReaderArticlePage('user-1', { ...navigation, articles, total: 10, nextCursor: 'next' }, reset);
}

describe('mark loaded unread items', () => {
  beforeEach(async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    await clearOfflineData();
    await saveReaderNavigation('user-1', navigation);
    await savePage([article('loaded'), article('already-read', 'feed-1', true), article('other-feed', 'feed-2')], true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('queues only the confirmed loaded unread IDs and leaves later arrivals and other feeds unread', async () => {
    const { result } = renderHook(() => useReader('user-1'));
    await waitFor(() => expect(result.current.coverage?.loaded).toBe(3));
    act(() => result.current.setFilter({ kind: 'feed', id: 'feed-1' }));
    expect(result.current.loadedUnreadCount).toBe(1);
    const confirmedAction = result.current.markLoadedRead;

    await act(() => savePage([article('arrived-later')]));
    // Model another reader client publishing the newly cached page.
    const channel = new BroadcastChannel('chadashot-reader-v1');
    channel.postMessage({ accountKey: 'account-1', senderId: 'other-client' });
    channel.close();
    await waitFor(() => expect(result.current.loadedUnreadCount).toBe(2));
    let marked = 0;
    await act(async () => { marked = await confirmedAction(); });

    expect(marked).toBe(1);
    expect((await queuedArticleMutations('account-1')).map(({ articleId, operation, value }) => ({ articleId, operation, value })))
      .toEqual([{ articleId: 'loaded', operation: 'read', value: true }]);
    expect(await queuedMarkReadJobs()).toEqual([]);
    const cached = await loadCachedReader('user-1');
    expect(cached!.snapshot.articles.filter((item) => !item.read).map((item) => item.id).sort()).toEqual(['arrived-later', 'other-feed']);
    expect(cached!.snapshot.counts!.inbox).toBe(8);
    expect(cached!.coverage.complete).toBe(false);
  });
});
