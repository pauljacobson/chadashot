// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../shared/reader';
import { App } from './App';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getSession: vi.fn(async () => ({
    authenticated: true,
    mode: 'development',
    setupRequired: false,
    user: { id: 'user-1', username: 'Paul' },
  })),
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
  clear: vi.fn(),
  coverage: null,
  error: null,
  filter: { kind: 'inbox' as const },
  loadMoreArticles: vi.fn(),
  markAllRead: vi.fn(),
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
  beforeEach(() => {
    reader.setFilter.mockClear();
    reader.setQuery.mockClear();
    reader.setReadFilter.mockClear();
    reader.selectArticle.mockClear();
    reader.toggleRead.mockClear();
    Reflect.set(reader, 'articles', []);
    Reflect.set(reader, 'filter', { kind: 'inbox' });
    Reflect.set(reader, 'query', '');
    Reflect.set(reader, 'readFilter', 'all');
    Reflect.set(reader, 'selectedArticle', null);
    Reflect.set(reader, 'snapshot', null);
    Reflect.set(reader, 'totalArticles', 0);
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

  it('uses one accessible brand control to clear search and return to the Inbox list', async () => {
    createResponsiveNavigation(false);
    Reflect.set(reader, 'articles', [article]);
    Reflect.set(reader, 'filter', { kind: 'starred' });
    Reflect.set(reader, 'query', 'selected');
    Reflect.set(reader, 'selectedArticle', article);
    Reflect.set(reader, 'totalArticles', 1);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /A selected article/ }));
    expect(screen.getByRole('heading', { name: 'A selected article' })).toBeInTheDocument();

    const home = screen.getByRole('button', { name: 'Go to Inbox' });
    expect(home).toHaveTextContent('ח');
    expect(home).toHaveTextContent('Chadashot');
    expect(home.tagName).toBe('BUTTON');
    fireEvent.click(home);

    expect(reader.setReadFilter).toHaveBeenLastCalledWith('all');
    expect(reader.setQuery).toHaveBeenLastCalledWith('');
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'inbox' });
    expect(screen.getByRole('list', { name: 'Inbox results' })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'Go to Inbox' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Feeds' })).not.toBeInTheDocument());
    expect(reader.setQuery).toHaveBeenLastCalledWith('');
    expect(reader.setFilter).toHaveBeenLastCalledWith({ kind: 'inbox' });
  });
});
