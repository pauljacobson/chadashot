import { waitForReaderCache } from './readerSync';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, ArticleMutation, ReaderArticleBody, ReaderArticleMetadata, ReaderMarkReadJobStatus, ReaderSnapshot, ReaderVersions } from '../shared/reader';
import {
  ApiError,
  createMarkReadJob,
  getReaderArticleBody,
  getReaderArticles,
  getReaderChanges,
  getReaderNavigation,
  getReaderRuntimeConfig,
  getReaderSnapshot,
  getReaderSynchronizationStatus,
  getMarkReadJobs,
  requestReaderRefresh,
  retryMarkReadJob,
} from './api';
import {
  applyLocalMutationToReaderCache,
  applyLocalReadStateToReaderCache,
  acknowledgeMarkReadJob,
  applyReaderChanges,
  enqueueArticleMutation,
  enqueueArticleMutations,
  enqueueMarkReadJob,
  loadCachedReader,
  loadReaderBody,
  queuedArticleMutations,
  queuedMarkReadJobs,
  reconcileSnapshotWithLocalMutations,
  requestPersistentStorage,
  saveCachedSnapshot,
  saveReaderArticlePage,
  saveReaderBody,
  saveReaderChangeToken,
  saveReaderNavigation,
  subscribeToReaderUpdates,
  type CachedReaderState,
} from './offlineStore';
import { describeOutboxFailure, outboxWorker, type OutboxRunResult } from './outboxWorker';
import { applyArticleMutation, applyReadStates } from './readerState';
import { readerBoundariesMatch, readerCountStatus, readerScopeTotal } from './readerCounts';
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

type RemoteArticlePage = {
  queryKey: string;
  accountKey: string;
  generation: string;
  versions: ReaderVersions;
  articles: ReaderArticleMetadata[];
  nextCursor: string | null;
  total: number;
};

function readerArticleQuery(filter: ReaderFilter, read: ArticleReadFilter, search: string, publishedSince?: string) {
  return {
    scope: filter.kind,
    ...(filter.kind === 'folder' || filter.kind === 'feed' ? { scopeId: filter.id } : {}),
    read,
    ...(search ? { search } : {}),
    ...(publishedSince ? { publishedSince } : {}),
  };
}

function retainsArticleInStateFilter(article: ReaderArticleMetadata, filter: ReaderFilter, readFilter: ArticleReadFilter) {
  if (filter.kind === 'inbox' && article.read) return false;
  if (filter.kind === 'starred' && !article.starred) return false;
  if (readFilter === 'read' && !article.read) return false;
  if (readFilter === 'unread' && article.read) return false;
  return true;
}

export function filterArticlesByReadState(articles: Article[], filter: ArticleReadFilter) {
  if (filter === 'all') return articles;
  return articles.filter((article) => filter === 'read' ? article.read : !article.read);
}

export function markReadCoverageError(coverage: CachedReaderState['coverage'] | null) {
  if (!coverage) return 'Finish the first reader synchronization before marking this view read';
  if (!coverage.complete) {
    return `Only ${coverage.loaded.toLocaleString()} of ${coverage.total.toLocaleString()} articles are cached. Finish synchronization before marking this view read.`;
  }
  return null;
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

export function useReader(userId?: string, defaultReadFilter: ArticleReadFilter = 'all', publishedSince?: string) {
  const enabled = Boolean(userId);
  const [snapshot, setSnapshot] = useState<ReaderSnapshot | null>(null);
  const [filter, setFilter] = useState<ReaderFilter>({ kind: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [readFilter, setReadFilter] = useState<ArticleReadFilter>(defaultReadFilter);
  const [status, setStatus] = useState<SyncStatus>(navigator.onLine ? 'syncing' : 'offline');
  const [error, setError] = useState<string | null>(null);
  const [pendingMutations, setPendingMutations] = useState(0);
  const [coverage, setCoverage] = useState<CachedReaderState['coverage'] | null>(null);
  const [activeAccountKey, setActiveAccountKey] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [remotePage, setRemotePage] = useState<RemoteArticlePage | null>(null);
  const [remoteRevision, setRemoteRevision] = useState(0);
  const [loadedBodies, setLoadedBodies] = useState(() => new Map<string, string>());
  const [remoteUnreadCount, setRemoteUnreadCount] = useState<number | null>(null);
  const [markReadJobs, setMarkReadJobs] = useState<ReaderMarkReadJobStatus[]>([]);
  const [readerPath, setReaderPath] = useState<'paginated' | 'snapshot' | null>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const completionRequest = useRef<AbortController | null>(null);
  const completionTimer = useRef<number | undefined>(undefined);
  const pendingManualRefresh = useRef(false);
  const serverUpdatePending = useRef(false);
  const currentSnapshot = useRef<ReaderSnapshot | null>(null);
  const currentCache = useRef<CachedReaderState | null>(null);
  const bodyRequests = useRef(new Map<string, Promise<ReaderArticleBody>>());
  const remotePageRef = useRef<RemoteArticlePage | null>(null);
  const remoteRequest = useRef<AbortController | null>(null);
  const loadingNextPage = useRef(false);

  const refreshPendingCount = useCallback(async () => {
    const accountKey = currentCache.current?.accountKey;
    const scopedAccountKey = accountKey?.startsWith('legacy:') ? undefined : accountKey;
    const [mutations, jobs] = await Promise.all([
      queuedArticleMutations(scopedAccountKey),
      queuedMarkReadJobs(scopedAccountKey),
    ]);
    setPendingMutations(mutations.length + jobs.length);
  }, []);

  const replayPendingMarkReadJobs = useCallback(async (accountKey: string) => {
    const jobs = await queuedMarkReadJobs(accountKey);
    for (const job of jobs) {
      await createMarkReadJob(job);
      await acknowledgeMarkReadJob(job);
    }
    return jobs.length;
  }, []);

  const refreshMarkReadJobs = useCallback(async () => {
    if (!navigator.onLine) return;
    const result = await getMarkReadJobs();
    setMarkReadJobs(result.jobs);
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
    }
  }, []);

  const publishCachedReader = useCallback(async (milestone?: 'cached' | 'server', signal?: AbortSignal) => {
    if (!userId) return null;
    const cached = await loadCachedReader(userId);
    signal?.throwIfAborted();
    if (!cached) return null;
    const reconciled = await reconcileSnapshotWithLocalMutations(cached.snapshot, cached.accountKey);
    signal?.throwIfAborted();
    currentCache.current = { ...cached, snapshot: reconciled.snapshot };
    setActiveAccountKey(cached.accountKey);
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
      if (milestone === 'server') setRemoteRevision((current) => current + 1);
    }
    return cached;
  }, [userId]);

  const waitForServerCache = useCallback(async (controller: AbortController, forceRefresh: boolean) => {
    return waitForReaderCache({
      signal: controller.signal,
      forceRefresh,
      loadStatus: getReaderSynchronizationStatus,
      refresh: requestReaderRefresh,
    });
  }, []);

  const applyAvailableChanges = useCallback(async (accountKey: string, token: string, signal: AbortSignal) => {
    let nextToken = token;
    do {
      const page = await getReaderChanges(nextToken, signal);
      if (page.accountKey !== accountKey) throw new Error('Reader account changed during synchronization');
      await applyReaderChanges(page, false);
      nextToken = page.token;
      if (!page.hasMore) return;
    } while (!signal.aborted);
  }, []);

  const continueBackfill = useCallback(async (
    accountKey: string,
    cursor: string | null,
    baselineToken: string,
    controller: AbortController,
    serverError: string | null,
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
    const cached = await publishCachedReader(undefined, controller.signal);
    setError(serverError);
    setStatus(serverUpdatePending.current ? 'syncing' : serverError ? 'error' : 'current');
    if (!serverUpdatePending.current && !serverError) {
      window.requestAnimationFrame(() => markMilestone('synchronization-complete', {
        articles: cached?.snapshot.articles.length ?? 0,
      }));
    }
  }, [applyAvailableChanges, publishCachedReader, userId]);

  const synchronize: (trigger?: 'startup' | 'manual' | 'interval' | 'visibility' | 'online') => Promise<void> = useCallback(async (trigger = 'manual') => {
    if (!enabled) return;
    if (!navigator.onLine) {
      setStatus('offline');
      return;
    }
    // Automatic triggers share the current run; manual intent is retained and
    // replayed after it finishes, rather than repeatedly cancelling backfill.
    if (activeRequest.current && !activeRequest.current.signal.aborted) {
      if (trigger === 'manual') pendingManualRefresh.current = true;
      return;
    }
    if (completionTimer.current !== undefined) window.clearTimeout(completionTimer.current);
    completionRequest.current?.abort();
    recordSynchronizationTrigger(trigger);
    const controller = new AbortController();
    activeRequest.current = controller;
    setStatus('syncing');
    try {
      const runtime = await getReaderRuntimeConfig(controller.signal);
      setReaderPath(runtime.path);
      if (runtime.path === 'snapshot') {
        serverUpdatePending.current = false;
        const loaded = await loadReaderSnapshotWithoutWaitingForReplay(
          () => getReaderSnapshot(controller.signal),
          (serverSnapshot) => reconcileSnapshotWithLocalMutations(serverSnapshot),
          () => replayPendingMutations(),
        );
        const versions = loaded.snapshot.cacheStatus?.versions ?? { collection: 0, state: 0, body: 0 };
        const accountKey = `legacy:${userId}`;
        const legacyCache: CachedReaderState = {
          accountKey,
          generation: `snapshot:${loaded.snapshot.generatedAt}`,
          versions,
          snapshot: loaded.snapshot,
          coverage: {
            loaded: loaded.snapshot.articles.length,
            total: loaded.snapshot.articles.length,
            complete: true,
            nextCursor: null,
            changeToken: null,
            backfillInterrupted: false,
          },
        };
        await saveCachedSnapshot(loaded.snapshot);
        currentCache.current = legacyCache;
        recordCollectionDiff(currentSnapshot.current, loaded.snapshot);
        currentSnapshot.current = loaded.snapshot;
        remotePageRef.current = null;
        setRemotePage(null);
        setActiveAccountKey(accountKey);
        setCoverage(legacyCache.coverage);
        setSnapshot(loaded.snapshot);
        setSelectedId((current) => current ?? loaded.snapshot.articles[0]?.id ?? null);
        setPendingMutations(loaded.pendingMutations);
        window.requestAnimationFrame(() => {
          markMilestone('first-server-backed-list', { articles: loaded.snapshot.articles.length });
          markMilestone('synchronization-complete', { articles: loaded.snapshot.articles.length });
        });
        setError(loaded.snapshot.cacheStatus?.error ?? null);
        setStatus(loaded.snapshot.cacheStatus?.error ? 'error' : 'current');
        void loaded.replayResult.then((result) => {
          if (!controller.signal.aborted) reportOutboxResult(result);
        }).catch(() => {
          setError('Queued changes remain on this device and will retry automatically');
          setStatus(navigator.onLine ? 'error' : 'offline');
        });
        await refreshPendingCount();
        return;
      }
      const serverStatus = await waitForServerCache(controller, trigger === 'manual');
      serverUpdatePending.current = ['refreshing', 'initializing', 'empty'].includes(serverStatus.state);
      if (serverStatus.state === 'empty' || serverStatus.state === 'initializing') {
        throw new Error(serverStatus.error ?? 'Reader cache is still initializing');
      }
      const navigation = await getReaderNavigation(controller.signal);
      // Publish only after the matching article boundary is durable.
      await saveReaderNavigation(userId!, navigation, false);
      void (async () => {
        let jobReplayFailed = false;
        try {
          await replayPendingMarkReadJobs(navigation.accountKey);
        } catch {
          jobReplayFailed = true;
        }
        try {
          const result = await replayPendingMutations(navigation.accountKey);
          if (controller.signal.aborted) return;
          reportOutboxResult(result);
          if (jobReplayFailed) {
            setError('A queued mark-read job is waiting for its original collection boundary');
            setStatus(navigator.onLine ? 'error' : 'offline');
          }
          await refreshPendingCount();
        } catch {
          if (!controller.signal.aborted) {
            setError('Queued changes could not be read and remain on this device');
            setStatus(navigator.onLine ? 'error' : 'offline');
          }
        }
      })();
      const cached = currentCache.current;
      const reusable = cached?.accountKey === navigation.accountKey && cached.generation === navigation.generation;
      if (reusable && cached.coverage.complete && cached.coverage.changeToken) {
        try {
          await applyAvailableChanges(navigation.accountKey, cached.coverage.changeToken, controller.signal);
          await saveReaderNavigation(userId!, await getReaderNavigation(controller.signal));
          await publishCachedReader('server', controller.signal);
          setError(serverStatus.error);
          setStatus(serverUpdatePending.current ? 'syncing' : serverStatus.error ? 'error' : 'current');
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
        await publishCachedReader('server', controller.signal);
      }
      setError(null);
      setStatus(serverUpdatePending.current ? 'syncing' : 'current');
      await continueBackfill(navigation.accountKey, cursor, baseline.token, controller, serverStatus.error).catch((backfillError: unknown) => {
        if (controller.signal.aborted) return;
        setError(backfillError instanceof Error ? `Metadata backfill paused: ${backfillError.message}` : 'Metadata backfill paused');
        setStatus(navigator.onLine ? 'error' : 'offline');
      });
    } catch (syncError) {
      if (controller.signal.aborted) return;
      setError(syncError instanceof Error ? syncError.message : 'Synchronization failed');
      setStatus(navigator.onLine ? 'error' : 'offline');
      await refreshPendingCount().catch(() => undefined);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        if (!controller.signal.aborted && navigator.onLine && document.visibilityState === 'visible') {
          if (pendingManualRefresh.current) {
            pendingManualRefresh.current = false;
            completionTimer.current = window.setTimeout(() => void synchronize('manual'), 0);
          } else if (serverUpdatePending.current) {
            // Poll only status while work is pending; re-reading the full local
            // cache every few seconds would slow mobile devices unnecessarily.
            const completion = new AbortController();
            completionRequest.current = completion;
            const followCompletion = async () => {
              if (completion.signal.aborted || !navigator.onLine || document.visibilityState !== 'visible') return;
              try {
                const next = await getReaderSynchronizationStatus(completion.signal);
                if (completion.signal.aborted) return;
                if (['refreshing', 'initializing', 'empty'].includes(next.state)) {
                  completionTimer.current = window.setTimeout(() => void followCompletion(), 5_000);
                } else {
                  serverUpdatePending.current = false;
                  void synchronize('interval');
                }
              } catch {
                if (!completion.signal.aborted) {
                  completionTimer.current = window.setTimeout(() => void followCompletion(), 10_000);
                }
              }
            };
            completionTimer.current = window.setTimeout(() => void followCompletion(), 2_000);
          }
        }
      }
    }
  }, [applyAvailableChanges, continueBackfill, enabled, publishCachedReader, refreshPendingCount, replayPendingMarkReadJobs, replayPendingMutations, reportOutboxResult, userId, waitForServerCache]);

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
    const stopForegroundWork = () => {
      activeRequest.current?.abort();
      completionRequest.current?.abort();
      if (completionTimer.current !== undefined) window.clearTimeout(completionTimer.current);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void synchronize('visibility');
      else stopForegroundWork();
    };
    const handlePageShow = () => {
      if (document.visibilityState === 'visible') void synchronize('visibility');
    };
    const handleOnline = () => {
      if (document.visibilityState === 'visible') void synchronize('online');
    };
    const handleOffline = () => {
      stopForegroundWork();
      remotePageRef.current = null;
      setRemotePage(null);
      setStatus('offline');
    };
    const unsubscribe = subscribeToReaderUpdates((accountKey) => {
      if (accountKey === currentCache.current?.accountKey) void publishCachedReader();
    });
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('online', handleOnline);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('offline', handleOffline);

    return () => {
      active = false;
      stopForegroundWork();
      pendingManualRefresh.current = false;
      if (initialSync !== undefined) window.clearTimeout(initialSync);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('offline', handleOffline);
      unsubscribe();
    };
  }, [enabled, publishCachedReader, refreshPendingCount, synchronize]);

  useEffect(() => {
    if (enabled) void requestPersistentStorage();
  }, [enabled]);

  useEffect(() => {
    if (readerPath !== 'paginated' || !enabled || !activeAccountKey || activeAccountKey.startsWith('legacy:') || !navigator.onLine) return;
    void refreshMarkReadJobs().catch(() => undefined);
    const interval = window.setInterval(() => void refreshMarkReadJobs().catch(() => undefined), 2_000);
    return () => window.clearInterval(interval);
  }, [activeAccountKey, enabled, readerPath, refreshMarkReadJobs]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const remoteQueryKey = useMemo(() => JSON.stringify([
    activeAccountKey,
    filter.kind,
    filter.kind === 'folder' || filter.kind === 'feed' ? filter.id : null,
    readFilter,
    debouncedQuery,
    remoteRevision,
    publishedSince,
    snapshot?.cacheStatus?.versions.collection ?? null,
    snapshot?.cacheStatus?.versions.state ?? null,
  ]), [activeAccountKey, debouncedQuery, filter, publishedSince, readFilter, remoteRevision, snapshot?.cacheStatus?.versions.collection, snapshot?.cacheStatus?.versions.state]);

  useEffect(() => {
    if (readerPath !== 'paginated' || !enabled || !activeAccountKey || activeAccountKey.startsWith('legacy:') || !navigator.onLine) {
      remotePageRef.current = null;
      setRemotePage(null);
      return;
    }
    const controller = new AbortController();
    remoteRequest.current?.abort();
    remoteRequest.current = controller;
    const requestKey = remoteQueryKey;
    const expectedGeneration = currentCache.current?.generation;
    const expectedVersions = snapshot?.cacheStatus?.versions;
    void getReaderArticles({
      ...readerArticleQuery(filter, readFilter, debouncedQuery, publishedSince),
      signal: controller.signal,
    }).then(async (page) => {
      if (controller.signal.aborted || page.accountKey !== activeAccountKey) return;
      if (expectedGeneration && page.generation !== expectedGeneration) {
        void synchronize('visibility');
        return;
      }
      if (
        expectedVersions
        && !readerBoundariesMatch(expectedGeneration, expectedVersions, page.generation, page.versions)
      ) {
        const navigation = await getReaderNavigation(controller.signal);
        if (controller.signal.aborted || navigation.accountKey !== activeAccountKey) return;
        await saveReaderNavigation(userId!, navigation);
        await publishCachedReader();
        return;
      }
      const next = {
        queryKey: requestKey,
        accountKey: page.accountKey,
        generation: page.generation,
        versions: page.versions,
        articles: page.articles,
        nextCursor: page.nextCursor,
        total: page.total,
      };
      remotePageRef.current = next;
      setRemotePage(next);
    }).catch(() => {
      if (!controller.signal.aborted) {
        remotePageRef.current = null;
        setRemotePage(null);
      }
    });
    return () => controller.abort();
  }, [activeAccountKey, debouncedQuery, enabled, filter, publishCachedReader, publishedSince, readFilter, readerPath, remoteQueryKey, snapshot?.cacheStatus?.versions, synchronize, userId]);

  useEffect(() => {
    if (readerPath !== 'paginated' || !enabled || !activeAccountKey || activeAccountKey.startsWith('legacy:') || !navigator.onLine || debouncedQuery !== query.trim()) {
      setRemoteUnreadCount(null);
      return;
    }
    const controller = new AbortController();
    void getReaderArticles({
      ...readerArticleQuery(filter, 'unread', debouncedQuery, publishedSince),
      limit: 1,
      signal: controller.signal,
    }).then((page) => {
      if (!controller.signal.aborted && page.accountKey === activeAccountKey) setRemoteUnreadCount(page.total);
    }).catch(() => {
      if (!controller.signal.aborted) setRemoteUnreadCount(null);
    });
    return () => controller.abort();
  }, [activeAccountKey, debouncedQuery, enabled, filter, publishedSince, query, readerPath]);

  const loadMoreArticles = useCallback(async () => {
    if (readerPath !== 'paginated') return;
    const current = remotePageRef.current;
    if (!current?.nextCursor || current.queryKey !== remoteQueryKey || loadingNextPage.current) return;
    loadingNextPage.current = true;
    try {
      const page = await getReaderArticles({
        ...readerArticleQuery(filter, readFilter, debouncedQuery, publishedSince),
        cursor: current.nextCursor,
      });
      if (page.accountKey !== current.accountKey || remotePageRef.current?.queryKey !== remoteQueryKey) return;
      const known = new Set(current.articles.map((article) => article.id));
      const next = {
        ...current,
        articles: [...current.articles, ...page.articles.filter((article) => !known.has(article.id))],
        nextCursor: page.nextCursor,
        total: page.total,
      };
      remotePageRef.current = next;
      setRemotePage(next);
    } catch (pagingError) {
      if (pagingError instanceof ApiError && pagingError.status === 409) {
        remotePageRef.current = null;
        setRemotePage(null);
        setRemoteRevision((currentRevision) => currentRevision + 1);
      }
    } finally {
      loadingNextPage.current = false;
    }
  }, [debouncedQuery, filter, publishedSince, readFilter, readerPath, remoteQueryKey]);

  const filteredArticles = useMemo(() => {
    if (!snapshot) return [];
    const publishedCutoff = publishedSince ? Date.parse(publishedSince) : null;
    const now = Date.now();
    const knownFolderIds = new Set(snapshot.folders.map((folder) => folder.id));
    const uncategorizedFeedIds = new Set(snapshot.subscriptions
      .filter((subscription) => subscription.folderIds.length === 0 || !subscription.folderIds.some((folderId) => knownFolderIds.has(folderId)))
      .map((subscription) => subscription.id));
    return snapshot.articles.filter((article) => {
      if (publishedCutoff !== null) {
        const published = Date.parse(article.publishedAt);
        if (!Number.isFinite(published) || published < publishedCutoff || published > now) return false;
      }
      const inFilter =
        filter.kind === 'all'
        || (filter.kind === 'inbox' && !article.read)
        || (filter.kind === 'starred' && article.starred)
        || (filter.kind === 'uncategorized' && uncategorizedFeedIds.has(article.feedId))
        || (filter.kind === 'folder' && article.folderIds.includes(filter.id))
        || (filter.kind === 'feed' && article.feedId === filter.id);
      return inFilter;
    });
  }, [filter, publishedSince, snapshot]);

  const searchedArticles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return filteredArticles;
    return filteredArticles.filter((article) => {
      return [article.title, article.source, article.author, article.summary]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [filteredArticles, query]);

  const localArticles = useMemo(
    () => filterArticlesByReadState(searchedArticles, readFilter),
    [readFilter, searchedArticles],
  );
  const localUnreadCount = useMemo(() => localArticles.reduce(
    (count, article) => count + Number(!article.read),
    0,
  ), [localArticles]);

  const cachedBodyById = useMemo(() => new Map((snapshot?.articles ?? [])
    .filter((article) => article.contentHtml)
    .map((article) => [article.id, article.contentHtml])), [snapshot]);
  const remoteIsCurrent = remotePage?.queryKey === remoteQueryKey && debouncedQuery === query.trim();
  const navigationTotal = publishedSince ? null : readerScopeTotal(snapshot, filter, readFilter, query);
  const totalArticles = navigationTotal ?? (remoteIsCurrent && remotePage ? remotePage.total : localArticles.length);
  const totalCountStatus = readerCountStatus(
    navigationTotal !== null || Boolean(remoteIsCurrent && remotePage),
    coverage,
    status === 'current',
  );
  const articles = useMemo(() => remoteIsCurrent && remotePage
    ? remotePage.articles.map((article) => ({
      ...article,
      contentHtml: loadedBodies.get(article.id) ?? cachedBodyById.get(article.id) ?? '',
    }))
    : localArticles.map((article) => loadedBodies.has(article.id)
      ? { ...article, contentHtml: loadedBodies.get(article.id)! }
      : article), [cachedBodyById, loadedBodies, localArticles, remoteIsCurrent, remotePage]);
  const articleIndexById = useMemo(() => new Map(articles.map((article, index) => [article.id, index])), [articles]);
  const loadedUnreadArticles = useMemo(() => [...new Map([...localArticles, ...articles]
    .map((article) => [article.id, article])).values()].filter((article) => !article.read), [articles, localArticles]);

  const selectedArticle = useMemo(
    () => articles[articleIndexById.get(selectedId ?? '') ?? -1] ?? articles[0] ?? null,
    [articleIndexById, articles, selectedId],
  );

  useEffect(() => {
    if (articles.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !articleIndexById.has(selectedId)) setSelectedId(articles[0]!.id);
  }, [articleIndexById, articles, selectedId]);

  const navigateSelection = useCallback(async (direction: -1 | 1) => {
    const currentIndex = articleIndexById.get(selectedId ?? '') ?? (direction > 0 ? -1 : articles.length);
    const target = articles[currentIndex + direction];
    if (target) {
      setSelectedId(target.id);
      return;
    }
    if (direction > 0 && remoteIsCurrent && remotePageRef.current?.nextCursor) {
      const priorLength = remotePageRef.current.articles.length;
      await loadMoreArticles();
      const next = remotePageRef.current?.articles[priorLength];
      if (next) setSelectedId(next.id);
    }
  }, [articleIndexById, articles, loadMoreArticles, remoteIsCurrent, selectedId]);

  useEffect(() => {
    const account = currentCache.current;
    const article = selectedArticle;
    if (readerPath !== 'paginated' || !enabled || !account || !article || article.contentHtml) return;
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
      setLoadedBodies((current) => new Map(current).set(body.articleId, body.contentHtml));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [enabled, readerPath, selectedArticle]);

  const mutate = useCallback(async (article: Article, operation: ArticleMutation['operation'], value: boolean) => {
    const mutation = { articleId: article.id, operation, value } satisfies ArticleMutation;
    const mutationAccountKey = currentCache.current?.accountKey.startsWith('legacy:')
      ? undefined
      : currentCache.current?.accountKey;
    setSnapshot((current) => current ? applyArticleMutation(current, article, mutation) : current);
    const changedArticle = { ...article, [operation === 'read' ? 'read' : 'starred']: value };
    if (!retainsArticleInStateFilter(changedArticle, filter, readFilter)) {
      const index = articleIndexById.get(article.id) ?? -1;
      setSelectedId((current) => current === article.id
        ? articles[index + 1]?.id ?? articles[index - 1]?.id ?? null
        : current);
    }
    setRemotePage((current) => {
      if (!current || current.queryKey !== remoteQueryKey) return current;
      const updated = current.articles
        .map((candidate) => candidate.id === article.id ? changedArticle : candidate)
        .filter((candidate) => retainsArticleInStateFilter(candidate, filter, readFilter));
      const next = { ...current, articles: updated, total: Math.max(0, current.total - (current.articles.length - updated.length)) };
      remotePageRef.current = next;
      return next;
    });

    let queued = false;
    try {
      await enqueueArticleMutation(mutation, mutationAccountKey);
      queued = true;
      if (currentCache.current) await applyLocalMutationToReaderCache(currentCache.current.accountKey, mutation, article);
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
      setSnapshot((current) => current ? applyArticleMutation(current, changedArticle, { ...mutation, value: !value }) : current);
      setError(mutationError instanceof Error ? mutationError.message : 'Could not save change');
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }, [articleIndexById, articles, filter, readFilter, refreshPendingCount, remoteQueryKey, replayPendingMutations, reportOutboxResult]);

  const markLoadedRead = useCallback(async () => {
    const cache = currentCache.current;
    if (!cache || cache.accountKey !== activeAccountKey) throw new Error('Reader account changed; reopen the confirmation');
    // This closure freezes explicit IDs when the confirmation opens. Never enqueue a scope-wide job here.
    const unread = loadedUnreadArticles;
    if (unread.length === 0) return 0;
    const accountKey = cache.accountKey.startsWith('legacy:') ? undefined : cache.accountKey;
    await enqueueArticleMutations(unread.map((article) => ({ articleId: article.id, operation: 'read', value: true })), accountKey);
    try {
      await applyLocalReadStateToReaderCache(cache.accountKey, unread.map((article) => article.id), true, unread);
      await publishCachedReader();
      setRemoteUnreadCount((current) => current === null ? null : Math.max(0, current - unread.length));
      setRemotePage((current) => {
        if (!current || current.queryKey !== remoteQueryKey) return current;
        const changedIds = new Set(unread.map((article) => article.id));
        const updated = current.articles
          .map((article) => changedIds.has(article.id) ? { ...article, read: true } : article)
          .filter((article) => retainsArticleInStateFilter(article, filter, readFilter));
        const next = { ...current, articles: updated, total: Math.max(0, current.total - (current.articles.length - updated.length)) };
        remotePageRef.current = next;
        return next;
      });
      await refreshPendingCount();
      if (navigator.onLine) reportOutboxResult(await replayPendingMutations(accountKey));
      else { setStatus('offline'); setError(null); }
    } catch {
      await refreshPendingCount().catch(() => undefined);
      setError('Loaded-item changes saved on this device and waiting to retry');
      setStatus(navigator.onLine ? 'error' : 'offline');
    }
    return unread.length;
  }, [activeAccountKey, filter, loadedUnreadArticles, publishCachedReader, readFilter, refreshPendingCount, remoteQueryKey, replayPendingMutations, reportOutboxResult]);

  const markAllRead = useCallback(async () => {
    const cache = currentCache.current;
    const coverageError = markReadCoverageError(cache?.coverage ?? null);
    if (!cache || cache.accountKey.startsWith('legacy:') || coverageError) throw new Error(coverageError ?? 'Finish synchronization before marking this view read');
    const unread = localArticles.filter((article) => !article.read);
    if (unread.length === 0) return 0;
    const job = await enqueueMarkReadJob({
      idempotencyKey: crypto.randomUUID(),
      accountKey: cache.accountKey,
      generation: cache.generation,
      collectionVersion: cache.versions.collection,
      stateVersion: cache.versions.state,
      scope: filter.kind === 'folder' || filter.kind === 'feed' ? { kind: filter.kind, id: filter.id } : { kind: filter.kind },
      ...(query.trim() ? { search: query.trim() } : {}),
      coverage: 'complete',
    });
    setRemoteUnreadCount(0);
    setSnapshot((current) => current ? applyReadStates(current, new Map(unread.map((article) => [article.id, true]))) : current);
    setRemotePage((current) => {
      if (!current || current.queryKey !== remoteQueryKey) return current;
      const changedIds = new Set(unread.map((article) => article.id));
      const updated = current.articles
        .map((article) => changedIds.has(article.id) ? { ...article, read: true } : article)
        .filter((article) => retainsArticleInStateFilter(article, filter, readFilter));
      const next = { ...current, articles: updated, total: Math.max(0, current.total - (current.articles.length - updated.length)) };
      remotePageRef.current = next;
      return next;
    });

    try {
      if (currentCache.current) {
        await applyLocalReadStateToReaderCache(currentCache.current.accountKey, unread.map((article) => article.id), true);
      }
      await refreshPendingCount();
      if (!navigator.onLine) {
        setStatus('offline');
        setError(null);
        return unread.length;
      }
      const accepted = await createMarkReadJob(job);
      await acknowledgeMarkReadJob(job);
      setMarkReadJobs((current) => [accepted, ...current.filter((candidate) => candidate.id !== accepted.id)]);
      await refreshPendingCount();
      setError(null);
      setStatus(serverUpdatePending.current ? 'syncing' : 'current');
      return accepted.targetCount;
    } catch {
      await refreshPendingCount().catch(() => undefined);
      setError('Mark-read job saved on this device and waiting to retry');
      setStatus(navigator.onLine ? 'error' : 'offline');
      return unread.length;
    }
  }, [filter, localArticles, query, readFilter, refreshPendingCount, remoteQueryKey]);

  const clear = useCallback(() => {
    activeRequest.current?.abort();
    completionRequest.current?.abort();
    if (completionTimer.current !== undefined) window.clearTimeout(completionTimer.current);
    pendingManualRefresh.current = false;
    serverUpdatePending.current = false;
    currentCache.current = null;
    currentSnapshot.current = null;
    setSnapshot(null);
    setSelectedId(null);
    setFilter({ kind: 'all' });
    setReadFilter('all');
    setError(null);
    setPendingMutations(0);
    setCoverage(null);
    setActiveAccountKey(null);
    setRemotePage(null);
    setRemoteUnreadCount(null);
    setMarkReadJobs([]);
    setReaderPath(null);
    remotePageRef.current = null;
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
    totalArticles,
    totalCountStatus,
    hasMoreArticles: Boolean(remoteIsCurrent && remotePage?.nextCursor),
    bulkUnreadCount: remoteUnreadCount ?? localUnreadCount,
    loadedUnreadCount: loadedUnreadArticles.length,
    markReadJobs,
    searchCoverage: query.trim() && (!remoteIsCurrent || !navigator.onLine) ? 'cached-partial' as const : 'complete' as const,
    setFilter,
    setReadFilter,
    setQuery,
    selectArticle: setSelectedId,
    navigateSelection,
    loadMoreArticles,
    synchronize,
    clear,
    toggleRead: (article: Article) => mutate(article, 'read', !article.read),
    toggleStarred: (article: Article) => mutate(article, 'starred', !article.starred),
    markAllRead,
    markLoadedRead,
    retryMarkReadJob: async (jobId: string) => {
      await retryMarkReadJob(jobId);
      await refreshMarkReadJobs();
    },
  };
}
