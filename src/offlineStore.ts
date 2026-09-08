import { openDB, type DBSchema } from 'idb';
import type {
  ArticleMutation,
  ReaderArticleBody,
  ReaderArticleMetadata,
  ReaderArticlePage,
  ReaderChangesPage,
  ReaderNavigation,
  ReaderMarkReadJobRequest,
  ReaderSnapshot,
  ReaderVersions,
  SessionState,
} from '../shared/reader';
import { applyReadStates } from './readerState';

const DATABASE_NAME = 'chadashot';
const DATABASE_VERSION = 4;
const SNAPSHOT_KEY = 'latest';
const MAX_CACHED_ARTICLES = 200;
const MAX_CACHE_BYTES = 100 * 1024 * 1024;
export const READER_BODY_CACHE_BUDGET = 25 * 1024 * 1024;
const READER_CLIENT_ID = crypto.randomUUID();

type ReaderAccountRecord = {
  accountKey: string;
  userId: string;
  generation: string;
  versions: ReaderVersions;
  updatedAt: string;
  active: boolean;
};

type ReaderNavigationRecord = { accountKey: string; navigation: ReaderNavigation; savedAt: string };
type ReaderArticleRecord = ReaderArticleMetadata & { key: string; accountKey: string; savedAt: string };
type ReaderBodyRecord = ReaderArticleBody & {
  key: string;
  accountKey: string;
  estimatedBytes: number;
  accessedAt: string;
};
export type ReaderCoverage = {
  loaded: number;
  total: number;
  complete: boolean;
  nextCursor: string | null;
  changeToken: string | null;
  backfillInterrupted: boolean;
};
type ReaderSyncRecord = ReaderCoverage & { accountKey: string; generation: string; versions: ReaderVersions; savedAt: string };

export type QueuedArticleMutation = ArticleMutation & {
  key: string;
  createdAt: string;
  revision: string;
  accountKey?: string;
};

export type AcknowledgedArticleMutation = QueuedArticleMutation & {
  acknowledgedAt: string;
};

export type QueuedMarkReadJob = ReaderMarkReadJobRequest & {
  key: string;
  createdAt: string;
};

interface ChadashotDatabase extends DBSchema {
  snapshots: {
    key: string;
    value: { key: string; snapshot: ReaderSnapshot; estimatedBytes: number; savedAt: string };
  };
  sessions: {
    key: string;
    value: { key: string; session: SessionState; savedAt: string };
  };
  outbox: {
    key: string;
    value: QueuedArticleMutation;
    indexes: { 'by-created-at': string };
  };
  acknowledgements: {
    key: string;
    value: AcknowledgedArticleMutation;
  };
  markReadJobs: {
    key: string;
    value: QueuedMarkReadJob;
    indexes: { 'by-created-at': string };
  };
  readerAccounts: {
    key: string;
    value: ReaderAccountRecord;
    indexes: { 'by-user': string };
  };
  readerNavigation: {
    key: string;
    value: ReaderNavigationRecord;
  };
  readerArticles: {
    key: string;
    value: ReaderArticleRecord;
    indexes: { 'by-account': string };
  };
  readerBodies: {
    key: string;
    value: ReaderBodyRecord;
    indexes: { 'by-account': string; 'by-accessed-at': string };
  };
  readerSync: {
    key: string;
    value: ReaderSyncRecord;
  };
}

let databasePromise: ReturnType<typeof openDB<ChadashotDatabase>> | null = null;

function database() {
  if (!databasePromise) {
    databasePromise = openDB<ChadashotDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('snapshots', { keyPath: 'key' });
          db.createObjectStore('sessions', { keyPath: 'key' });
          const outbox = db.createObjectStore('outbox', { keyPath: 'key' });
          outbox.createIndex('by-created-at', 'createdAt');
        }
        if (oldVersion < 2) db.createObjectStore('acknowledgements', { keyPath: 'key' });
        if (oldVersion < 3) {
          const accounts = db.createObjectStore('readerAccounts', { keyPath: 'accountKey' });
          accounts.createIndex('by-user', 'userId');
          db.createObjectStore('readerNavigation', { keyPath: 'accountKey' });
          const articles = db.createObjectStore('readerArticles', { keyPath: 'key' });
          articles.createIndex('by-account', 'accountKey');
          const bodies = db.createObjectStore('readerBodies', { keyPath: 'key' });
          bodies.createIndex('by-account', 'accountKey');
          bodies.createIndex('by-accessed-at', 'accessedAt');
          db.createObjectStore('readerSync', { keyPath: 'accountKey' });
        }
        if (oldVersion < 4) {
          const jobs = db.createObjectStore('markReadJobs', { keyPath: 'key' });
          jobs.createIndex('by-created-at', 'createdAt');
        }
      },
      blocking() {
        databasePromise?.then((db) => db.close()).catch(() => undefined);
        databasePromise = null;
      },
    });
  }
  return databasePromise;
}

function estimateBytes(value: unknown) {
  return new Blob([JSON.stringify(value)]).size;
}

function boundedSnapshot(snapshot: ReaderSnapshot): ReaderSnapshot {
  const articles = [...snapshot.articles]
    .sort((first, second) => Date.parse(second.publishedAt) - Date.parse(first.publishedAt))
    .slice(0, MAX_CACHED_ARTICLES);
  const retained = [] as ReaderSnapshot['articles'];
  let bytes = estimateBytes({ ...snapshot, articles: [] });
  for (const article of articles) {
    const articleBytes = estimateBytes(article);
    if (retained.length > 0 && bytes + articleBytes > MAX_CACHE_BYTES) break;
    retained.push(article);
    bytes += articleBytes;
  }
  return { ...snapshot, articles: retained };
}

export async function saveCachedSnapshot(snapshot: ReaderSnapshot) {
  const bounded = boundedSnapshot(snapshot);
  await (await database()).put('snapshots', {
    key: SNAPSHOT_KEY,
    snapshot: bounded,
    estimatedBytes: estimateBytes(bounded),
    savedAt: new Date().toISOString(),
  });
}

export async function loadCachedSnapshot() {
  return (await (await database()).get('snapshots', SNAPSHOT_KEY))?.snapshot ?? null;
}

export async function saveOfflineSession(session: SessionState) {
  if (!session.authenticated) return;
  await (await database()).put('sessions', { key: 'current', session, savedAt: new Date().toISOString() });
}

export async function loadOfflineSession() {
  return (await (await database()).get('sessions', 'current'))?.session ?? null;
}

export async function enqueueArticleMutation(mutation: ArticleMutation, accountKey?: string) {
  return (await enqueueArticleMutations([mutation], accountKey))[0];
}

export async function enqueueMarkReadJob(job: ReaderMarkReadJobRequest) {
  const queued = { ...job, key: job.idempotencyKey, createdAt: new Date().toISOString() } satisfies QueuedMarkReadJob;
  await (await database()).put('markReadJobs', queued);
  return queued;
}

export async function queuedMarkReadJobs(accountKey?: string) {
  const jobs = await (await database()).getAllFromIndex('markReadJobs', 'by-created-at');
  return accountKey ? jobs.filter((job) => job.accountKey === accountKey) : jobs;
}

export async function acknowledgeMarkReadJob(job: QueuedMarkReadJob) {
  const db = await database();
  const current = await db.get('markReadJobs', job.key);
  if (current?.accountKey === job.accountKey) await db.delete('markReadJobs', job.key);
}

/** Atomically persists a local batch before any provider request is attempted. */
export async function enqueueArticleMutations(mutations: ArticleMutation[], accountKey?: string) {
  if (mutations.length === 0) return [];
  const db = await database();
  const transaction = db.transaction('outbox', 'readwrite', { durability: 'strict' });
  const queued: QueuedArticleMutation[] = [];
  for (const mutation of mutations) {
    const key = `${accountKey ? `${accountKey}:` : ''}${mutation.articleId}:${mutation.operation}`;
    const existing = await transaction.store.get(key);
    const next = {
      ...mutation,
      key,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      revision: crypto.randomUUID(),
      ...(accountKey ? { accountKey } : {}),
    };
    await transaction.store.put(next);
    queued.push(next);
  }
  await transaction.done;
  return queued;
}

export async function queuedArticleMutations(accountKey?: string) {
  const mutations = await (await database()).getAllFromIndex('outbox', 'by-created-at');
  if (!accountKey) return mutations;
  return mutations.filter((mutation) => !mutation.accountKey || mutation.accountKey === accountKey);
}

export async function removeQueuedArticleMutation(mutation: QueuedArticleMutation) {
  const db = await database();
  const transaction = db.transaction('outbox', 'readwrite');
  const current = await transaction.store.get(mutation.key);
  if (current?.revision === mutation.revision) await transaction.store.delete(mutation.key);
  await transaction.done;
}

/**
 * Moves successfully submitted revisions from the outbox to an acknowledgement
 * barrier in one transaction. A newer local revision is never removed by an
 * older request completing later.
 */
export async function acknowledgeQueuedArticleMutations(mutations: QueuedArticleMutation[]) {
  if (mutations.length === 0) return 0;
  const db = await database();
  const transaction = db.transaction(['outbox', 'acknowledgements'], 'readwrite', { durability: 'strict' });
  let acknowledged = 0;
  for (const mutation of mutations) {
    const current = await transaction.objectStore('outbox').get(mutation.key);
    if (current?.revision !== mutation.revision) continue;
    await transaction.objectStore('outbox').delete(mutation.key);
    await transaction.objectStore('acknowledgements').put({
      ...mutation,
      acknowledgedAt: new Date().toISOString(),
    });
    acknowledged += 1;
  }
  await transaction.done;
  return acknowledged;
}

export async function acknowledgedArticleMutations() {
  return (await (await database()).getAll('acknowledgements'));
}

export function applyQueuedArticleMutations(snapshot: ReaderSnapshot, mutations: QueuedArticleMutation[]) {
  const readStates = new Map(mutations
    .filter((mutation) => mutation.operation === 'read')
    .map((mutation) => [mutation.articleId, mutation.value]));
  const starredStates = new Map(mutations
    .filter((mutation) => mutation.operation === 'starred')
    .map((mutation) => [mutation.articleId, mutation.value]));
  const withReadStates = applyReadStates(snapshot, readStates);
  return {
    ...withReadStates,
    articles: withReadStates.articles.map((article) => starredStates.has(article.id)
      ? { ...article, starred: starredStates.get(article.id)! }
      : article),
  };
}

function snapshotMatchesMutation(snapshot: ReaderSnapshot, mutation: ArticleMutation) {
  const article = snapshot.articles.find((candidate) => candidate.id === mutation.articleId);
  if (!article) return false;
  return mutation.operation === 'read'
    ? article.read === mutation.value
    : article.starred === mutation.value;
}

/** Applies durable local intent to cached data without treating that cache as provider confirmation. */
export async function overlayLocalMutations(snapshot: ReaderSnapshot, accountKey?: string) {
  const db = await database();
  const transaction = db.transaction(['outbox', 'acknowledgements'], 'readonly');
  const [pending, acknowledgements] = await Promise.all([
    transaction.objectStore('outbox').index('by-created-at').getAll(),
    transaction.objectStore('acknowledgements').getAll(),
  ]);
  await transaction.done;
  const applicablePending = accountKey ? pending.filter((mutation) => !mutation.accountKey || mutation.accountKey === accountKey) : pending;
  const applicableAcknowledgements = accountKey
    ? acknowledgements.filter((mutation) => !mutation.accountKey || mutation.accountKey === accountKey)
    : acknowledgements;
  return {
    snapshot: applyQueuedArticleMutations(snapshot, [...applicableAcknowledgements, ...applicablePending]),
    pendingMutations: applicablePending.length,
  };
}

/**
 * Overlays both pending and recently acknowledged intent on a server snapshot.
 * An acknowledgement is cleared only after the provider snapshot confirms the
 * same value, preventing an eventually consistent response from reverting UI.
 */
export async function reconcileSnapshotWithLocalMutations(snapshot: ReaderSnapshot, accountKey?: string) {
  const db = await database();
  const transaction = db.transaction(['outbox', 'acknowledgements'], 'readwrite');
  const pending = await transaction.objectStore('outbox').index('by-created-at').getAll();
  const acknowledgements = await transaction.objectStore('acknowledgements').getAll();
  const retainedAcknowledgements: AcknowledgedArticleMutation[] = [];

  const applicablePending = accountKey ? pending.filter((mutation) => !mutation.accountKey || mutation.accountKey === accountKey) : pending;
  const applicableAcknowledgements = accountKey
    ? acknowledgements.filter((mutation) => !mutation.accountKey || mutation.accountKey === accountKey)
    : acknowledgements;

  for (const acknowledgement of applicableAcknowledgements) {
    if (snapshotMatchesMutation(snapshot, acknowledgement)) {
      const current = await transaction.objectStore('acknowledgements').get(acknowledgement.key);
      if (current?.revision === acknowledgement.revision) {
        await transaction.objectStore('acknowledgements').delete(acknowledgement.key);
      }
    } else {
      retainedAcknowledgements.push(acknowledgement);
    }
  }
  await transaction.done;

  return {
    snapshot: applyQueuedArticleMutations(snapshot, [...retainedAcknowledgements, ...applicablePending]),
    pendingMutations: applicablePending.length,
  };
}

export async function offlineStorageSummary() {
  const db = await database();
  const [snapshotRecord, queuedMutations, queuedJobs] = await Promise.all([
    db.get('snapshots', SNAPSHOT_KEY),
    db.count('outbox'),
    db.count('markReadJobs'),
  ]);
  return {
    articles: snapshotRecord?.snapshot.articles.length ?? 0,
    queuedChanges: queuedMutations + queuedJobs,
    estimatedBytes: snapshotRecord?.estimatedBytes ?? 0,
  };
}

export type CachedReaderState = {
  accountKey: string;
  generation: string;
  versions: ReaderVersions;
  snapshot: ReaderSnapshot;
  coverage: ReaderCoverage;
};

function readerRecordKey(accountKey: string, articleId: string) {
  return `${accountKey}\0${articleId}`;
}

function isQuotaError(error: unknown) {
  return error instanceof DOMException && error.name === 'QuotaExceededError';
}

async function evictReaderBodies(requiredBytes = 0, retainedArticleId?: string) {
  const db = await database();
  const transaction = db.transaction('readerBodies', 'readwrite');
  const records = await transaction.store.index('by-accessed-at').getAll();
  let bytes = records.reduce((total, record) => total + record.estimatedBytes, 0);
  for (const record of records) {
    if (bytes + requiredBytes <= READER_BODY_CACHE_BUDGET) break;
    if (record.articleId === retainedArticleId) continue;
    await transaction.store.delete(record.key);
    bytes -= record.estimatedBytes;
  }
  await transaction.done;
}

function notifyReaderUpdate(accountKey: string) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('chadashot-reader-v1');
  channel.postMessage({ accountKey, senderId: READER_CLIENT_ID });
  channel.close();
}

export function subscribeToReaderUpdates(listener: (accountKey: string) => void) {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel('chadashot-reader-v1');
  channel.addEventListener('message', (event) => {
    if (
      event.data
      && event.data.senderId !== READER_CLIENT_ID
      && typeof event.data.accountKey === 'string'
    ) listener(event.data.accountKey);
  });
  return () => channel.close();
}

function snapshotFromNormalized(
  navigation: ReaderNavigation,
  metadata: ReaderArticleRecord[],
  bodies: ReaderBodyRecord[],
): ReaderSnapshot {
  const bodyByArticle = new Map(bodies
    .filter((body) => body.bodyVersion === navigation.versions.body)
    .map((body) => [body.articleId, body.contentHtml]));
  return {
    generatedAt: new Date().toISOString(),
    source: 'google-reader',
    folders: navigation.folders.map((folder) => ({
      id: folder.id,
      title: folder.title,
      unreadCount: folder.unreadCount,
      totalCount: folder.totalCount,
      latestPublishedAt: folder.latestPublishedAt,
    })),
    subscriptions: navigation.feeds.map((feed) => ({
      id: feed.id,
      title: feed.title,
      url: feed.url,
      siteUrl: feed.siteUrl,
      iconUrl: feed.iconUrl,
      folderIds: feed.folderIds,
      unreadCount: feed.unreadCount,
      totalCount: feed.totalCount,
      latestPublishedAt: feed.latestPublishedAt,
    })),
    articles: metadata
      .sort((first, second) => second.publishedAt.localeCompare(first.publishedAt) || second.id.localeCompare(first.id))
      .map((article) => ({
        id: article.id,
        feedId: article.feedId,
        folderIds: article.folderIds,
        title: article.title,
        author: article.author,
        source: article.source,
        canonicalUrl: article.canonicalUrl,
        publishedAt: article.publishedAt,
        readingMinutes: article.readingMinutes,
        summary: article.summary,
        read: article.read,
        starred: article.starred,
        contentHtml: bodyByArticle.get(article.id) ?? '',
      })),
    cacheStatus: {
      state: 'current',
      lastSuccessAt: null,
      error: null,
      versions: navigation.versions,
    },
  };
}

async function migrateLegacySnapshot(userId: string) {
  const db = await database();
  if ((await db.getAllFromIndex('readerAccounts', 'by-user', userId)).length > 0) return;
  const legacy = await db.get('snapshots', SNAPSHOT_KEY);
  if (!legacy) return;
  const accountKey = `legacy:${userId}`;
  const generation = `legacy:${legacy.snapshot.generatedAt}`;
  const versions = legacy.snapshot.cacheStatus?.versions ?? { collection: 0, state: 0, body: 0 };
  const navigation: ReaderNavigation = {
    accountKey,
    generation,
    versions,
    counts: {
      all: legacy.snapshot.articles.length,
      inbox: legacy.snapshot.articles.filter((article) => !article.read).length,
      starred: legacy.snapshot.articles.filter((article) => article.starred).length,
      uncategorized: legacy.snapshot.articles.filter((article) => article.folderIds.length === 0).length,
    },
    folders: legacy.snapshot.folders.map((folder) => ({ ...folder, totalCount: 0, latestPublishedAt: null })),
    feeds: legacy.snapshot.subscriptions.map((feed) => ({ ...feed, totalCount: 0, latestPublishedAt: null })),
  };
  const timestamp = new Date().toISOString();
  const transaction = db.transaction(
    ['readerAccounts', 'readerNavigation', 'readerArticles', 'readerBodies', 'readerSync'],
    'readwrite',
  );
  await transaction.objectStore('readerAccounts').put({ accountKey, userId, generation, versions, updatedAt: timestamp, active: true });
  await transaction.objectStore('readerNavigation').put({ accountKey, navigation, savedAt: timestamp });
  for (const { contentHtml, ...article } of legacy.snapshot.articles) {
    await transaction.objectStore('readerArticles').put({
      ...article, key: readerRecordKey(accountKey, article.id), accountKey, savedAt: timestamp,
    });
    if (contentHtml) {
      await transaction.objectStore('readerBodies').put({
        accountKey,
        articleId: article.id,
        contentHtml,
        bodyVersion: versions.body,
        key: readerRecordKey(accountKey, article.id),
        estimatedBytes: estimateBytes(contentHtml),
        accessedAt: timestamp,
      });
    }
  }
  await transaction.objectStore('readerSync').put({
    accountKey,
    generation,
    versions,
    loaded: legacy.snapshot.articles.length,
    total: legacy.snapshot.articles.length,
    complete: false,
    nextCursor: null,
    changeToken: null,
    backfillInterrupted: false,
    savedAt: timestamp,
  });
  await transaction.done;
}

export async function loadCachedReader(userId: string): Promise<CachedReaderState | null> {
  await migrateLegacySnapshot(userId);
  const db = await database();
  const accounts = await db.getAllFromIndex('readerAccounts', 'by-user', userId);
  const account = accounts.sort((first, second) => Number(second.active) - Number(first.active)
    || second.updatedAt.localeCompare(first.updatedAt))[0];
  if (!account) return null;
  const transaction = db.transaction(['readerNavigation', 'readerArticles', 'readerBodies', 'readerSync'], 'readonly');
  const [navigationRecord, articles, bodies, sync] = await Promise.all([
    transaction.objectStore('readerNavigation').get(account.accountKey),
    transaction.objectStore('readerArticles').index('by-account').getAll(account.accountKey),
    transaction.objectStore('readerBodies').index('by-account').getAll(account.accountKey),
    transaction.objectStore('readerSync').get(account.accountKey),
  ]);
  await transaction.done;
  if (!navigationRecord || !sync) return null;
  return {
    accountKey: account.accountKey,
    generation: account.generation,
    versions: account.versions,
    snapshot: snapshotFromNormalized(navigationRecord.navigation, articles, bodies),
    coverage: sync,
  };
}

export async function saveReaderNavigation(userId: string, navigation: ReaderNavigation) {
  const db = await database();
  const timestamp = new Date().toISOString();
  const account = await db.get('readerAccounts', navigation.accountKey);
  const transaction = db.transaction(['readerAccounts', 'readerNavigation'], 'readwrite', { durability: 'strict' });
  const userAccounts = await transaction.objectStore('readerAccounts').index('by-user').getAll(userId);
  for (const prior of userAccounts) {
    if (prior.accountKey !== navigation.accountKey && prior.active) {
      await transaction.objectStore('readerAccounts').put({ ...prior, active: false });
    }
  }
  await transaction.objectStore('readerAccounts').put({
    accountKey: navigation.accountKey,
    userId,
    generation: navigation.generation,
    versions: navigation.versions,
    updatedAt: timestamp,
    active: true,
  });
  await transaction.objectStore('readerNavigation').put({ accountKey: navigation.accountKey, navigation, savedAt: timestamp });
  await transaction.done;
  if (account?.generation !== navigation.generation) notifyReaderUpdate(navigation.accountKey);
}

export async function saveReaderArticlePage(userId: string, page: ReaderArticlePage, replaceExisting = false) {
  const write = async () => {
    const db = await database();
    const timestamp = new Date().toISOString();
    const existing = await db.get('readerAccounts', page.accountKey);
    const reset = replaceExisting || existing?.generation !== page.generation;
    const transaction = db.transaction(['readerAccounts', 'readerArticles', 'readerBodies', 'readerSync'], 'readwrite', { durability: 'strict' });
    if (reset) {
      let articleCursor = await transaction.objectStore('readerArticles').index('by-account').openKeyCursor(IDBKeyRange.only(page.accountKey));
      while (articleCursor) {
        await transaction.objectStore('readerArticles').delete(articleCursor.primaryKey);
        articleCursor = await articleCursor.continue();
      }
      let bodyCursor = await transaction.objectStore('readerBodies').index('by-account').openKeyCursor(IDBKeyRange.only(page.accountKey));
      while (bodyCursor) {
        await transaction.objectStore('readerBodies').delete(bodyCursor.primaryKey);
        bodyCursor = await bodyCursor.continue();
      }
    }
    await transaction.objectStore('readerAccounts').put({
      accountKey: page.accountKey,
      userId,
      generation: page.generation,
      versions: page.versions,
      updatedAt: timestamp,
      active: existing?.active ?? true,
    });
    for (const article of page.articles) {
      await transaction.objectStore('readerArticles').put({
        ...article,
        key: readerRecordKey(page.accountKey, article.id),
        accountKey: page.accountKey,
        savedAt: timestamp,
      });
    }
    const priorSync = await transaction.objectStore('readerSync').get(page.accountKey);
    const loaded = reset ? page.articles.length : await transaction.objectStore('readerArticles').index('by-account').count(page.accountKey);
    await transaction.objectStore('readerSync').put({
      accountKey: page.accountKey,
      generation: page.generation,
      versions: page.versions,
      loaded,
      total: page.total,
      complete: page.nextCursor === null,
      nextCursor: page.nextCursor,
      changeToken: reset ? null : priorSync?.changeToken ?? null,
      backfillInterrupted: page.nextCursor !== null,
      savedAt: timestamp,
    });
    await transaction.done;
  };
  try {
    await write();
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await evictReaderBodies();
    await write();
  }
  notifyReaderUpdate(page.accountKey);
}

export async function saveReaderChangeToken(accountKey: string, token: string) {
  const db = await database();
  const sync = await db.get('readerSync', accountKey);
  if (!sync) return;
  await db.put('readerSync', { ...sync, changeToken: token, savedAt: new Date().toISOString() });
}

function isArticleMetadata(value: unknown): value is ReaderArticleMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ReaderArticleMetadata>;
  return typeof candidate.id === 'string'
    && typeof candidate.feedId === 'string'
    && Array.isArray(candidate.folderIds)
    && typeof candidate.title === 'string'
    && typeof candidate.publishedAt === 'string'
    && typeof candidate.read === 'boolean'
    && typeof candidate.starred === 'boolean';
}

export async function applyReaderChanges(page: ReaderChangesPage) {
  const db = await database();
  const timestamp = new Date().toISOString();
  const transaction = db.transaction(['readerAccounts', 'readerArticles', 'readerBodies', 'readerSync'], 'readwrite', { durability: 'strict' });
  for (const change of page.changes) {
    if (!change.articleId) continue;
    const key = readerRecordKey(page.accountKey, change.articleId);
    if (change.deleted) {
      await transaction.objectStore('readerArticles').delete(key);
      await transaction.objectStore('readerBodies').delete(key);
      continue;
    }
    if (isArticleMetadata(change.payload)) {
      await transaction.objectStore('readerArticles').put({
        ...change.payload,
        key,
        accountKey: page.accountKey,
        savedAt: timestamp,
      });
    }
    if (change.bodyChanged) await transaction.objectStore('readerBodies').delete(key);
  }
  const account = await transaction.objectStore('readerAccounts').get(page.accountKey);
  if (account) {
    await transaction.objectStore('readerAccounts').put({ ...account, versions: page.versions, updatedAt: timestamp });
  }
  const sync = await transaction.objectStore('readerSync').get(page.accountKey);
  if (sync) {
    await transaction.objectStore('readerSync').put({
      ...sync,
      versions: page.versions,
      changeToken: page.token,
      savedAt: timestamp,
    });
  }
  await transaction.done;
  notifyReaderUpdate(page.accountKey);
}

export async function saveReaderBody(body: ReaderArticleBody) {
  const record: ReaderBodyRecord = {
    ...body,
    key: readerRecordKey(body.accountKey, body.articleId),
    estimatedBytes: estimateBytes(body.contentHtml),
    accessedAt: new Date().toISOString(),
  };
  await evictReaderBodies(record.estimatedBytes, body.articleId);
  try {
    await (await database()).put('readerBodies', record);
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    await evictReaderBodies(READER_BODY_CACHE_BUDGET, body.articleId);
    await (await database()).put('readerBodies', record);
  }
  notifyReaderUpdate(body.accountKey);
}

export async function loadReaderBody(accountKey: string, articleId: string, bodyVersion: number) {
  const db = await database();
  const key = readerRecordKey(accountKey, articleId);
  const body = await db.get('readerBodies', key);
  if (!body || body.bodyVersion !== bodyVersion) return null;
  await db.put('readerBodies', { ...body, accessedAt: new Date().toISOString() });
  return body;
}

export async function applyLocalMutationToReaderCache(accountKey: string, mutation: ArticleMutation) {
  const db = await database();
  const key = readerRecordKey(accountKey, mutation.articleId);
  const article = await db.get('readerArticles', key);
  if (!article) return;
  await db.put('readerArticles', {
    ...article,
    [mutation.operation === 'read' ? 'read' : 'starred']: mutation.value,
    savedAt: new Date().toISOString(),
  });
  notifyReaderUpdate(accountKey);
}

export async function applyLocalReadStateToReaderCache(accountKey: string, articleIds: string[], read: boolean) {
  if (articleIds.length === 0) return;
  const db = await database();
  const transaction = db.transaction('readerArticles', 'readwrite', { durability: 'strict' });
  const savedAt = new Date().toISOString();
  for (const articleId of articleIds) {
    const key = readerRecordKey(accountKey, articleId);
    const article = await transaction.store.get(key);
    if (article && article.read !== read) await transaction.store.put({ ...article, read, savedAt });
  }
  await transaction.done;
  notifyReaderUpdate(accountKey);
}

export async function clearOfflineData() {
  const db = await database();
  const transaction = db.transaction([
    'snapshots', 'sessions', 'outbox', 'acknowledgements', 'readerAccounts', 'readerNavigation',
    'readerArticles', 'readerBodies', 'readerSync',
    'markReadJobs',
  ], 'readwrite', { durability: 'strict' });
  await Promise.all([
    transaction.objectStore('snapshots').clear(),
    transaction.objectStore('sessions').clear(),
    transaction.objectStore('outbox').clear(),
    transaction.objectStore('acknowledgements').clear(),
    transaction.objectStore('readerAccounts').clear(),
    transaction.objectStore('readerNavigation').clear(),
    transaction.objectStore('readerArticles').clear(),
    transaction.objectStore('readerBodies').clear(),
    transaction.objectStore('readerSync').clear(),
    transaction.objectStore('markReadJobs').clear(),
  ]);
  await transaction.done;
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
