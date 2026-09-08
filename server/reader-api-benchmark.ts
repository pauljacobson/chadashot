import { performance } from 'node:perf_hooks';
import { openMemoryDatabase } from './database.js';
import { createPerformanceFixture } from './performance-fixture.js';
import { ReaderApi } from './reader-api.js';
import { ReaderCache, type ReaderCacheIdentity } from './reader-cache.js';

const identity: ReaderCacheIdentity = {
  accountKey: 'synthetic-reader-api-benchmark',
  providerIdentity: 'synthetic-provider',
  credentialGeneration: 'synthetic-generation',
};

function p95(values: number[]) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

const database = openMemoryDatabase();
const cache = new ReaderCache(database, 'benchmark-worker');
const fixture = createPerformanceFixture();
const lease = cache.acquireLease(identity)!;
const run = cache.beginImport(lease);
cache.stageFolders(run, fixture.folders);
cache.stageSubscriptions(run, fixture.subscriptions);
for (let offset = 0; offset < fixture.articles.length; offset += 500) {
  cache.stageArticles(run, fixture.articles.slice(offset, offset + 500));
}
cache.publish(run);

const api = new ReaderApi(database);
const firstPage = () => api.articles(identity, { scope: 'all', read: 'all', limit: 100 });
firstPage();
const firstPageDurations = Array.from({ length: 20 }, () => {
  const startedAt = performance.now();
  firstPage();
  return performance.now() - startedAt;
});
const page = firstPage();
const ids: string[] = [];
let cursor: string | undefined;
do {
  const result = api.articles(identity, { scope: 'all', read: 'all', limit: 100, cursor });
  ids.push(...result.articles.map((article) => article.id));
  cursor = result.nextCursor ?? undefined;
} while (cursor);

const standardArticle = fixture.articles.find((article) => article.contentHtml.length < 10_000)!;
const largeArticle = fixture.articles.find((article) => article.contentHtml.length >= 64 * 1_024)!;
const bodyP95 = (articleId: string) => {
  api.body(identity, articleId);
  return p95(Array.from({ length: 20 }, () => {
    const startedAt = performance.now();
    api.body(identity, articleId);
    return performance.now() - startedAt;
  }));
};

process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  articles: fixture.articles.length,
  traversed: ids.length,
  uniqueIds: new Set(ids).size,
  firstPageRows: page.articles.length,
  firstPageDecodedBytes: Buffer.byteLength(JSON.stringify(page), 'utf8'),
  firstPageQueryP95Ms: Math.round(p95(firstPageDurations) * 100) / 100,
  standardBodyBytes: Buffer.byteLength(standardArticle.contentHtml, 'utf8'),
  standardBodyQueryP95Ms: Math.round(bodyP95(standardArticle.id) * 100) / 100,
  largeBodyBytes: Buffer.byteLength(largeArticle.contentHtml, 'utf8'),
  largeBodyQueryP95Ms: Math.round(bodyP95(largeArticle.id) * 100) / 100,
}, null, 2)}\n`);
database.close();
