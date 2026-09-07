import DOMPurify from 'dompurify';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Article, IntegrationStatus, SessionState } from '../shared/reader';
import {
  connectBirchfeed,
  connectReadwise,
  createReadwiseHighlight,
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

type MobileScreen = 'list' | 'reader';

const filterLabels: Record<ReaderFilter['kind'], string> = {
  inbox: 'Inbox',
  all: 'All articles',
  starred: 'Starred',
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

function Navigation({
  snapshot,
  filter,
  onFilter,
  onSettings,
  onSubscribe,
  status,
}: {
  snapshot: ReturnType<typeof useReader>['snapshot'];
  filter: ReaderFilter;
  onFilter: (filter: ReaderFilter) => void;
  onSettings: () => void;
  onSubscribe: () => void;
  status: SyncStatus;
}) {
  const unread = snapshot?.articles.filter((article) => !article.read).length ?? 0;
  return (
    <aside className="sidebar">
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
        <div className="nav-group">
          <div className="nav-heading">Folders</div>
          {snapshot?.folders.map((folder) => (
            <button key={folder.id} className={`nav-item ${filter.kind === 'folder' && filter.id === folder.id ? 'active' : ''}`} onClick={() => onFilter({ kind: 'folder', id: folder.id })}>
              <span aria-hidden="true">⌁</span><span>{folder.title}</span><span className="nav-count">{folder.unreadCount}</span>
            </button>
          ))}
        </div>
        <div className="nav-group feeds-group">
          <div className="nav-heading-row"><div className="nav-heading">Feeds</div><button aria-label="Add feed" onClick={onSubscribe}>＋</button></div>
          {snapshot?.subscriptions.map((subscription) => (
            <button key={subscription.id} className={`nav-item ${filter.kind === 'feed' && filter.id === subscription.id ? 'active' : ''}`} onClick={() => onFilter({ kind: 'feed', id: subscription.id })}>
              <span className="feed-initial" aria-hidden="true">{subscription.title.slice(0, 1)}</span><span>{subscription.title}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="connection-status">
        <span className={`status-dot ${status}`}></span>{syncLabel(status)}
        <button onClick={onSettings}>Settings</button>
      </div>
    </aside>
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
  selectedId,
  onSelect,
  onToggleStar,
}: {
  title: string;
  articles: Article[];
  selectedId: string | null;
  onSelect: (article: Article) => void;
  onToggleStar: (article: Article) => void;
}) {
  return (
    <section className="article-list" aria-label={`${title} articles`}>
      <header className="list-header">
        <h1>{title}</h1>
        <span>{articles.length}</span>
      </header>
      <div className="article-list-scroll">
        {articles.length === 0 ? <div className="empty-list">Nothing here right now.</div> : articles.map((article) => (
          <article key={article.id} className={`article-row ${selectedId === article.id ? 'active' : ''} ${article.read ? 'read' : ''}`}>
            <button className="article-main-action" onClick={() => onSelect(article)}>
              <div className="article-meta"><strong>{article.source}</strong><span>· {article.readingMinutes} min</span><time>{formatAge(article.publishedAt)}</time></div>
              <h2>{article.title}</h2>
              <p>{article.summary}</p>
              {!article.read && <span className="unread-dot" aria-label="Unread"></span>}
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
    return <main className="reader-pane empty-reader"><div><strong>Select an article</strong><span>Choose something from the list to begin reading.</span></div></main>;
  }

  return (
    <main className="reader-pane">
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

function SettingsPanel({ session, onClose, onConnected }: { session: SessionState; onClose: () => void; onConnected: () => Promise<void> }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [serverUrl, setServerUrl] = useState('https://birchfeed.app/api/greader.php');
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [readwiseToken, setReadwiseToken] = useState('');
  const [connecting, setConnecting] = useState(false);
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

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><div className="eyebrow">Chadashot</div><h1 id="settings-title">Settings</h1></div><button aria-label="Close settings" onClick={onClose}>×</button></header>
        <div className="setting-section">
          <h2>RSS service</h2>
          <div className="setting-line"><div><strong>Birchfeed or compatible service</strong><span>Google Reader compatible synchronization.</span></div><span className="setting-state">{status?.rss.configured ? 'Connected' : 'Not connected'}</span></div>
          {status?.rss.configured && status.rss.serverUrl && <div className="connected-endpoint">{status.rss.serverUrl}</div>}
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
        <div className="setting-section">
          <h2>Appearance</h2>
          <div className="setting-line"><div><strong>Follow system</strong><span>The interface changes with the device light or dark theme.</span></div><span className="setting-state">Automatic</span></div>
        </div>
        {error && <div className="auth-error" role="alert">{error}</div>}
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
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>('list');
  const [notice, setNotice] = useState('');
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

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} mobile-${mobileScreen}`}>
      <header className="topbar">
        <div className="wordmark"><span className="app-mark">ח</span><span>Chadashot</span></div>
        <label className="search-box" htmlFor="article-search"><span aria-hidden="true">⌕</span><input id="article-search" type="search" value={reader.query} onChange={(event) => reader.setQuery(event.target.value)} placeholder="Search your reading" /></label>
        <div className="topbar-actions">
          <span className="topbar-status"><span className={`status-dot ${reader.status}`}></span>{syncLabel(reader.status)}</span>
          <button aria-label="Refresh" onClick={() => void reader.synchronize()}>↻</button>
          <button className="sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((current) => !current)}>☰</button>
          <button aria-label="Open settings" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>
      <div className="workspace">
        <Navigation snapshot={reader.snapshot} filter={reader.filter} onFilter={chooseFilter} onSettings={() => setSettingsOpen(true)} onSubscribe={() => setSubscribeOpen(true)} status={reader.status} />
        <ArticleList title={title} articles={reader.articles} selectedId={reader.selectedArticle?.id ?? null} onSelect={chooseArticle} onToggleStar={(article) => void reader.toggleStarred(article)} />
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
        <button onClick={() => setSubscribeOpen(true)}><span>＋</span>Add feed</button>
        <button onClick={() => setSettingsOpen(true)}><span>⚙</span>Settings</button>
      </nav>
      {notice && <div className="toast" role="status" aria-live="polite">{notice}</div>}
      {reader.error && <div className="error-banner" role="alert">{reader.error}</div>}
      {subscribeOpen && <SubscribePanel
        onClose={() => setSubscribeOpen(false)}
        onSubscribed={async (feedUrl) => {
          const result = await subscribeToFeed(feedUrl);
          setNotice(`Subscribed to ${result.subscription.title}`);
          await reader.synchronize();
        }}
      />}
      {settingsOpen && <SettingsPanel session={session} onClose={() => setSettingsOpen(false)} onConnected={reader.synchronize} />}
    </div>
  );
}
