import type { Folder, ReaderSnapshot, Subscription } from '../shared/reader';

export const UNCATEGORIZED_FOLDER_ID = '__uncategorized__';
export type FeedSortOrder = 'alphabetical' | 'recent';

export type FeedTreeOptions = {
  unreadOnly?: boolean;
  sortOrder?: FeedSortOrder;
};

export type FeedGroup = Folder & {
  uncategorized: boolean;
  subscriptions: Subscription[];
};

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function buildFeedGroups(snapshot: ReaderSnapshot | null, options: FeedTreeOptions = {}): FeedGroup[] {
  if (!snapshot) return [];

  const { unreadOnly = false, sortOrder = 'alphabetical' } = options;
  const activityByFeed = new Map(snapshot.subscriptions.map((subscription) => {
    const publishedAt = subscription.latestPublishedAt ? Date.parse(subscription.latestPublishedAt) : 0;
    return [subscription.id, Number.isFinite(publishedAt) ? publishedAt : 0] as const;
  }));
  if (!snapshot.subscriptions.some((subscription) => subscription.latestPublishedAt !== undefined)) {
    for (const article of snapshot.articles) {
      const publishedAt = Date.parse(article.publishedAt);
      if (Number.isFinite(publishedAt)) {
        activityByFeed.set(article.feedId, Math.max(activityByFeed.get(article.feedId) ?? 0, publishedAt));
      }
    }
  }
  const compareSubscriptions = (left: Subscription, right: Subscription) => {
    if (sortOrder === 'recent') {
      const activityDifference = (activityByFeed.get(right.id) ?? 0) - (activityByFeed.get(left.id) ?? 0);
      if (activityDifference !== 0) return activityDifference;
    }
    return titleCollator.compare(left.title, right.title);
  };
  const folderIds = new Set(snapshot.folders.map((folder) => folder.id));
  const visibleSubscriptions = unreadOnly
    ? snapshot.subscriptions.filter((subscription) => subscription.unreadCount > 0)
    : snapshot.subscriptions;
  const groups: FeedGroup[] = snapshot.folders.map((folder) => ({
      ...folder,
      uncategorized: false,
      subscriptions: visibleSubscriptions
        .filter((subscription) => subscription.folderIds.includes(folder.id))
        .sort(compareSubscriptions),
    }))
    .filter((group) => !unreadOnly || group.subscriptions.length > 0);
  const uncategorized = visibleSubscriptions
    .filter((subscription) =>
      subscription.folderIds.length === 0
      || !subscription.folderIds.some((folderId) => folderIds.has(folderId)),
    )
    .sort(compareSubscriptions);

  if (uncategorized.length > 0) {
    groups.push({
      id: UNCATEGORIZED_FOLDER_ID,
      title: 'Uncategorized',
      unreadCount: uncategorized.reduce((count, feed) => count + feed.unreadCount, 0),
      uncategorized: true,
      subscriptions: uncategorized,
    });
  }

  return groups.sort((left, right) => {
    if (sortOrder === 'recent') {
      const newestActivity = (group: FeedGroup) => group.subscriptions.reduce(
        (newest, subscription) => Math.max(newest, activityByFeed.get(subscription.id) ?? 0),
        0,
      );
      const activityDifference = newestActivity(right) - newestActivity(left);
      if (activityDifference !== 0) return activityDifference;
    }
    return titleCollator.compare(left.title, right.title);
  });
}

export function feedFaviconUrl(subscription: Subscription) {
  if (subscription.iconUrl) {
    if (subscription.iconUrl.startsWith('/')) return subscription.iconUrl;
    try {
      const iconUrl = new URL(subscription.iconUrl);
      if (iconUrl.protocol === 'http:' || iconUrl.protocol === 'https:') return iconUrl.toString();
    } catch {
      // Fall through to a favicon derived from the feed's website.
    }
  }

  for (const candidate of [subscription.siteUrl, subscription.url]) {
    if (!candidate) continue;
    try {
      const siteUrl = new URL(candidate);
      if (siteUrl.protocol === 'http:' || siteUrl.protocol === 'https:') {
        return new URL('/favicon.ico', siteUrl.origin).toString();
      }
    } catch {
      // Try the next available URL.
    }
  }

  return null;
}
