import type { ReaderSnapshot } from '../shared/reader';

export type BrowserPerformanceEventName =
  | 'shell'
  | 'first-usable-cached-list'
  | 'first-server-backed-list'
  | 'first-article'
  | 'synchronization-complete'
  | 'snapshot-persistence'
  | 'reader-response'
  | 'collection-diff'
  | 'mounted-rows'
  | 'synchronization-trigger'
  | 'article-open'
  | 'outbox-replay';

type BrowserPerformanceEvent = {
  name: BrowserPerformanceEventName;
  startTimeMs: number;
  durationMs?: number;
  runId?: string;
  source?: 'cache' | 'server';
  trigger?: 'startup' | 'manual' | 'interval' | 'visibility' | 'online';
  completed?: boolean;
  encodedBytes?: number | null;
  decodedBytes?: number;
  articles?: number;
  changedItems?: number;
  unchangedItems?: number;
  mountedRows?: number;
  coalesced?: number;
  retries?: number;
  browserRequests?: number;
  browserRequestBytes?: number;
  attemptedMutations?: number;
  completedMutations?: number;
};

export type BrowserPerformanceSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  navigation: {
    userAgent: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
  };
  events: BrowserPerformanceEvent[];
  longTasks: { count: number; totalDurationMs: number; maximumDurationMs: number };
  maximumMountedRows: number;
};

const events: BrowserPerformanceEvent[] = [];
const milestones = new Set<BrowserPerformanceEventName>();
let longTaskCount = 0;
let longTaskTotalDurationMs = 0;
let longTaskMaximumDurationMs = 0;
let maximumMountedRows = 0;
let initialized = false;
let articleOpenStartedAt: { startTimeMs: number; source: 'cache' | 'server' } | null = null;

function roundedMilliseconds(value: number) {
  return Math.round(value * 100) / 100;
}

function now() {
  return typeof performance === 'undefined' ? 0 : performance.now();
}

function addEvent(event: BrowserPerformanceEvent) {
  events.push(event);
  if (events.length > 1_000) events.shift();
}

function validRunId(value: string | null) {
  return value && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value) ? value : undefined;
}

export function initializeBrowserPerformance() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalDurationMs += entry.duration;
        longTaskMaximumDurationMs = Math.max(longTaskMaximumDurationMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  }
  window.__CHADASHOT_PERFORMANCE__ = {
    reset: resetBrowserPerformance,
    snapshot: browserPerformanceSnapshot,
  };
}

export function markMilestone(name: Extract<BrowserPerformanceEventName, 'shell' | 'first-usable-cached-list' | 'first-server-backed-list' | 'first-article' | 'synchronization-complete'>, options: Pick<BrowserPerformanceEvent, 'runId' | 'articles'> = {}) {
  if (milestones.has(name)) return;
  milestones.add(name);
  const startTimeMs = now();
  if (typeof performance?.mark === 'function') performance.mark(`chadashot:${name}`);
  addEvent({ name, startTimeMs: roundedMilliseconds(startTimeMs), ...options });
}

export function recordSynchronizationTrigger(trigger: NonNullable<BrowserPerformanceEvent['trigger']>, coalesced = 0) {
  addEvent({ name: 'synchronization-trigger', startTimeMs: roundedMilliseconds(now()), trigger, coalesced, retries: 0 });
}

export function recordReaderResponse(response: Response, decodedText: string) {
  const declaredLength = response.headers.get('content-length');
  const encodedBytes = declaredLength && /^\d+$/.test(declaredLength) ? Number(declaredLength) : null;
  addEvent({
    name: 'reader-response',
    startTimeMs: roundedMilliseconds(now()),
    runId: validRunId(response.headers.get('x-reader-run-id')),
    completed: true,
    browserRequests: 1,
    browserRequestBytes: 0,
    encodedBytes,
    decodedBytes: new Blob([decodedText]).size,
  });
}

export function recordCollectionDiff(previous: ReaderSnapshot | null, next: ReaderSnapshot) {
  if (!previous) {
    addEvent({
      name: 'collection-diff',
      startTimeMs: roundedMilliseconds(now()),
      articles: next.articles.length,
      changedItems: next.articles.length,
      unchangedItems: 0,
    });
    return;
  }
  const prior = new Map(previous.articles.map((article) => [article.id, article]));
  let changedItems = 0;
  let unchangedItems = 0;
  for (const article of next.articles) {
    const old = prior.get(article.id);
    if (old && JSON.stringify(old) === JSON.stringify(article)) unchangedItems += 1;
    else changedItems += 1;
  }
  addEvent({ name: 'collection-diff', startTimeMs: roundedMilliseconds(now()), articles: next.articles.length, changedItems, unchangedItems });
}

export async function measureSnapshotPersistence(operation: () => Promise<void>) {
  const startedAt = now();
  await operation();
  addEvent({ name: 'snapshot-persistence', startTimeMs: roundedMilliseconds(startedAt), durationMs: roundedMilliseconds(now() - startedAt) });
}

export async function measureOutboxReplay(attemptedMutations: number, operation: () => Promise<number>) {
  const startedAt = now();
  try {
    const result = await operation();
    addEvent({
      name: 'outbox-replay',
      startTimeMs: roundedMilliseconds(startedAt),
      durationMs: roundedMilliseconds(now() - startedAt),
      attemptedMutations,
      completedMutations: result,
    });
    return result;
  } catch (error) {
    addEvent({
      name: 'outbox-replay',
      startTimeMs: roundedMilliseconds(startedAt),
      durationMs: roundedMilliseconds(now() - startedAt),
      attemptedMutations,
      completedMutations: 0,
    });
    throw error;
  }
}

export function startArticleOpen(source: 'cache' | 'server' = 'cache') {
  articleOpenStartedAt = { startTimeMs: now(), source };
}

export function finishArticleOpen() {
  if (!articleOpenStartedAt) return;
  addEvent({
    name: 'article-open',
    startTimeMs: roundedMilliseconds(articleOpenStartedAt.startTimeMs),
    durationMs: roundedMilliseconds(now() - articleOpenStartedAt.startTimeMs),
    source: articleOpenStartedAt.source,
  });
  articleOpenStartedAt = null;
}

export function recordMountedRows(mountedRows: number) {
  maximumMountedRows = Math.max(maximumMountedRows, mountedRows);
  addEvent({ name: 'mounted-rows', startTimeMs: roundedMilliseconds(now()), mountedRows });
}

export function browserPerformanceSnapshot(): BrowserPerformanceSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    navigation: {
      userAgent: typeof navigator === 'undefined' ? 'unavailable' : navigator.userAgent,
      viewport: {
        width: typeof window === 'undefined' ? 0 : window.innerWidth,
        height: typeof window === 'undefined' ? 0 : window.innerHeight,
        devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
      },
    },
    events: [...events],
    longTasks: {
      count: longTaskCount,
      totalDurationMs: roundedMilliseconds(longTaskTotalDurationMs),
      maximumDurationMs: roundedMilliseconds(longTaskMaximumDurationMs),
    },
    maximumMountedRows,
  };
}

export function resetBrowserPerformance() {
  events.length = 0;
  milestones.clear();
  longTaskCount = 0;
  longTaskTotalDurationMs = 0;
  longTaskMaximumDurationMs = 0;
  maximumMountedRows = 0;
  articleOpenStartedAt = null;
}

declare global {
  interface Window {
    __CHADASHOT_PERFORMANCE__: {
      reset: typeof resetBrowserPerformance;
      snapshot: typeof browserPerformanceSnapshot;
    };
  }
}
