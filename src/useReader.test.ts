import { describe, expect, it, vi } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader';
import { filterArticlesByReadState, loadReaderSnapshotWithoutWaitingForReplay, markReadCoverageError } from './useReader';
import { readerBoundariesMatch, readerCountStatus, readerScopeTotal } from './readerCounts';
import type { OutboxRunResult } from './outboxWorker';

const articles = [
  { id: 'unread', read: false },
  { id: 'read', read: true },
] as Article[];

describe('article read-state filter', () => {
  it('keeps the displayed count aligned with all, unread, and read views', () => {
    expect(filterArticlesByReadState(articles, 'all').map((article) => article.id)).toEqual(['unread', 'read']);
    expect(filterArticlesByReadState(articles, 'unread').map((article) => article.id)).toEqual(['unread']);
    expect(filterArticlesByReadState(articles, 'read').map((article) => article.id)).toEqual(['read']);
  });
});

describe('reader synchronization', () => {
  it('returns reader data without waiting for a stalled outbox replay', async () => {
    let finishReplay: ((result: OutboxRunResult) => void) | undefined;
    const replay = vi.fn(() => new Promise<OutboxRunResult>((resolve) => { finishReplay = resolve; }));
    const readerSnapshot = { articles: [] } as unknown as ReaderSnapshot;
    const loadSnapshot = vi.fn(async () => readerSnapshot);
    const reconcile = vi.fn(async (next: ReaderSnapshot) => ({ snapshot: next, pendingMutations: 1 }));

    const loaded = await loadReaderSnapshotWithoutWaitingForReplay(loadSnapshot, reconcile, replay);

    expect(loaded.snapshot).toBe(readerSnapshot);
    expect(loaded.pendingMutations).toBe(1);
    expect(replay).toHaveBeenCalledOnce();
    expect(finishReplay).toBeTypeOf('function');

    finishReplay!({
      attempted: 1,
      submitted: 0,
      acknowledged: 0,
      pending: 1,
      failureKind: null,
      error: null,
      skippedBecauseLocked: false,
    });
    await loaded.replayResult;
  });
});

describe('versioned reader counts', () => {
  const partialSnapshot = {
    generatedAt: '2026-09-09T10:24:00.000Z',
    source: 'google-reader',
    counts: { all: 29_402, inbox: 18_916, starred: 20, uncategorized: 4_000 },
    folders: [],
    subscriptions: [],
    articles: Array.from({ length: 1_600 }, (_, index) => ({ id: `article-${index}`, read: index >= 1_192 })),
    cacheStatus: {
      state: 'current',
      lastSuccessAt: '2026-09-09T10:24:00.000Z',
      error: null,
      versions: { collection: 1, state: 1, body: 1 },
    },
  } as unknown as ReaderSnapshot;

  const partialCoverage = {
    loaded: 1_600,
    total: 29_402,
    complete: false,
    nextCursor: 'next',
    changeToken: 'token',
    backfillInterrupted: true,
  };

  it('uses the full navigation total instead of the unread subset cached on the device', () => {
    expect(partialSnapshot.articles.filter((article) => !article.read)).toHaveLength(1_192);
    expect(readerScopeTotal(partialSnapshot, { kind: 'inbox' }, 'all', '')).toBe(18_916);
    expect(readerCountStatus(true, partialCoverage, true)).toBe('current');
  });

  it('moves the Inbox total atomically to a refreshed state version', () => {
    const refreshed = {
      ...partialSnapshot,
      counts: { ...partialSnapshot.counts!, inbox: 3_148 },
      cacheStatus: {
        ...partialSnapshot.cacheStatus!,
        versions: { ...partialSnapshot.cacheStatus!.versions, state: 2 },
      },
    };

    expect(readerScopeTotal(partialSnapshot, { kind: 'inbox' }, 'all', '')).toBe(18_916);
    expect(readerScopeTotal(refreshed, { kind: 'inbox' }, 'all', '')).toBe(3_148);
    expect(readerBoundariesMatch(
      'generation-1',
      partialSnapshot.cacheStatus!.versions,
      'generation-1',
      refreshed.cacheStatus!.versions,
    )).toBe(false);
  });

  it('distinguishes a last-known full count from a partial offline fallback', () => {
    expect(readerCountStatus(true, partialCoverage, false)).toBe('last-synced');
    expect(readerCountStatus(false, partialCoverage, false)).toBe('cached-partial');
  });
});

describe('bulk mark-read availability', () => {
  it('defers offline confirmation when the cached scope is incomplete', () => {
    expect(markReadCoverageError({
      loaded: 425,
      total: 20_000,
      complete: false,
      nextCursor: 'next',
      changeToken: null,
      backfillInterrupted: true,
    })).toBe('Only 425 of 20,000 articles are cached. Finish synchronization before marking this view read.');
  });

  it('allows a complete cached boundary', () => {
    expect(markReadCoverageError({
      loaded: 20_000,
      total: 20_000,
      complete: true,
      nextCursor: null,
      changeToken: 'token',
      backfillInterrupted: false,
    })).toBeNull();
  });
});
