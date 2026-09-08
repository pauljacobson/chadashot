import { openDB, type DBSchema } from 'idb';
import type { ArticleMutation, ReaderSnapshot, SessionState } from '../shared/reader';
import { applyReadStates } from './readerState';

const DATABASE_NAME = 'chadashot';
const DATABASE_VERSION = 2;
const SNAPSHOT_KEY = 'latest';
const MAX_CACHED_ARTICLES = 200;
const MAX_CACHE_BYTES = 100 * 1024 * 1024;

export type QueuedArticleMutation = ArticleMutation & {
  key: string;
  createdAt: string;
  revision: string;
};

export type AcknowledgedArticleMutation = QueuedArticleMutation & {
  acknowledgedAt: string;
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

export async function enqueueArticleMutation(mutation: ArticleMutation) {
  return (await enqueueArticleMutations([mutation]))[0];
}

/** Atomically persists a local batch before any provider request is attempted. */
export async function enqueueArticleMutations(mutations: ArticleMutation[]) {
  if (mutations.length === 0) return [];
  const db = await database();
  const transaction = db.transaction('outbox', 'readwrite', { durability: 'strict' });
  const queued: QueuedArticleMutation[] = [];
  for (const mutation of mutations) {
    const key = `${mutation.articleId}:${mutation.operation}`;
    const existing = await transaction.store.get(key);
    const next = {
      ...mutation,
      key,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      revision: crypto.randomUUID(),
    };
    await transaction.store.put(next);
    queued.push(next);
  }
  await transaction.done;
  return queued;
}

export async function queuedArticleMutations() {
  return (await (await database()).getAllFromIndex('outbox', 'by-created-at'));
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
export async function overlayLocalMutations(snapshot: ReaderSnapshot) {
  const db = await database();
  const transaction = db.transaction(['outbox', 'acknowledgements'], 'readonly');
  const [pending, acknowledgements] = await Promise.all([
    transaction.objectStore('outbox').index('by-created-at').getAll(),
    transaction.objectStore('acknowledgements').getAll(),
  ]);
  await transaction.done;
  return {
    snapshot: applyQueuedArticleMutations(snapshot, [...acknowledgements, ...pending]),
    pendingMutations: pending.length,
  };
}

/**
 * Overlays both pending and recently acknowledged intent on a server snapshot.
 * An acknowledgement is cleared only after the provider snapshot confirms the
 * same value, preventing an eventually consistent response from reverting UI.
 */
export async function reconcileSnapshotWithLocalMutations(snapshot: ReaderSnapshot) {
  const db = await database();
  const transaction = db.transaction(['outbox', 'acknowledgements'], 'readwrite');
  const pending = await transaction.objectStore('outbox').index('by-created-at').getAll();
  const acknowledgements = await transaction.objectStore('acknowledgements').getAll();
  const retainedAcknowledgements: AcknowledgedArticleMutation[] = [];

  for (const acknowledgement of acknowledgements) {
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
    snapshot: applyQueuedArticleMutations(snapshot, [...retainedAcknowledgements, ...pending]),
    pendingMutations: pending.length,
  };
}

export async function offlineStorageSummary() {
  const db = await database();
  const [snapshotRecord, queuedChanges] = await Promise.all([
    db.get('snapshots', SNAPSHOT_KEY),
    db.count('outbox'),
  ]);
  return {
    articles: snapshotRecord?.snapshot.articles.length ?? 0,
    queuedChanges,
    estimatedBytes: snapshotRecord?.estimatedBytes ?? 0,
  };
}

export async function clearOfflineData() {
  const db = await database();
  const transaction = db.transaction(['snapshots', 'sessions', 'outbox', 'acknowledgements'], 'readwrite', { durability: 'strict' });
  await Promise.all([
    transaction.objectStore('snapshots').clear(),
    transaction.objectStore('sessions').clear(),
    transaction.objectStore('outbox').clear(),
    transaction.objectStore('acknowledgements').clear(),
  ]);
  await transaction.done;
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
