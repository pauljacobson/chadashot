import DOMPurify from 'dompurify';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AccountSecurityState, AppLogLevel, AppLogResult, Article, IntegrationStatus, SavedHighlight, SessionState, Subscription } from '../shared/reader';
import {
  appLogExportUrl,
  connectBirchfeed,
  connectReadwise,
  createReadwiseHighlight,
  disconnectReadwise,
  disconnectRssService,
  getAccountSecurity,
  getAdditionalPasskeyOptions,
  getArticleHighlights,
  getBootstrapOptions,
  getAppLogs,
  getIntegrationStatus,
  getLoginOptions,
  getSession,
  logout,
  recoverAccount,
  regenerateRecoveryCodes,
  removePasskey,
  saveReadwiseDocument,
  subscribeToFeed,
  verifyBootstrap,
  verifyAdditionalPasskey,
  verifyLogin,
} from './api';
import { type ArticleReadFilter, type ReaderFilter, type SyncStatus, useReader } from './useReader';
import { buildFeedGroups, type FeedSortOrder, feedFaviconUrl } from './feedTree';
import {
  clearOfflineData,
  loadOfflineSession,
  offlineStorageSummary,
  saveOfflineSession,
} from './offlineStore';
import { finishArticleOpen, finishSelectionUpdate, markMilestone, recordMountedRows, startArticleOpen, startSelectionUpdate } from './performance';

type ContentView = 'list' | 'reader';
const FEED_SORT_ORDER_KEY = 'chadashot.feedSortOrder';
const ACCENT_COLOR_KEY = 'chadashot.accentColor';
const PANEL_WIDTHS_KEY = 'chadashot.panelWidths';
const DEFAULT_PANEL_WIDTHS = { sidebar: 220 };
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_READER_WIDTH = 300;
const PANEL_RESIZER_WIDTH = 10;
const ARTICLE_ROW_ESTIMATE = 116;
const ARTICLE_ROW_OVERSCAN = 12;
const articleListScrollPositions = new Map<string, number>();

type PanelWidths = typeof DEFAULT_PANEL_WIDTHS;
const ACCENT_COLORS = [
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'amber', label: 'Amber' },
  { id: 'rose', label: 'Rose' },
] as const;
type AccentColor = (typeof ACCENT_COLORS)[number]['id'];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function savedPanelWidths(): PanelWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? '') as Partial<PanelWidths>;
    return {
      sidebar: clamp(Number(saved.sidebar) || DEFAULT_PANEL_WIDTHS.sidebar, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    };
  } catch {
    return DEFAULT_PANEL_WIDTHS;
  }
}

function fitPanelWidths(widths: PanelWidths, availableWidth: number): PanelWidths {
  if (availableWidth <= 0) return widths;
  const maximum = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, availableWidth - MIN_READER_WIDTH - PANEL_RESIZER_WIDTH),
  );
  return { sidebar: clamp(widths.sidebar, MIN_SIDEBAR_WIDTH, maximum) };
}

function PanelResizer({ className, label, controls, value, minimum, maximum, defaultValue, onResize }: {
  className: string;
  label: string;
  controls: string;
  value: number;
  minimum: number;
  maximum: number;
  defaultValue: number;
  onResize: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => () => document.body.classList.remove('panel-resizing'), []);

  function finishResize(element: HTMLDivElement, pointerId: number) {
    if (drag.current?.pointerId !== pointerId) return;
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    drag.current = null;
    document.body.classList.remove('panel-resizing');
  }

  return (
    <div
      className={`panel-resizer ${className}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} pixels`}
      title="Drag to resize. Double-click to reset."
      onDoubleClick={() => onResize(defaultValue)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') onResize(clamp(value - step, minimum, maximum));
        else if (event.key === 'ArrowRight') onResize(clamp(value + step, minimum, maximum));
        else if (event.key === 'Home') onResize(minimum);
        else if (event.key === 'End') onResize(maximum);
        else if (event.key === 'Enter') onResize(defaultValue);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: value };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('panel-resizing');
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        onResize(clamp(drag.current.startWidth + event.clientX - drag.current.startX, minimum, maximum));
      }}
      onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId)}
    >
      <span aria-hidden="true" />
    </div>
  );
}

function savedFeedSortOrder(): FeedSortOrder {
  try {
    return localStorage.getItem(FEED_SORT_ORDER_KEY) === 'recent' ? 'recent' : 'alphabetical';
  } catch {
    return 'alphabetical';
  }
}

function savedAccentColor(): AccentColor {
  try {
    const saved = localStorage.getItem(ACCENT_COLOR_KEY);
    return ACCENT_COLORS.some((color) => color.id === saved) ? saved as AccentColor : 'green';
  } catch {
    return 'green';
  }
}

const filterLabels: Record<ReaderFilter['kind'], string> = {
  inbox: 'Inbox',
  all: 'All articles',
  starred: 'Starred',
  uncategorized: 'Uncategorized',
  folder: 'Folder',
  feed: 'Feed',
};

function formatAge(publishedAt: string) {
  const difference = Date.now() - new Date(publishedAt).getTime();
  const minutes = Math.max(1, Math.floor(difference / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function syncLabel(status: SyncStatus, pendingMutations = 0) {
  const base = status === 'syncing'
    ? 'Syncing'
    : status === 'offline'
      ? 'Offline'
      : status === 'error'
        ? 'Action needed'
        : 'Up to date';
  return pendingMutations > 0 ? `${base} · ${pendingMutations} pending` : base;
}

function FeedIcon({ subscription }: { subscription: Subscription }) {
  const source = feedFaviconUrl(subscription);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (!source || failedSource === source) {
    return (
      <span className="feed-icon feed-icon-fallback" aria-hidden="true">
        <svg viewBox="0 0 16 16" focusable="false"><circle cx="4" cy="12" r="1.4"/><path d="M3 7a6 6 0 0 1 6 6M3 3a10 10 0 0 1 10 10"/></svg>
      </span>
    );
  }

  return <img className="feed-icon" src={source} alt="" aria-hidden="true" loading="lazy" onError={() => setFailedSource(source)} />;
}

function FeedTree({ snapshot, filter, unreadOnly, sortOrder, onFilter, onSubscribe, onFeedSelection, onUnreadOnlyChange, showHeading = true }: {
  snapshot: ReturnType<typeof useReader>['snapshot'];
  filter: ReaderFilter;
  unreadOnly: boolean;
  sortOrder: FeedSortOrder;
  onFilter: (filter: ReaderFilter) => void;
  onSubscribe: () => void;
  onFeedSelection?: () => void;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  showHeading?: boolean;
}) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const feedGroups = buildFeedGroups(snapshot, { unreadOnly, sortOrder });

  function toggleFolder(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function folderGroup(folder: (typeof feedGroups)[number]) {
    const expanded = expandedFolders.has(folder.id);
    const active = folder.uncategorized
      ? filter.kind === 'uncategorized'
      : filter.kind === 'folder' && filter.id === folder.id;
    return (
      <div className="feed-tree-folder" key={folder.id}>
        <button
          className={`nav-item folder-item ${active ? 'active' : ''}`}
          aria-expanded={expanded}
          onClick={() => {
            toggleFolder(folder.id);
            onFilter(folder.uncategorized ? { kind: 'uncategorized' } : { kind: 'folder', id: folder.id });
          }}
        >
          <span className="folder-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span><span>{folder.title}</span><span className="nav-count">{folder.unreadCount}</span>
        </button>
        {expanded && (
          <div className="nested-feeds">
            {folder.subscriptions.length === 0 ? <div className="empty-folder">No feeds</div> : folder.subscriptions.map((subscription) => (
              <button key={subscription.id} className={`nav-item nested-feed ${filter.kind === 'feed' && filter.id === subscription.id ? 'active' : ''}`} onClick={() => { onFilter({ kind: 'feed', id: subscription.id }); onFeedSelection?.(); }}>
                <FeedIcon subscription={subscription} /><span>{subscription.title}</span>{subscription.unreadCount > 0 && <span className="nav-count">{subscription.unreadCount}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="nav-group feeds-group">
      {showHeading && <div className="nav-heading-row"><div className="nav-heading">Feeds</div><button aria-label="Add feed" onClick={onSubscribe}>＋</button></div>}
      <label className="feed-filter-toggle">
        <span>Unread feeds only</span>
        <span className="toggle-control">
          <input type="checkbox" role="switch" checked={unreadOnly} onChange={(event) => onUnreadOnlyChange(event.target.checked)} />
          <span className="toggle-track" aria-hidden="true"><span /></span>
        </span>
      </label>
      {feedGroups.length > 0 ? feedGroups.map(folderGroup) : <div className="empty-feed-tree">No feeds with unread items.</div>}
    </div>
  );
}

function Navigation({
  snapshot,
  filter,
  onFilter,
  onSettings,
  onSubscribe,
  unreadOnly,
  sortOrder,
  onUnreadOnlyChange,
  status,
}: {
  snapshot: ReturnType<typeof useReader>['snapshot'];
  filter: ReaderFilter;
  onFilter: (filter: ReaderFilter) => void;
  onSettings: () => void;
  onSubscribe: () => void;
  unreadOnly: boolean;
  sortOrder: FeedSortOrder;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  status: SyncStatus;
}) {
  const unread = snapshot?.articles.filter((article) => !article.read).length ?? 0;
  return (
    <aside className="sidebar" id="reader-sidebar">
      <nav aria-label="Reader navigation">
        <div className="nav-group">
          <button className={`nav-item ${filter.kind === 'inbox' ? 'active' : ''}`} onClick={() => onFilter({ kind: 'inbox' })}>
            <span aria-hidden="true">●</span><span>Inbox</span><span className="nav-count">{unread}</span>
          </button>
          <button className={`nav-item ${filter.kind === 'all' ? 'active' : ''}`} onClick={() => onFilter({ kind: 'all' })}>
            <span aria-hidden="true">○</span><span>All articles</span>
          </button>
          <button className={`nav-item ${filter.kind === 'starred' ? 'active' : ''}`} onClick={() => onFilter({ kind: 'starred' })}>
            <span aria-hidden="true">☆</span><span>Starred</span>
          </button>
        </div>
        <FeedTree snapshot={snapshot} filter={filter} unreadOnly={unreadOnly} sortOrder={sortOrder} onFilter={onFilter} onSubscribe={onSubscribe} onUnreadOnlyChange={onUnreadOnlyChange} />
      </nav>
      <div className="connection-status">
        <span className={`status-dot ${status}`}></span>{syncLabel(status)}
        <button onClick={onSettings}>Settings</button>
      </div>
    </aside>
  );
}

function MobileFeedsPanel({ snapshot, filter, unreadOnly, sortOrder, onFilter, onSubscribe, onUnreadOnlyChange, onClose }: {
  snapshot: ReturnType<typeof useReader>['snapshot'];
  filter: ReaderFilter;
  unreadOnly: boolean;
  sortOrder: FeedSortOrder;
  onFilter: (filter: ReaderFilter) => void;
  onSubscribe: () => void;
  onUnreadOnlyChange: (unreadOnly: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="mobile-feeds-panel" role="dialog" aria-modal="true" aria-labelledby="mobile-feeds-title">
        <header><h1 id="mobile-feeds-title">Feeds</h1><button onClick={onSubscribe}>＋ Add feed</button><button aria-label="Close feeds" onClick={onClose}>×</button></header>
        <FeedTree snapshot={snapshot} filter={filter} unreadOnly={unreadOnly} sortOrder={sortOrder} onFilter={onFilter} onFeedSelection={onClose} onSubscribe={onSubscribe} onUnreadOnlyChange={onUnreadOnlyChange} showHeading={false} />
      </section>
    </div>
  );
}

function SubscribePanel({ onClose, onSubscribed }: { onClose: () => void; onSubscribed: (feedUrl: string) => Promise<void> }) {
  const [feedUrl, setFeedUrl] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubscribing(true);
    setError(null);
    try {
      await onSubscribed(feedUrl);
      onClose();
    } catch (subscriptionError) {
      setError(subscriptionError instanceof Error ? subscriptionError.message : 'Could not add feed');
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="subscribe-panel" role="dialog" aria-modal="true" aria-labelledby="subscribe-title">
        <header><div><div className="eyebrow">Subscription</div><h1 id="subscribe-title">Add a feed</h1></div><button aria-label="Close add feed" onClick={onClose}>×</button></header>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor="feed-url">Feed or website URL</label>
          <input id="feed-url" type="url" inputMode="url" autoCapitalize="none" spellCheck={false} autoFocus required value={feedUrl} onChange={(event) => setFeedUrl(event.target.value)} placeholder="https://example.com/feed.xml" />
          <p>The connected RSS service will discover and subscribe to the feed.</p>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="dialog-actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary-action" disabled={subscribing || !feedUrl} type="submit">{subscribing ? 'Adding…' : 'Add feed'}</button></div>
        </form>
      </section>
    </div>
  );
}

export function ArticleList({
  listKey,
  title,
  articles,
  readFilter,
  showReadFilter = true,
  markAllCount = 0,
  selectedId,
  onSelect,
  onToggleRead,
  onToggleStar,
  onReadFilterChange,
  onMarkAllRead,
  onLoadMore,
  total = articles.length,
}: {
  listKey: string;
  title: string;
  articles: Article[];
  readFilter: ArticleReadFilter;
  showReadFilter?: boolean;
  markAllCount?: number;
  selectedId: string | null;
  onSelect: (article: Article) => void;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onReadFilterChange: (filter: ArticleReadFilter) => void;
  onMarkAllRead?: () => Promise<number>;
  onLoadMore?: () => void;
  total?: number;
}) {
  const [confirmingMarkAll, setConfirmingMarkAll] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listHasFocus = useRef(false);
  const unreadCount = markAllCount;
  const articleIndex = useMemo(() => new Map(articles.map((article, index) => [article.id, index])), [articles]);
  const rowVirtualizer = useVirtualizer({
    count: articles.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ARTICLE_ROW_ESTIMATE,
    getItemKey: (index) => articles[index]?.id ?? index,
    overscan: ARTICLE_ROW_OVERSCAN,
    useFlushSync: false,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();

  useLayoutEffect(() => {
    recordMountedRows(listRef.current?.querySelectorAll('.article-row').length ?? 0);
  }, [virtualRows]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const savedOffset = articleListScrollPositions.get(listKey);
    if (scrollElement && savedOffset !== undefined) scrollElement.scrollTop = savedOffset;
    return () => {
      articleListScrollPositions.set(listKey, scrollElement?.scrollTop ?? 0);
    };
  }, [listKey]);

  useLayoutEffect(() => {
    if (!selectedId) return;
    const index = articleIndex.get(selectedId);
    if (index === undefined) return;
    rowVirtualizer.scrollToIndex(index, { align: 'auto' });
    finishSelectionUpdate();
    if (listHasFocus.current) {
      window.requestAnimationFrame(() => {
        scrollRef.current
          ?.querySelector<HTMLButtonElement>(`[data-virtual-index="${index}"] .article-main-action`)
          ?.focus({ preventScroll: true });
      });
    }
  }, [articleIndex, rowVirtualizer, selectedId]);

  useEffect(() => {
    const finalRow = virtualRows.at(-1);
    if (finalRow && finalRow.index >= articles.length - 10 && articles.length < total) onLoadMore?.();
  }, [articles.length, onLoadMore, total, virtualRows]);

  async function confirmMarkAllRead() {
    if (!onMarkAllRead || markingAll) return;
    setMarkingAll(true);
    try {
      await onMarkAllRead();
      setConfirmingMarkAll(false);
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <section ref={listRef} className="article-list" id="article-list" aria-label={`${title} articles`}>
      <header className="list-header">
        <div className="list-heading"><h1>{title}</h1><span>{total}</span></div>
        {showReadFilter && (
          <div className="article-read-filter" role="group" aria-label="Filter articles by read status">
            {(['all', 'unread', 'read'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                aria-pressed={readFilter === filter}
                onClick={() => onReadFilterChange(filter)}
              >
                {filter[0]!.toUpperCase() + filter.slice(1)}
              </button>
            ))}
          </div>
        )}
        {onMarkAllRead && unreadCount > 0 && (
          <button className="mark-all-button" onClick={() => setConfirmingMarkAll(true)}>✓ Mark all read</button>
        )}
      </header>
      {confirmingMarkAll && unreadCount > 0 && (
        <div className="mark-all-confirmation" role="alertdialog" aria-label="Confirm mark all read">
          <span>Mark {unreadCount} unread {unreadCount === 1 ? 'item' : 'items'} in this view as read?</span>
          <div>
            <button disabled={markingAll} onClick={() => setConfirmingMarkAll(false)}>Cancel</button>
            <button className="primary-action" disabled={markingAll} onClick={() => void confirmMarkAllRead()}>{markingAll ? 'Marking…' : 'Mark all read'}</button>
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        className="article-list-scroll"
        role="list"
        aria-label={`${title} results`}
        onFocusCapture={() => { listHasFocus.current = true; }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) listHasFocus.current = false;
        }}
      >
        {articles.length === 0 ? <div className="empty-list">Nothing here right now.</div> : (
          <div className="article-list-window" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {virtualRows.map((virtualRow) => {
              const article = articles[virtualRow.index]!;
              return (
                <article
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-virtual-index={virtualRow.index}
                  role="listitem"
                  aria-posinset={virtualRow.index + 1}
                  aria-setsize={total}
                  className={`article-row ${selectedId === article.id ? 'active' : ''} ${article.read ? 'read' : ''}`}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <button className="article-main-action" aria-current={selectedId === article.id ? 'true' : undefined} tabIndex={selectedId === article.id ? 0 : -1} onClick={() => onSelect(article)}>
                    <div className="article-meta"><strong>{article.source}</strong><span>· {article.readingMinutes} min</span><time>{formatAge(article.publishedAt)}</time></div>
                    <h2>{article.title}</h2>
                    <p>{article.summary}</p>
                  </button>
                  <button className="row-read" title={article.read ? 'Mark unread' : 'Mark read'} aria-label={article.read ? 'Mark article unread' : 'Mark article read'} aria-pressed={article.read} onClick={() => onToggleRead(article)}>
                    {article.read ? '○' : '●'}
                  </button>
                  <button className="row-star" aria-label={article.starred ? 'Remove star' : 'Star article'} aria-pressed={article.starred} onClick={() => onToggleStar(article)}>
                    {article.starred ? '★' : '☆'}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

type SelectionAnchor = {
  text: string;
  startOffset: number;
  endOffset: number;
};

type MediaLightboxState = {
  src: string;
  alt: string;
  caption: string;
};

function renderHighlightMarks(root: HTMLElement, highlights: SavedHighlight[]) {
  root.querySelectorAll('mark[data-chadashot-highlight]').forEach((mark) => mark.replaceWith(...mark.childNodes));
  root.normalize();

  for (const highlight of [...highlights].sort((first, second) => second.startOffset - first.startOffset)) {
    if (highlight.startOffset < 0 || highlight.endOffset <= highlight.startOffset || highlight.endOffset > (root.textContent?.length ?? 0)) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const segments: { node: Text; start: number; end: number }[] = [];
    let documentOffset = 0;
    let node = walker.nextNode();
    while (node) {
      const textNode = node as Text;
      const nodeEnd = documentOffset + textNode.data.length;
      const start = Math.max(highlight.startOffset, documentOffset) - documentOffset;
      const end = Math.min(highlight.endOffset, nodeEnd) - documentOffset;
      if (start < end) segments.push({ node: textNode, start, end });
      documentOffset = nodeEnd;
      node = walker.nextNode();
    }

    for (const segment of segments.reverse()) {
      const range = document.createRange();
      range.setStart(segment.node, segment.start);
      range.setEnd(segment.node, segment.end);
      const mark = document.createElement('mark');
      mark.dataset.chadashotHighlight = highlight.id;
      mark.dataset.syncStatus = highlight.readwiseStatus;
      if (highlight.readwiseError) mark.title = highlight.readwiseError;
      range.surroundContents(mark);
    }
  }
}

function prepareArticleMedia(root: HTMLElement) {
  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    const description = image.alt.trim() || 'article image';
    image.dataset.chadashotMedia = 'image';

    if (!image.closest('.article-media-frame')) {
      const mediaElement = image.parentElement instanceof HTMLPictureElement ? image.parentElement : image;
      const frame = document.createElement('span');
      frame.className = 'article-media-frame';
      mediaElement.replaceWith(frame);
      frame.append(mediaElement);
    }

    const trigger = image.closest<HTMLAnchorElement>('a[href]')
      ?? image.closest<HTMLElement>('.article-media-frame');
    if (!trigger) return;
    trigger.dataset.chadashotMediaTrigger = 'image';
    trigger.tabIndex = 0;
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-label', `View ${description} larger`);
  });
}

export function ReaderPane({
  article,
  position,
  total,
  hasPrevious,
  hasNext,
  onClose,
  onPrevious,
  onNext,
  onToggleStar,
  onToggleRead,
  onNotify,
  onHighlight,
  onSaveToReader,
}: {
  article: Article | null;
  position: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleStar: (article: Article) => void;
  onToggleRead: (article: Article) => void;
  onNotify: (message: string) => void;
  onHighlight: (article: Article, selection: SelectionAnchor, note?: string) => Promise<{ highlight: SavedHighlight; synchronized: boolean; warning?: string }>;
  onSaveToReader: (article: Article) => Promise<void>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const lightboxCloseRef = useRef<HTMLButtonElement>(null);
  const lightboxTriggerRef = useRef<HTMLElement | null>(null);
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [highlights, setHighlights] = useState<SavedHighlight[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [savingAction, setSavingAction] = useState<'highlight' | 'document' | null>(null);
  const [lightbox, setLightbox] = useState<MediaLightboxState | null>(null);
  const articleId = article?.id;
  const sanitized = useMemo(() => DOMPurify.sanitize(article?.contentHtml ?? ''), [article?.contentHtml]);
  const sanitizedMarkup = useMemo(() => ({ __html: sanitized }), [sanitized]);

  useEffect(() => {
    setHighlights([]);
    if (!article) return;
    const controller = new AbortController();
    getArticleHighlights(article.id, controller.signal)
      .then((result) => setHighlights(result.highlights))
      .catch(() => undefined);
    return () => controller.abort();
  }, [article]);

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    renderHighlightMarks(contentRef.current, highlights);
    prepareArticleMedia(contentRef.current);
  }, [highlights, sanitized]);

  useEffect(() => {
    if (!lightbox) return;
    const trigger = lightboxTriggerRef.current;
    lightboxCloseRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setLightbox(null);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        lightboxCloseRef.current?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [lightbox]);

  useEffect(() => {
    setLightbox(null);
  }, [articleId]);

  useLayoutEffect(() => {
    if (!articleId || !contentRef.current) return;
    finishArticleOpen();
    window.requestAnimationFrame(() => markMilestone('first-article'));
  }, [articleId, sanitized]);

  function captureSelection() {
    const current = window.getSelection();
    if (!current || current.isCollapsed || !contentRef.current) {
      setSelection(null);
      return;
    }
    const range = current.getRangeAt(0);
    if (!contentRef.current.contains(range.startContainer) || !contentRef.current.contains(range.endContainer)) return;
    const rawText = current.toString();
    const text = rawText.trim().slice(0, 8191);
    if (!text) {
      setSelection(null);
      return;
    }
    const leadingWhitespace = rawText.length - rawText.trimStart().length;
    const prefix = document.createRange();
    prefix.selectNodeContents(contentRef.current);
    prefix.setEnd(range.startContainer, range.startOffset);
    const startOffset = prefix.toString().length + leadingWhitespace;
    setSelection({ text, startOffset, endOffset: startOffset + text.length });
  }

  async function saveHighlight() {
    if (!selection || !article) return;
    setSavingAction('highlight');
    try {
      const result = await onHighlight(article, selection, note || undefined);
      setHighlights((current) => [...current.filter((highlight) => highlight.id !== result.highlight.id), result.highlight]);
      if (result.warning) onNotify(`Highlight kept in Chadashot. ${result.warning}`);
      setNoteOpen(false);
      setSelection(null);
      setNote('');
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not save highlight');
    } finally {
      setSavingAction(null);
    }
  }

  async function saveDocument() {
    if (!article) return;
    setSavingAction('document');
    try {
      await onSaveToReader(article);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not save to Reader');
    } finally {
      setSavingAction(null);
    }
  }

  function openMediaFromTarget(target: EventTarget | null) {
    const trigger = target instanceof Element
      ? target.closest<HTMLElement>('[data-chadashot-media-trigger="image"]')
      : null;
    if (!trigger || !contentRef.current?.contains(trigger)) return false;
    const image = trigger instanceof HTMLImageElement
      ? trigger
      : trigger.querySelector<HTMLImageElement>('img[data-chadashot-media="image"]');
    if (!image) return false;

    const src = image.currentSrc || image.src;
    if (!src) return false;
    const caption = image.closest('figure')?.querySelector('figcaption')?.textContent?.trim()
      || image.alt.trim()
      || article?.title
      || 'Article image';
    lightboxTriggerRef.current = trigger;
    setLightbox({ src, alt: image.alt.trim(), caption });
    return true;
  }

  if (!article) {
    return <main className="reader-pane empty-reader" id="reader-pane"><div><strong>Select an article</strong><span>Choose something from the list to begin reading.</span></div></main>;
  }

  return (
    <main className="reader-pane" id="reader-pane">
      <header className="reader-toolbar">
        <button className="reader-close" aria-label="Close article and return to article list" onClick={onClose}>
          <span aria-hidden="true">←</span><span className="button-label">All items</span>
        </button>
        <div className="reader-navigation" role="group" aria-label="Article navigation">
          <button aria-label="Previous article" disabled={!hasPrevious} onClick={onPrevious}>
            <span aria-hidden="true">←</span><span className="button-label">Previous</span>
          </button>
          <span className="reader-position" aria-live="polite">{position} of {total}</span>
          <button aria-label="Next article" disabled={!hasNext} onClick={onNext}>
            <span className="button-label">Next</span><span aria-hidden="true">→</span>
          </button>
        </div>
        <span className="toolbar-spacer"></span>
        <div className="reader-actions">
          <button aria-label={article.read ? 'Mark unread' : 'Mark read'} onClick={() => onToggleRead(article)}>
            <span aria-hidden="true">{article.read ? '○' : '●'}</span><span className="button-label">{article.read ? 'Unread' : 'Read'}</span>
          </button>
          <button aria-label={article.starred ? 'Remove star' : 'Star article'} aria-pressed={article.starred} onClick={() => onToggleStar(article)}>
            <span aria-hidden="true">{article.starred ? '★' : '☆'}</span><span className="button-label">{article.starred ? 'Starred' : 'Star'}</span>
          </button>
          <button className="save-reader-action" disabled={savingAction !== null} onClick={() => void saveDocument()}>
            <span aria-hidden="true">↗</span><span className="button-label">{savingAction === 'document' ? 'Saving…' : 'Save to Reader'}</span>
          </button>
          <a className="toolbar-link" href={article.canonicalUrl} target="_blank" rel="noreferrer">
            <span aria-hidden="true">↗</span><span className="button-label">Open original</span>
          </a>
        </div>
      </header>
      <div className="reading-scroll">
        <article className="reading-column">
          <div className="article-source">{article.source}</div>
          <h1>{article.title}</h1>
          <div className="byline">{article.author ?? article.source} · {new Date(article.publishedAt).toLocaleDateString()} · {article.readingMinutes} min read</div>
          <div className="article-rule"></div>
          {sanitized ? (
            <div
              ref={contentRef}
              className="article-content"
              onMouseUp={captureSelection}
              onTouchEnd={captureSelection}
              onClick={(event) => {
                if (!openMediaFromTarget(event.target)) return;
                event.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                if (!openMediaFromTarget(event.target)) return;
                event.preventDefault();
              }}
              dangerouslySetInnerHTML={sanitizedMarkup}
            />
          ) : (
            <div ref={contentRef} className="article-content article-content-missing" role="status">
              Article content is not cached yet. Chadashot will load it when a connection is available.
            </div>
          )}
        </article>
      </div>
      {selection && (
        <div className="selection-panel" role="toolbar" aria-label="Selected text actions">
          <div className="selection-preview">“{selection.text}”</div>
          {noteOpen && <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why does this matter?" aria-label="Highlight note" autoFocus />}
          <div className="selection-actions">
            <button className="primary-action" disabled={savingAction !== null} onClick={() => void saveHighlight()}>{savingAction === 'highlight' ? 'Saving…' : noteOpen ? 'Save highlight + note' : 'Highlight'}</button>
            {!noteOpen && <button onClick={() => setNoteOpen(true)}>Add note</button>}
            <button onClick={() => { void navigator.clipboard.writeText(selection.text); onNotify('Copied selection'); }}>Copy</button>
            <button aria-label="Close selection actions" onClick={() => setSelection(null)}>×</button>
          </div>
        </div>
      )}
      {lightbox && (
        <div
          className="media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-labelledby="media-lightbox-caption"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setLightbox(null);
          }}
        >
          <figure className="media-lightbox-frame">
            <button ref={lightboxCloseRef} className="media-lightbox-close" aria-label="Close enlarged image" onClick={() => setLightbox(null)}>× Close</button>
            <div className="media-lightbox-image-area">
              <img className="media-lightbox-image" src={lightbox.src} alt={lightbox.alt} />
            </div>
            <figcaption id="media-lightbox-caption">{lightbox.caption}</figcaption>
          </figure>
        </div>
      )}
    </main>
  );
}

function PreferencesPanel({ sortOrder, accentColor, onSortOrderChange, onAccentColorChange, onClose }: {
  sortOrder: FeedSortOrder;
  accentColor: AccentColor;
  onSortOrderChange: (sortOrder: FeedSortOrder) => void;
  onAccentColorChange: (accentColor: AccentColor) => void;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="preferences-panel" role="dialog" aria-modal="true" aria-labelledby="preferences-title">
        <header><div><div className="eyebrow">Chadashot</div><h1 id="preferences-title">Preferences</h1></div><button aria-label="Close preferences" onClick={onClose}>×</button></header>
        <div className="setting-section">
          <h2>Feed organization</h2>
          <fieldset className="preference-options">
            <legend>Folder and feed order</legend>
            <label className="preference-option">
              <input type="radio" name="feed-sort-order" value="alphabetical" checked={sortOrder === 'alphabetical'} onChange={() => onSortOrderChange('alphabetical')} />
              <span><strong>Alphabetical</strong><small>Sort folders and the feeds inside them from A to Z.</small></span>
            </label>
            <label className="preference-option">
              <input type="radio" name="feed-sort-order" value="recent" checked={sortOrder === 'recent'} onChange={() => onSortOrderChange('recent')} />
              <span><strong>Most recent</strong><small>Put the folders and feeds with the newest synchronized articles first.</small></span>
            </label>
          </fieldset>
        </div>
        <div className="setting-section">
          <h2>Appearance</h2>
          <div className="setting-line"><div><strong>Follow system</strong><span>The interface changes with the device light or dark theme.</span></div><span className="setting-state">Automatic</span></div>
          <fieldset className="accent-options">
            <legend>Accent color</legend>
            <div className="accent-grid">
              {ACCENT_COLORS.map((color) => (
                <label className={`accent-option accent-option-${color.id}`} key={color.id}>
                  <input type="radio" name="accent-color" value={color.id} checked={accentColor === color.id} onChange={() => onAccentColorChange(color.id)} />
                  <span className="accent-swatch" aria-hidden="true"><span>✓</span></span>
                  <span>{color.label}</span>
                </label>
              ))}
            </div>
            <small>Each option uses separate light and dark colors for readable text and controls.</small>
          </fieldset>
        </div>
        <p className="preferences-note">Preferences are saved in this browser.</p>
      </section>
    </div>
  );
}

function formatLogFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LogsPanel({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<AppLogResult | null>(null);
  const [level, setLevel] = useState<AppLogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getAppLogs({
      ...(level === 'all' ? {} : { level }),
      ...(appliedSearch ? { search: appliedSearch } : {}),
    }, controller.signal)
      .then((logsResult) => {
        setResult(logsResult);
        setError(null);
      })
      .catch((logsError: unknown) => {
        if (!controller.signal.aborted) setError(logsError instanceof Error ? logsError.message : 'Could not load application logs');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [level, appliedSearch, refreshKey]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(() => setRefreshKey((current) => current + 1), 15_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="logs-panel" role="dialog" aria-modal="true" aria-labelledby="logs-title">
        <header>
          <div><div className="eyebrow">Settings</div><h1 id="logs-title">Application logs</h1><p>Review recent activity and errors without exposing stored credentials.</p></div>
          <button aria-label="Back to settings" onClick={onClose}>×</button>
        </header>
        {error && <div className="settings-error-banner" role="alert"><strong>Logs unavailable</strong><span>{error}</span></div>}
        <div className="log-summary" aria-label="Log summary">
          {(['error', 'warn', 'info', 'debug'] as const).map((summaryLevel) => (
            <div key={summaryLevel}><strong>{result?.stats[summaryLevel] ?? 0}</strong><span>{summaryLevel}</span></div>
          ))}
          <div><strong>{formatLogFileSize(result?.stats.fileSizeBytes ?? 0)}</strong><span>stored</span></div>
        </div>
        <form className="log-controls" onSubmit={(event) => {
          event.preventDefault();
          setLoading(true);
          setError(null);
          setAppliedSearch(search.trim());
          setRefreshKey((current) => current + 1);
        }}>
          <label>Level
            <select value={level} onChange={(event) => {
              setLoading(true);
              setError(null);
              setLevel(event.target.value as AppLogLevel | 'all');
            }}>
              <option value="all">All levels</option>
              <option value="error">Errors</option>
              <option value="warn">Warnings</option>
              <option value="info">Information</option>
              <option value="debug">Debug</option>
            </select>
          </label>
          <label className="log-search">Search
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Message, path, or request ID" />
          </label>
          <button type="submit">Search</button>
          <button type="button" onClick={() => {
            setLoading(true);
            setError(null);
            setRefreshKey((current) => current + 1);
          }} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </form>
        <div className="log-options">
          <label><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> Refresh every 15 seconds</label>
          <span>{result ? `Showing ${result.entries.length} of ${result.total}` : 'Loading logs…'}</span>
        </div>
        <div className="log-list" aria-live="polite" aria-busy={loading}>
          {!loading && !error && result?.entries.length === 0 && <div className="empty-logs"><strong>No matching logs</strong><span>Try another level or search term.</span></div>}
          {result?.entries.map((entry, index) => (
            <article className={`log-entry log-entry-${entry.level}`} key={`${entry.timestamp}-${entry.requestId ?? index}`}>
              <div className="log-entry-main">
                <span className="log-level">{entry.level}</span>
                <strong>{entry.message}</strong>
                <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>
              </div>
              {(entry.method || entry.path || entry.error) && (
                <div className="log-entry-context">
                  {entry.method && <span>{entry.method}</span>}
                  {entry.path && <code>{entry.path}</code>}
                  {entry.error && <span>{entry.error.message}</span>}
                </div>
              )}
              {(entry.data || entry.error?.stack || entry.requestId) && (
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify({ requestId: entry.requestId, userId: entry.userId, error: entry.error, data: entry.data }, null, 2)}</pre>
                </details>
              )}
            </article>
          ))}
        </div>
        <footer>
          <span>Logs are stored on this server and trimmed automatically.</span>
          <a href={appLogExportUrl} download>Download NDJSON</a>
        </footer>
      </section>
    </div>
  );
}

function downloadRecoveryCodes(codes: string[]) {
  const blob = new Blob([
    `Chadashot recovery codes\n\nEach code works once. Store these somewhere private.\n\n${codes.join('\n')}\n`,
  ], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'chadashot-recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}

function RecoveryCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="recovery-codes-view">
      <div className="recovery-warning" role="alert"><strong>Save these recovery codes now</strong><span>They are shown only once. Each code can sign you in one time if your passkeys are unavailable.</span></div>
      <ol>{codes.map((code) => <li key={code}><code>{code}</code></li>)}</ol>
      <div className="recovery-actions">
        <button type="button" onClick={() => {
          void navigator.clipboard.writeText(codes.join('\n')).then(() => setCopied(true));
        }}>{copied ? 'Copied' : 'Copy codes'}</button>
        <button type="button" onClick={() => downloadRecoveryCodes(codes)}>Download</button>
        <button className="primary-action" type="button" onClick={onDone}>I saved these codes</button>
      </div>
    </div>
  );
}

export function AccountSecurityPanel({ onClose }: { onClose: () => void }) {
  const [security, setSecurity] = useState<AccountSecurityState | null>(null);
  const [passkeyName, setPasskeyName] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshSecurity() {
    setSecurity(await getAccountSecurity());
  }

  useEffect(() => {
    const controller = new AbortController();
    getAccountSecurity(controller.signal).then(setSecurity).catch((securityError: unknown) => {
      if (!controller.signal.aborted) setError(securityError instanceof Error ? securityError.message : 'Could not load account security');
    });
    return () => controller.abort();
  }, []);

  async function addPasskey() {
    if (!passkeyName.trim()) return;
    setWorking('add');
    setError(null);
    try {
      const pending = await getAdditionalPasskeyOptions(passkeyName.trim());
      const credential = await startRegistration({ optionsJSON: pending.options });
      await verifyAdditionalPasskey(pending.challengeId, credential);
      setPasskeyName('');
      await refreshSecurity();
    } catch (passkeyError) {
      setError(passkeyError instanceof Error ? passkeyError.message : 'Could not register passkey');
    } finally {
      setWorking(null);
    }
  }

  async function deletePasskey(credentialId: string, name: string) {
    if (!window.confirm(`Remove “${name}”? You will no longer be able to sign in with that passkey.`)) return;
    setWorking(credentialId);
    setError(null);
    try {
      await removePasskey(credentialId);
      await refreshSecurity();
    } catch (passkeyError) {
      setError(passkeyError instanceof Error ? passkeyError.message : 'Could not remove passkey');
    } finally {
      setWorking(null);
    }
  }

  async function createNewRecoveryCodes() {
    if (security?.recoveryCodesRemaining && !window.confirm('Generate new recovery codes? Every existing unused code will stop working.')) return;
    setWorking('recovery');
    setError(null);
    try {
      const result = await regenerateRecoveryCodes();
      setRecoveryCodes(result.recoveryCodes);
      await refreshSecurity();
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : 'Could not generate recovery codes');
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="security-panel" role="dialog" aria-modal="true" aria-labelledby="security-title">
        <header><div><div className="eyebrow">Settings</div><h1 id="security-title">Account security</h1></div><button aria-label="Back to settings" onClick={onClose}>×</button></header>
        {error && <div className="settings-error-banner" role="alert"><strong>Security action failed</strong><span>{error}</span></div>}
        {recoveryCodes ? (
          <RecoveryCodesView codes={recoveryCodes} onDone={() => setRecoveryCodes(null)} />
        ) : (
          <>
            <div className="setting-section">
              <h2>Passkeys</h2>
              <div className="passkey-list">
                {security?.passkeys.map((passkey) => (
                  <div className="passkey-row" key={passkey.credentialId}>
                    <div><strong>{passkey.name}</strong><span>{passkey.backedUp ? 'Synced passkey' : 'Device-bound passkey'} · Added {new Date(passkey.createdAt).toLocaleDateString()}{passkey.lastUsedAt ? ` · Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}` : ''}</span></div>
                    <button className="danger-action" type="button" disabled={working !== null || (security?.passkeys.length ?? 0) <= 1} onClick={() => void deletePasskey(passkey.credentialId, passkey.name)}>{working === passkey.credentialId ? 'Removing…' : 'Remove'}</button>
                  </div>
                ))}
              </div>
              <div className="add-passkey-form">
                <label>New passkey name<input value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} placeholder="Android phone or password manager" maxLength={80} /></label>
                <button className="primary-action" type="button" disabled={working !== null || !passkeyName.trim()} onClick={() => void addPasskey()}>{working === 'add' ? 'Waiting for your device…' : 'Add passkey'}</button>
              </div>
            </div>
            <div className="setting-section">
              <h2>Recovery codes</h2>
              <div className="setting-line"><div><strong>{security?.recoveryCodesRemaining ?? 0} unused codes</strong><span>Each recovery code works once. Generating a new set invalidates every older code.</span></div><button type="button" disabled={working !== null} onClick={() => void createNewRecoveryCodes()}>{working === 'recovery' ? 'Generating…' : 'Generate new codes'}</button></div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SettingsPanel({ session, onClose, onConnected, onRssDisconnected, onClearOfflineData, onLogout }: {
  session: SessionState;
  onClose: () => void;
  onConnected: () => Promise<void>;
  onRssDisconnected: () => Promise<void> | void;
  onClearOfflineData: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [serverUrl, setServerUrl] = useState('https://birchfeed.app/api/greader.php');
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [readwiseToken, setReadwiseToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<'rss' | 'readwise' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [offlineSummary, setOfflineSummary] = useState<{ articles: number; queuedChanges: number; estimatedBytes: number } | null>(null);
  const [clearingOfflineData, setClearingOfflineData] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getIntegrationStatus(controller.signal).then(setStatus),
      offlineStorageSummary().then(setOfflineSummary),
    ]).catch((statusError: unknown) => {
      if (!controller.signal.aborted) setError(statusError instanceof Error ? statusError.message : 'Could not load settings');
    });
    return () => controller.abort();
  }, []);

  async function removeOfflineData() {
    if (!window.confirm('Clear articles and pending changes stored on this device? The cache will rebuild after the next synchronization.')) return;
    setClearingOfflineData(true);
    setError(null);
    try {
      await onClearOfflineData();
      setOfflineSummary({ articles: 0, queuedChanges: 0, estimatedBytes: 0 });
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : 'Could not clear offline data');
    } finally {
      setClearingOfflineData(false);
    }
  }

  async function saveBirchfeed() {
    setConnecting(true);
    setError(null);
    try {
      const connection = await connectBirchfeed(serverUrl, email, apiKey);
      setStatus((current) => current ? {
        ...current,
        rss: { provider: 'google-reader', configured: true, serverUrl: connection.serverUrl },
      } : current);
      setApiKey('');
      await onConnected();
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Could not connect RSS service');
    } finally {
      setConnecting(false);
    }
  }

  async function saveReadwise() {
    setConnecting(true);
    setError(null);
    try {
      await connectReadwise(readwiseToken);
      setStatus((current) => current ? { ...current, readwise: { configured: true } } : current);
      setReadwiseToken('');
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Could not connect Readwise');
    } finally {
      setConnecting(false);
    }
  }

  async function removeRssService() {
    if (!window.confirm('Disconnect the RSS service? Chadashot will remove its stored credentials, but your subscriptions and account at the service will not be changed.')) return;
    setDisconnecting('rss');
    setError(null);
    try {
      await disconnectRssService();
      setStatus((current) => current ? {
        ...current,
        rss: { provider: 'google-reader', configured: false, serverUrl: null },
      } : current);
      setEmail('');
      setApiKey('');
      await onRssDisconnected();
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Could not disconnect RSS service');
    } finally {
      setDisconnecting(null);
    }
  }

  async function removeReadwise() {
    if (!window.confirm('Disconnect Readwise? Chadashot will remove its stored access token. Existing highlights and documents in Readwise will not be changed.')) return;
    setDisconnecting('readwise');
    setError(null);
    try {
      await disconnectReadwise();
      setStatus((current) => current ? { ...current, readwise: { configured: false } } : current);
      setReadwiseToken('');
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Could not disconnect Readwise');
    } finally {
      setDisconnecting(null);
    }
  }

  if (logsOpen) return <LogsPanel onClose={() => setLogsOpen(false)} />;
  if (securityOpen) return <AccountSecurityPanel onClose={() => setSecurityOpen(false)} />;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><div className="eyebrow">Chadashot</div><h1 id="settings-title">Settings</h1></div><button aria-label="Close settings" onClick={onClose}>×</button></header>
        {error && <div className="settings-error-banner" role="alert"><strong>Integration problem</strong><span>{error}</span></div>}
        <div className="setting-section">
          <h2>RSS service</h2>
          <div className="setting-line"><div><strong>Birchfeed or compatible service</strong><span>Google Reader compatible synchronization.</span></div><span className="setting-state">{status?.rss.configured ? 'Connected' : 'Not connected'}</span></div>
          {status?.rss.configured && status.rss.serverUrl && <div className="connected-endpoint">{status.rss.serverUrl}</div>}
          {status?.rss.configured && <div className="connection-actions"><button className="danger-action" type="button" disabled={disconnecting !== null} onClick={() => void removeRssService()}>{disconnecting === 'rss' ? 'Disconnecting…' : 'Disconnect RSS service'}</button></div>}
          {!status?.rss.configured && (
            <div className="connection-form">
              <label>Server or API URL<input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false} /></label>
              <label>Account email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /></label>
              <label>API key or password<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" /></label>
              <button className="primary-action" disabled={connecting || !serverUrl || !email || !apiKey} onClick={() => void saveBirchfeed()}>{connecting ? 'Checking…' : 'Connect RSS service'}</button>
            </div>
          )}
        </div>
        <div className="setting-section">
          <h2>Readwise</h2>
          <div className="setting-line"><div><strong>Readwise and Reader</strong><span>Highlights and saved documents remain separate actions.</span></div><span className="setting-state">{status?.readwise.configured ? 'Connected' : 'Not connected'}</span></div>
          {status?.readwise.configured && <div className="connection-actions"><button className="danger-action" type="button" disabled={disconnecting !== null} onClick={() => void removeReadwise()}>{disconnecting === 'readwise' ? 'Disconnecting…' : 'Disconnect Readwise'}</button></div>}
          {!status?.readwise.configured && (
            <div className="connection-form">
              <label>Readwise access token<input type="password" value={readwiseToken} onChange={(event) => setReadwiseToken(event.target.value)} autoComplete="off" /></label>
              <button className="primary-action" disabled={connecting || !readwiseToken} onClick={() => void saveReadwise()}>{connecting ? 'Checking…' : 'Connect Readwise'}</button>
            </div>
          )}
        </div>
        <div className="setting-section">
          <h2>Diagnostics</h2>
          <div className="setting-line"><div><strong>Application logs</strong><span>Review recent activity, warnings, and errors stored by this server.</span></div><button type="button" onClick={() => setLogsOpen(true)}>View logs</button></div>
        </div>
        <div className="setting-section">
          <h2>Offline storage</h2>
          <div className="setting-line">
            <div><strong>{offlineSummary?.articles ?? 0} cached articles</strong><span>{formatLogFileSize(offlineSummary?.estimatedBytes ?? 0)} on this device · {offlineSummary?.queuedChanges ?? 0} pending changes</span></div>
            <button type="button" disabled={clearingOfflineData} onClick={() => void removeOfflineData()}>{clearingOfflineData ? 'Clearing…' : 'Clear data'}</button>
          </div>
          <p className="setting-help">The cache is limited to the newest 200 articles and rebuilds on the next synchronization.</p>
        </div>
        <div className="setting-section">
          <h2>Access</h2>
          <div className="setting-line"><div><strong>{session.mode === 'development' ? 'Local development identity' : 'Passkeys and recovery'}</strong><span>{session.mode === 'development' ? 'Available only from loopback in development.' : 'Manage sign-in devices and one-time recovery codes.'}</span></div>{session.mode === 'passkey' ? <button type="button" onClick={() => setSecurityOpen(true)}>Manage</button> : <span className="setting-state">{session.user?.displayName}</span>}</div>
          {session.mode === 'passkey' && <div className="connection-actions"><button type="button" disabled={connecting || disconnecting !== null} onClick={() => void onLogout()}>Log out</button></div>}
        </div>
      </section>
    </div>
  );
}

export function AuthenticationScreen({ session, onAuthenticated }: { session: SessionState; onAuthenticated: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState('Paul');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function authenticate() {
    setWorking(true);
    setError(null);
    try {
      if (session.setupRequired) {
        const pending = await getBootstrapOptions(displayName, bootstrapToken);
        const credential = await startRegistration({ optionsJSON: pending.options });
        const result = await verifyBootstrap(pending.setupId, bootstrapToken, credential);
        setRecoveryCodes(result.recoveryCodes);
        return;
      } else {
        const pending = await getLoginOptions();
        const credential = await startAuthentication({ optionsJSON: pending.options });
        await verifyLogin(pending.challengeId, credential);
      }
      await onAuthenticated();
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Passkey authentication failed');
    } finally {
      setWorking(false);
    }
  }

  async function recover() {
    setWorking(true);
    setError(null);
    try {
      await recoverAccount(recoveryCode);
      await onAuthenticated();
    } catch (recoveryError) {
      setError(recoveryError instanceof Error ? recoveryError.message : 'Recovery code sign-in failed');
    } finally {
      setWorking(false);
    }
  }

  if (recoveryCodes) {
    return (
      <main className="auth-screen">
        <section className="auth-card auth-card-wide">
          <div><div className="eyebrow">Account created</div><h1>Keep a way back in</h1></div>
          <RecoveryCodesView codes={recoveryCodes} onDone={() => void onAuthenticated()} />
        </section>
      </main>
    );
  }

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <span className="app-mark">ח</span>
        <div><div className="eyebrow">Chadashot</div><h1>{session.setupRequired ? 'Create your private reader' : 'Your private reading space'}</h1></div>
        <p>{session.setupRequired ? 'Use the one-time setup token from Railway, then register a passkey on this device.' : 'Sign in to read and synchronize your feeds.'}</p>
        {session.setupRequired && (
          <div className="auth-fields">
            <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" /></label>
            <label>One-time setup token<input type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="one-time-code" /></label>
          </div>
        )}
        {!recoveryMode ? (
          <button className="primary-action" disabled={working || (session.setupRequired && (!displayName.trim() || !bootstrapToken))} onClick={() => void authenticate()}>
            {working ? 'Waiting for your device…' : session.setupRequired ? 'Create account and passkey' : 'Sign in with a passkey'}
          </button>
        ) : (
          <div className="recovery-login">
            <label>Recovery code<input value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} autoCapitalize="characters" autoComplete="one-time-code" placeholder="XXXX-XXXX-XXXX-XXXX" /></label>
            <button className="primary-action" disabled={working || !recoveryCode.trim()} onClick={() => void recover()}>{working ? 'Checking…' : 'Use recovery code'}</button>
          </div>
        )}
        {!session.setupRequired && <button className="auth-secondary-action" type="button" onClick={() => { setRecoveryMode((current) => !current); setError(null); }}>{recoveryMode ? 'Use a passkey instead' : 'Use a recovery code'}</button>}
        {error && <div className="auth-error" role="alert">{error}</div>}
        <small>{session.setupRequired ? 'Setup closes permanently after the first account is created.' : 'Your passkey never leaves your device.'}</small>
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [feedsOpen, setFeedsOpen] = useState(false);
  const [unreadFeedsOnly, setUnreadFeedsOnly] = useState(false);
  const [feedSortOrder, setFeedSortOrder] = useState<FeedSortOrder>(savedFeedSortOrder);
  const [accentColor, setAccentColor] = useState<AccentColor>(savedAccentColor);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [contentView, setContentView] = useState<ContentView>('list');
  const [notice, setNotice] = useState('');
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(savedPanelWidths);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const reader = useReader(session?.authenticated ? session.user?.id : undefined);

  useLayoutEffect(() => {
    if (!session?.authenticated) return;
    window.requestAnimationFrame(() => markMilestone('shell'));
  }, [session?.authenticated]);

  async function refreshSession() {
    const nextSession = await getSession();
    setSession(nextSession);
    if (nextSession.authenticated) await saveOfflineSession(nextSession);
  }

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then((nextSession) => {
      setSession(nextSession);
      if (nextSession.authenticated) void saveOfflineSession(nextSession);
    }).catch(async (error: unknown) => {
      if (controller.signal.aborted) return;
      if (!navigator.onLine) {
        const cachedSession = await loadOfflineSession().catch(() => null);
        if (cachedSession) {
          setSession(cachedSession);
          return;
        }
      }
      setSessionError(error instanceof Error ? error.message : 'Could not load session');
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    try {
      localStorage.setItem(FEED_SORT_ORDER_KEY, feedSortOrder);
    } catch {
      // The preference remains available for this session if storage is unavailable.
    }
  }, [feedSortOrder]);

  useEffect(() => {
    document.documentElement.dataset.accent = accentColor;
    try {
      localStorage.setItem(ACCENT_COLOR_KEY, accentColor);
    } catch {
      // The preference remains available for this session if storage is unavailable.
    }
  }, [accentColor]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateWidth = () => setWorkspaceWidth(workspace.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [session?.authenticated]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(panelWidths));
    } catch {
      // The panel sizes remain available for this session if storage is unavailable.
    }
  }, [panelWidths]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'j') { startSelectionUpdate(); void reader.navigateSelection(1); }
      if (event.key === 'k') { startSelectionUpdate(); void reader.navigateSelection(-1); }
      if (event.key === 's' && reader.selectedArticle) void reader.toggleStarred(reader.selectedArticle);
      if (event.key === 'm' && reader.selectedArticle) void reader.toggleRead(reader.selectedArticle);
      if (event.key === '/') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#article-search')?.focus();
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [reader]);

  if (sessionError) return <div className="centered-state"><strong>Chadashot could not start</strong><span>{sessionError}</span></div>;
  if (!session) return <div className="centered-state"><span className="app-mark">ח</span><span>Opening Chadashot…</span></div>;
  if (!session.authenticated) {
    return <AuthenticationScreen session={session} onAuthenticated={refreshSession} />;
  }

  const activeFilter = reader.filter;
  const title = activeFilter.kind === 'folder'
    ? reader.snapshot?.folders.find((folder) => folder.id === activeFilter.id)?.title ?? 'Folder'
    : activeFilter.kind === 'feed'
      ? reader.snapshot?.subscriptions.find((subscription) => subscription.id === activeFilter.id)?.title ?? 'Feed'
      : filterLabels[activeFilter.kind];
  const activeListKey = activeFilter.kind === 'folder' || activeFilter.kind === 'feed'
    ? `${activeFilter.kind}:${activeFilter.id}:${reader.readFilter}:${reader.query}`
    : `${activeFilter.kind}:${reader.readFilter}:${reader.query}`;
  const latestMarkReadJob = reader.markReadJobs[0];
  const markReadJobLabel = latestMarkReadJob?.status === 'completed'
    ? `${latestMarkReadJob.completedCount.toLocaleString()} marked read`
    : latestMarkReadJob?.status === 'failed'
      ? `Mark-read paused at ${latestMarkReadJob.completedCount.toLocaleString()} of ${latestMarkReadJob.targetCount.toLocaleString()}`
      : latestMarkReadJob
        ? `Marking ${latestMarkReadJob.completedCount.toLocaleString()} of ${latestMarkReadJob.targetCount.toLocaleString()} read`
        : null;

  function chooseFilter(filter: ReaderFilter) {
    if (filter.kind === 'inbox') reader.setReadFilter('all');
    reader.setFilter(filter);
    setContentView('list');
  }

  function chooseArticle(article: Article) {
    if (article.id !== reader.selectedArticle?.id) {
      startArticleOpen('cache');
      startSelectionUpdate();
    }
    reader.selectArticle(article.id);
    setContentView('reader');
  }

  function navigateArticle(direction: -1 | 1) {
    const currentArticle = reader.selectedArticle;
    startArticleOpen('cache');
    startSelectionUpdate();
    void reader.navigateSelection(direction).then(() => {
      if (currentArticle && !currentArticle.read) void reader.toggleRead(currentArticle);
    });
  }

  function closeArticle() {
    const currentArticle = reader.selectedArticle;
    setContentView('list');
    if (currentArticle && !currentArticle.read) void reader.toggleRead(currentArticle);
  }

  const selectedArticleIndex = reader.selectedArticle
    ? reader.articles.findIndex((article) => article.id === reader.selectedArticle?.id)
    : -1;
  const selectedArticlePosition = selectedArticleIndex >= 0 ? selectedArticleIndex + 1 : 0;
  const fittedPanelWidths = fitPanelWidths(panelWidths, workspaceWidth);
  const sidebarMaximum = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, workspaceWidth - MIN_READER_WIDTH - PANEL_RESIZER_WIDTH),
  );
  const workspaceStyle = {
    '--sidebar-width': `${fittedPanelWidths.sidebar}px`,
  } as CSSProperties;

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} content-${contentView}`}>
      <header className="topbar">
        <div className="wordmark">
          <button
            className="sidebar-toggle brand-sidebar-toggle"
            aria-label={sidebarOpen ? 'Collapse navigation sidebar' : 'Expand navigation sidebar'}
            aria-controls="reader-sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((current) => !current)}
          >☰</button>
          <span className="app-mark">ח</span><span>Chadashot</span>
        </div>
        <label className="search-box" htmlFor="article-search"><span aria-hidden="true">⌕</span><input id="article-search" type="search" value={reader.query} onChange={(event) => { reader.setQuery(event.target.value); setContentView('list'); }} placeholder="Search your reading" /></label>
        <div className="topbar-actions">
          <span className="topbar-status">
            <span className={`status-dot ${reader.status}`}></span>
            {syncLabel(reader.status, reader.pendingMutations)}
            {reader.coverage && !reader.coverage.complete
              ? ` · ${reader.coverage.loaded.toLocaleString()} of ${reader.coverage.total.toLocaleString()} cached`
              : ''}
            {reader.searchCoverage === 'cached-partial' ? ' · Cached search only' : ''}
            {markReadJobLabel ? ` · ${markReadJobLabel}` : ''}
            {latestMarkReadJob?.status === 'failed' && (
              <button className="inline-retry" onClick={() => void reader.retryMarkReadJob(latestMarkReadJob.id)}>Retry</button>
            )}
          </span>
          <button aria-label="Refresh" onClick={() => void reader.synchronize()}>↻</button>
          <button aria-label="Open preferences" onClick={() => setPreferencesOpen(true)}>☷</button>
          <button aria-label="Open settings" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>
      <div className="workspace" ref={workspaceRef} style={workspaceStyle}>
        <Navigation snapshot={reader.snapshot} filter={reader.filter} unreadOnly={unreadFeedsOnly} sortOrder={feedSortOrder} onFilter={chooseFilter} onSettings={() => setSettingsOpen(true)} onSubscribe={() => setSubscribeOpen(true)} onUnreadOnlyChange={setUnreadFeedsOnly} status={reader.status} />
        <PanelResizer
          className="sidebar-resizer"
          label="Resize feed sidebar"
          controls="reader-sidebar"
          value={fittedPanelWidths.sidebar}
          minimum={MIN_SIDEBAR_WIDTH}
          maximum={sidebarMaximum}
          defaultValue={DEFAULT_PANEL_WIDTHS.sidebar}
          onResize={(sidebar) => setPanelWidths((current) => ({ ...current, sidebar }))}
        />
        {contentView === 'list' ? (
          <ArticleList
            key={activeListKey}
            listKey={activeListKey}
            title={title}
            articles={reader.articles}
            total={reader.totalArticles}
            readFilter={reader.readFilter}
            showReadFilter={activeFilter.kind !== 'inbox'}
            markAllCount={reader.readFilter !== 'read' && reader.coverage?.complete ? reader.bulkUnreadCount : 0}
            selectedId={reader.selectedArticle?.id ?? null}
            onSelect={chooseArticle}
            onToggleRead={(article) => void reader.toggleRead(article)}
            onToggleStar={(article) => void reader.toggleStarred(article)}
            onReadFilterChange={reader.setReadFilter}
            onLoadMore={() => void reader.loadMoreArticles()}
            onMarkAllRead={reader.readFilter !== 'read' && reader.coverage?.complete ? async () => {
              const count = await reader.markAllRead();
              setNotice(`${count} ${count === 1 ? 'item' : 'items'} accepted for marking as read`);
              return count;
            } : undefined}
          />
        ) : (
          <ReaderPane
            key={reader.selectedArticle?.id ?? 'empty-reader'}
            article={reader.selectedArticle}
            position={selectedArticlePosition}
            total={reader.totalArticles}
            hasPrevious={selectedArticleIndex > 0}
            hasNext={selectedArticleIndex >= 0 && selectedArticlePosition < reader.totalArticles}
            onClose={closeArticle}
            onPrevious={() => navigateArticle(-1)}
            onNext={() => navigateArticle(1)}
            onToggleRead={(article) => void reader.toggleRead(article)}
            onToggleStar={(article) => void reader.toggleStarred(article)}
            onNotify={setNotice}
            onHighlight={async (article, selection, note) => {
              const result = await createReadwiseHighlight({
                articleId: article.id,
                ...selection,
                note,
                title: article.title,
                author: article.author,
                canonicalUrl: article.canonicalUrl,
              });
              if (result.synchronized) setNotice(note ? 'Highlight and note saved to Readwise' : 'Highlight saved to Readwise');
              return result;
            }}
            onSaveToReader={async (article) => {
              await saveReadwiseDocument({
                articleId: article.id,
                title: article.title,
                author: article.author,
                canonicalUrl: article.canonicalUrl,
              });
              setNotice('Article saved to Readwise Reader');
            }}
          />
        )}
      </div>
      <nav className="mobile-navigation" aria-label="Primary navigation">
        <button className={reader.filter.kind === 'inbox' ? 'active' : ''} onClick={() => chooseFilter({ kind: 'inbox' })}><span>●</span>Inbox</button>
        <button className={reader.filter.kind === 'starred' ? 'active' : ''} onClick={() => chooseFilter({ kind: 'starred' })}><span>☆</span>Starred</button>
        <button onClick={() => setFeedsOpen(true)}><span>⌁</span>Feeds</button>
        <button onClick={() => setPreferencesOpen(true)}><span>☷</span>Prefs</button>
        <button onClick={() => setSettingsOpen(true)}><span>⚙</span>Settings</button>
      </nav>
      {notice && <div className="toast" role="status" aria-live="polite">{notice}</div>}
      {reader.error && <div className="error-banner" role="alert">{reader.error}</div>}
      {feedsOpen && <MobileFeedsPanel
        snapshot={reader.snapshot}
        filter={reader.filter}
        unreadOnly={unreadFeedsOnly}
        sortOrder={feedSortOrder}
        onFilter={chooseFilter}
        onSubscribe={() => { setFeedsOpen(false); setSubscribeOpen(true); }}
        onUnreadOnlyChange={setUnreadFeedsOnly}
        onClose={() => setFeedsOpen(false)}
      />}
      {preferencesOpen && <PreferencesPanel sortOrder={feedSortOrder} accentColor={accentColor} onSortOrderChange={setFeedSortOrder} onAccentColorChange={setAccentColor} onClose={() => setPreferencesOpen(false)} />}
      {subscribeOpen && <SubscribePanel
        onClose={() => setSubscribeOpen(false)}
        onSubscribed={async (feedUrl) => {
          const result = await subscribeToFeed(feedUrl);
          setNotice(`Subscribed to ${result.subscription.title}`);
          await reader.synchronize();
        }}
      />}
      {settingsOpen && <SettingsPanel
        session={session}
        onClose={() => setSettingsOpen(false)}
        onConnected={reader.synchronize}
        onRssDisconnected={async () => {
          reader.clear();
          if (session.mode === 'development') await reader.synchronize();
        }}
        onClearOfflineData={clearOfflineData}
        onLogout={async () => {
          await logout();
          await clearOfflineData();
          reader.clear();
          setSettingsOpen(false);
          await refreshSession();
        }}
      />}
    </div>
  );
}
