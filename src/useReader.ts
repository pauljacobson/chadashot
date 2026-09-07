import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, ArticleMutation, ReaderSnapshot } from '../shared/reader';
import { ApiError, getReaderSnapshot, sendArticleMutation, sendArticleMutations } from './api';
import {
  applyQueuedArticleMutations,
  enqueueArticleMutation,
  loadCachedSnapshot,
  queuedArticleMutations,
  removeQueuedArticleMutation,
  requestPersistentStorage,
  saveCachedSnapshot,
} from './offlineStore';
import { applyReadStates } from './readerState';

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

function shouldQueue(error: unknown) {
  return !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
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

  const refreshPendingCount = useCallback(async () => {
    setPendingMutations((await queuedArticleMutations()).length);
  }, []);

  const synchronize = useCallback(async () => {
    if (!enabled) return;
    if (!navigator.onLine) {
      setStatus('offline');
      return;
    }
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus('syncing');
    try {
      let outboxError: unknown = null;
      for (const queued of await queuedArticleMutations()) {
        try {
          await sendArticleMutation({
            articleId: queued.articleId,
            operation: queued.operation,
            value: queued.value,
          });
          await removeQueuedArticleMutation(queued);
        } catch (mutationError) {
          outboxError = mutationError;
          break;
        }
      }

      const next = await getReaderSnapshot(controller.signal);
      const remaining = await queuedArticleMutations();
      const reconciled = applyQueuedArticleMutations(next, remaining);
      setSnapshot(reconciled);
      setSelectedId((current) => current ?? reconciled.articles[0]?.id ?? null);
      setPendingMutations(remaining.length);
      setError(outboxError ? 'Some offline changes are still waiting to synchronize' : null);
      setStatus(outboxError ? 'error' : 'current');
      lastSync.current = Date.now();
    } catch (syncError) {
      if (controller.signal.aborted) return;
      setError(syncError instanceof Error ? syncError.message : 'Synchronization failed');
      setStatus(navigator.onLine ? 'error' : 'offline');
      await refreshPendingCount().catch(() => undefined);
    }
  }, [enabled, refreshPendingCount]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let initialSync: number | undefined;
    void Promise.all([loadCachedSnapshot(), queuedArticleMutations()]).then(([cached, queued]) => {
      if (!active) return;
      if (cached && lastSync.current === 0) {
        const restored = applyQueuedArticleMutations(cached, queued);
        setSnapshot(restored);
        setSelectedId((current) => current ?? restored.articles[0]?.id ?? null);
      }
      setPendingMutations(queued.length);
      initialSync = window.setTimeout(() => void synchronize(), 0);
    }).catch(() => {
      if (active) initialSync = window.setTimeout(() => void synchronize(), 0);
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void synchronize();
    }, 3 * 60 * 1000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastSync.current > 60_000) void synchronize();
    };
    const handleOnline = () => void synchronize();
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
  }, [enabled, synchronize]);

  useEffect(() => {
    if (!snapshot) return;
    void saveCachedSnapshot(snapshot).catch(() => {
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

    let queued: Awaited<ReturnType<typeof enqueueArticleMutation>> | null = null;
    try {
      queued = await enqueueArticleMutation(mutation);
      await refreshPendingCount();
      if (!navigator.onLine) {
        setStatus('offline');
        setError(null);
        return;
      }
      await sendArticleMutation(mutation);
      await removeQueuedArticleMutation(queued);
      await refreshPendingCount();
    } catch (mutationError) {
      if (queued && shouldQueue(mutationError)) {
        setError('Change saved on this device and will retry automatically');
        setStatus(navigator.onLine ? 'error' : 'offline');
        return;
      }
      if (queued) await removeQueuedArticleMutation(queued).catch(() => undefined);
      await refreshPendingCount().catch(() => undefined);
      setSnapshot((current) => current ? applyMutation(current, { ...mutation, value: !value }) : current);
      setError(mutationError instanceof Error ? mutationError.message : 'Could not save change');
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }, [refreshPendingCount]);

  const markAllRead = useCallback(async (candidates: Article[]) => {
    const unread = candidates.filter((article) => !article.read);
    if (unread.length === 0) return 0;
    const mutations = unread.map((article) => ({ articleId: article.id, operation: 'read' as const, value: true }));
    setSnapshot((current) => current ? applyReadStates(current, new Map(unread.map((article) => [article.id, true]))) : current);

    let queued = [] as Awaited<ReturnType<typeof enqueueArticleMutation>>[];
    try {
      queued = await Promise.all(mutations.map(enqueueArticleMutation));
      await refreshPendingCount();
      if (!navigator.onLine) {
        setStatus('offline');
        setError(null);
        return unread.length;
      }
      await sendArticleMutations(mutations);
      await Promise.all(queued.map(removeQueuedArticleMutation));
      await refreshPendingCount();
      return unread.length;
    } catch (mutationError) {
      if (queued.length > 0 && shouldQueue(mutationError)) {
        setError('Changes saved on this device and will retry automatically');
        setStatus(navigator.onLine ? 'error' : 'offline');
        return unread.length;
      }
      await Promise.all(queued.map((mutation) => removeQueuedArticleMutation(mutation).catch(() => undefined)));
      await refreshPendingCount().catch(() => undefined);
      setSnapshot((current) => current ? applyReadStates(current, new Map(unread.map((article) => [article.id, false]))) : current);
      setError(mutationError instanceof Error ? mutationError.message : 'Could not mark articles as read');
      setStatus(navigator.onLine ? 'error' : 'offline');
      throw mutationError;
    }
  }, [refreshPendingCount]);

  const clear = useCallback(() => {
    activeRequest.current?.abort();
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
