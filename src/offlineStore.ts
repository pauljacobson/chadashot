import { openDB, type DBSchema } from 'idb';
import type { ArticleMutation, ReaderSnapshot, SessionState } from '../shared/reader';
import { applyReadStates } from './readerState';

const DATABASE_NAME = 'chadashot';
const DATABASE_VERSION = 1;
const SNAPSHOT_KEY = 'latest';
const MAX_CACHED_ARTICLES = 200;
const MAX_CACHE_BYTES = 100 * 1024 * 1024;

export type QueuedArticleMutation = ArticleMutation & {
  key: string;
  createdAt: string;
  revision: string;
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
}

let databasePromise: ReturnType<typeof openDB<ChadashotDatabase>> | null = null;

function database() {
  if (!databasePromise) {
    databasePromise = openDB<ChadashotDatabase>(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(db) {
        db.createObjectStore('snapshots', { keyPath: 'key' });
        db.createObjectStore('sessions', { keyPath: 'key' });
        const outbox = db.createObjectStore('outbox', { keyPath: 'key' });
        outbox.createIndex('by-created-at', 'createdAt');
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
  const db = await database();
  const key = `${mutation.articleId}:${mutation.operation}`;
  const existing = await db.get('outbox', key);
  const queued = {
    ...mutation,
    key,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    revision: crypto.randomUUID(),
  };
  await db.put('outbox', queued);
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
  const transaction = db.transaction(['snapshots', 'sessions', 'outbox'], 'readwrite', { durability: 'strict' });
  await Promise.all([
    transaction.objectStore('snapshots').clear(),
    transaction.objectStore('sessions').clear(),
    transaction.objectStore('outbox').clear(),
  ]);
  await transaction.done;
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
