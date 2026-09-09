import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type ReadwiseCredentials = { token: string };

type FetchImplementation = typeof fetch;

export type ReaderDocument = {
  url: string;
  title: string;
  author: string | null;
  html?: string;
};

export type ReaderHighlight = ReaderDocument & {
  text: string;
  note?: string;
};

export type ReaderHighlightResult = {
  document: { id: string; url: string };
  highlightId: string;
  reused: boolean;
};

export class ReaderHighlightDeliveryError extends Error {
  constructor(message: string, readonly document: { id: string; url: string }) {
    super(message);
    this.name = 'ReaderHighlightDeliveryError';
  }
}

export type ReaderToolSession = {
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
};

export type ReaderToolSessionFactory = (credentials: ReadwiseCredentials) => Promise<ReaderToolSession>;

const READER_MCP_URL = 'https://mcp2.readwise.io/mcp';
const READER_MCP_TIMEOUT_MS = 30_000;

async function createReaderToolSession(credentials: ReadwiseCredentials): Promise<ReaderToolSession> {
  const client = new Client({ name: 'chadashot', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(READER_MCP_URL), {
    requestInit: { headers: { Authorization: `Token ${credentials.token}` } },
  });
  await client.connect(transport);
  return {
    async callTool(name, arguments_) {
      return client.callTool({ name, arguments: arguments_ }, undefined, { timeout: READER_MCP_TIMEOUT_MS });
    },
    async close() {
      await client.close();
    },
  };
}

function responseText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const content = Reflect.get(value, 'content');
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } => Boolean(
      item && typeof item === 'object' && Reflect.get(item, 'type') === 'text' && typeof Reflect.get(item, 'text') === 'string',
    ))
    .map((item) => item.text)
    .join('\n');
}

function parseJsonText(value: unknown) {
  const text = responseText(value).trim();
  if (!text) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function collectObjects(value: unknown, result: Record<string, unknown>[] = []) {
  if (!value || typeof value !== 'object') return result;
  if (Array.isArray(value)) {
    value.forEach((item) => collectObjects(item, result));
    return result;
  }
  const object = value as Record<string, unknown>;
  result.push(object);
  Object.values(object).forEach((item) => collectObjects(item, result));
  return result;
}

function highlightText(record: Record<string, unknown>) {
  for (const key of ['html_content', 'text', 'content', 'highlight']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function highlightId(record: Record<string, unknown>) {
  for (const key of ['highlight_document_id', 'document_id', 'id']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

function highlightNote(record: Record<string, unknown>) {
  for (const key of ['notes', 'note']) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function normalizedWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function readerHighlights(value: unknown) {
  const parsed = parseJsonText(value);
  return collectObjects(parsed)
    .map((record) => ({ id: highlightId(record), text: highlightText(record), note: highlightNote(record) }))
    .filter((record): record is { id: string; text: string; note: string | null } => Boolean(record.id && record.text));
}

function toolError(value: unknown) {
  if (!value || typeof value !== 'object' || Reflect.get(value, 'isError') !== true) return null;
  return responseText(value) || 'Reader rejected the highlight operation';
}

export class ReadwiseClient {
  constructor(
    private readonly credentials: ReadwiseCredentials,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly readerToolSessionFactory: ReaderToolSessionFactory = createReaderToolSession,
  ) {}

  private safeError(error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replaceAll(this.credentials.token, '[redacted]');
    if (/401|unauthori[sz]ed|invalid (access )?token/i.test(message)) return 'Readwise rejected this access token';
    if (/429|rate.?limit/i.test(message)) return 'Readwise rate limit reached; try again shortly';
    if (/timed? ?out|timeout/i.test(message)) return 'Readwise Reader timed out; try again';
    if (/not found|could not find|cannot find|exact text|anchor/i.test(message)) {
      return 'Reader could not anchor the selected text in this document; the local highlight is ready to retry';
    }
    return `Readwise Reader request failed: ${message}`;
  }

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

  async saveDocument(document: ReaderDocument) {
    const response = await this.request('https://readwise.io/api/v3/save/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: document.url,
        html: document.html,
        title: document.title,
        author: document.author ?? undefined,
        category: 'article',
        location: 'new',
        saved_using: 'chadashot',
      }),
    });
    return response.json() as Promise<{ id: string; url: string }>;
  }

  async createReaderHighlight(highlight: ReaderHighlight): Promise<ReaderHighlightResult> {
    const document = await this.saveDocument(highlight);
    let session: ReaderToolSession | null = null;
    try {
      session = await this.readerToolSessionFactory(this.credentials);
      const before = await session.callTool('reader_get_document_highlights', { document_id: document.id });
      const beforeError = toolError(before);
      if (beforeError) throw new Error(beforeError);
      const expectedText = normalizedWhitespace(highlight.text);
      const existing = readerHighlights(before).find((item) => normalizedWhitespace(item.text) === expectedText);
      if (existing) {
        if (highlight.note !== undefined && existing.note !== highlight.note) {
          const noted = await session.callTool('reader_set_highlight_notes', {
            document_id: document.id,
            highlight_document_id: existing.id,
            notes: highlight.note,
          });
          const noteError = toolError(noted);
          if (noteError) throw new Error(noteError);
          const verifiedNote = await session.callTool('reader_get_document_highlights', { document_id: document.id });
          const match = readerHighlights(verifiedNote).find((item) => item.id === existing.id && normalizedWhitespace(item.text) === expectedText);
          if (!match || match.note !== highlight.note) throw new Error('Reader did not return the requested note after updating the highlight');
        }
        return { document, highlightId: existing.id, reused: true };
      }

      const created = await session.callTool('reader_create_highlight', {
        document_id: document.id,
        html_content: highlight.text,
        note: highlight.note ?? null,
      });
      const createError = toolError(created);
      if (createError) throw new Error(createError);

      const after = await session.callTool('reader_get_document_highlights', { document_id: document.id });
      const afterError = toolError(after);
      if (afterError) throw new Error(afterError);
      const verified = readerHighlights(after).find((item) => normalizedWhitespace(item.text) === expectedText);
      if (!verified) throw new Error('Reader did not return the selected text after creating the highlight');
      if (highlight.note !== undefined && verified.note !== highlight.note) {
        throw new Error('Reader did not return the requested note after creating the highlight');
      }
      return { document, highlightId: verified.id, reused: false };
    } catch (error) {
      throw new ReaderHighlightDeliveryError(this.safeError(error), document);
    } finally {
      await session?.close().catch(() => undefined);
    }
  }
}
