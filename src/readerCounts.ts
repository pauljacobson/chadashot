import type { ReaderSnapshot, ReaderVersions } from '../shared/reader';
import type { ArticleReadFilter, ReaderFilter } from './useReader';

export type ReaderCountStatus = 'current' | 'last-synced' | 'cached-partial';

export function readerBoundariesMatch(
  expectedGeneration: string | undefined,
  expectedVersions: ReaderVersions,
  actualGeneration: string,
  actualVersions: ReaderVersions,
) {
  return expectedGeneration === actualGeneration
    && expectedVersions.collection === actualVersions.collection
    && expectedVersions.state === actualVersions.state;
}

/**
 * Returns a complete navigation total only when the requested view can be
 * calculated from the same versioned aggregates used by the sidebar.
 */
export function readerScopeTotal(
  snapshot: ReaderSnapshot | null,
  filter: ReaderFilter,
  readFilter: ArticleReadFilter,
  search: string,
) {
  if (!snapshot?.counts || search.trim()) return null;

  let total: number | undefined;
  let unread: number | undefined;
  if (filter.kind === 'inbox') {
    total = snapshot.counts.inbox;
    unread = snapshot.counts.inbox;
  } else if (filter.kind === 'all') {
    total = snapshot.counts.all;
    unread = snapshot.counts.inbox;
  } else if (filter.kind === 'starred') {
    total = snapshot.counts.starred;
  } else if (filter.kind === 'uncategorized') {
    total = snapshot.counts.uncategorized;
  } else {
    const scope = filter.kind === 'folder'
      ? snapshot.folders.find((folder) => folder.id === filter.id)
      : snapshot.subscriptions.find((subscription) => subscription.id === filter.id);
    total = scope?.totalCount;
    unread = scope?.unreadCount;
  }

  if (total === undefined) return null;
  if (readFilter === 'all') return total;
  if (unread === undefined) return null;
  return readFilter === 'unread' ? unread : Math.max(0, total - unread);
}

export function readerCountStatus(
  hasCompleteCount: boolean,
  coverage: { complete: boolean } | null,
  current: boolean,
): ReaderCountStatus {
  if (hasCompleteCount) return current ? 'current' : 'last-synced';
  if (coverage && !coverage.complete) return 'cached-partial';
  return current ? 'current' : 'last-synced';
}
