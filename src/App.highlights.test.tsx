// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Article } from '../shared/reader';
import { ReaderPane } from './App';

const article: Article = {
  id: 'article-1',
  feedId: 'feed-1',
  folderIds: [],
  title: 'Persistent highlights',
  author: 'Paul',
  source: 'Example',
  canonicalUrl: 'https://example.test/article',
  publishedAt: '2026-09-07T00:00:00.000Z',
  readingMinutes: 2,
  summary: 'Summary',
  contentHtml: '<p>The selected words should remain highlighted after saving.</p>',
  read: false,
  starred: false,
};

describe('article highlights', () => {
  it('keeps selected text visibly highlighted after the save completes', async () => {
    const onHighlight = vi.fn().mockImplementation(async (_article: Article, selection: { text: string; startOffset: number; endOffset: number }) => ({
      synchronized: true,
      highlight: {
        id: 'highlight-1',
        articleId: article.id,
        text: selection.text,
        note: null,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        readwiseStatus: 'saved',
        readwiseId: 'readwise-1',
        readwiseError: null,
        createdAt: '2026-09-07T00:00:00.000Z',
      },
    }));
    const { container } = render(
      <ReaderPane
        article={article}
        onBack={vi.fn()}
        onToggleStar={vi.fn()}
        onToggleRead={vi.fn()}
        onNotify={vi.fn()}
        onHighlight={onHighlight}
        onSaveToReader={vi.fn()}
      />,
    );
    const paragraph = container.querySelector('.article-content p');
    const textNode = paragraph?.firstChild;
    if (!paragraph || !textNode) throw new Error('Article content did not render');
    const text = textNode.textContent ?? '';
    const start = text.indexOf('selected words');
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + 'selected words'.length);
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.mouseUp(paragraph);
    fireEvent.click(await screen.findByRole('button', { name: 'Highlight' }));

    await waitFor(() => expect(onHighlight).toHaveBeenCalledWith(
      article,
      expect.objectContaining({ text: 'selected words', startOffset: start, endOffset: start + 'selected words'.length }),
      undefined,
    ));
    expect(container.querySelector('mark[data-chadashot-highlight]')).toHaveTextContent('selected words');
  });
});
