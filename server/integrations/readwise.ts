export type ReadwiseCredentials = { token: string };

type FetchImplementation = typeof fetch;

export type ReadwiseHighlight = {
  text: string;
  title: string;
  author: string | null;
  sourceUrl: string;
  note?: string;
  location?: number;
};

export type ReaderDocument = {
  url: string;
  title: string;
  author: string | null;
};

export class ReadwiseClient {
  constructor(
    private readonly credentials: ReadwiseCredentials,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  private async request(url: string, init?: RequestInit) {
    const response = await this.fetchImplementation(url, {
      ...init,
      headers: {
        Authorization: `Token ${this.credentials.token}`,
        Accept: 'application/json',
        ...init?.headers,
      },
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Readwise rejected this access token');
      if (response.status === 429) throw new Error('Readwise rate limit reached; try again shortly');
      throw new Error(`Readwise request failed (${response.status})`);
    }
    return response;
  }

  async validateCredentials() {
    await this.request('https://readwise.io/api/v2/auth/');
  }

  async createHighlight(highlight: ReadwiseHighlight) {
    const response = await this.request('https://readwise.io/api/v2/highlights/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ highlights: [{
        text: highlight.text,
        title: highlight.title,
        author: highlight.author ?? undefined,
        source_url: highlight.sourceUrl,
        source_type: 'rss',
        category: 'articles',
        note: highlight.note || undefined,
        location: highlight.location,
        location_type: highlight.location === undefined ? undefined : 'offset',
      }] }),
    });
    const result = await response.json().catch(() => null) as unknown;
    if (Array.isArray(result) && Array.isArray(result[0]?.modified_highlights) && typeof result[0].modified_highlights[0] === 'number') {
      return String(result[0].modified_highlights[0]);
    }
    return null;
  }

  async saveDocument(document: ReaderDocument) {
    const response = await this.request('https://readwise.io/api/v3/save/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: document.url,
        title: document.title,
        author: document.author ?? undefined,
        category: 'article',
        location: 'new',
        saved_using: 'chadashot',
      }),
    });
    return response.json() as Promise<{ id: string; url: string }>;
  }
}
