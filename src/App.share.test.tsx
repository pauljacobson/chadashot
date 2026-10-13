// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderPane } from './App';
import type { Article } from '../shared/reader';
import { featureFlags } from '../shared/features';

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  getArticleHighlights: vi.fn().mockResolvedValue({ highlights: [] }),
}));

const article: Article = {
  id: 'share-article', feedId: 'feed-1', folderIds: [], title: 'An article worth sharing',
  canonicalUrl: 'https://example.test/article', author: null, source: 'Example',
  publishedAt: '2026-10-13T00:00:00.000Z', readingMinutes: 2, summary: '',
  contentHtml: '<p>Article content.</p>', read: false, starred: false,
};

function openArticle(selectedArticle = article) {
  const onNotify = vi.fn();
  render(<ReaderPane article={selectedArticle} position={1} total={1} hasPrevious={false} hasNext={false}
    onClose={vi.fn()} onPrevious={vi.fn()} onNext={vi.fn()} onToggleStar={vi.fn()}
    onToggleRead={vi.fn()} onNotify={onNotify} onHighlight={vi.fn()} onSaveToReader={vi.fn()} />);
  return { onNotify };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); featureFlags.readerDocumentSaving = false; });

describe('article sharing', () => {
  it('restores document saving alongside sharing when the feature flag is enabled', () => {
    featureFlags.readerDocumentSaving = true;
    openArticle();
    expect(screen.getByRole('button', { name: 'Save to Reader' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share article' })).toBeInTheDocument();
  });

  it('replaces document saving and invokes native sharing directly with the original URL', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share });
    openArticle();
    expect(screen.queryByRole('button', { name: 'Save to Reader' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    // Invocation must happen during the click, before any asynchronous preparation.
    expect(share).toHaveBeenCalledWith({ title: 'An article worth sharing', url: 'https://example.test/article' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share article' })).toBeEnabled());
  });

  it('copies the link when native sharing is unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { onNotify } = openArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Link copied'));
    expect(writeText).toHaveBeenCalledWith('https://example.test/article');
  });

  it('treats share cancellation quietly without copying anything', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')), clipboard: { writeText } });
    const { onNotify } = openArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Share article' })).toBeEnabled());
    expect(onNotify).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Share article link' })).not.toBeInTheDocument();
  });

  it.each(['#', '', 'javascript:alert(1)', '/relative', 'https://user:password@example.test'])('rejects unsafe or missing original URL %s', async (canonicalUrl) => {
    const share = vi.fn();
    vi.stubGlobal('navigator', { share });
    const { onNotify } = openArticle({ ...article, canonicalUrl });
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    expect(onNotify).toHaveBeenCalledWith('This article has no valid original link to share');
    expect(share).not.toHaveBeenCalled();
  });

  it('provides a selectable link and explicit copy action when native sharing fails', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share: vi.fn().mockRejectedValue(new DOMException('Blocked', 'NotAllowedError')), clipboard: { writeText } });
    const { onNotify } = openArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    const input = await screen.findByRole('textbox', { name: 'Article link' });
    expect(input).toHaveValue('https://example.test/article');
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Link copied'));
  });

  it('keeps the selectable link available when clipboard access is denied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    const { onNotify } = openArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    expect(await screen.findByRole('textbox', { name: 'Article link' })).toHaveValue('https://example.test/article');
    expect(onNotify).not.toHaveBeenCalledWith('Link copied');
  });

  it('uses copying when the device cannot share this payload', async () => {
    const share = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { share, canShare: () => false, clipboard: { writeText } });
    const { onNotify } = openArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('Link copied'));
    expect(share).not.toHaveBeenCalled();
  });

  it('provides manual sharing if both native sharing and clipboard support are absent', async () => {
    vi.stubGlobal('navigator', {});
    openArticle();
    fireEvent.click(screen.getByRole('button', { name: 'Share article' }));
    const link = await screen.findByRole('textbox', { name: 'Article link' });
    expect(link).toHaveValue('https://example.test/article');
    expect(link).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Share article link' })).not.toBeInTheDocument();
  });

  it('prevents duplicate shares while the native sheet is open', async () => {
    let finishShare!: () => void;
    const share = vi.fn(() => new Promise<void>((resolve) => { finishShare = resolve; }));
    vi.stubGlobal('navigator', { share });
    openArticle();
    const button = screen.getByRole('button', { name: 'Share article' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(share).toHaveBeenCalledOnce();
    finishShare();
    await waitFor(() => expect(button).toBeEnabled());
  });
});
