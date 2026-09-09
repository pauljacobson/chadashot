// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('./useReader', () => ({
  useReader: () => ({
    articles: [],
    bulkUnreadCount: 0,
    clear: vi.fn(),
    coverage: null,
    error: null,
    filter: { kind: 'inbox' },
    loadMoreArticles: vi.fn(),
    markAllRead: vi.fn(),
    markReadJobs: [],
    navigateSelection: vi.fn(),
    pendingMutations: 0,
    query: '',
    readFilter: 'all',
    retryMarkReadJob: vi.fn(),
    searchCoverage: 'complete',
    selectArticle: vi.fn(),
    selectedArticle: null,
    setFilter: vi.fn(),
    setQuery: vi.fn(),
    setReadFilter: vi.fn(),
    snapshot: null,
    status: 'idle',
    synchronize: vi.fn(),
    toggleRead: vi.fn(),
    toggleStarred: vi.fn(),
    totalArticles: 0,
  }),
}));

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
