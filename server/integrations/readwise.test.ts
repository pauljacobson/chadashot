import { describe, expect, it, vi } from 'vitest';
import { ReadwiseClient } from './readwise.js';

describe('Readwise integration', () => {
  it('keeps highlight creation separate from Reader document saving', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v2/highlights/')) return new Response(JSON.stringify([{ id: 42, modified_highlights: [123] }]), { status: 200 });
      if (url.endsWith('/api/v3/save/')) return new Response(JSON.stringify({ id: 'doc-1', url: 'https://readwise.io/reader/doc-1' }), { status: 201 });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new ReadwiseClient({ token: 'token' }, fetchMock);

    const highlightId = await client.createHighlight({
      text: 'A useful passage', title: 'Article', author: 'Author', sourceUrl: 'https://example.test/article', note: 'Remember this', location: 12,
    });
    const document = await client.saveDocument({ url: 'https://example.test/article', title: 'Article', author: 'Author' });

    expect(highlightId).toBe('123');
    expect(document.id).toBe('doc-1');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('A useful passage');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('"location_type":"offset"');
    expect(String(fetchMock.mock.calls[1][1]?.body)).not.toContain('A useful passage');
  });

  it('reports invalid tokens without exposing them', async () => {
    const client = new ReadwiseClient({ token: 'private-token' }, async () => new Response('', { status: 401 }));
    await expect(client.validateCredentials()).rejects.toThrow('Readwise rejected this access token');
  });
});
