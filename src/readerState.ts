import type { ReaderSnapshot } from '../shared/reader';

/**
 * Applies article read-state changes and keeps the derived feed and folder
 * unread counters in step with the article collection.
 */
export function applyReadStates(
  snapshot: ReaderSnapshot,
  states: ReadonlyMap<string, boolean>,
): ReaderSnapshot {
  const subscriptionDeltas = new Map<string, number>();
  const folderDeltas = new Map<string, number>();

  const articles = snapshot.articles.map((article) => {
    const nextRead = states.get(article.id);
    if (nextRead === undefined || nextRead === article.read) return article;

    // Becoming read removes one unread item; becoming unread adds one.
    const delta = nextRead ? -1 : 1;
    subscriptionDeltas.set(article.feedId, (subscriptionDeltas.get(article.feedId) ?? 0) + delta);
    for (const folderId of article.folderIds) {
      folderDeltas.set(folderId, (folderDeltas.get(folderId) ?? 0) + delta);
    }
    return { ...article, read: nextRead };
  });

  return {
    ...snapshot,
    articles,
    subscriptions: snapshot.subscriptions.map((subscription) => ({
      ...subscription,
      unreadCount: Math.max(0, subscription.unreadCount + (subscriptionDeltas.get(subscription.id) ?? 0)),
    })),
    folders: snapshot.folders.map((folder) => ({
      ...folder,
      unreadCount: Math.max(0, folder.unreadCount + (folderDeltas.get(folder.id) ?? 0)),
    })),
  };
}
