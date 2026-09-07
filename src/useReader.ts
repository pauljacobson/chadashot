import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, ArticleMutation, ReaderSnapshot } from '../shared/reader';
import { getReaderSnapshot, sendArticleMutation, sendArticleMutations } from './api';
import { applyReadStates } from './readerState';

export type ReaderFilter =
  | { kind: 'inbox' }
  | { kind: 'all' }
  | { kind: 'starred' }
  | { kind: 'uncategorized' }
  | { kind: 'folder'; id: string }
  | { kind: 'feed'; id: string };

export type SyncStatus = 'offline' | 'syncing' | 'current' | 'error';

export function useReader(enabled = true) {
  const [snapshot, setSnapshot] = useState<ReaderSnapshot | null>(null);
  const [filter, setFilter] = useState<ReaderFilter>({ kind: 'inbox' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SyncStatus>(navigator.onLine ? 'syncing' : 'offline');
  const [error, setError] = useState<string | null>(null);
  const lastSync = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

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
      const next = await getReaderSnapshot(controller.signal);
      setSnapshot((current) => {
        if (!current) return next;
        const localState = new Map(current.articles.map((article) => [article.id, { read: article.read, starred: article.starred }]));
        return {
          ...next,
          articles: next.articles.map((article) => ({ ...article, ...localState.get(article.id) })),
        };
      });
      setSelectedId((current) => current ?? next.articles[0]?.id ?? null);
      setError(null);
      setStatus('current');
      lastSync.current = Date.now();
    } catch (syncError) {
      if (controller.signal.aborted) return;
      setError(syncError instanceof Error ? syncError.message : 'Synchronization failed');
      setStatus('error');
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const initialSync = window.setTimeout(() => void synchronize(), 0);
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
      activeRequest.current?.abort();
      window.clearTimeout(initialSync);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [enabled, synchronize]);

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

  const articles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return filteredArticles;
    return filteredArticles.filter((article) => {
      return [article.title, article.source, article.author, article.summary]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [filteredArticles, query]);

  const selectedArticle = useMemo(
    () => snapshot?.articles.find((article) => article.id === selectedId) ?? articles[0] ?? null,
    [articles, selectedId, snapshot],
  );

  const mutate = useCallback(async (article: Article, operation: ArticleMutation['operation'], value: boolean) => {
    setSnapshot((current) => {
      if (!current) return current;
      if (operation === 'read') return applyReadStates(current, new Map([[article.id, value]]));
      return {
        ...current,
        articles: current.articles.map((candidate) => candidate.id === article.id ? { ...candidate, starred: value } : candidate),
      };
    });

    try {
      await sendArticleMutation({ articleId: article.id, operation, value });
    } catch (mutationError) {
      setSnapshot((current) => {
        if (!current) return current;
        if (operation === 'read') return applyReadStates(current, new Map([[article.id, !value]]));
        return {
          ...current,
          articles: current.articles.map((candidate) => candidate.id === article.id ? { ...candidate, starred: !value } : candidate),
        };
      });
      setError(mutationError instanceof Error ? mutationError.message : 'Could not save change');
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }, []);

  const markAllRead = useCallback(async (candidates: Article[]) => {
    const unread = candidates.filter((article) => !article.read);
    if (unread.length === 0) return 0;
    const optimisticStates = new Map(unread.map((article) => [article.id, true] as const));
    setSnapshot((current) => current ? applyReadStates(current, optimisticStates) : current);

    try {
      await sendArticleMutations(unread.map((article) => ({
        articleId: article.id,
        operation: 'read',
        value: true,
      })));
      return unread.length;
    } catch (mutationError) {
      const rollbackStates = new Map(unread.map((article) => [article.id, false] as const));
      setSnapshot((current) => current ? applyReadStates(current, rollbackStates) : current);
      setError(mutationError instanceof Error ? mutationError.message : 'Could not mark articles as read');
      setStatus(navigator.onLine ? 'error' : 'offline');
      throw mutationError;
    }
  }, []);

  const clear = useCallback(() => {
    activeRequest.current?.abort();
    setSnapshot(null);
    setSelectedId(null);
    setFilter({ kind: 'inbox' });
    setError(null);
    setStatus(navigator.onLine ? 'current' : 'offline');
  }, []);

  return {
    snapshot,
    articles,
    filteredArticles,
    selectedArticle,
    selectedId,
    filter,
    query,
    status,
    error,
    setFilter,
    setQuery,
    selectArticle: setSelectedId,
    synchronize,
    clear,
    toggleRead: (article: Article) => mutate(article, 'read', !article.read),
    toggleStarred: (article: Article) => mutate(article, 'starred', !article.starred),
    markAllRead,
  };
}
