// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Article, SavedHighlight } from '../shared/reader';
import { ReaderPane } from './App';

const apiMocks = vi.hoisted(() => ({ getArticleHighlights: vi.fn(), retryReadwiseHighlight: vi.fn() }));

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getArticleHighlights: apiMocks.getArticleHighlights,
  retryReadwiseHighlight: apiMocks.retryReadwiseHighlight,
}));

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

function savedHighlight(text: string, startOffset: number, id = 'highlight-1'): SavedHighlight {
  return {
    id,
    articleId: article.id,
    text,
    note: null,
    startOffset,
    endOffset: startOffset + text.length,
    readwiseStatus: 'saved',
    readwiseId: 'readwise-1',
    readerDocumentId: 'reader-document-1',
    readwiseError: null,
    createdAt: '2026-09-07T00:00:00.000Z',
  };
}

type HighlightHandler = (selectedArticle: Article, selection: { text: string; startOffset: number; endOffset: number }, note?: string) => Promise<{
  highlight: SavedHighlight;
  synchronized: boolean;
  warning?: string;
}>;
type NotifyHandler = (message: string) => void;

function renderReaderPane({
  selectedArticle = article,
  onHighlight = vi.fn(async (_article: Article, selection: { text: string; startOffset: number }) => ({
    synchronized: true,
    highlight: savedHighlight(selection.text, selection.startOffset),
  })),
  onNotify = vi.fn(),
}: {
  selectedArticle?: Article;
  onHighlight?: HighlightHandler;
  onNotify?: NotifyHandler;
} = {}) {
  return {
    onHighlight,
    onNotify,
    ...render(
      <ReaderPane
        article={selectedArticle}
        position={1}
        total={1}
        hasPrevious={false}
        hasNext={false}
        onClose={vi.fn()}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onToggleStar={vi.fn()}
        onToggleRead={vi.fn()}
        onNotify={onNotify}
        onHighlight={onHighlight}
        onSaveToReader={vi.fn()}
      />,
    ),
  };
}

function selectText(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

beforeEach(() => {
  apiMocks.getArticleHighlights.mockReset();
  apiMocks.getArticleHighlights.mockResolvedValue({ highlights: [] });
  apiMocks.retryReadwiseHighlight.mockReset();
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

describe('article highlights', () => {
  it('keeps selected text visibly highlighted after the save completes', async () => {
    const onHighlight = vi.fn().mockImplementation(async (_article: Article, selection: { text: string; startOffset: number; endOffset: number }) => ({
      synchronized: true,
      highlight: savedHighlight(selection.text, selection.startOffset),
    }));
    const { container } = renderReaderPane({ onHighlight });
    const paragraph = container.querySelector('.article-content p');
    const textNode = paragraph?.firstChild;
    if (!paragraph || !textNode) throw new Error('Article content did not render');
    const text = textNode.textContent ?? '';
    const start = text.indexOf('selected words');
    selectText(textNode, start, textNode, start + 'selected words'.length);

    fireEvent.mouseUp(paragraph);
    fireEvent.click(await screen.findByRole('button', { name: 'Highlight' }));

    await waitFor(() => expect(onHighlight).toHaveBeenCalledWith(
      article,
      expect.objectContaining({ text: 'selected words', startOffset: start, endOffset: start + 'selected words'.length }),
      undefined,
    ));
    expect(container.querySelector('mark[data-chadashot-highlight]')).toHaveTextContent('selected words');
  });

  it('captures keyboard selection changes across inline formatting', async () => {
    const selectedArticle = {
      ...article,
      contentHtml: '<p>Keyboard <strong>selection</strong> crosses nodes.</p>',
    };
    const { container, onHighlight } = renderReaderPane({ selectedArticle });
    const paragraph = container.querySelector('.article-content p');
    const startNode = paragraph?.firstChild;
    const endNode = paragraph?.querySelector('strong')?.firstChild;
    if (!startNode || !endNode) throw new Error('Cross-node article content did not render');

    selectText(startNode, 0, endNode, 'selection'.length);
    fireEvent(document, new Event('selectionchange'));

    fireEvent.click(await screen.findByRole('button', { name: 'Highlight' }));
    await waitFor(() => expect(onHighlight).toHaveBeenCalledWith(
      selectedArticle,
      expect.objectContaining({ text: 'Keyboard selection', startOffset: 0, endOffset: 18 }),
      undefined,
    ));
  });

  it('updates touch handle selections and clears actions for selections outside the article', async () => {
    const { container } = renderReaderPane();
    const paragraph = container.querySelector('.article-content p');
    const textNode = paragraph?.firstChild;
    if (!paragraph || !textNode) throw new Error('Article content did not render');
    const text = textNode.textContent ?? '';
    const start = text.indexOf('selected words');

    selectText(textNode, start, textNode, start + 'selected'.length);
    fireEvent.touchEnd(paragraph);
    expect(await screen.findByText('“selected”')).toBeInTheDocument();

    selectText(textNode, start, textNode, start + 'selected words should'.length);
    fireEvent(document, new Event('selectionchange'));
    expect(await screen.findByText('“selected words should”')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    expect(screen.getByRole('textbox', { name: 'Highlight note' })).toHaveFocus();

    const outside = document.createElement('p');
    outside.textContent = 'Outside selection';
    document.body.append(outside);
    selectText(outside.firstChild!, 0, outside.firstChild!, outside.textContent.length);
    fireEvent(document, new Event('selectionchange'));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Selected text actions' })).not.toBeInTheDocument());
    outside.remove();
  });

  it('does not let a late highlight load erase a newly saved mark', async () => {
    let resolveLoad!: (value: { highlights: SavedHighlight[] }) => void;
    apiMocks.getArticleHighlights.mockImplementation(() => new Promise((resolve) => { resolveLoad = resolve; }));
    const { container } = renderReaderPane();
    const textNode = container.querySelector('.article-content p')?.firstChild;
    if (!textNode) throw new Error('Article content did not render');
    const text = textNode.textContent ?? '';
    const start = text.indexOf('selected words');
    selectText(textNode, start, textNode, start + 'selected words'.length);

    fireEvent.mouseUp(textNode.parentElement!);
    fireEvent.click(await screen.findByRole('button', { name: 'Highlight' }));
    await waitFor(() => expect(container.querySelector('mark[data-chadashot-highlight]')).toHaveTextContent('selected words'));

    resolveLoad({ highlights: [] });
    await waitFor(() => expect(apiMocks.getArticleHighlights).toHaveBeenCalledWith(article.id, expect.any(AbortSignal)));
    expect(container.querySelector('mark[data-chadashot-highlight]')).toHaveTextContent('selected words');
  });

  it('reports highlight loading failures without claiming saved marks are empty', async () => {
    apiMocks.getArticleHighlights.mockRejectedValue(new Error('Server unavailable'));
    const { onNotify } = renderReaderPane();

    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Could not load saved highlights: Server unavailable'));
  });

  it('offers a retry for failed Reader delivery and updates the existing mark after confirmation', async () => {
    const failed = {
      ...savedHighlight('selected words', 'The '.length),
      readwiseStatus: 'failed' as const,
      readwiseId: null,
      readerDocumentId: 'reader-document-1',
      readwiseError: 'Readwise Reader timed out; try again',
    };
    const confirmed = { ...failed, readwiseStatus: 'saved' as const, readwiseId: 'reader-highlight-1', readwiseError: null };
    apiMocks.getArticleHighlights.mockResolvedValue({ highlights: [failed] });
    apiMocks.retryReadwiseHighlight.mockResolvedValue({ highlight: confirmed, synchronized: true, reused: true });
    const { container, onNotify } = renderReaderPane();

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(apiMocks.retryReadwiseHighlight).toHaveBeenCalledWith(failed.id, expect.objectContaining({
      articleId: article.id,
      contentHtml: article.contentHtml,
      articleText: 'The selected words should remain highlighted after saving.',
    })));
    expect(onNotify).toHaveBeenCalledWith('Highlight confirmed in Readwise Reader');
    expect(container.querySelector('mark[data-sync-status="saved"]')).toHaveTextContent('selected words');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});
