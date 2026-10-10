// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article, ReaderSnapshot } from '../shared/reader';
import { articlePreviewImage } from '../shared/articlePreview';
import { buildEditionSections } from './editionModel';
import { LatestEdition } from './LatestEdition';

const now = Date.parse('2026-10-10T08:00:00.000Z');
function article(id: string, hours: number, overrides: Partial<Article> = {}): Article {
  return { id, feedId: 'feed-1', folderIds: ['tech'], title: id, author: null, source: 'Example feed', canonicalUrl: 'https://example.test/posts/story', publishedAt: new Date(now - hours * 3_600_000).toISOString(), readingMinutes: 2, summary: 'An excerpt from the feed.', contentHtml: '', read: false, starred: false, ...overrides };
}
const snapshot: ReaderSnapshot = {
  generatedAt: new Date(now).toISOString(), source: 'fixture', articles: [],
  folders: [{ id: 'tech', title: 'Technology', unreadCount: 2 }, { id: 'culture', title: 'Culture', unreadCount: 0 }],
  subscriptions: [{ id: 'feed-1', title: 'Example', url: 'https://example.test/feed', siteUrl: null, iconUrl: null, folderIds: ['tech'], unreadCount: 2 }],
};

afterEach(cleanup);

describe('Latest Edition', () => {
  it('uses publication time for all three windows, includes read items, and excludes future or invalid dates', () => {
    const items = [article('48-hour boundary', 48), article('24-hour boundary', 24, { read: true }), article('12-hour boundary', 12), article('latest', 1), article('too old', 49), article('future', -1), article('invalid', 0, { publishedAt: 'invalid' })];
    expect(buildEditionSections(snapshot, items, 12, now, 'alphabetical')[0].articles.map((item) => item.id)).toEqual(['latest', '12-hour boundary']);
    expect(buildEditionSections(snapshot, items, 24, now, 'alphabetical')[0].articles.map((item) => item.id)).toEqual(['latest', '12-hour boundary', '24-hour boundary']);
    expect(buildEditionSections(snapshot, items, 48, now, 'alphabetical')[0].articles).toHaveLength(4);
  });

  it('groups multi-category posts and keeps uncategorized or orphaned articles reachable', () => {
    const sections = buildEditionSections(snapshot, [article('both', 1, { folderIds: ['tech', 'culture'] }), article('orphan', 2, { feedId: 'missing', folderIds: ['missing'] })], 24, now, 'alphabetical');
    expect(sections.map((section) => section.title)).toEqual(['Culture', 'Technology', 'Uncategorized']);
    expect(sections[0].articles[0].id).toBe('both');
    expect(sections[2].articles[0].id).toBe('orphan');
  });

  it('resolves feed images, handles lazy images, and skips tiny pixels and executable URLs', () => {
    expect(articlePreviewImage('<img width="1" height="1" src="/pixel"><img src="javascript:alert(1)"><img data-src="../photo.jpg?a=1&amp;b=2" src="data:image/gif;base64,x">', 'https://example.test/posts/story')).toBe('https://example.test/photo.jpg?a=1&b=2');
    expect(articlePreviewImage('<img src="javascript:alert(1)"><script>evil()</script>', 'https://example.test/story')).toBeNull();
  });

  it('opens the original feed item, stars it, and removes broken images without losing its excerpt', () => {
    const item = article('A thoughtful story', 1, { contentHtml: '<img src="/photo.jpg">' });
    const onOpen = vi.fn();
    const onToggleStar = vi.fn();
    const view = render(<LatestEdition snapshot={snapshot} articles={[item]} hours={24} now={now} sortOrder="alphabetical" total={1} hasMore={false} partial={false} loading={false} onLoadMore={vi.fn()} onOpen={onOpen} onToggleStar={onToggleStar} onPreferences={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read A thoughtful story' }));
    expect(onOpen).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole('button', { name: 'Star A thoughtful story' }));
    expect(onToggleStar).toHaveBeenCalledWith(item);
    fireEvent.error(view.container.querySelector('img')!);
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText(item.summary)).toBeInTheDocument();
  });

  it('reveals additional stories per section and explicitly offers unloaded recent articles', async () => {
    const items = Array.from({ length: 9 }, (_, index) => article(`Story ${index}`, index));
    const onLoadMore = vi.fn(async () => {});
    render(<LatestEdition snapshot={snapshot} articles={items} hours={24} now={now} sortOrder="alphabetical" total={20} hasMore partial={false} loading={false} onLoadMore={onLoadMore} onOpen={vi.fn()} onToggleStar={vi.fn()} onPreferences={vi.fn()} />);
    const section = screen.getByRole('region', { name: 'Technology' });
    expect(within(section).getAllByRole('article')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: /More in Technology/ }));
    expect(within(section).getAllByRole('article')).toHaveLength(9);
    fireEvent.click(screen.getByRole('button', { name: 'Load more recent articles' }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });
});
