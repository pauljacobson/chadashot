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
  author: 'Reader',
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
        position={5}
        total={5}
        hasPrevious
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

    expect(screen.getByText('5 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous article' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next article' })).toBeDisabled();
  });

  it('exposes clear action names and states with a five-digit article total', () => {
    render(
      <ReaderPane
        article={article}
        position={1}
        total={21_692}
        hasPrevious={false}
        hasNext
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

    expect(screen.getByText('1 of 21692')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous article' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next article' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mark unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Star article' })).toHaveAttribute('aria-pressed', 'false');

    const share = screen.getByRole('button', { name: 'Share article' });
    const original = screen.getByRole('link', { name: 'Open original' });
    expect(share).toHaveAttribute('aria-label', 'Share article');
    expect(original).toHaveAttribute('aria-label', 'Open original');
    expect(within(share).getByText('Share')).toHaveClass('button-label');
    expect(within(original).getByText('Open original')).toHaveClass('button-label');
    expect(screen.queryByRole('button', { name: 'Save to Reader' })).not.toBeInTheDocument();
    expect(within(original).getByText('↗')).toBeInTheDocument();
  });
});
