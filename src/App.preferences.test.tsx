// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '../shared/preferences';
import type { ArticleReadFilter, ReaderFilter } from './useReader';
import { getUserPreferences, saveUserPreferences } from './api';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getUserPreferences: vi.fn(async () => ({ preferences: null })),
  saveUserPreferences: vi.fn(async (patch) => ({ preferences: { ...DEFAULT_USER_PREFERENCES, ...patch } })),
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

vi.mock('./useReader', async () => {
  const { useState } = await import('react');
  return { useReader: (_userId?: string, defaultReadFilter: ArticleReadFilter = 'all') => {
    const [filter, setFilter] = useState<ReaderFilter>({ kind: 'all' });
    const [readFilter, setReadFilter] = useState<ArticleReadFilter>(defaultReadFilter);
    return {
    articles: [],
    bulkUnreadCount: 0,
    clear: vi.fn(),
    coverage: null,
    error: null,
    filter,
    loadMoreArticles: vi.fn(),
    markAllRead: vi.fn(),
    markReadJobs: [],
    navigateSelection: vi.fn(),
    pendingMutations: 0,
    query: '',
    readFilter,
    retryMarkReadJob: vi.fn(),
    searchCoverage: 'complete',
    selectArticle: vi.fn(),
    selectedArticle: null,
    setFilter,
    setQuery: vi.fn(),
    setReadFilter,
    snapshot: {
      generatedAt: '2026-10-10T00:00:00Z', source: 'fixture', articles: [],
      folders: [{ id: 'folder-1', title: 'News', unreadCount: 1 }],
      subscriptions: [
        { id: 'feed-1', title: 'First feed', folderIds: ['folder-1'], unreadCount: 1, url: 'https://example.test/feed', siteUrl: 'https://example.test', iconUrl: null },
        { id: 'feed-2', title: 'Second feed', folderIds: ['folder-1'], unreadCount: 0, url: 'https://example.test/feed2', siteUrl: 'https://example.test', iconUrl: null },
      ],
    },
    status: 'idle',
    synchronize: vi.fn(),
    toggleRead: vi.fn(),
    toggleStarred: vi.fn(),
    totalArticles: 0,
    };
  } };
});

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

async function openPreferences() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open preferences' }));
  return screen.findByRole('dialog', { name: 'Preferences' });
}

function clearReadingPreferences() {
  delete document.documentElement.dataset.readingFont;
  delete document.documentElement.dataset.articleTextSize;
  for (const property of [
    '--article-body-size',
    '--article-mobile-body-size',
    '--article-title-min-size',
    '--article-title-fluid-size',
    '--article-title-max-size',
    '--article-mobile-title-size',
    '--article-heading-two-size',
  ]) {
    document.documentElement.style.removeProperty(property);
  }
}

describe('reading preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    clearReadingPreferences();
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    clearReadingPreferences();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('saves a start-page choice without leaving the current page and uses it on home and restart', async () => {
    const view = render(<App />);
    await openPreferences();
    const options = screen.getByRole('group', { name: 'Default start page' });
    expect(within(options).getByRole('radio', { name: /^All articles/ })).toBeChecked();
    fireEvent.click(within(options).getByRole('radio', { name: /^Latest Edition/ }));
    expect(localStorage.getItem('chadashot.defaultStartPage')).toBe('latest-edition');
    await waitFor(() => expect(saveUserPreferences).toHaveBeenCalledWith(expect.objectContaining({ defaultStartPage: 'latest-edition' }), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));
    expect(screen.queryByRole('heading', { name: 'Latest Edition', level: 1 })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Latest Edition' }));
    expect(screen.getByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    view.unmount();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
  });

  it('uses the All articles read-status default after changing the start page from Latest Edition', async () => {
    localStorage.setItem('chadashot.defaultStartPage', 'latest-edition');
    localStorage.setItem('chadashot.defaultArticleView', 'unread');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    await openPreferences();
    fireEvent.click(within(screen.getByRole('group', { name: 'Default start page' })).getByRole('radio', { name: /^All articles/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));
    expect(screen.getByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to All articles' }));
    expect(screen.queryByRole('heading', { name: 'Latest Edition', level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('chadashot.defaultStartPage')).toBe('all');
  });

  it('opens the account start page on another device but keeps the current page on later refreshes', async () => {
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultStartPage: 'latest-edition', defaultArticleView: 'unread' } });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultStartPage: 'all' } });
    fireEvent(window, new Event('focus'));
    await screen.findByRole('button', { name: 'Go to All articles' });
    expect(screen.getByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
  });

  it('uses the account All articles choice over a cached edition choice at startup', async () => {
    localStorage.setItem('chadashot.defaultStartPage', 'latest-edition');
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultStartPage: 'all', defaultArticleView: 'unread' } });
    render(<App />);
    await screen.findByRole('button', { name: 'Unread' });
    expect(screen.queryByRole('heading', { name: 'Latest Edition', level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('chadashot.defaultStartPage')).toBe('all');
  });

  it('does not redirect after navigation when account preferences arrive late', async () => {
    let finish: ((value: { preferences: UserPreferences }) => void) | undefined;
    vi.mocked(getUserPreferences).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Reader navigation' });
    fireEvent.click(within(navigation).getByRole('button', { name: /Starred/ }));
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => { finish!({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultStartPage: 'latest-edition' } }); });
    expect(screen.getByRole('button', { name: 'Go to Latest Edition' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Latest Edition', level: 1 })).not.toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: /Starred/ })).toHaveClass('active');
  });

  it('opens the cached start page offline and ignores unsupported saved values', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    localStorage.setItem('chadashot.defaultStartPage', 'latest-edition');
    const view = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Latest Edition', level: 1 })).toBeInTheDocument();
    view.unmount();
    localStorage.setItem('chadashot.defaultStartPage', 'inbox');
    render(<App />);
    await screen.findByRole('button', { name: 'Open preferences' });
    expect(screen.queryByRole('heading', { name: 'Latest Edition', level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to All articles' })).toBeInTheDocument();
  });

  it('defaults Latest Edition to 24 hours and persists each supported publication window', async () => {
    const view = render(<App />);
    await openPreferences();
    expect(screen.getByRole('radio', { name: '24 hours' })).toBeChecked();
    for (const hours of [12, 48]) {
      fireEvent.click(screen.getByRole('radio', { name: `${hours} hours` }));
      expect(localStorage.getItem('chadashot.latestEditionHours')).toBe(String(hours));
    }
    view.unmount();
    render(<App />);
    await openPreferences();
    expect(screen.getByRole('radio', { name: '48 hours' })).toBeChecked();
  });

  it('falls back to 24 hours for unsupported saved windows', async () => {
    localStorage.setItem('chadashot.latestEditionHours', '72');
    render(<App />);
    await openPreferences();
    expect(screen.getByRole('radio', { name: '24 hours' })).toBeChecked();
  });

  it('keeps Latest Edition preferences usable when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App />);
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: '12 hours' }));
    expect(screen.getByRole('radio', { name: '12 hours' })).toBeChecked();
    const startPage = within(screen.getByRole('group', { name: 'Default start page' })).getByRole('radio', { name: /^Latest Edition/ });
    fireEvent.click(startPage);
    expect(startPage).toBeChecked();
  });

  it('applies and persists a keyboard-accessible font choice immediately', async () => {
    render(<App />);
    await openPreferences();

    expect(screen.getByRole('radio', { name: /Serif/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Sans-serif/ }));

    await waitFor(() => expect(document.documentElement.dataset.readingFont).toBe('sans-serif'));
    expect(localStorage.getItem('chadashot.readingFont')).toBe('sans-serif');
    expect(screen.getAllByText('אבג · Reading should feel calm and clear.')).toHaveLength(2);
    expect(screen.getAllByText('אבג · Reading should feel calm and clear.')[1]).toHaveAttribute('data-font', 'sans-serif');
  });

  it('applies the unread preference to the desktop feed switch and feed visibility', async () => {
    render(<App />);
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: /^Unread items only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));

    expect(screen.getByRole('switch', { name: 'Unread feeds only' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Expand News feeds' }));
    expect(screen.getByRole('button', { name: /First feed/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Second feed/ })).not.toBeInTheDocument();
  });

  it('loads the account unread preference into the mobile feed switch', async () => {
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'unread' } });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open feeds panel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Feeds' });

    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Unread feeds only' })).toBeChecked());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Expand News feeds' }));
    expect(within(dialog).queryByRole('button', { name: /Second feed/ })).not.toBeInTheDocument();
  });

  it('keeps the desktop feed switch override temporary and reapplies a changed default', async () => {
    render(<App />);
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: /^Unread items only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));
    const toggle = screen.getByRole('switch', { name: 'Unread feeds only' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(localStorage.getItem('chadashot.defaultArticleView')).toBe('unread');
    await openPreferences();
    expect(screen.getByRole('radio', { name: /^Unread items only/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /^All items/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Unread items only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));
    expect(toggle).toBeChecked();
  });

  it('keeps article toolbar overrides temporary and uses the default on navigation', async () => {
    localStorage.setItem('chadashot.defaultArticleView', 'unread');
    render(<App />);
    const navigation = await screen.findByRole('navigation', { name: 'Reader navigation' });
    fireEvent.click(within(navigation).getByRole('button', { name: /^All articles/ }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('chadashot.defaultArticleView')).toBe('unread');
    fireEvent.click(screen.getByRole('button', { name: /View News folder/ }));
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(screen.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('chadashot.defaultArticleView')).toBe('unread');
    fireEvent.click(screen.getAllByRole('button', { name: /Latest Edition/ })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /^All articles/ })[0]);
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps mobile feed switch overrides temporary and shared with the desktop feed tree', async () => {
    localStorage.setItem('chadashot.defaultArticleView', 'unread');
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open feeds panel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Feeds' });
    const toggle = within(dialog).getByRole('switch', { name: 'Unread feeds only' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(within(screen.getByRole('navigation', { name: 'Reader navigation' })).getByRole('switch', { name: 'Unread feeds only' })).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close feeds' }));
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    await openPreferences();
    expect(screen.getByRole('radio', { name: /^Unread items only/ })).toBeChecked();
    expect(localStorage.getItem('chadashot.defaultArticleView')).toBe('unread');
  });

  it('reapplies defaults received from another device to an overridden feed switch and article toolbar', async () => {
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'unread' } });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Unread feeds only' })).toBeChecked());
    fireEvent.click(screen.getAllByRole('button', { name: /^All articles/ })[0]);
    fireEvent.click(screen.getByRole('switch', { name: 'Unread feeds only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'all' } });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('switch', { name: 'Unread feeds only' })).not.toBeChecked();
    vi.mocked(getUserPreferences).mockResolvedValueOnce({ preferences: { ...DEFAULT_USER_PREFERENCES, defaultArticleView: 'unread' } });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Unread feeds only' })).toBeChecked());
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses the global default across feeds, folders, collections, and returning from Latest Edition', async () => {
    render(<App />);
    await openPreferences();
    expect(screen.getByRole('radio', { name: /^All items/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /^Unread items only/ }));
    expect(localStorage.getItem('chadashot.defaultArticleView')).toBe('unread');
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand News feeds' }));
    fireEvent.click(screen.getByRole('button', { name: /First feed/ }));
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Unread feeds only' }));
    fireEvent.click(screen.getByRole('button', { name: /Second feed/ }));
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /View News folder/ }));
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: /Latest Edition/ })[0]);
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /^All articles/ })[0]);
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: /^All items/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close preferences' }));
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: 'Starred' })[0]);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('restores the default view and tolerates invalid or unavailable storage', async () => {
    localStorage.setItem('chadashot.defaultArticleView', 'unread');
    const view = render(<App />);
    await openPreferences();
    expect(screen.getByRole('radio', { name: /^Unread items only/ })).toBeChecked();
    view.unmount();
    localStorage.setItem('chadashot.defaultArticleView', 'read');
    const fallback = render(<App />);
    await openPreferences();
    expect(screen.getByRole('radio', { name: /^All items/ })).toBeChecked();
    fallback.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App />);
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: /^Unread items only/ }));
    expect(screen.getByRole('radio', { name: /^Unread items only/ })).toBeChecked();
  });

  it('restores a saved choice and falls back from an invalid saved value', async () => {
    localStorage.setItem('chadashot.readingFont', 'sans-serif');
    const view = render(<App />);
    await openPreferences();

    expect(screen.getByRole('radio', { name: /Sans-serif/ })).toBeChecked();
    expect(document.documentElement.dataset.readingFont).toBe('sans-serif');

    view.unmount();
    localStorage.setItem('chadashot.readingFont', 'not-a-font');
    render(<App />);
    await openPreferences();

    expect(screen.getByRole('radio', { name: /Serif/ })).toBeChecked();
    expect(document.documentElement.dataset.readingFont).toBe('serif');
  });

  it('keeps the session preference usable when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });

    render(<App />);
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: /Sans-serif/ }));

    await waitFor(() => expect(document.documentElement.dataset.readingFont).toBe('sans-serif'));
  });

  it('starts at the default article text size and exposes the supported range', async () => {
    render(<App />);
    await openPreferences();

    const control = screen.getByRole('slider', { name: 'Article text size' });
    expect(control).toHaveValue('100');
    expect(control).toHaveAttribute('min', '80');
    expect(control).toHaveAttribute('max', '150');
    expect(control).toHaveAttribute('step', '10');
    expect(control).toHaveAttribute('aria-valuetext', '100%');
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset article text size' })).toBeDisabled();
    expect(document.documentElement.dataset.articleTextSize).toBe('100');
  });

  it('applies and persists the minimum and maximum sizes without changing the font choice', async () => {
    render(<App />);
    await openPreferences();
    fireEvent.click(screen.getByRole('radio', { name: /Sans-serif/ }));
    const control = screen.getByRole('slider', { name: 'Article text size' });

    fireEvent.change(control, { target: { value: '80' } });
    await waitFor(() => expect(document.documentElement.dataset.articleTextSize).toBe('80'));
    expect(document.documentElement.style.getPropertyValue('--article-body-size')).toBe('14.4px');

    fireEvent.change(control, { target: { value: '150' } });
    await waitFor(() => expect(document.documentElement.dataset.articleTextSize).toBe('150'));
    expect(control).toHaveAttribute('aria-valuetext', '150%');
    expect(localStorage.getItem('chadashot.articleTextSize')).toBe('150');
    expect(document.documentElement.dataset.readingFont).toBe('sans-serif');
  });

  it('restores a valid saved size and falls back safely from invalid values', async () => {
    localStorage.setItem('chadashot.articleTextSize', '130');
    const view = render(<App />);
    await openPreferences();

    expect(screen.getByRole('slider', { name: 'Article text size' })).toHaveValue('130');
    expect(document.documentElement.dataset.articleTextSize).toBe('130');

    view.unmount();
    localStorage.setItem('chadashot.articleTextSize', '155');
    render(<App />);
    await openPreferences();

    expect(screen.getByRole('slider', { name: 'Article text size' })).toHaveValue('100');
    expect(document.documentElement.dataset.articleTextSize).toBe('100');
  });

  it('resets the size to 100% and remains usable when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<App />);
    await openPreferences();
    const control = screen.getByRole('slider', { name: 'Article text size' });

    fireEvent.change(control, { target: { value: '140' } });
    await waitFor(() => expect(document.documentElement.dataset.articleTextSize).toBe('140'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset article text size' }));

    await waitFor(() => expect(document.documentElement.dataset.articleTextSize).toBe('100'));
    expect(control).toHaveValue('100');
  });
});
