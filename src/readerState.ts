import type { Article, ArticleMutation, ReaderSnapshot } from '../shared/reader';

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
  let inboxDelta = 0;

  const articles = snapshot.articles.map((article) => {
    const nextRead = states.get(article.id);
    if (nextRead === undefined || nextRead === article.read) return article;

    // Becoming read removes one unread item; becoming unread adds one.
    const delta = nextRead ? -1 : 1;
    inboxDelta += delta;
    subscriptionDeltas.set(article.feedId, (subscriptionDeltas.get(article.feedId) ?? 0) + delta);
    for (const folderId of article.folderIds) {
      folderDeltas.set(folderId, (folderDeltas.get(folderId) ?? 0) + delta);
    }
    return { ...article, read: nextRead };
  });

  return {
    ...snapshot,
    articles,
    ...(snapshot.counts ? { counts: {
      ...snapshot.counts,
      inbox: Math.max(0, snapshot.counts.inbox + inboxDelta),
    } } : {}),
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

/** Applies star changes while keeping the complete Starred scope total aligned. */
export function applyStarredStates(
  snapshot: ReaderSnapshot,
  states: ReadonlyMap<string, boolean>,
): ReaderSnapshot {
  let starredDelta = 0;
  const articles = snapshot.articles.map((article) => {
    const nextStarred = states.get(article.id);
    if (nextStarred === undefined || nextStarred === article.starred) return article;
    starredDelta += nextStarred ? 1 : -1;
    return { ...article, starred: nextStarred };
  });

  return {
    ...snapshot,
    articles,
    ...(snapshot.counts ? { counts: {
      ...snapshot.counts,
      starred: Math.max(0, snapshot.counts.starred + starredDelta),
    } } : {}),
  };
}

/**
 * Applies a mutation even when the visible server page is ahead of the partial
 * device cache. In that case the supplied article still provides the prior
 * state and scope memberships needed to update complete navigation counters.
 */
export function applyArticleMutation(
  snapshot: ReaderSnapshot,
  article: Article,
  mutation: ArticleMutation,
) {
  if (snapshot.articles.some((candidate) => candidate.id === mutation.articleId)) {
    return mutation.operation === 'read'
      ? applyReadStates(snapshot, new Map([[mutation.articleId, mutation.value]]))
      : applyStarredStates(snapshot, new Map([[mutation.articleId, mutation.value]]));
  }

  if (mutation.operation === 'starred') {
    if (article.starred === mutation.value || !snapshot.counts) return snapshot;
    return {
      ...snapshot,
      counts: {
        ...snapshot.counts,
        starred: Math.max(0, snapshot.counts.starred + (mutation.value ? 1 : -1)),
      },
    };
  }

  if (article.read === mutation.value) return snapshot;
  const unreadDelta = mutation.value ? -1 : 1;
  return {
    ...snapshot,
    ...(snapshot.counts ? { counts: {
      ...snapshot.counts,
      inbox: Math.max(0, snapshot.counts.inbox + unreadDelta),
    } } : {}),
    subscriptions: snapshot.subscriptions.map((subscription) => subscription.id === article.feedId ? {
      ...subscription,
      unreadCount: Math.max(0, subscription.unreadCount + unreadDelta),
    } : subscription),
    folders: snapshot.folders.map((folder) => article.folderIds.includes(folder.id) ? {
      ...folder,
      unreadCount: Math.max(0, folder.unreadCount + unreadDelta),
    } : folder),
  };
}
