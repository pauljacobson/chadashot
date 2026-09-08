import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, ArticleMutation, ReaderArticleBody, ReaderSnapshot } from '../shared/reader';
import {
  ApiError,
  getReaderArticleBody,
  getReaderArticles,
  getReaderChanges,
  getReaderNavigation,
  getReaderSynchronizationStatus,
  requestReaderRefresh,
} from './api';
import {
  applyLocalMutationToReaderCache,
  applyReaderChanges,
  enqueueArticleMutation,
  enqueueArticleMutations,
  loadCachedReader,
  loadReaderBody,
  queuedArticleMutations,
  reconcileSnapshotWithLocalMutations,
  requestPersistentStorage,
  saveReaderArticlePage,
  saveReaderBody,
  saveReaderChangeToken,
  saveReaderNavigation,
  subscribeToReaderUpdates,
  type CachedReaderState,
} from './offlineStore';
import { describeOutboxFailure, outboxWorker, type OutboxRunResult } from './outboxWorker';
import { applyReadStates } from './readerState';
import {
  markMilestone,
  measureOutboxReplay,
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

export function useReader(userId?: string) {
  const enabled = Boolean(userId);
  const [snapshot, setSnapshot] = useState<ReaderSnapshot | null>(null);
  const [filter, setFilter] = useState<ReaderFilter>({ kind: 'inbox' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [readFilter, setReadFilter] = useState<ArticleReadFilter>('all');
  const [status, setStatus] = useState<SyncStatus>(navigator.onLine ? 'syncing' : 'offline');
  const [error, setError] = useState<string | null>(null);
  const [pendingMutations, setPendingMutations] = useState(0);
  const [coverage, setCoverage] = useState<CachedReaderState['coverage'] | null>(null);
  const lastSync = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const currentSnapshot = useRef<ReaderSnapshot | null>(null);
  const currentCache = useRef<CachedReaderState | null>(null);
  const bodyRequests = useRef(new Map<string, Promise<ReaderArticleBody>>());

  const refreshPendingCount = useCallback(async () => {
    setPendingMutations((await queuedArticleMutations(currentCache.current?.accountKey)).length);
  }, []);

  const replayPendingMutations = useCallback(async (accountKey?: string) => {
    const attempted = (await queuedArticleMutations(accountKey)).length;
    let result: OutboxRunResult | null = null;
    await measureOutboxReplay(attempted, async () => {
      result = await outboxWorker.run(accountKey);
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

  const publishCachedReader = useCallback(async (milestone?: 'cached' | 'server') => {
    if (!userId) return null;
    const cached = await loadCachedReader(userId);
    if (!cached) return null;
    const reconciled = await reconcileSnapshotWithLocalMutations(cached.snapshot, cached.accountKey);
    currentCache.current = { ...cached, snapshot: reconciled.snapshot };
    setCoverage(cached.coverage);
    recordCollectionDiff(currentSnapshot.current, reconciled.snapshot);
    currentSnapshot.current = reconciled.snapshot;
    setSnapshot(reconciled.snapshot);
    setSelectedId((current) => current ?? reconciled.snapshot.articles[0]?.id ?? null);
    setPendingMutations(reconciled.pendingMutations);
    if (milestone) {
      window.requestAnimationFrame(() => markMilestone(
        milestone === 'cached' ? 'first-usable-cached-list' : 'first-server-backed-list',
        { articles: reconciled.snapshot.articles.length },
      ));
    }
    return cached;
  }, [userId]);

  const waitForServerCache = useCallback(async (controller: AbortController, forceRefresh: boolean) => {
    let serverStatus = await getReaderSynchronizationStatus(controller.signal);
    if (forceRefresh || serverStatus.state === 'empty') {
      await requestReaderRefresh(controller.signal);
      serverStatus = await getReaderSynchronizationStatus(controller.signal);
    }
    const isWaiting = () => serverStatus.state === 'empty'
      || serverStatus.state === 'initializing'
      || (forceRefresh && serverStatus.state === 'refreshing');
    for (let attempt = 0; attempt < 120 && isWaiting(); attempt += 1) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, 500);
        controller.signal.addEventListener('abort', () => {
          window.clearTimeout(timeout);
          reject(controller.signal.reason);
        }, { once: true });
      });
      serverStatus = await getReaderSynchronizationStatus(controller.signal);
    }
    return serverStatus;
  }, []);

  const applyAvailableChanges = useCallback(async (accountKey: string, token: string, signal: AbortSignal) => {
    let nextToken = token;
    do {
      const page = await getReaderChanges(nextToken, signal);
      if (page.accountKey !== accountKey) throw new Error('Reader account changed during synchronization');
      await applyReaderChanges(page);
      nextToken = page.token;
      if (!page.hasMore) return;
    } while (!signal.aborted);
  }, []);

  const continueBackfill = useCallback(async (
    accountKey: string,
    cursor: string | null,
    baselineToken: string,
    controller: AbortController,
  ) => {
    let nextCursor = cursor;
    let deltaBaseline = baselineToken;
    while (nextCursor && !controller.signal.aborted) {
      let page;
      try {
        page = await getReaderArticles({ cursor: nextCursor, signal: controller.signal });
      } catch (pagingError) {
        if (!(pagingError instanceof ApiError) || pagingError.status !== 409) throw pagingError;
        const replacementBaseline = await getReaderChanges(undefined, controller.signal);
        page = await getReaderArticles({ signal: controller.signal });
        await saveReaderArticlePage(userId!, page, true);
        await saveReaderChangeToken(accountKey, replacementBaseline.token);
        deltaBaseline = replacementBaseline.token;
      }
      if (page.accountKey !== accountKey) throw new Error('Reader account changed during metadata backfill');
      await saveReaderArticlePage(userId!, page);
      nextCursor = page.nextCursor;
    }
    if (controller.signal.aborted) return;
    await saveReaderChangeToken(accountKey, deltaBaseline);
    await applyAvailableChanges(accountKey, deltaBaseline, controller.signal);
    await saveReaderNavigation(userId!, await getReaderNavigation(controller.signal));
    const cached = await publishCachedReader();
    lastSync.current = Date.now();
    setError(null);
    setStatus('current');
    window.requestAnimationFrame(() => markMilestone('synchronization-complete', {
      articles: cached?.snapshot.articles.length ?? 0,
    }));
  }, [applyAvailableChanges, publishCachedReader, userId]);

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
      const serverStatus = await waitForServerCache(controller, trigger === 'manual');
      if (serverStatus.state === 'empty' || serverStatus.state === 'initializing') {
        throw new Error(serverStatus.error ?? 'Reader cache is still initializing');
      }
      const navigation = await getReaderNavigation(controller.signal);
      await saveReaderNavigation(userId!, navigation);
      void replayPendingMutations(navigation.accountKey).then((result) => {
        if (!controller.signal.aborted) reportOutboxResult(result);
      }).catch(() => {
        if (!controller.signal.aborted) {
          setError('Queued changes could not be read and remain on this device');
          setStatus(navigator.onLine ? 'error' : 'offline');
        }
      });
      const cached = currentCache.current;
      const reusable = cached?.accountKey === navigation.accountKey && cached.generation === navigation.generation;
      if (reusable && cached.coverage.complete && cached.coverage.changeToken) {
        try {
          await applyAvailableChanges(navigation.accountKey, cached.coverage.changeToken, controller.signal);
          await saveReaderNavigation(userId!, await getReaderNavigation(controller.signal));
          await publishCachedReader('server');
          lastSync.current = Date.now();
          setError(serverStatus.error);
          setStatus(serverStatus.error ? 'error' : 'current');
          return;
        } catch (changeError) {
          if (!(changeError instanceof ApiError) || changeError.status !== 409) throw changeError;
          // An expired token requires a metadata rebuild, but the outbox remains untouched.
        }
      }
      const baseline = await getReaderChanges(undefined, controller.signal);
      let cursor = reusable && !cached.coverage.complete ? cached.coverage.nextCursor : null;
      if (!cursor) {
        const firstPage = await getReaderArticles({ signal: controller.signal });
        if (firstPage.accountKey !== navigation.accountKey) throw new Error('Reader account changed during synchronization');
        await saveReaderArticlePage(userId!, firstPage, true);
        await saveReaderChangeToken(firstPage.accountKey, baseline.token);
        cursor = firstPage.nextCursor;
        await publishCachedReader('server');
      }
      setError(null);
      setStatus('current');
      void continueBackfill(navigation.accountKey, cursor, baseline.token, controller).catch((backfillError: unknown) => {
        if (controller.signal.aborted) return;
        setError(backfillError instanceof Error ? `Metadata backfill paused: ${backfillError.message}` : 'Metadata backfill paused');
        setStatus(navigator.onLine ? 'error' : 'offline');
      });
    } catch (syncError) {
      if (controller.signal.aborted) return;
      setError(syncError instanceof Error ? syncError.message : 'Synchronization failed');
      setStatus(navigator.onLine ? 'error' : 'offline');
      await refreshPendingCount().catch(() => undefined);
    }
  }, [applyAvailableChanges, continueBackfill, enabled, publishCachedReader, refreshPendingCount, replayPendingMutations, reportOutboxResult, userId, waitForServerCache]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let initialSync: number | undefined;
    void publishCachedReader('cached').then(async (cached) => {
      if (!active) return;
      if (!cached) await refreshPendingCount();
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
    const unsubscribe = subscribeToReaderUpdates((accountKey) => {
      if (accountKey === currentCache.current?.accountKey) void publishCachedReader();
    });
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
      unsubscribe();
    };
  }, [enabled, publishCachedReader, refreshPendingCount, synchronize]);

  useEffect(() => {
    if (enabled) void requestPersistentStorage();
  }, [enabled]);

  useEffect(() => {
    const account = currentCache.current;
    const article = snapshot?.articles.find((candidate) => candidate.id === selectedId);
    if (!enabled || !account || !article || article.contentHtml) return;
    const requestKey = `${account.accountKey}\0${article.id}\0${account.versions.body}`;
    let bodyRequest = bodyRequests.current.get(requestKey);
    if (!bodyRequest) {
      bodyRequest = (async () => {
        const cachedBody = await loadReaderBody(account.accountKey, article.id, account.versions.body);
        if (cachedBody) return cachedBody;
        if (!navigator.onLine) throw new Error('Article body is not cached on this device');
        const downloaded = await getReaderArticleBody(article.id);
        if (downloaded.accountKey !== account.accountKey) throw new Error('Reader account changed while loading article content');
        await saveReaderBody(downloaded);
        return downloaded;
      })().finally(() => bodyRequests.current.delete(requestKey));
      bodyRequests.current.set(requestKey, bodyRequest);
    }
    let active = true;
    void bodyRequest.then((body) => {
      if (!active) return;
      setSnapshot((current) => current ? {
        ...current,
        articles: current.articles.map((candidate) => candidate.id === body.articleId
          ? { ...candidate, contentHtml: body.contentHtml }
          : candidate),
      } : current);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [enabled, selectedId, snapshot]);

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
    const mutationAccountKey = currentCache.current?.accountKey.startsWith('legacy:')
      ? undefined
      : currentCache.current?.accountKey;
    setSnapshot((current) => current ? applyMutation(current, mutation) : current);

    let queued = false;
    try {
      await enqueueArticleMutation(mutation, mutationAccountKey);
      queued = true;
      if (currentCache.current) await applyLocalMutationToReaderCache(currentCache.current.accountKey, mutation);
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
    const mutationAccountKey = currentCache.current?.accountKey.startsWith('legacy:')
      ? undefined
      : currentCache.current?.accountKey;
    setSnapshot((current) => current ? applyReadStates(current, new Map(unread.map((article) => [article.id, true]))) : current);

    let queued = false;
    try {
      await enqueueArticleMutations(mutations, mutationAccountKey);
      queued = true;
      if (currentCache.current) {
        await Promise.all(mutations.map((mutation) => applyLocalMutationToReaderCache(currentCache.current!.accountKey, mutation)));
      }
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
    setCoverage(null);
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
    coverage,
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
