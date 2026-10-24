// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../shared/reader';
import { ReaderPane } from './App';

const article: Article = {
  id: 'article-with-media',
  feedId: 'feed-1',
  folderIds: [],
  title: 'Research acceleration',
  author: 'Reader',
  source: 'Example',
  canonicalUrl: 'https://example.test/article',
  publishedAt: '2026-09-08T00:00:00.000Z',
  readingMinutes: 2,
  summary: 'Summary',
  contentHtml: `
    <p>Article introduction.</p>
    <figure>
      <a href="https://example.test/chart.png">
        <img src="https://example.test/chart.png" alt="Usage chart" width="1600" height="900">
      </a>
      <figcaption>Usage of internal coding agents</figcaption>
    </figure>
  `,
  read: false,
  starred: false,
};

function renderReader() {
  return render(
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
}

afterEach(() => {
  cleanup();
});

describe('article media', () => {
  it('opens inline images in a labelled, framed lightbox', async () => {
    renderReader();
    const inlineImage = await screen.findByRole('button', { name: 'View Usage chart larger' });

    fireEvent.click(inlineImage);

    const dialog = screen.getByRole('dialog', { name: 'Usage of internal coding agents' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: 'Usage chart' })).toHaveClass('media-lightbox-image');
    expect(within(dialog).getByText('Usage of internal coding agents')).toBeInTheDocument();
    expect(document.querySelector('.article-media-frame')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close enlarged image' })).toHaveFocus();
  });

  it('closes with Escape and restores focus to the inline image', async () => {
    renderReader();
    const inlineImage = await screen.findByRole('button', { name: 'View Usage chart larger' });
    fireEvent.keyDown(inlineImage, { key: 'Enter' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(inlineImage).toHaveFocus();
  });

  it('closes from the explicit button or the backdrop', async () => {
    renderReader();
    const inlineImage = await screen.findByRole('button', { name: 'View Usage chart larger' });
    fireEvent.click(inlineImage);
    fireEvent.click(screen.getByRole('button', { name: 'Close enlarged image' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(inlineImage);
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('supports unlinked images and uses the article title when no caption is available', async () => {
    render(
      <ReaderPane
        article={{ ...article, contentHtml: '<img src="https://example.test/uncaptioned.png" alt="">' }}
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
    const inlineImage = await screen.findByRole('button', { name: 'View article image larger' });

    fireEvent.keyDown(inlineImage, { key: ' ' });

    expect(screen.getByRole('dialog', { name: article.title })).toBeInTheDocument();
  });
});
