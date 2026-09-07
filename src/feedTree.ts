import type { Folder, ReaderSnapshot, Subscription } from '../shared/reader';

export const UNCATEGORIZED_FOLDER_ID = '__uncategorized__';

export type FeedGroup = Folder & {
  uncategorized: boolean;
  subscriptions: Subscription[];
};

export function buildFeedGroups(snapshot: ReaderSnapshot | null): FeedGroup[] {
  if (!snapshot) return [];

  const folderIds = new Set(snapshot.folders.map((folder) => folder.id));
  const groups = snapshot.folders.map((folder) => ({
    ...folder,
    uncategorized: false,
    subscriptions: snapshot.subscriptions.filter((subscription) => subscription.folderIds.includes(folder.id)),
  }));
  const uncategorized = snapshot.subscriptions.filter((subscription) =>
    subscription.folderIds.length === 0
    || !subscription.folderIds.some((folderId) => folderIds.has(folderId)),
  );

  if (uncategorized.length > 0) {
    groups.push({
      id: UNCATEGORIZED_FOLDER_ID,
      title: 'Uncategorized',
      unreadCount: uncategorized.reduce((count, feed) => count + feed.unreadCount, 0),
      uncategorized: true,
      subscriptions: uncategorized,
    });
  }

  return groups;
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
