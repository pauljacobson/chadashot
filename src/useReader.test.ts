import { describe, expect, it, vi } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader';
import { filterArticlesByReadState, loadReaderSnapshotWithoutWaitingForReplay } from './useReader';
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
