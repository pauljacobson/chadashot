import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, ArticleMutation, ReaderSnapshot } from '../shared/reader';
import { getReaderSnapshot } from './api';
import {
  enqueueArticleMutation,
  enqueueArticleMutations,
  loadCachedSnapshot,
  overlayLocalMutations,
  queuedArticleMutations,
  reconcileSnapshotWithLocalMutations,
  requestPersistentStorage,
  saveCachedSnapshot,
} from './offlineStore';
import { describeOutboxFailure, outboxWorker, type OutboxRunResult } from './outboxWorker';
import { applyReadStates } from './readerState';
import {
  markMilestone,
  measureOutboxReplay,
  measureSnapshotPersistence,
  recordCollectionDiff,
  recordSynchronizationTrigger,
} from './performance';

export type ReaderFilter =
  | { kind: 'inbox' }
  | { kind: 'all' }
  | { kind: 'starred' }
  | { kind: 'uncategorized' }
  | { kind: 'folder'; id: string }
  | { kind: 'feed'; id: string };

export type SyncStatus = 'offline' | 'syncing' | 'current' | 'error';
export type ArticleReadFilter = 'all' | 'unread' | 'read';

export function filterArticlesByReadState(articles: Article[], filter: ArticleReadFilter) {
  if (filter === 'all') return articles;
  return articles.filter((article) => filter === 'read' ? article.read : !article.read);
}

function applyMutation(snapshot: ReaderSnapshot, mutation: ArticleMutation) {
  if (mutation.operation === 'read') return applyReadStates(snapshot, new Map([[mutation.articleId, mutation.value]]));
  return {
    ...snapshot,
    articles: snapshot.articles.map((article) => article.id === mutation.articleId
      ? { ...article, starred: mutation.value }
      : article),
  };
}

export async function loadReaderSnapshotWithoutWaitingForReplay(
  loadSnapshot: () => Promise<ReaderSnapshot>,
  reconcile: (snapshot: ReaderSnapshot) => Promise<{ snapshot: ReaderSnapshot; pendingMutations: number }>,
  replay: () => Promise<OutboxRunResult>,
) {
  const replayResult = replay();
  // The snapshot remains independently usable even if replay stalls or fails.
  void replayResult.catch(() => undefined);
  const reconciliation = await reconcile(await loadSnapshot());
  return { ...reconciliation, replayResult };
}

export function useReader(enabled = true) {
  const [snapshot, setSnapshot] = useState<ReaderSnapshot | null>(null);
  const [filter, setFilter] = useState<ReaderFilter>({ kind: 'inbox' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [readFilter, setReadFilter] = useState<ArticleReadFilter>('all');
  const [status, setStatus] = useState<SyncStatus>(navigator.onLine ? 'syncing' : 'offline');
  const [error, setError] = useState<string | null>(null);
  const [pendingMutations, setPendingMutations] = useState(0);
  const lastSync = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const currentSnapshot = useRef<ReaderSnapshot | null>(null);

  const refreshPendingCount = useCallback(async () => {
    setPendingMutations((await queuedArticleMutations()).length);
  }, []);

  const replayPendingMutations = useCallback(async () => {
    const attempted = (await queuedArticleMutations()).length;
    let result: OutboxRunResult | null = null;
    await measureOutboxReplay(attempted, async () => {
      result = await outboxWorker.run();
      return result.acknowledged;
    });
    return result!;
  }, []);

  const reportOutboxResult = useCallback((result: OutboxRunResult) => {
    setPendingMutations(result.pending);
    const message = describeOutboxFailure(result);
    if (message) {
      setError(message);
      setStatus(navigator.onLine ? 'error' : 'offline');
    } else if (!result.skippedBecauseLocked) {
      setError(null);
      setStatus(navigator.onLine ? 'current' : 'offline');
    }
  }, []);

  const synchronize = useCallback(async (trigger: 'startup' | 'manual' | 'interval' | 'visibility' | 'online' = 'manual') => {
    if (!enabled) return;
    if (!navigator.onLine) {
      setStatus('offline');
      return;
    }
    recordSynchronizationTrigger(trigger);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus('syncing');
    try {
      const reconciliation = await loadReaderSnapshotWithoutWaitingForReplay(
        () => getReaderSnapshot(controller.signal),
        reconcileSnapshotWithLocalMutations,
        replayPendingMutations,
      );
      const reconciled = reconciliation.snapshot;
      recordCollectionDiff(currentSnapshot.current, reconciled);
      currentSnapshot.current = reconciled;
      setSnapshot(reconciled);
      setSelectedId((current) => current ?? reconciled.articles[0]?.id ?? null);
      setPendingMutations(reconciliation.pendingMutations);
      setError(null);
      setStatus('current');
      void reconciliation.replayResult.then((result) => {
        if (!controller.signal.aborted) reportOutboxResult(result);
      }).catch(() => {
        if (!controller.signal.aborted) {
          setError('Queued changes could not be read and remain on this device');
          setStatus(navigator.onLine ? 'error' : 'offline');
        }
      });
      lastSync.current = Date.now();
      window.requestAnimationFrame(() => {
        markMilestone('first-server-backed-list', { articles: reconciled.articles.length });
        markMilestone('synchronization-complete', { articles: reconciled.articles.length });
      });
    } catch (syncError) {
      if (controller.signal.aborted) return;
      setError(syncError instanceof Error ? syncError.message : 'Synchronization failed');
      setStatus(navigator.onLine ? 'error' : 'offline');
      await refreshPendingCount().catch(() => undefined);
    }
  }, [enabled, refreshPendingCount, replayPendingMutations, reportOutboxResult]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let initialSync: number | undefined;
    void loadCachedSnapshot().then(async (cached) => {
      if (!active) return;
      if (cached && lastSync.current === 0) {
        const restored = await overlayLocalMutations(cached);
        if (!active) return;
        currentSnapshot.current = restored.snapshot;
        setSnapshot(restored.snapshot);
        setSelectedId((current) => current ?? restored.snapshot.articles[0]?.id ?? null);
        setPendingMutations(restored.pendingMutations);
        window.requestAnimationFrame(() => markMilestone('first-usable-cached-list', { articles: restored.snapshot.articles.length }));
      } else {
        await refreshPendingCount();
      }
      initialSync = window.setTimeout(() => void synchronize('startup'), 0);
    }).catch(() => {
      if (active) initialSync = window.setTimeout(() => void synchronize('startup'), 0);
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void synchronize('interval');
    }, 3 * 60 * 1000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastSync.current > 60_000) void synchronize('visibility');
    };
    const handleOnline = () => void synchronize('online');
    const handleOffline = () => setStatus('offline');
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      active = false;
      activeRequest.current?.abort();
      if (initialSync !== undefined) window.clearTimeout(initialSync);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [enabled, refreshPendingCount, synchronize]);

  useEffect(() => {
    if (!snapshot) return;
    void measureSnapshotPersistence(() => saveCachedSnapshot(snapshot)).catch(() => {
      setError('Could not update offline storage on this device');
      setStatus('error');
    });
  }, [snapshot]);

  useEffect(() => {
    if (enabled) void requestPersistentStorage();
  }, [enabled]);

  const filteredArticles = useMemo(() => {
    if (!snapshot) return [];
    const knownFolderIds = new Set(snapshot.folders.map((folder) => folder.id));
    const uncategorizedFeedIds = new Set(snapshot.subscriptions
      .filter((subscription) => subscription.folderIds.length === 0 || !subscription.folderIds.some((folderId) => knownFolderIds.has(folderId)))
      .map((subscription) => subscription.id));
    return snapshot.articles.filter((article) => {
      const inFilter =
        filter.kind === 'all'
        || (filter.kind === 'inbox' && !article.read)
        || (filter.kind === 'starred' && article.starred)
        || (filter.kind === 'uncategorized' && uncategorizedFeedIds.has(article.feedId))
        || (filter.kind === 'folder' && article.folderIds.includes(filter.id))
        || (filter.kind === 'feed' && article.feedId === filter.id);
      return inFilter;
    });
  }, [filter, snapshot]);

  const searchedArticles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return filteredArticles;
    return filteredArticles.filter((article) => {
      return [article.title, article.source, article.author, article.summary]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [filteredArticles, query]);

  const articles = useMemo(
    () => filterArticlesByReadState(searchedArticles, readFilter),
    [readFilter, searchedArticles],
  );

  const selectedArticle = useMemo(
    () => articles.find((article) => article.id === selectedId) ?? articles[0] ?? null,
    [articles, selectedId],
  );

  const mutate = useCallback(async (article: Article, operation: ArticleMutation['operation'], value: boolean) => {
    const mutation = { articleId: article.id, operation, value } satisfies ArticleMutation;
    setSnapshot((current) => current ? applyMutation(current, mutation) : current);

    let queued = false;
    try {
      await enqueueArticleMutation(mutation);
      queued = true;
      await refreshPendingCount();
      if (!navigator.onLine) {
        setStatus('offline');
        setError(null);
        return;
      }
      reportOutboxResult(await replayPendingMutations());
    } catch (mutationError) {
      if (queued) {
        await refreshPendingCount().catch(() => undefined);
        setError('Change saved on this device and will retry automatically');
        setStatus(navigator.onLine ? 'error' : 'offline');
        return;
      }
      await refreshPendingCount().catch(() => undefined);
      setSnapshot((current) => current ? applyMutation(current, { ...mutation, value: !value }) : current);
      setError(mutationError instanceof Error ? mutationError.message : 'Could not save change');
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }, [refreshPendingCount, replayPendingMutations, reportOutboxResult]);

  const markAllRead = useCallback(async (candidates: Article[]) => {
    const unread = candidates.filter((article) => !article.read);
    if (unread.length === 0) return 0;
    const mutations = unread.map((article) => ({ articleId: article.id, operation: 'read' as const, value: true }));
    setSnapshot((current) => current ? applyReadStates(current, new Map(unread.map((article) => [article.id, true]))) : current);

    let queued = false;
    try {
      await enqueueArticleMutations(mutations);
      queued = true;
      await refreshPendingCount();
      if (!navigator.onLine) {
        setStatus('offline');
        setError(null);
        return unread.length;
      }
      reportOutboxResult(await replayPendingMutations());
      return unread.length;
    } catch (mutationError) {
      if (queued) {
        await refreshPendingCount().catch(() => undefined);
        setError('Changes saved on this device and will retry automatically');
        setStatus(navigator.onLine ? 'error' : 'offline');
        return unread.length;
      }
      await refreshPendingCount().catch(() => undefined);
      setSnapshot((current) => current ? applyReadStates(current, new Map(unread.map((article) => [article.id, false]))) : current);
      setError(mutationError instanceof Error ? mutationError.message : 'Could not mark articles as read');
      setStatus(navigator.onLine ? 'error' : 'offline');
      throw mutationError;
    }
  }, [refreshPendingCount, replayPendingMutations, reportOutboxResult]);

  const clear = useCallback(() => {
    activeRequest.current?.abort();
    currentSnapshot.current = null;
    setSnapshot(null);
    setSelectedId(null);
    setFilter({ kind: 'inbox' });
    setReadFilter('all');
    setError(null);
    setPendingMutations(0);
    setStatus(navigator.onLine ? 'current' : 'offline');
  }, []);

  return {
    snapshot,
    articles,
    filteredArticles,
    selectedArticle,
    selectedId,
    filter,
    readFilter,
    query,
    status,
    error,
    pendingMutations,
    setFilter,
    setReadFilter,
    setQuery,
    selectArticle: setSelectedId,
    synchronize,
    clear,
    toggleRead: (article: Article) => mutate(article, 'read', !article.read),
    toggleStarred: (article: Article) => mutate(article, 'starred', !article.starred),
    markAllRead,
  };
}
