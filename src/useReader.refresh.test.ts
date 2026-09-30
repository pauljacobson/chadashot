// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderArticlePage, ReaderNavigation, ReaderSynchronizationStatus } from '../shared/reader';
import * as api from './api';
import { clearOfflineData, saveReaderArticlePage, saveReaderChangeToken, saveReaderNavigation } from './offlineStore';
import { useReader } from './useReader';

vi.mock('./api', async (original) => ({ ...await original<typeof import('./api')>(),
  getReaderRuntimeConfig: vi.fn(), getReaderSynchronizationStatus: vi.fn(), requestReaderRefresh: vi.fn(),
  getReaderNavigation: vi.fn(), getReaderChanges: vi.fn(), getReaderArticles: vi.fn(),
  getMarkReadJobs: vi.fn(), getReaderArticleBody: vi.fn(),
}));
vi.mock('./outboxWorker', async (original) => ({ ...await original<typeof import('./outboxWorker')>(),
  outboxWorker: { run: vi.fn(async () => ({ attempted: 0, submitted: 0, acknowledged: 0, pending: 0,
    failureKind: null, error: null, skippedBecauseLocked: false })) },
}));

const versions = { collection: 1, state: 1, body: 1 };
const navigation: ReaderNavigation = { accountKey: 'account', generation: 'generation', versions,
  counts: { all: 1, inbox: 1, starred: 0, uncategorized: 1 }, folders: [], feeds: [] };
const page: ReaderArticlePage = { accountKey: 'account', generation: 'generation', versions, total: 1,
  nextCursor: null, articles: [{ id: 'old', feedId: 'feed', folderIds: [], title: 'old', author: null,
    source: 'Feed', canonicalUrl: 'https://example.test/old', publishedAt: '2026-09-30T00:00:00Z',
    readingMinutes: 1, summary: 'old', read: false, starred: false }] };
function status(state: ReaderSynchronizationStatus['state']): ReaderSynchronizationStatus {
  return { accountKey: 'account', state, itemsStaged: 0, lastAttemptAt: null, lastSuccessAt: '2026-09-30T00:00:00Z',
    error: null, storageDeferral: null, versions };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(api.getReaderRuntimeConfig).mockReset();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await clearOfflineData();
  await saveReaderArticlePage('owner', page, true);
  await saveReaderChangeToken('account', 'baseline');
  await saveReaderNavigation('owner', navigation);
  vi.mocked(api.getReaderRuntimeConfig).mockResolvedValue({ path: 'paginated' });
  vi.mocked(api.getReaderSynchronizationStatus).mockResolvedValue(status('current'));
  vi.mocked(api.getReaderNavigation).mockResolvedValue(navigation);
  vi.mocked(api.getReaderChanges).mockResolvedValue({ accountKey: 'account', changes: [], hasMore: false,
    token: 'next', versions });
  vi.mocked(api.getReaderArticles).mockResolvedValue(page);
  vi.mocked(api.getMarkReadJobs).mockResolvedValue({ jobs: [] });
  vi.mocked(api.getReaderArticleBody).mockResolvedValue({ accountKey: 'account', articleId: 'old', contentHtml: '<p>old</p>', bodyVersion: 1 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('foreground reader refresh', () => {
  it('keeps the cached list usable and fetches completed server updates automatically', async () => {
    vi.mocked(api.getReaderSynchronizationStatus).mockResolvedValue(status('refreshing'));
    const { result } = renderHook(() => useReader('owner'));
    await waitFor(() => expect(api.getReaderChanges).toHaveBeenCalled());
    expect(result.current.snapshot?.articles[0]?.id).toBe('old');
    expect(result.current.status).toBe('syncing');
    await waitFor(() => expect(api.getReaderSynchronizationStatus).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(api.getReaderChanges).toHaveBeenCalledOnce();
    vi.mocked(api.getReaderSynchronizationStatus).mockResolvedValue(status('current'));
    const fresh = { ...page.articles[0], id: 'new', title: 'new' };
    vi.mocked(api.getReaderChanges).mockResolvedValue({ accountKey: 'account', hasMore: false, token: 'fresh',
      versions, changes: [{ sequence: 1, kind: 'upsert', articleId: 'new', metadataChanged: true,
        stateChanged: false, bodyChanged: false, deleted: false, versions, payload: fresh }] });
    await waitFor(() => expect(result.current.snapshot?.articles.some((article) => article.id === 'new')).toBe(true), { timeout: 6000 });
    await waitFor(() => expect(result.current.status).toBe('current'));
  }, 10_000);

  it('coalesces overlapping automatic triggers instead of aborting a useful request', async () => {
    let finish!: (value: { path: 'paginated' }) => void;
    vi.mocked(api.getReaderRuntimeConfig).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useReader('owner'));
    await waitFor(() => expect(api.getReaderRuntimeConfig).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.getReaderRuntimeConfig).mock.calls[0][0]!;
    act(() => { void result.current.synchronize('online'); });
    expect(signal.aborted).toBe(false);
    expect(api.getReaderRuntimeConfig).toHaveBeenCalledOnce();
    await act(async () => { finish({ path: 'paginated' }); });
  });

  it('refreshes immediately after a back-forward cache restore even after a recent sync', async () => {
    renderHook(() => useReader('owner'));
    await waitFor(() => expect(api.getReaderChanges).toHaveBeenCalledOnce());
    await act(async () => { window.dispatchEvent(new Event('pageshow')); });
    await waitFor(() => expect(api.getReaderChanges).toHaveBeenCalledTimes(2));
  });
  it('retains a manual refresh requested while automatic synchronization is running', async () => {
    let finish!: (value: { path: 'paginated' }) => void;
    vi.mocked(api.getReaderRuntimeConfig).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useReader('owner'));
    await waitFor(() => expect(api.getReaderRuntimeConfig).toHaveBeenCalledOnce());
    await act(async () => { await result.current.synchronize('manual'); });
    expect(api.requestReaderRefresh).not.toHaveBeenCalled();
    await act(async () => { finish({ path: 'paginated' }); });
    await waitFor(() => expect(api.requestReaderRefresh).toHaveBeenCalledOnce());
  });

  it('cancels suspended work and starts a fresh request when the app becomes visible', async () => {
    vi.mocked(api.getReaderRuntimeConfig).mockImplementationOnce((signal) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    renderHook(() => useReader('owner'));
    await waitFor(() => expect(api.getReaderRuntimeConfig).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.getReaderRuntimeConfig).mock.calls[0][0]!;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(signal.aborted).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(api.getReaderChanges).toHaveBeenCalledOnce());
  });

  it('stops completion polling after unmount', async () => {
    vi.mocked(api.getReaderSynchronizationStatus).mockResolvedValue(status('refreshing'));
    const { unmount } = renderHook(() => useReader('owner'));
    await waitFor(() => expect(api.getReaderChanges).toHaveBeenCalledOnce());
    unmount();
    const calls = vi.mocked(api.getReaderSynchronizationStatus).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(api.getReaderSynchronizationStatus).toHaveBeenCalledTimes(calls);
  });

});
