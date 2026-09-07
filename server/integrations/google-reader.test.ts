import { describe, expect, it, vi } from 'vitest';
import { GoogleReaderClient } from './google-reader.js';

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Google Reader compatible Birchfeed client', () => {
  it('turns transport failures into an actionable connection error', async () => {
    const client = new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, async () => { throw new TypeError('fetch failed'); });
    await expect(client.validateCredentials()).rejects.toThrow('Could not reach the RSS service. Check the server URL and try again.');
  });

  it('maps subscriptions, folders and items into the reader model', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('SID=ignored\nAuth=reader-key\n');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/https://example.test/feed', title: 'Example', url: 'https://example.test/feed', htmlUrl: 'https://example.test', iconUrl: '../f.php?h=abc',
        categories: [{ id: 'user/-/label/Tech', label: 'Tech' }],
      }] });
      if (url.includes('/stream/contents/')) return jsonResponse({ items: [{
        id: 'tag:google.com,2005:reader/item/abc', title: 'A careful web', author: 'Author', published: 1_700_000_000,
        categories: ['user/-/state/com.google/starred'], canonical: [{ href: 'https://example.test/article' }],
        content: { content: '<p>A useful article with a few words.</p>' },
        origin: { streamId: 'feed/https://example.test/feed', title: 'Example' },
      }] });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const snapshot = await new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php/', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock).snapshot();
    expect(snapshot.source).toBe('google-reader');
    expect(fetchMock.mock.calls[0][0]).toBe('https://reader.example.test/api/greader.php/accounts/ClientLogin');
    expect(snapshot.folders).toEqual([{ id: 'folder:user/-/label/Tech', title: 'Tech', unreadCount: 1 }]);
    expect(snapshot.subscriptions[0]).toMatchObject({ title: 'Example', unreadCount: 1, iconUrl: 'https://reader.example.test/api/f.php?h=abc' });
    expect(snapshot.articles[0]).toMatchObject({ title: 'A careful web', starred: true, read: false, folderIds: ['folder:user/-/label/Tech'] });
  });

  it('follows continuation tokens without imposing a total item limit', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.pathname.includes('/subscription/list')) return jsonResponse({ subscriptions: [{
        id: 'feed/1', title: 'Example', categories: [],
      }] });
      if (url.pathname.includes('/stream/contents/')) {
        const continuation = url.searchParams.get('c');
        const article = (id: string) => ({
          id,
          title: id,
          categories: [],
          origin: { streamId: 'feed/1', title: 'Example' },
        });
        if (!continuation) return jsonResponse({ items: [article('article-1')], continuation: 'next page' });
        if (continuation === 'next page') return jsonResponse({ items: [article('article-2')] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const snapshot = await new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock).snapshot();

    expect(snapshot.articles.map((article) => article.id)).toEqual(['article-1', 'article-2']);
    const streamRequests = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.includes('/stream/contents/'));
    expect(streamRequests).toHaveLength(2);
    expect(streamRequests[0]?.searchParams.get('n')).toBe('1000');
    expect(streamRequests[1]?.searchParams.get('c')).toBe('next page');
  });

  it('stops a malformed service from repeating the same continuation forever', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.includes('/subscription/list')) return jsonResponse({ subscriptions: [] });
      if (url.includes('/stream/contents/')) return jsonResponse({ items: [], continuation: 'repeated' });
      throw new Error(`Unexpected URL: ${url}`);
    });

    const client = new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock);

    await expect(client.snapshot()).rejects.toThrow('RSS service returned a repeating continuation token');
  });

  it('uses the edit-tag endpoint for state changes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/token')) return new Response('csrf-token');
      if (url.endsWith('/edit-tag')) return new Response('OK');
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock);
    await client.mutate({ articleId: 'article-1', operation: 'read', value: true });
    const request = fetchMock.mock.calls.at(-1);
    expect(String(request?.[0])).toContain('/edit-tag');
    expect(String(request?.[1]?.body)).toContain('a=user%2F-%2Fstate%2Fcom.google%2Fread');
  });

  it('sends same-state article changes as one edit-tag request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/token')) return new Response('csrf-token');
      if (url.endsWith('/edit-tag')) return new Response('OK');
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock);

    await client.mutateMany([
      { articleId: 'article-1', operation: 'read', value: true },
      { articleId: 'article-2', operation: 'read', value: true },
    ]);

    const editRequests = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/edit-tag'));
    expect(editRequests).toHaveLength(1);
    const body = new URLSearchParams(String(editRequests[0][1]?.body));
    expect(body.getAll('i')).toEqual(['article-1', 'article-2']);
    expect(body.get('a')).toBe('user/-/state/com.google/read');
  });

  it('subscribes through quickadd with the service write token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/token')) return new Response('write-token');
      if (url.includes('/subscription/quickadd')) return new Response(JSON.stringify({
        numResults: 1,
        query: 'https://example.test/feed.xml',
        streamId: 'feed/42',
        streamName: 'Example feed',
      }), { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock);

    const subscription = await client.subscribe('https://example.test/feed.xml');
    expect(subscription).toEqual({ id: 'feed/42', title: 'Example feed', url: 'https://example.test/feed.xml' });
    const body = String(fetchMock.mock.calls.at(-1)?.[1]?.body);
    expect(body).toContain('quickadd=https%3A%2F%2Fexample.test%2Ffeed.xml');
    expect(body).toContain('T=write-token');
  });

  it('falls back to subscription edit when quickadd is unavailable', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/accounts/ClientLogin')) return new Response('Auth=reader-key\n');
      if (url.endsWith('/token')) return new Response('write-token');
      if (url.includes('/subscription/quickadd')) return new Response('', { status: 404 });
      if (url.endsWith('/subscription/edit')) return new Response('OK');
      throw new Error(`Unexpected URL: ${url}`);
    });
    const client = new GoogleReaderClient({
      serverUrl: 'https://reader.example.test/api/greader.php', email: 'reader@example.test', apiKey: 'secret',
    }, fetchMock);

    await client.subscribe('https://example.test/feed.xml');
    const body = String(fetchMock.mock.calls.at(-1)?.[1]?.body);
    expect(body).toContain('ac=subscribe');
    expect(body).toContain('s=feed%2Fhttps%3A%2F%2Fexample.test%2Ffeed.xml');
  });
});
