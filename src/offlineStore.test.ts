// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReaderArticlePage, ReaderNavigation, ReaderSnapshot, SessionState } from '../shared/reader';
import {
  acknowledgeQueuedArticleMutations,
  acknowledgedArticleMutations,
  applyReaderChanges,
  applyQueuedArticleMutations,
  clearOfflineData,
  enqueueArticleMutation,
  enqueueArticleMutations,
  loadCachedReader,
  loadCachedSnapshot,
  loadOfflineSession,
  loadReaderBody,
  offlineStorageSummary,
  queuedArticleMutations,
  reconcileSnapshotWithLocalMutations,
  removeQueuedArticleMutation,
  saveCachedSnapshot,
  saveOfflineSession,
  saveReaderArticlePage,
  saveReaderBody,
  saveReaderChangeToken,
  saveReaderNavigation,
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

function navigation(accountKey = 'account-1', generation = 'generation-1'): ReaderNavigation {
  return {
    accountKey,
    generation,
    versions: { collection: 1, state: 1, body: 1 },
    counts: { all: 2, inbox: 2, starred: 0, uncategorized: 2 },
    folders: [],
    feeds: [{
      id: 'feed-1', title: 'Feed', url: 'https://example.test/feed', siteUrl: null, iconUrl: null,
      folderIds: [], unreadCount: 2, totalCount: 2, latestPublishedAt: '2026-09-08T00:00:00.000Z',
    }],
  };
}

function page(options: {
  accountKey?: string;
  generation?: string;
  articleId?: string;
  nextCursor?: string | null;
  total?: number;
  bodyVersion?: number;
} = {}): ReaderArticlePage {
  const accountKey = options.accountKey ?? 'account-1';
  const generation = options.generation ?? 'generation-1';
  const articleId = options.articleId ?? 'article-1';
  return {
    accountKey,
    generation,
    versions: { collection: 1, state: 1, body: options.bodyVersion ?? 1 },
    total: options.total ?? 1,
    nextCursor: options.nextCursor ?? null,
    articles: [{
      id: articleId, feedId: 'feed-1', folderIds: [], title: articleId, author: null, source: 'Feed',
      canonicalUrl: `https://example.test/${articleId}`, publishedAt: '2026-09-08T00:00:00.000Z',
      readingMinutes: 1, summary: articleId, read: false, starred: false,
    }],
  };
}

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

  it('persists a large local batch atomically for bounded replay', async () => {
    const mutations = Array.from({ length: 425 }, (_, index) => ({
      articleId: `article-${index}`,
      operation: 'read' as const,
      value: true,
    }));

    await enqueueArticleMutations(mutations);

    expect(await queuedArticleMutations()).toHaveLength(425);
  });

  it('replays queued read and star changes over a fresh server snapshot', async () => {
    const read = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });
    const starred = await enqueueArticleMutation({ articleId: 'article-1', operation: 'starred', value: true });

    const restored = applyQueuedArticleMutations(snapshot, [read, starred]);

    expect(restored.articles[0]).toMatchObject({ read: true, starred: true });
    expect(restored.folders[0].unreadCount).toBe(0);
    expect(restored.subscriptions[0].unreadCount).toBe(0);
  });

  it('does not let an older request acknowledge a newer local toggle', async () => {
    const submitted = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });
    const newer = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: false });

    expect(await acknowledgeQueuedArticleMutations([submitted])).toBe(0);
    expect(await queuedArticleMutations()).toEqual([newer]);
    expect(await acknowledgedArticleMutations()).toEqual([]);
  });

  it('retains acknowledged intent across a stale snapshot and an offline restart', async () => {
    const submitted = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });
    expect(await acknowledgeQueuedArticleMutations([submitted])).toBe(1);

    const stale = await reconcileSnapshotWithLocalMutations(snapshot);
    expect(stale.snapshot.articles[0].read).toBe(true);
    expect(stale.pendingMutations).toBe(0);
    expect(await acknowledgedArticleMutations()).toHaveLength(1);

    const confirmedSnapshot = {
      ...snapshot,
      articles: snapshot.articles.map((article) => ({ ...article, read: true })),
    };
    const confirmed = await reconcileSnapshotWithLocalMutations(confirmedSnapshot);
    expect(confirmed.snapshot.articles[0].read).toBe(true);
    expect(await acknowledgedArticleMutations()).toEqual([]);
  });

  it('lets a pending revision override an older acknowledgement', async () => {
    const submitted = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });
    await acknowledgeQueuedArticleMutations([submitted]);
    await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: false });

    const reconciled = await reconcileSnapshotWithLocalMutations(snapshot);

    expect(reconciled.snapshot.articles[0].read).toBe(false);
    expect(reconciled.pendingMutations).toBe(1);
  });

  it('clears cached identity, articles, and queued changes together', async () => {
    await saveCachedSnapshot(snapshot);
    await saveOfflineSession(session);
    await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });

    await clearOfflineData();

    expect(await loadCachedSnapshot()).toBeNull();
    expect(await loadOfflineSession()).toBeNull();
    expect(await queuedArticleMutations()).toEqual([]);
    expect(await acknowledgedArticleMutations()).toEqual([]);
  });

  it('hydrates normalized metadata before bodies and resumes an interrupted backfill', async () => {
    await saveReaderNavigation('user-1', navigation());
    await saveReaderArticlePage('user-1', page({ nextCursor: 'page-2', total: 2 }), true);
    await saveReaderChangeToken('account-1', 'baseline-token');

    const interrupted = await loadCachedReader('user-1');
    expect(interrupted?.snapshot.articles).toEqual([
      expect.objectContaining({ id: 'article-1', contentHtml: '' }),
    ]);
    expect(interrupted?.coverage).toMatchObject({ complete: false, nextCursor: 'page-2', changeToken: 'baseline-token' });

    await saveReaderArticlePage('user-1', page({ articleId: 'article-2', total: 2 }));
    const complete = await loadCachedReader('user-1');
    expect(complete?.snapshot.articles.map(({ id }) => id).sort()).toEqual(['article-1', 'article-2']);
    expect(complete?.coverage).toMatchObject({ loaded: 2, total: 2, complete: true, nextCursor: null });
  });

  it('loads bodies on demand and rejects a cached body from an older body version', async () => {
    await saveReaderNavigation('user-1', navigation());
    await saveReaderArticlePage('user-1', page(), true);
    await saveReaderBody({ accountKey: 'account-1', articleId: 'article-1', contentHtml: '<p>Body</p>', bodyVersion: 1 });

    expect(await loadReaderBody('account-1', 'article-1', 1)).toMatchObject({ contentHtml: '<p>Body</p>' });
    expect(await loadReaderBody('account-1', 'article-1', 2)).toBeNull();
  });

  it('isolates a replacement provider while preserving pending mutations', async () => {
    await saveReaderNavigation('user-1', navigation());
    await saveReaderArticlePage('user-1', page(), true);
    const queued = await enqueueArticleMutation({ articleId: 'article-1', operation: 'read', value: true });

    await saveReaderNavigation('user-1', navigation('account-2', 'generation-2'));
    await saveReaderArticlePage('user-1', page({ accountKey: 'account-2', generation: 'generation-2', articleId: 'other-article' }), true);

    expect((await loadCachedReader('user-1'))?.accountKey).toBe('account-2');
    expect((await loadCachedReader('user-1'))?.snapshot.articles.map(({ id }) => id)).toEqual(['other-article']);
    expect(await queuedArticleMutations()).toEqual([queued]);
  });

  it('migrates the legacy snapshot without dropping an in-flight revision', async () => {
    await saveCachedSnapshot(snapshot);
    const queued = await enqueueArticleMutation({ articleId: 'article-1', operation: 'starred', value: true });

    const migrated = await loadCachedReader('another-user');

    expect(migrated?.accountKey).toBe('legacy:another-user');
    expect(migrated?.snapshot.articles[0]).toMatchObject({ id: 'article-1', contentHtml: '<p>One</p>' });
    expect(await queuedArticleMutations()).toEqual([queued]);
  });

  it('keeps provider-specific revisions separate even when article IDs match', async () => {
    const first = await enqueueArticleMutation({ articleId: 'same-article', operation: 'read', value: true }, 'account-1');
    const second = await enqueueArticleMutation({ articleId: 'same-article', operation: 'read', value: false }, 'account-2');

    expect(await queuedArticleMutations('account-1')).toEqual([first]);
    expect(await queuedArticleMutations('account-2')).toEqual([second]);
    expect(await queuedArticleMutations()).toEqual([first, second]);
  });

  it('applies record-level deltas and invalidates only a changed article body', async () => {
    await saveReaderNavigation('user-1', navigation());
    await saveReaderArticlePage('user-1', page(), true);
    await saveReaderBody({ accountKey: 'account-1', articleId: 'article-1', contentHtml: '<p>Old</p>', bodyVersion: 1 });

    await applyReaderChanges({
      accountKey: 'account-1',
      hasMore: false,
      token: 'next-token',
      versions: { collection: 1, state: 2, body: 2 },
      changes: [{
        sequence: 1,
        kind: 'upsert',
        articleId: 'article-1',
        metadataChanged: false,
        stateChanged: true,
        bodyChanged: true,
        deleted: false,
        versions: { collection: 1, state: 2, body: 2 },
        payload: { ...page().articles[0], read: true },
      }],
    });

    expect((await loadCachedReader('user-1'))?.snapshot.articles[0]).toMatchObject({ read: true, contentHtml: '' });
    expect(await loadReaderBody('account-1', 'article-1', 1)).toBeNull();
  });
});
