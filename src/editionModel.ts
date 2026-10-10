import type { Article, ReaderSnapshot } from '../shared/reader';
import { buildFeedGroups, type FeedSortOrder } from './feedTree';

export const EDITION_WINDOWS = [12, 24, 48] as const;
export type EditionHours = (typeof EDITION_WINDOWS)[number];
export const EDITION_WINDOW_KEY = 'chadashot.latestEditionHours';

export function savedEditionHours(): EditionHours {
  try {
    const value = Number(localStorage.getItem(EDITION_WINDOW_KEY));
    return EDITION_WINDOWS.includes(value as EditionHours) ? value as EditionHours : 24;
  } catch {
    return 24;
  }
}

export function buildEditionSections(snapshot: ReaderSnapshot | null, articles: Article[], hours: EditionHours, now: number, sortOrder: FeedSortOrder) {
  const cutoff = now - hours * 3_600_000;
  const recent = articles.filter((article) => {
    const published = Date.parse(article.publishedAt);
    return published >= cutoff && published <= now;
  }).sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt) || right.id.localeCompare(left.id));
  const knownFolders = new Set(snapshot?.folders.map((folder) => folder.id));
  const feedFolders = new Map(snapshot?.subscriptions.map((feed) => [feed.id, feed.folderIds]));
  const categories = (article: Article) => [...new Set([
    ...article.folderIds, ...(feedFolders.get(article.feedId) ?? []),
  ])].filter((id) => knownFolders.has(id));
  const groups = buildFeedGroups(snapshot, { sortOrder });
  // Include uncategorized articles even if their subscription metadata has disappeared.
  if (!groups.some((group) => group.uncategorized) && recent.some((article) => !categories(article).length)) {
    groups.push({ id: '__uncategorized__', title: 'Uncategorized', unreadCount: 0, uncategorized: true, subscriptions: [] });
  }
  return groups.map((group) => ({
    id: group.id,
    title: group.title,
    articles: recent.filter((article) => group.uncategorized ? !categories(article).length : categories(article).includes(group.id)),
  })).filter((group) => group.articles.length);
}
