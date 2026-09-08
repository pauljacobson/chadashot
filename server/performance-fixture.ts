import type { Article, ReaderSnapshot } from '../shared/reader.js';

export const PERFORMANCE_FIXTURE_ARTICLES = 20_000;
export const PERFORMANCE_FIXTURE_FEEDS = 50;
export const PERFORMANCE_FIXTURE_LARGE_BODY_BYTES = 64 * 1024;
export const PERFORMANCE_FIXTURE_STANDARD_BODY_BYTES = 2 * 1024;

function syntheticBody(index: number, targetBytes: number) {
  const prefix = `<p>Synthetic performance article ${index}. `;
  const suffix = '</p>';
  const repeated = 'Deterministic fixture text for measuring transfer, parsing, storage, and rendering. ';
  return `${prefix}${repeated.repeat(Math.ceil((targetBytes - prefix.length - suffix.length) / repeated.length)).slice(0, targetBytes - prefix.length - suffix.length)}${suffix}`;
}

export function createPerformanceFixture(articleCount = PERFORMANCE_FIXTURE_ARTICLES): ReaderSnapshot {
  const folders = Array.from({ length: 5 }, (_, index) => ({
    id: `folder:synthetic-${index}`,
    title: `Synthetic folder ${index}`,
    unreadCount: 0,
  }));
  const subscriptions = Array.from({ length: PERFORMANCE_FIXTURE_FEEDS }, (_, index) => ({
    id: `feed:https://feed-${index}.example.invalid/rss`,
    title: `Synthetic feed ${index}`,
    url: `https://feed-${index}.example.invalid/rss`,
    siteUrl: `https://feed-${index}.example.invalid/`,
    iconUrl: null,
    folderIds: [folders[index % folders.length]!.id],
    unreadCount: 0,
  }));
  const baseTimestamp = Date.parse('2026-01-01T00:00:00.000Z');
  const articles = Array.from({ length: articleCount }, (_, index): Article => {
    const feed = subscriptions[index % subscriptions.length]!;
    const oldStateFixture = index >= articleCount - 25;
    const unread = oldStateFixture || index % 7 === 0;
    const starred = oldStateFixture || index % 101 === 0;
    const bodyBytes = index % 500 === 0 ? PERFORMANCE_FIXTURE_LARGE_BODY_BYTES : PERFORMANCE_FIXTURE_STANDARD_BODY_BYTES;
    if (unread) feed.unreadCount += 1;
    return {
      id: `synthetic-article-${String(index).padStart(5, '0')}`,
      feedId: feed.id,
      folderIds: [...feed.folderIds],
      title: `Synthetic article ${index}`,
      author: `Fixture author ${index % 12}`,
      source: feed.title,
      canonicalUrl: `https://article.example.invalid/${index}`,
      publishedAt: new Date(baseTimestamp - index * 60 * 60 * 1000).toISOString(),
      readingMinutes: Math.max(1, Math.ceil(bodyBytes / 1_200)),
      summary: `Synthetic summary ${index}. No production content or private URL is present.`,
      contentHtml: syntheticBody(index, bodyBytes),
      read: !unread,
      starred,
    };
  });
  for (const folder of folders) {
    const feedIds = new Set(subscriptions.filter((subscription) => subscription.folderIds.includes(folder.id)).map((subscription) => subscription.id));
    folder.unreadCount = articles.filter((article) => !article.read && feedIds.has(article.feedId)).length;
  }
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'fixture',
    folders,
    subscriptions,
    articles,
  };
}
