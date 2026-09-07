// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReaderSnapshot, SessionState } from '../shared/reader';
import {
  applyQueuedArticleMutations,
  clearOfflineData,
  enqueueArticleMutation,
  loadCachedSnapshot,
  loadOfflineSession,
  offlineStorageSummary,
  queuedArticleMutations,
  removeQueuedArticleMutation,
  saveCachedSnapshot,
  saveOfflineSession,
} from './offlineStore';

const snapshot: ReaderSnapshot = {
  generatedAt: '2026-09-07T00:00:00.000Z',
  source: 'fixture',
  folders: [{ id: 'folder-1', title: 'Folder', unreadCount: 1 }],
  subscriptions: [{
    id: 'feed-1', title: 'Feed', url: 'https://example.test/feed', siteUrl: null,
    iconUrl: null, folderIds: ['folder-1'], unreadCount: 1,
  }],
  articles: [{
    id: 'article-1', feedId: 'feed-1', folderIds: ['folder-1'], title: 'One', author: null,
    source: 'Feed', canonicalUrl: 'https://example.test/one', publishedAt: '2026-09-07T00:00:00.000Z',
    readingMinutes: 1, summary: 'One', contentHtml: '<p>One</p>', read: false, starred: false,
  }],
};

const session: SessionState = {
  authenticated: true,
  mode: 'passkey',
  setupRequired: false,
  user: { id: 'user-1', displayName: 'Paul' },
};

describe('offline reader storage', () => {
  beforeEach(async () => {
    await clearOfflineData();
  });

  it('persists the reader snapshot and authenticated session', async () => {
    await saveCachedSnapshot(snapshot);
    await saveOfflineSession(session);

    expect(await loadCachedSnapshot()).toEqual(snapshot);
    expect(await loadOfflineSession()).toEqual(session);
    expect(await offlineStorageSummary()).toMatchObject({ articles: 1, queuedChanges: 0 });
  });

  it('coalesces repeated changes and only acknowledges the current revision', async () => {
    const first = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });
    const latest = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: false });

    await removeQueuedArticleMutation(first);
    expect(await queuedArticleMutations()).toEqual([latest]);

    await removeQueuedArticleMutation(latest);
    expect(await queuedArticleMutations()).toEqual([]);
  });

  it('replays queued read and star changes over a fresh server snapshot', async () => {
    const read = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });
    const starred = await enqueueArticleMutation({ articleId: 'article-1', operation: 'starred', value: true });

    const restored = applyQueuedArticleMutations(snapshot, [read, starred]);

    expect(restored.articles[0]).toMatchObject({ read: true, starred: true });
    expect(restored.folders[0].unreadCount).toBe(0);
    expect(restored.subscriptions[0].unreadCount).toBe(0);
  });

  it('clears cached identity, articles, and queued changes together', async () => {
    await saveCachedSnapshot(snapshot);
    await saveOfflineSession(session);
    await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });

    await clearOfflineData();

    expect(await loadCachedSnapshot()).toBeNull();
    expect(await loadOfflineSession()).toBeNull();
    expect(await queuedArticleMutations()).toEqual([]);
  });
});
