import DOMPurify from 'dompurify';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { Article, IntegrationStatus, SessionState, Subscription } from '../shared/reader';
import {
  connectBirchfeed,
  connectReadwise,
  createReadwiseHighlight,
  disconnectReadwise,
  disconnectRssService,
  getBootstrapOptions,
  getIntegrationStatus,
  getLoginOptions,
  getSession,
  saveReadwiseDocument,
  subscribeToFeed,
  verifyBootstrap,
  verifyLogin,
} from './api';
import { type ReaderFilter, type SyncStatus, useReader } from './useReader';
import { buildFeedGroups, type FeedSortOrder, feedFaviconUrl } from './feedTree';

type MobileScreen = 'list' | 'reader';
const FEED_SORT_ORDER_KEY = 'chadashot.feedSortOrder';
const PANEL_WIDTHS_KEY = 'chadashot.panelWidths';
const DEFAULT_PANEL_WIDTHS = { sidebar: 220, articleList: 350 };
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_ARTICLE_LIST_WIDTH = 240;
const MAX_ARTICLE_LIST_WIDTH = 640;
const MIN_READER_WIDTH = 300;
const PANEL_RESIZER_WIDTH = 10;

type PanelWidths = typeof DEFAULT_PANEL_WIDTHS;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function savedPanelWidths(): PanelWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? '') as Partial<PanelWidths>;
    return {
      sidebar: clamp(Number(saved.sidebar) || DEFAULT_PANEL_WIDTHS.sidebar, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
      articleList: clamp(Number(saved.articleList) || DEFAULT_PANEL_WIDTHS.articleList, MIN_ARTICLE_LIST_WIDTH, MAX_ARTICLE_LIST_WIDTH),
    };
  } catch {
    return DEFAULT_PANEL_WIDTHS;
  }
}

function fitPanelWidths(widths: PanelWidths, availableWidth: number, sidebarOpen: boolean): PanelWidths {
  if (availableWidth <= 0) return widths;

  let sidebar = clamp(widths.sidebar, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
  let articleList = clamp(widths.articleList, MIN_ARTICLE_LIST_WIDTH, MAX_ARTICLE_LIST_WIDTH);
  if (!sidebarOpen) {
    articleList = Math.min(articleList, Math.max(MIN_ARTICLE_LIST_WIDTH, availableWidth - MIN_READER_WIDTH - PANEL_RESIZER_WIDTH));
    return { sidebar, articleList };
  }

  const availableForAdjustablePanels = availableWidth - MIN_READER_WIDTH - (PANEL_RESIZER_WIDTH * 2);
  let excess = Math.max(0, sidebar + articleList - availableForAdjustablePanels);
  const articleReduction = Math.min(excess, articleList - MIN_ARTICLE_LIST_WIDTH);
  articleList -= articleReduction;
  excess -= articleReduction;
  sidebar -= Math.min(excess, sidebar - MIN_SIDEBAR_WIDTH);
  return { sidebar, articleList };
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

function syncLabel(status: SyncStatus) {
  if (status === 'syncing') return 'Syncing';
  if (status === 'offline') return 'Offline';
  if (status === 'error') return 'Action needed';
  return 'Up to date';
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

function ArticleList({
  title,
  articles,
  markAllCandidates,
  selectedId,
  onSelect,
  onToggleRead,
  onToggleStar,
  onMarkAllRead,
}: {
  title: string;
  articles: Article[];
  markAllCandidates?: Article[];
  selectedId: string | null;
  onSelect: (article: Article) => void;
  onToggleRead: (article: Article) => void;
  onToggleStar: (article: Article) => void;
  onMarkAllRead?: (articles: Article[]) => Promise<number>;
}) {
  const [confirmingMarkAll, setConfirmingMarkAll] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const unreadCount = markAllCandidates?.filter((article) => !article.read).length ?? 0;

  async function confirmMarkAllRead() {
    if (!onMarkAllRead || !markAllCandidates || markingAll) return;
    setMarkingAll(true);
    try {
      await onMarkAllRead(markAllCandidates);
      setConfirmingMarkAll(false);
    } finally {
      setMarkingAll(false);
    }
  }

  return (
    <section className="article-list" id="article-list" aria-label={`${title} articles`}>
      <header className="list-header">
        <div className="list-heading"><h1>{title}</h1><span>{articles.length}</span></div>
        {onMarkAllRead && unreadCount > 0 && (
          <button className="mark-all-button" onClick={() => setConfirmingMarkAll(true)}>✓ Mark all read</button>
        )}
      </header>
      {confirmingMarkAll && unreadCount > 0 && (
        <div className="mark-all-confirmation" role="alertdialog" aria-label="Confirm mark all read">
          <span>Mark {unreadCount} unread {unreadCount === 1 ? 'item' : 'items'} in this feed as read?</span>
          <div>
            <button disabled={markingAll} onClick={() => setConfirmingMarkAll(false)}>Cancel</button>
            <button className="primary-action" disabled={markingAll} onClick={() => void confirmMarkAllRead()}>{markingAll ? 'Marking…' : 'Mark all read'}</button>
          </div>
        </div>
      )}
      <div className="article-list-scroll">
        {articles.length === 0 ? <div className="empty-list">Nothing here right now.</div> : articles.map((article) => (
          <article key={article.id} className={`article-row ${selectedId === article.id ? 'active' : ''} ${article.read ? 'read' : ''}`}>
            <button className="article-main-action" onClick={() => onSelect(article)}>
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
        ))}
      </div>
    </section>
  );
}

function ReaderPane({
  article,
  onBack,
  onToggleStar,
  onToggleRead,
  onNotify,
  onHighlight,
  onSaveToReader,
}: {
  article: Article | null;
  onBack: () => void;
  onToggleStar: (article: Article) => void;
  onToggleRead: (article: Article) => void;
  onNotify: (message: string) => void;
  onHighlight: (article: Article, text: string, note?: string) => Promise<void>;
  onSaveToReader: (article: Article) => Promise<void>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [savingAction, setSavingAction] = useState<'highlight' | 'document' | null>(null);
  const sanitized = useMemo(() => DOMPurify.sanitize(article?.contentHtml ?? ''), [article?.contentHtml]);

  function captureSelection() {
    const current = window.getSelection();
    if (!current || current.isCollapsed || !contentRef.current) {
      setSelection('');
      return;
    }
    const range = current.getRangeAt(0);
    if (!contentRef.current.contains(range.commonAncestorContainer)) return;
    setSelection(current.toString().trim().slice(0, 8191));
  }

  async function saveHighlight() {
    if (!selection || !article) return;
    setSavingAction('highlight');
    try {
      await onHighlight(article, selection, note || undefined);
      setNoteOpen(false);
      setSelection('');
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

  if (!article) {
    return <main className="reader-pane empty-reader" id="reader-pane"><div><strong>Select an article</strong><span>Choose something from the list to begin reading.</span></div></main>;
  }

  return (
    <main className="reader-pane" id="reader-pane">
      <header className="reader-toolbar">
        <button className="mobile-back" aria-label="Back to article list" onClick={onBack}>←</button>
        <button aria-label={article.read ? 'Mark unread' : 'Mark read'} onClick={() => onToggleRead(article)}>{article.read ? '○ Unread' : '● Read'}</button>
        <span className="toolbar-spacer"></span>
        <button aria-label={article.starred ? 'Remove star' : 'Star article'} aria-pressed={article.starred} onClick={() => onToggleStar(article)}>{article.starred ? '★ Starred' : '☆ Star'}</button>
        <button disabled={savingAction !== null} onClick={() => void saveDocument()}>↗ {savingAction === 'document' ? 'Saving…' : 'Save to Reader'}</button>
        <a className="toolbar-link" href={article.canonicalUrl} target="_blank" rel="noreferrer">Open original</a>
      </header>
      <div className="reading-scroll">
        <article className="reading-column">
          <div className="article-source">{article.source}</div>
          <h1>{article.title}</h1>
          <div className="byline">{article.author ?? article.source} · {new Date(article.publishedAt).toLocaleDateString()} · {article.readingMinutes} min read</div>
          <div className="article-rule"></div>
          <div
            ref={contentRef}
            className="article-content"
            onMouseUp={captureSelection}
            onTouchEnd={captureSelection}
            dangerouslySetInnerHTML={{ __html: sanitized }}
          />
        </article>
      </div>
      {selection && (
        <div className="selection-panel" role="toolbar" aria-label="Selected text actions">
          <div className="selection-preview">“{selection}”</div>
          {noteOpen && <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why does this matter?" aria-label="Highlight note" autoFocus />}
          <div className="selection-actions">
            <button className="primary-action" disabled={savingAction !== null} onClick={() => void saveHighlight()}>{savingAction === 'highlight' ? 'Saving…' : noteOpen ? 'Save highlight + note' : 'Highlight'}</button>
            {!noteOpen && <button onClick={() => setNoteOpen(true)}>Add note</button>}
            <button onClick={() => { void navigator.clipboard.writeText(selection); onNotify('Copied selection'); }}>Copy</button>
            <button aria-label="Close selection actions" onClick={() => setSelection('')}>×</button>
          </div>
        </div>
      )}
    </main>
  );
}

function PreferencesPanel({ sortOrder, onSortOrderChange, onClose }: {
  sortOrder: FeedSortOrder;
  onSortOrderChange: (sortOrder: FeedSortOrder) => void;
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
        </div>
        <p className="preferences-note">Preferences are saved in this browser.</p>
      </section>
    </div>
  );
}

function SettingsPanel({ session, onClose, onConnected, onRssDisconnected }: {
  session: SessionState;
  onClose: () => void;
  onConnected: () => Promise<void>;
  onRssDisconnected: () => Promise<void> | void;
}) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [serverUrl, setServerUrl] = useState('https://birchfeed.app/api/greader.php');
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [readwiseToken, setReadwiseToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState<'rss' | 'readwise' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getIntegrationStatus(controller.signal).then(setStatus).catch((statusError: unknown) => {
      if (!controller.signal.aborted) setError(statusError instanceof Error ? statusError.message : 'Could not load connection status');
    });
    return () => controller.abort();
  }, []);

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
          <h2>Access</h2>
          <div className="setting-line"><div><strong>{session.mode === 'development' ? 'Local development identity' : 'Passkey'}</strong><span>{session.mode === 'development' ? 'Available only from loopback in development.' : 'Passkeys protect this deployment.'}</span></div><span className="setting-state">{session.user?.displayName}</span></div>
        </div>
      </section>
    </div>
  );
}

function AuthenticationScreen({ session, onAuthenticated }: { session: SessionState; onAuthenticated: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState('Paul');
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function authenticate() {
    setWorking(true);
    setError(null);
    try {
      if (session.setupRequired) {
        const pending = await getBootstrapOptions(displayName, bootstrapToken);
        const credential = await startRegistration({ optionsJSON: pending.options });
        await verifyBootstrap(pending.setupId, bootstrapToken, credential);
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

  return (
    <main className="auth-screen">
      <section className="auth-card">
        <span className="app-mark">ח</span>
        <div><div className="eyebrow">Chadashot</div><h1>{session.setupRequired ? 'Create your private reader' : 'Welcome back'}</h1></div>
        <p>{session.setupRequired ? 'Use the one-time setup token from Railway, then register a passkey on this device.' : 'Use a registered passkey to open your reader.'}</p>
        {session.setupRequired && (
          <div className="auth-fields">
            <label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" /></label>
            <label>One-time setup token<input type="password" value={bootstrapToken} onChange={(event) => setBootstrapToken(event.target.value)} autoComplete="one-time-code" /></label>
          </div>
        )}
        <button className="primary-action" disabled={working || (session.setupRequired && (!displayName.trim() || !bootstrapToken))} onClick={() => void authenticate()}>
          {working ? 'Waiting for your device…' : session.setupRequired ? 'Create account and passkey' : 'Sign in with a passkey'}
        </button>
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>('list');
  const [notice, setNotice] = useState('');
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(savedPanelWidths);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const reader = useReader(Boolean(session?.authenticated));

  async function refreshSession() {
    setSession(await getSession());
  }

  useEffect(() => {
    const controller = new AbortController();
    getSession(controller.signal).then(setSession).catch((error: unknown) => {
      if (!controller.signal.aborted) setSessionError(error instanceof Error ? error.message : 'Could not load session');
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
      const index = reader.articles.findIndex((article) => article.id === reader.selectedArticle?.id);
      if (event.key === 'j' && reader.articles[index + 1]) reader.selectArticle(reader.articles[index + 1].id);
      if (event.key === 'k' && reader.articles[index - 1]) reader.selectArticle(reader.articles[index - 1].id);
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

  function chooseFilter(filter: ReaderFilter) {
    reader.setFilter(filter);
    setMobileScreen('list');
  }

  function chooseArticle(article: Article) {
    reader.selectArticle(article.id);
    if (!article.read) void reader.toggleRead(article);
    setMobileScreen('reader');
  }

  const fittedPanelWidths = fitPanelWidths(panelWidths, workspaceWidth, sidebarOpen);
  const sidebarMaximum = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(MAX_SIDEBAR_WIDTH, workspaceWidth - fittedPanelWidths.articleList - MIN_READER_WIDTH - (PANEL_RESIZER_WIDTH * 2)),
  );
  const articleListMaximum = Math.max(
    MIN_ARTICLE_LIST_WIDTH,
    Math.min(
      MAX_ARTICLE_LIST_WIDTH,
      workspaceWidth - (sidebarOpen ? fittedPanelWidths.sidebar + (PANEL_RESIZER_WIDTH * 2) : PANEL_RESIZER_WIDTH) - MIN_READER_WIDTH,
    ),
  );
  const workspaceStyle = {
    '--sidebar-width': `${fittedPanelWidths.sidebar}px`,
    '--article-list-width': `${fittedPanelWidths.articleList}px`,
  } as CSSProperties;

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} mobile-${mobileScreen}`}>
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
        <label className="search-box" htmlFor="article-search"><span aria-hidden="true">⌕</span><input id="article-search" type="search" value={reader.query} onChange={(event) => reader.setQuery(event.target.value)} placeholder="Search your reading" /></label>
        <div className="topbar-actions">
          <span className="topbar-status"><span className={`status-dot ${reader.status}`}></span>{syncLabel(reader.status)}</span>
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
        <ArticleList
          key={activeFilter.kind === 'folder' || activeFilter.kind === 'feed' ? `${activeFilter.kind}:${activeFilter.id}` : activeFilter.kind}
          title={title}
          articles={reader.articles}
          markAllCandidates={activeFilter.kind === 'feed' ? reader.filteredArticles : undefined}
          selectedId={reader.selectedArticle?.id ?? null}
          onSelect={chooseArticle}
          onToggleRead={(article) => void reader.toggleRead(article)}
          onToggleStar={(article) => void reader.toggleStarred(article)}
          onMarkAllRead={activeFilter.kind === 'feed' ? async (articles) => {
            const count = await reader.markAllRead(articles);
            setNotice(`${count} ${count === 1 ? 'item' : 'items'} marked as read`);
            return count;
          } : undefined}
        />
        <PanelResizer
          className="article-list-resizer"
          label="Resize article list"
          controls="article-list"
          value={fittedPanelWidths.articleList}
          minimum={MIN_ARTICLE_LIST_WIDTH}
          maximum={articleListMaximum}
          defaultValue={DEFAULT_PANEL_WIDTHS.articleList}
          onResize={(articleList) => setPanelWidths((current) => ({ ...current, articleList }))}
        />
        <ReaderPane
          key={reader.selectedArticle?.id ?? 'empty-reader'}
          article={reader.selectedArticle}
          onBack={() => setMobileScreen('list')}
          onToggleRead={(article) => void reader.toggleRead(article)}
          onToggleStar={(article) => void reader.toggleStarred(article)}
          onNotify={setNotice}
          onHighlight={async (article, text, note) => {
            await createReadwiseHighlight({
              articleId: article.id,
              text,
              note,
              title: article.title,
              author: article.author,
              canonicalUrl: article.canonicalUrl,
            });
            setNotice(note ? 'Highlight and note saved to Readwise' : 'Highlight saved to Readwise');
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
      {preferencesOpen && <PreferencesPanel sortOrder={feedSortOrder} onSortOrderChange={setFeedSortOrder} onClose={() => setPreferencesOpen(false)} />}
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
      />}
    </div>
  );
}
