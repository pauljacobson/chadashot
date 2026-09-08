// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../shared/reader';
import { ReaderPane } from './App';

const article: Article = {
  id: 'article-2',
  feedId: 'feed-1',
  folderIds: [],
  title: 'A focused reading view',
  author: 'Paul',
  source: 'Example',
  canonicalUrl: 'https://example.test/article-2',
  publishedAt: '2026-09-08T00:00:00.000Z',
  readingMinutes: 3,
  summary: 'Summary',
  contentHtml: '<p>Article content.</p>',
  read: true,
  starred: false,
};

afterEach(cleanup);

describe('article navigation toolbar', () => {
  it('returns to the list and moves to adjacent articles', () => {
    const onClose = vi.fn();
    const onPrevious = vi.fn();
    const onNext = vi.fn();

    render(
      <ReaderPane
        article={article}
        position={2}
        total={5}
        hasPrevious
        hasNext
        onClose={onClose}
        onPrevious={onPrevious}
        onNext={onNext}
        onToggleStar={vi.fn()}
        onToggleRead={vi.fn()}
        onNotify={vi.fn()}
        onHighlight={vi.fn()}
        onSaveToReader={vi.fn()}
      />,
    );

    const navigation = screen.getByRole('group', { name: 'Article navigation' });
    expect(within(navigation).getByText('2 of 5')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close article and return to article list' }));
    fireEvent.click(within(navigation).getByRole('button', { name: 'Previous article' }));
    fireEvent.click(within(navigation).getByRole('button', { name: 'Next article' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('disables navigation beyond the available list boundaries', () => {
    render(
      <ReaderPane
        article={article}
        position={1}
        total={1}
        hasPrevious={false}
        hasNext={false}
        onClose={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onToggleStar={vi.fn()}
        onToggleRead={vi.fn()}
        onNotify={vi.fn()}
        onHighlight={vi.fn()}
        onSaveToReader={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Previous article' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next article' })).toBeDisabled();
  });
});
