import { describe, expect, it, vi } from 'vitest';
import { ReaderHighlightDeliveryError, ReadwiseClient, type ReaderToolSessionFactory } from './readwise.js';

function toolResult(value: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

describe('Readwise integration', () => {
  it('saves the document, creates an exact-text Reader highlight, and verifies it by reading it back', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/api/v3/save/')) {
        return new Response(JSON.stringify({ id: 'doc-1', url: 'https://read.readwise.io/new/read/doc-1' }), { status: 201 });
      }
      throw new Error(`Unexpected URL: ${String(input)}`);
    });
    const callTool = vi.fn()
      .mockResolvedValueOnce(toolResult({ highlights: [] }))
      .mockResolvedValueOnce(toolResult({ success: true }))
      .mockResolvedValueOnce(toolResult({ highlights: [{ id: 'highlight-1', text: 'A useful passage', notes: 'Remember this' }] }));
    const close = vi.fn().mockResolvedValue(undefined);
    const factory: ReaderToolSessionFactory = vi.fn(async () => ({ callTool, close }));
    const client = new ReadwiseClient({ token: 'token' }, fetchMock, factory);

    const result = await client.createReaderHighlight({
      text: 'A useful passage',
      title: 'Article',
      author: 'Author',
      url: 'https://example.test/article',
      html: '<p>A useful passage</p>',
      note: 'Remember this',
    });

    expect(result).toEqual({
      document: { id: 'doc-1', url: 'https://read.readwise.io/new/read/doc-1' },
      highlightId: 'highlight-1',
      reused: false,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      url: 'https://example.test/article', html: '<p>A useful passage</p>', saved_using: 'chadashot',
    });
    expect(callTool.mock.calls).toEqual([
      ['reader_get_document_highlights', { document_id: 'doc-1' }],
      ['reader_create_highlight', { document_id: 'doc-1', html_content: 'A useful passage', note: 'Remember this' }],
      ['reader_get_document_highlights', { document_id: 'doc-1' }],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('reuses an existing Reader document and matching highlight without creating a duplicate', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: 'doc-existing', url: 'https://read.readwise.io/new/read/doc-existing',
    }), { status: 200 }));
    const callTool = vi.fn().mockResolvedValue(toolResult({
      highlights: [{ id: 'highlight-existing', html_content: 'Same\npassage' }],
    }));
    const factory: ReaderToolSessionFactory = vi.fn(async () => ({ callTool, close: vi.fn().mockResolvedValue(undefined) }));

    const result = await new ReadwiseClient({ token: 'token' }, fetchMock, factory).createReaderHighlight({
      text: 'Same passage', title: 'Article', author: null, url: 'https://example.test/article',
    });

    expect(result).toMatchObject({ highlightId: 'highlight-existing', reused: true, document: { id: 'doc-existing' } });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('updates and verifies the note when reusing a matching Reader highlight', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(toolResult({ highlights: [{ id: 'highlight-existing', content: 'Same passage', notes: 'Old note' }] }))
      .mockResolvedValueOnce(toolResult({ success: true }))
      .mockResolvedValueOnce(toolResult({ highlights: [{ id: 'highlight-existing', content: 'Same passage', notes: 'New note' }] }));
    const factory: ReaderToolSessionFactory = vi.fn(async () => ({ callTool, close: vi.fn().mockResolvedValue(undefined) }));
    const client = new ReadwiseClient(
      { token: 'token' },
      async () => new Response(JSON.stringify({ id: 'doc-existing', url: 'https://read.readwise.io/new/read/doc-existing' }), { status: 200 }),
      factory,
    );

    const result = await client.createReaderHighlight({
      text: 'Same passage', note: 'New note', title: 'Article', author: null, url: 'https://example.test/article',
    });

    expect(result).toMatchObject({ highlightId: 'highlight-existing', reused: true });
    expect(callTool.mock.calls[1]).toEqual(['reader_set_highlight_notes', {
      document_id: 'doc-existing', highlight_document_id: 'highlight-existing', notes: 'New note',
    }]);
  });

  it.each([
    ['authentication', new Error('401 Unauthorized'), 'Readwise rejected this access token'],
    ['rate limiting', new Error('429 rate limit'), 'Readwise rate limit reached'],
    ['timeout', new Error('request timed out'), 'Readwise Reader timed out'],
  ])('maps %s failures to a recoverable error while retaining the document identifier', async (_name, providerError, expected) => {
    const factory: ReaderToolSessionFactory = vi.fn(async () => ({
      callTool: vi.fn().mockRejectedValue(providerError),
      close: vi.fn().mockResolvedValue(undefined),
    }));
    const client = new ReadwiseClient(
      { token: 'private-token' },
      async () => new Response(JSON.stringify({ id: 'doc-1', url: 'https://read.readwise.io/new/read/doc-1' }), { status: 201 }),
      factory,
    );

    await expect(client.createReaderHighlight({
      text: 'Passage', title: 'Article', author: null, url: 'https://example.test/article',
    })).rejects.toMatchObject<ReaderHighlightDeliveryError>({ message: expect.stringContaining(expected), document: { id: 'doc-1' } });
  });

  it('reports text-not-found without substituting a Readwise-only highlight', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce(toolResult({ highlights: [] }))
      .mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Exact text not found in document' }] });
    const factory: ReaderToolSessionFactory = vi.fn(async () => ({ callTool, close: vi.fn().mockResolvedValue(undefined) }));
    const client = new ReadwiseClient(
      { token: 'token' },
      async () => new Response(JSON.stringify({ id: 'doc-1', url: 'https://read.readwise.io/new/read/doc-1' }), { status: 201 }),
      factory,
    );

    await expect(client.createReaderHighlight({
      text: 'Divergent passage', title: 'Article', author: null, url: 'https://example.test/article',
    })).rejects.toThrow('could not anchor');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('reports invalid tokens without exposing them', async () => {
    const client = new ReadwiseClient({ token: 'private-token' }, async () => new Response('', { status: 401 }));
    await expect(client.validateCredentials()).rejects.toThrow('Readwise rejected this access token');
  });
});
