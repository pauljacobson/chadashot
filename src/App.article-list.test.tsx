// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../shared/reader';
import { ArticleList } from './App';

const resizeObservers = new Set<ResizeObserverCallback>();
let lastScrollTop = 0;

class TestResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.add(callback);
  }

  observe(target: Element) {
    this.callback([{
      target,
      contentRect: target.getBoundingClientRect(),
      borderBoxSize: [{ blockSize: target.getBoundingClientRect().height, inlineSize: target.getBoundingClientRect().width }],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    } as unknown as ResizeObserverEntry], this);
  }

  unobserve() {}

  disconnect() {
    resizeObservers.delete(this.callback);
  }
}

function article(index: number): Article {
  return {
    id: `article-${index}`,
    feedId: 'feed-1',
    folderIds: [],
    title: `Article ${index}${index % 3 === 0 ? ' with a title that wraps onto another line' : ''}`,
    author: null,
    source: 'Feed',
    canonicalUrl: `https://example.test/${index}`,
    publishedAt: new Date(Date.UTC(2026, 8, 8, 0, 0, 0) - index * 1_000).toISOString(),
    readingMinutes: 1,
    summary: index % 2 === 0 ? 'A short summary.' : 'A longer summary that uses enough text to exercise measured variable-height rows.',
    contentHtml: '',
    read: false,
    starred: false,
  };
}

function props(articles: Article[], selectedId: string | null = articles[0]?.id ?? null) {
  return {
    listKey: 'all:all',
    title: 'All',
    articles,
    readFilter: 'all' as const,
    selectedId,
    onSelect: vi.fn(),
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onReadFilterChange: vi.fn(),
  };
}

describe('virtual article list', () => {
  beforeEach(() => {
    lastScrollTop = 0;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function bounds(this: HTMLElement) {
      const height = this.classList.contains('article-list-scroll') ? 600 : this.classList.contains('article-row') ? 96 : 600;
      return { x: 0, y: 0, top: 0, left: 0, right: 360, bottom: height, width: 360, height, toJSON: () => ({}) };
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 360 });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.classList.contains('article-list-scroll') ? 2_400_000 : 600;
      },
    });
    HTMLElement.prototype.scrollTo = function scrollTo(options?: ScrollToOptions | number, y?: number) {
      this.scrollTop = typeof options === 'number' ? (y ?? 0) : options?.top ?? 0;
      lastScrollTop = this.scrollTop;
      fireEvent.scroll(this);
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resizeObservers.clear();
  });

  it('renders a lazy right-hand thumbnail and preserves article and state actions', async () => {
    const articles = [{ ...article(0), thumbnailUrl: 'https://example.test/forest.jpg' }, article(1)];
    const actions = props(articles);
    const { container } = render(<ArticleList {...actions} />);
    const image = await waitFor(() => {
      const result = container.querySelector('.article-thumbnail');
      expect(result).toBeInTheDocument();
      return result!;
    });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(container.querySelectorAll('.article-thumbnail')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Article 0/ }));
    expect(actions.onSelect).toHaveBeenCalledWith(articles[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark article read' })[0]!);
    expect(actions.onToggleRead).toHaveBeenCalledWith(articles[0]);
    expect(actions.onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Star article' })[0]!);
    expect(actions.onToggleStar).toHaveBeenCalledWith(articles[0]);
  });

  it('removes broken thumbnails and tries a new URL when the article image changes', async () => {
    const initial = { ...article(0), thumbnailUrl: 'https://example.test/broken.jpg' };
    const { container, rerender } = render(<ArticleList {...props([initial])} />);
    await waitFor(() => expect(container.querySelector('.article-thumbnail')).toBeInTheDocument());
    fireEvent.error(container.querySelector('.article-thumbnail')!);
    expect(container.querySelector('.article-thumbnail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Article 0/ })).toBeInTheDocument();
    rerender(<ArticleList {...props([{ ...initial, thumbnailUrl: 'https://example.test/new.jpg' }])} />);
    expect(container.querySelector('.article-thumbnail')).toHaveAttribute('src', 'https://example.test/new.jpg');
  });

  it('does not render unsafe image metadata', async () => {
    const { container } = render(<ArticleList {...props([{ ...article(0), thumbnailUrl: 'javascript:alert(1)' }])} />);
    await screen.findByRole('button', { name: /Article 0/ });
    expect(container.querySelector('.article-thumbnail')).not.toBeInTheDocument();
  });

  it('keeps a 20,000-result list below the 200-mounted-row budget with useful list semantics', async () => {
    const articles = Array.from({ length: 20_000 }, (_, index) => article(index));
    const { container } = render(<ArticleList {...props(articles)} total={20_000} />);

    await waitFor(() => expect(container.querySelectorAll('.article-row').length).toBeGreaterThan(0));
    expect(container.querySelectorAll('.article-row').length).toBeLessThanOrEqual(200);
    expect(screen.getByRole('list', { name: 'All results' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '20000');
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-posinset', '1');
  });

  it('scrolls a far-away stable selection into the rendered window and restores focus', async () => {
    const articles = Array.from({ length: 20_000 }, (_, index) => article(index));
    const initial = props(articles);
    const { rerender } = render(<ArticleList {...initial} total={20_000} />);
    const first = await screen.findByRole('button', { name: /Article 0/ });
    await act(async () => {
      first.focus();
      rerender(<ArticleList {...initial} selectedId="article-5" total={20_000} />);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /Article 5/ })).toHaveFocus());
    await act(async () => rerender(<ArticleList {...initial} selectedId="article-10000" total={20_000} />));
    await waitFor(() => expect(lastScrollTop).toBeGreaterThan(100_000));
    expect(document.querySelectorAll('.article-row').length).toBeLessThanOrEqual(200);
  });

  it('loads the next page near the end and handles an empty result without hidden rows', async () => {
    const articles = Array.from({ length: 20 }, (_, index) => article(index));
    const onLoadMore = vi.fn();
    const view = render(<ArticleList {...props(articles)} total={40} onLoadMore={onLoadMore} />);

    await waitFor(() => expect(onLoadMore).toHaveBeenCalled());
    await act(async () => view.rerender(<ArticleList {...props([])} total={0} onLoadMore={onLoadMore} />));

    expect(screen.getByText('Nothing here right now.')).toBeInTheDocument();
    expect(document.querySelectorAll('.article-row')).toHaveLength(0);
  });
});
