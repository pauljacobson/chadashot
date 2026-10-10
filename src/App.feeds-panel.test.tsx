// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../shared/reader';
import { App } from './App';
import { unsubscribeFromFeed } from './api';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getSession: vi.fn(async () => ({
    authenticated: true,
    mode: 'development',
    setupRequired: false,
    user: { id: 'user-1', username: 'Paul' },
  })),
  unsubscribeFromFeed: vi.fn(async () => ({ removed: true as const })),
}));

vi.mock('./offlineStore', () => ({
  clearOfflineData: vi.fn(),
  loadOfflineSession: vi.fn(),
  offlineStorageSummary: vi.fn(),
  saveOfflineSession: vi.fn(),
}));

vi.mock('./performance', () => ({
  finishArticleOpen: vi.fn(),
  finishSelectionUpdate: vi.fn(),
  markMilestone: vi.fn(),
  recordMountedRows: vi.fn(),
  startArticleOpen: vi.fn(),
  startSelectionUpdate: vi.fn(),
}));

const reader = vi.hoisted(() => ({
  articles: [],
  bulkUnreadCount: 0,
  loadedUnreadCount: 0,
  clear: vi.fn(),
  coverage: null,
  error: null,
  filter: { kind: 'all' as const },
  loadMoreArticles: vi.fn(),
  markAllRead: vi.fn(),
  markLoadedRead: vi.fn(),
  markReadJobs: [],
  navigateSelection: vi.fn(),
  pendingMutations: 0,
  query: '',
  readFilter: 'all' as const,
  retryMarkReadJob: vi.fn(),
  searchCoverage: 'complete',
  selectArticle: vi.fn(),
  selectedArticle: null,
  setFilter: vi.fn(),
  setQuery: vi.fn(),
  setReadFilter: vi.fn(),
  snapshot: null,
  status: 'idle' as const,
  synchronize: vi.fn(),
  toggleRead: vi.fn(),
  toggleStarred: vi.fn(),
  totalArticles: 0,
  totalCountStatus: 'current' as const,
}));

const article: Article = {
  id: 'article-1',
  feedId: 'feed-1',
  folderIds: [],
  title: 'A selected article',
  author: 'Paul',
  source: 'Example',
  canonicalUrl: 'https://example.test/article-1',
  publishedAt: '2026-09-09T00:00:00.000Z',
  readingMinutes: 2,
  summary: 'A summary.',
  contentHtml: '<p>Article content.</p>',
  read: false,
  starred: false,
};

vi.mock('./useReader', () => ({ useReader: () => reader }));

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{
      target,
      contentRect: { width: 600, height: 600 } as DOMRectReadOnly,
      borderBoxSize: [{ blockSize: 600, inlineSize: 600 }],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
}

function createResponsiveNavigation(initiallyCompact: boolean) {
  let compact = initiallyCompact;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() { return compact; },
    media: '(max-width: 1024px)',
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as MediaQueryList;

  vi.stubGlobal('matchMedia', vi.fn(() => mediaQuery));

  return {
    setCompact(next: boolean) {
      compact = next;
      const event = { matches: next, media: mediaQuery.media } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

describe('responsive feeds navigation', () => {
  it('opens Latest Edition from the main items, returns from an article, and retains All articles', async () => {
    createResponsiveNavigation(false);
    const recent = { ...article, publishedAt: new Date(Date.now() - 3_600_000).toISOString() };
    Reflect.set(reader, 'articles', [recent]);
    Reflect.set(reader, 'selectedArticle', recent);
    Reflect.set(reader, 'totalArticles', 1);
    Reflect.set(reader, 'snapshot', { generatedAt: new Date().toISOString(), source: 'fixture', folders: [], subscriptions: [], articles: [recent] });
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Reader navigation' });
    fireEvent.click(within(navigation).getByRole('button', { name: 'Latest Edition' }));
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'all' });
    expect(reader.setReadFilter).toHaveBeenLastCalledWith('all');
    expect(screen.getByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: /^All articles/ })).not.toHaveClass('active');
    fireEvent.click(screen.getByRole('button', { name: 'Read A selected article' }));
    expect(reader.selectArticle).toHaveBeenLastCalledWith(recent.id);
    fireEvent.click(screen.getByRole('button', { name: 'Close article and return to Latest Edition' }));
    expect(screen.getByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    fireEvent.click(within(navigation).getByRole('button', { name: /^All articles/ }));
    expect(screen.queryByRole('heading', { name: 'Latest Edition', level: 1 })).not.toBeInTheDocument();
  });

  it('makes Latest Edition available from the hamburger menu on tablet layouts', async () => {
    createResponsiveNavigation(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open feeds panel' }));
    const dialog = screen.getByRole('dialog', { name: 'Feeds' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Latest Edition' }));
    expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(unsubscribeFromFeed).mockReset().mockResolvedValue({ removed: true });
    reader.synchronize.mockReset().mockResolvedValue(undefined);
    reader.setFilter.mockClear();
    reader.setQuery.mockClear();
    reader.setReadFilter.mockClear();
    reader.selectArticle.mockClear();
    reader.toggleRead.mockClear();
    reader.markAllRead.mockReset();
    reader.markLoadedRead.mockReset();
    Reflect.set(reader, 'bulkUnreadCount', 0);
    Reflect.set(reader, 'loadedUnreadCount', 0);
    Reflect.set(reader, 'articles', []);
    Reflect.set(reader, 'filter', { kind: 'all' });
    Reflect.set(reader, 'coverage', null);
    Reflect.set(reader, 'query', '');
    Reflect.set(reader, 'readFilter', 'all');
    Reflect.set(reader, 'selectedArticle', null);
    Reflect.set(reader, 'snapshot', null);
    Reflect.set(reader, 'status', 'current');
    Reflect.set(reader, 'totalArticles', 0);
    Reflect.set(reader, 'totalCountStatus', 'current');
    reader.setFilter.mockImplementation((filter) => Reflect.set(reader, 'filter', filter));
    reader.setQuery.mockImplementation((query) => Reflect.set(reader, 'query', query));
    reader.setReadFilter.mockImplementation((filter) => Reflect.set(reader, 'readFilter', filter));
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([true, false])('keeps removal controls in edit mode and includes read feeds (compact: %s)', async (compact) => {
    createResponsiveNavigation(compact);
    localStorage.setItem('chadashot.defaultArticleView', 'unread');
    Reflect.set(reader, 'snapshot', {
      generatedAt: '2026-10-10T10:00:00.000Z', source: 'google-reader', articles: [],
      folders: [{ id: 'tech', title: 'Technology', unreadCount: 2 }],
      subscriptions: [
        { id: 'feed/42', title: 'Example feed', folderIds: ['tech'], unreadCount: 2 },
        { id: 'feed/43', title: 'Read feed', folderIds: ['tech'], unreadCount: 0 },
      ],
    });
    render(<App />);
    await screen.findByRole('button', { name: compact ? 'Open feeds panel' : 'Collapse navigation sidebar' });
    if (compact) fireEvent.click(screen.getByRole('button', { name: 'Open feeds panel' }));
    const scope = compact ? screen.getByRole('dialog', { name: 'Feeds' }) : screen.getByRole('navigation', { name: 'Reader navigation' });
    expect(within(scope).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    expect(within(scope).getByRole('switch', { name: 'Unread feeds only' })).toBeChecked();
    fireEvent.click(within(scope).getByRole('button', { name: 'Edit feeds' }));
    expect(within(scope).getByRole('button', { name: 'Remove Read feed' })).toBeInTheDocument();
    expect(within(scope).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(scope).queryByRole('button', { name: 'Add feed' })).not.toBeInTheDocument();
    const remove = within(scope).getByRole('button', { name: 'Remove Read feed' });
    fireEvent.click(remove);
    const confirmation = screen.getByRole('dialog', { name: 'Remove Read feed?' });
    expect(screen.getByRole('button', { name: 'Keep feed' })).toHaveFocus();
    fireEvent.keyDown(confirmation, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Remove feed' })).toHaveFocus();
    fireEvent.keyDown(confirmation, { key: 'Escape' });
    expect(unsubscribeFromFeed).not.toHaveBeenCalled();
    expect(remove).toHaveFocus();
    fireEvent.click(within(scope).getByRole('button', { name: 'Done' }));
    expect(within(scope).getByRole('switch', { name: 'Unread feeds only' })).toBeChecked();
    expect(within(scope).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });

  it('keeps a failed removal visible, then hides it after confirmation and resets the selected feed', async () => {
    createResponsiveNavigation(true);
    Reflect.set(reader, 'filter', { kind: 'feed', id: 'feed/42' });
    Reflect.set(reader, 'snapshot', {
      generatedAt: '2026-10-10T10:00:00.000Z', source: 'google-reader', articles: [], folders: [],
      subscriptions: [{ id: 'feed/42', title: 'Example feed', folderIds: [], unreadCount: 2 }],
    });
    vi.mocked(unsubscribeFromFeed).mockRejectedValueOnce(new Error('The RSS service did not confirm the feed removal'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open feeds panel' }));
    const scope = screen.getByRole('dialog', { name: 'Feeds' });
    fireEvent.click(within(scope).getByRole('button', { name: 'Edit feeds' }));
    fireEvent.click(within(scope).getByRole('button', { name: 'Remove Example feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove feed' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not confirm');
    expect(reader.synchronize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep feed' }));
    expect(within(scope).getByRole('button', { name: 'Remove Example feed' })).toBeInTheDocument();
    fireEvent.click(within(scope).getByRole('button', { name: 'Remove Example feed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove feed' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove Example feed?' })).not.toBeInTheDocument());
    expect(unsubscribeFromFeed).toHaveBeenLastCalledWith('feed/42');
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'all' });
    expect(reader.synchronize).toHaveBeenCalledTimes(1);
    expect(within(scope).queryByRole('button', { name: 'Remove Example feed' })).not.toBeInTheDocument();
    expect(within(scope).getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('prevents duplicate removal and dismissal while the provider request is pending', async () => {
    createResponsiveNavigation(true);
    Reflect.set(reader, 'snapshot', {
      generatedAt: '2026-10-10T10:00:00.000Z', source: 'google-reader', articles: [], folders: [],
      subscriptions: [{ id: 'feed/42', title: 'Example feed', folderIds: [], unreadCount: 2 }],
    });
    let finish!: (value: { removed: true }) => void;
    vi.mocked(unsubscribeFromFeed).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open feeds panel' }));
    const scope = screen.getByRole('dialog', { name: 'Feeds' });
    fireEvent.click(within(scope).getByRole('button', { name: 'Edit feeds' }));
    fireEvent.click(within(scope).getByRole('button', { name: 'Remove Example feed' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Example feed?' });
    const confirm = within(dialog).getByRole('button', { name: 'Remove feed' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(within(dialog).getByRole('button', { name: 'Removing…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Keep feed' })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(unsubscribeFromFeed).toHaveBeenCalledTimes(1);
    finish({ removed: true });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it('uses the header hamburger to open a labelled modal feeds panel in compact mode', async () => {
    createResponsiveNavigation(true);
    render(<App />);

    const trigger = await screen.findByRole('button', { name: 'Open feeds panel' });
    expect(trigger).toHaveAttribute('aria-controls', 'mobile-feeds-panel');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Feeds' });
    expect(dialog).toHaveAttribute('id', 'mobile-feeds-panel');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Close feeds' })).toHaveFocus();

    fireEvent.mouseDown(dialog.parentElement!);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('shows global unread counts separately from the All articles total with partial device coverage', async () => {
    createResponsiveNavigation(false);
    Reflect.set(reader, 'coverage', {
      loaded: 1_600,
      total: 29_402,
      complete: false,
      nextCursor: 'next',
      changeToken: 'token',
      backfillInterrupted: true,
    });
    Reflect.set(reader, 'snapshot', {
      generatedAt: '2026-09-09T10:24:00.000Z',
      source: 'google-reader',
      counts: { all: 29_402, inbox: 18_916, starred: 20, uncategorized: 4_000 },
      articles: Array.from({ length: 1_600 }, (_, index) => ({ ...article, id: `article-${index}`, read: index >= 1_192 })),
      folders: [],
      subscriptions: [],
    });
    Reflect.set(reader, 'totalArticles', 29_402);

    render(<App />);

    expect(await screen.findAllByText('18916')).toHaveLength(2);
    const navigation = screen.getByRole('navigation', { name: 'Reader navigation' });
    const allArticles = within(navigation).getByRole('button', { name: /^All articles/ });
    expect(allArticles).toHaveClass('active');
    expect(within(allArticles).getByLabelText('18916 unread articles.')).toHaveTextContent('18916');
    expect(within(navigation).queryByRole('button', { name: /Inbox/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All articles' })).toBeInTheDocument();
    expect(screen.getByText('29402')).toBeInTheDocument();
    expect(screen.queryByText('1192')).not.toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: 'Latest Edition' }));
    expect(within(allArticles).getByLabelText('18916 unread articles.')).toHaveTextContent('18916');
    expect(allArticles).not.toHaveClass('active');
    fireEvent.click(allArticles);
    expect(allArticles).toHaveClass('active');
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'all' });
  });

  it.each([true, false])('offers loaded-item marking during synchronization (compact: %s)', async (compact) => {
    createResponsiveNavigation(compact);
    Reflect.set(reader, 'bulkUnreadCount', 525);
    Reflect.set(reader, 'loadedUnreadCount', 100);
    Reflect.set(reader, 'coverage', {
      loaded: 23_700,
      total: 42_728,
      complete: false,
      nextCursor: 'next',
      changeToken: null,
      backfillInterrupted: false,
    });
    const view = render(<App />);

    const button = await screen.findByRole('button', { name: /Mark loaded read/ });
    expect(button).toBeEnabled();
    expect(button).toHaveAccessibleDescription(/loaded.*device/i);
    fireEvent.click(button);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('100 loaded unread items');
    expect(reader.markAllRead).not.toHaveBeenCalled();

    Reflect.set(reader, 'coverage', {
      loaded: 42_728,
      total: 42_728,
      complete: true,
      nextCursor: null,
      changeToken: 'token',
      backfillInterrupted: false,
    });
    view.rerender(<App />);
    // Completing sync must not widen a confirmation that is already open.
    expect(screen.getByRole('alertdialog')).toHaveTextContent('100 loaded unread items');
    reader.markLoadedRead.mockResolvedValue(100);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark loaded read' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(reader.markLoadedRead).toHaveBeenCalledOnce();
    expect(reader.markAllRead).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Mark all read/ }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('525 unread items');
    reader.markAllRead.mockResolvedValue(525);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(reader.markAllRead).toHaveBeenCalledOnce();
  });

  it('marks a partial offline fallback as a lower bound', async () => {
    createResponsiveNavigation(false);
    Reflect.set(reader, 'status', 'offline');
    Reflect.set(reader, 'coverage', {
      loaded: 2,
      total: 20,
      complete: false,
      nextCursor: 'next',
      changeToken: null,
      backfillInterrupted: true,
    });
    Reflect.set(reader, 'snapshot', {
      generatedAt: '2026-09-09T10:24:00.000Z',
      source: 'google-reader',
      articles: [{ ...article, id: 'article-1' }, { ...article, id: 'article-2' }],
      folders: [],
      subscriptions: [],
    });
    Reflect.set(reader, 'articles', [{ ...article, id: 'article-1' }, { ...article, id: 'article-2' }]);
    Reflect.set(reader, 'totalArticles', 2);
    Reflect.set(reader, 'totalCountStatus', 'cached-partial');

    render(<App />);

    expect(await screen.findAllByText('≥2')).toHaveLength(3);
    expect(screen.getAllByTitle(/full count is not available offline/i)).toHaveLength(3);
  });

  it('uses the same All articles unread count in the mobile bar and hamburger menu', async () => {
    createResponsiveNavigation(true);
    Reflect.set(reader, 'snapshot', {
      generatedAt: new Date().toISOString(), source: 'fixture',
      counts: { all: 7, inbox: 3, starred: 0, uncategorized: 7 },
      articles: [article], folders: [], subscriptions: [],
    });
    Reflect.set(reader, 'filter', { kind: 'starred' });
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Primary navigation' });
    const allArticles = within(navigation).getByRole('button', { name: /^All articles/ });
    expect(within(allArticles).getByLabelText('3 unread articles.')).toHaveTextContent('3');
    expect(within(navigation).queryByRole('button', { name: /Inbox/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open feeds panel' }));
    const dialog = screen.getByRole('dialog', { name: 'Feeds' });
    const menuEntry = within(dialog).getByRole('button', { name: /^All articles/ });
    expect(within(menuEntry).getByLabelText('3 unread articles.')).toHaveTextContent('3');
    expect(within(dialog).queryByRole('button', { name: /Inbox/ })).not.toBeInTheDocument();
    fireEvent.click(menuEntry);
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'all' });
    expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument();
    expect(allArticles).toHaveClass('active');
  });

  it('keeps unread-only and read-only filters available within All articles', async () => {
    createResponsiveNavigation(false);
    render(<App />);
    await screen.findByRole('heading', { name: 'All articles' });
    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));
    expect(reader.setReadFilter).toHaveBeenLastCalledWith('unread');
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(reader.setReadFilter).toHaveBeenLastCalledWith('read');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(reader.setReadFilter).toHaveBeenLastCalledWith('all');
  });

  it('traps focus, closes with Escape, and restores focus to the active trigger', async () => {
    createResponsiveNavigation(true);
    render(<App />);
    const trigger = await screen.findByRole('button', { name: 'Open feeds panel' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Feeds' });

    const firstControl = within(dialog).getByRole('button', { name: /Add feed/ });
    firstControl.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('switch', { name: 'Unread feeds only' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('routes the retained bottom Feeds button through the same panel state', async () => {
    createResponsiveNavigation(true);
    render(<App />);
    await screen.findByRole('button', { name: 'Open feeds panel' });
    const mobileNavigation = screen.getByRole('navigation', { name: 'Primary navigation' });

    fireEvent.click(within(mobileNavigation).getByRole('button', { name: /Feeds/ }));
    expect(await screen.findByRole('dialog', { name: 'Feeds' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close feeds' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
    expect(within(mobileNavigation).getByRole('button', { name: /Feeds/ })).toHaveFocus();
  });

  it('lets people expand folders, then closes after choosing a feed or folder', async () => {
    createResponsiveNavigation(true);
    Reflect.set(reader, 'snapshot', {
      generatedAt: '2026-09-09T00:00:00.000Z',
      source: 'fixture',
      articles: [],
      folders: [{ id: 'folder-1', title: 'Technology', unreadCount: 2 }],
      subscriptions: [{
        id: 'feed-1',
        title: 'Example feed',
        url: 'https://example.test/feed.xml',
        siteUrl: 'https://example.test',
        iconUrl: null,
        folderIds: ['folder-1'],
        unreadCount: 2,
      }],
    });
    render(<App />);
    const trigger = await screen.findByRole('button', { name: 'Open feeds panel' });
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Feeds' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Expand Technology feeds' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Example feed/ }));

    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'feed', id: 'feed-1' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());

    fireEvent.click(trigger);
    const reopenedDialog = await screen.findByRole('dialog', { name: 'Feeds' });
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: 'View Technology folder (2 unread)' }));
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'folder', id: 'folder-1' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
  });

  it('closes the floating panel on a desktop transition without changing the desktop collapse choice', async () => {
    const responsive = createResponsiveNavigation(false);
    render(<App />);
    const desktopTrigger = await screen.findByRole('button', { name: 'Collapse navigation sidebar' });
    fireEvent.click(desktopTrigger);
    expect(await screen.findByRole('button', { name: 'Expand navigation sidebar' })).toHaveAttribute('aria-expanded', 'false');

    responsive.setCompact(true);
    const compactTrigger = await screen.findByRole('button', { name: 'Open feeds panel' });
    fireEvent.click(compactTrigger);
    expect(await screen.findByRole('dialog', { name: 'Feeds' })).toBeInTheDocument();

    responsive.setCompact(false);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Expand navigation sidebar' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses one accessible brand control to clear search and return to the All articles list', async () => {
    createResponsiveNavigation(false);
    Reflect.set(reader, 'articles', [article]);
    Reflect.set(reader, 'filter', { kind: 'starred' });
    Reflect.set(reader, 'query', 'selected');
    Reflect.set(reader, 'selectedArticle', article);
    Reflect.set(reader, 'totalArticles', 1);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /A selected article/ }));
    expect(screen.getByRole('heading', { name: 'A selected article' })).toBeInTheDocument();

    const home = screen.getByRole('button', { name: 'Go to All articles' });
    expect(home).toHaveTextContent('ח');
    expect(home).toHaveTextContent('Chadashot');
    expect(home.tagName).toBe('BUTTON');
    fireEvent.click(home);

    expect(reader.setReadFilter).toHaveBeenLastCalledWith('all');
    expect(reader.setQuery).toHaveBeenLastCalledWith('');
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'all' });
    expect(screen.getByRole('list', { name: 'All articles results' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(reader.toggleRead).not.toHaveBeenCalled();

    fireEvent.click(home);
    expect(reader.setFilter).toHaveBeenCalledTimes(2);
  });

  it('dismisses the floating feeds panel when the brand home control is activated', async () => {
    createResponsiveNavigation(true);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open feeds panel' }));
    expect(await screen.findByRole('dialog', { name: 'Feeds' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to All articles' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
    expect(reader.setQuery).toHaveBeenLastCalledWith('');
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'all' });
  });
});
