import { z } from 'zod';
import type { ArticleMutation, ReaderSnapshot } from '../../shared/reader.js';

export const BIRCHFEED_API_URL = 'https://birchfeed.app/api/greader.php';

export type GoogleReaderCredentials = {
  serverUrl: string;
  email: string;
  apiKey: string;
};

type FetchImplementation = typeof fetch;

const subscriptionListSchema = z.object({
  subscriptions: z.array(z.object({
    id: z.string(),
    title: z.string(),
    url: z.string().optional(),
    htmlUrl: z.string().optional(),
    iconUrl: z.string().optional(),
    categories: z.array(z.object({ id: z.string(), label: z.string().optional() })).default([]),
  })),
});

const streamItemSchema = z.object({
    id: z.string(),
    title: z.string().default('Untitled'),
    author: z.string().optional(),
    published: z.number().optional(),
    updated: z.number().optional(),
    timestampUsec: z.string().optional(),
    categories: z.array(z.string()).default([]),
    canonical: z.array(z.object({ href: z.string() })).optional(),
    alternate: z.array(z.object({ href: z.string() })).optional(),
    summary: z.object({ content: z.string() }).optional(),
    content: z.object({ content: z.string() }).optional(),
    origin: z.object({ streamId: z.string(), title: z.string().optional(), htmlUrl: z.string().optional() }),
});

const streamSchema = z.object({
  items: z.array(streamItemSchema),
  continuation: z.coerce.string().min(1).optional(),
});

const STREAM_PAGE_SIZE = 1_000;

const quickAddSchema = z.object({
  numResults: z.number(),
  query: z.string().optional(),
  streamId: z.string().optional(),
  streamName: z.string().optional(),
  error: z.string().optional(),
});

function folderId(categoryId: string) {
  return `folder:${categoryId}`;
}

function plainText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function publishedAt(item: z.infer<typeof streamItemSchema>) {
  if (item.published) return new Date(item.published * 1000).toISOString();
  if (item.updated) return new Date(item.updated * 1000).toISOString();
  if (item.timestampUsec) return new Date(Number(item.timestampUsec) / 1000).toISOString();
  return new Date(0).toISOString();
}

export class GoogleReaderClient {
  constructor(
    private readonly credentials: GoogleReaderCredentials,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  private get baseUrl() {
    return this.credentials.serverUrl.replace(/\/+$/, '');
  }

  private iconUrl(iconUrl: string | undefined) {
    if (!iconUrl) return null;
    try {
      const resolved = new URL(iconUrl, `${this.baseUrl}/`);
      return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : null;
    } catch {
      return null;
    }
  }

  private async request(url: string, init?: RequestInit) {
    try {
      return await this.fetchImplementation(url, init);
    } catch {
      throw new Error('Could not reach the RSS service. Check the server URL and try again.');
    }
  }

  private async authenticate() {
    const body = new URLSearchParams({
      Email: this.credentials.email,
      Passwd: this.credentials.apiKey,
      accountType: 'HOSTED_OR_GOOGLE',
      service: 'reader',
      source: 'chadashot',
    });
    const response = await this.request(`${this.baseUrl}/accounts/ClientLogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error('The RSS service rejected the email or API key');
    const auth = (await response.text()).split('\n').find((line) => line.startsWith('Auth='))?.slice(5);
    if (!auth) throw new Error('The RSS service returned an invalid authentication response');
    return auth;
  }

  private async authorizedRequest(path: string, auth: string, init?: RequestInit) {
    const response = await this.request(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `GoogleLogin auth=${auth}`,
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`RSS service request failed (${response.status})`);
    return response;
  }

  async validateCredentials() {
    await this.authenticate();
  }

  private async allStreamItems(auth: string) {
    const items = [] as z.infer<typeof streamItemSchema>[];
    const itemIds = new Set<string>();
    const continuationTokens = new Set<string>();
    let continuation: string | undefined;

    do {
      const query = new URLSearchParams({ output: 'json', n: String(STREAM_PAGE_SIZE) });
      if (continuation) query.set('c', continuation);
      const response = await this.authorizedRequest(
        `/reader/api/0/stream/contents/user/-/state/com.google/reading-list?${query}`,
        auth,
      );
      const page = streamSchema.parse(await response.json());
      for (const item of page.items) {
        if (itemIds.has(item.id)) continue;
        itemIds.add(item.id);
        items.push(item);
      }

      const nextContinuation = page.continuation;
      if (!nextContinuation) break;
      if (continuationTokens.has(nextContinuation)) {
        throw new Error('RSS service returned a repeating continuation token');
      }
      continuationTokens.add(nextContinuation);
      continuation = nextContinuation;
    } while (continuation);

    return items;
  }

  async snapshot(): Promise<ReaderSnapshot> {
    const auth = await this.authenticate();
    const [subscriptionsResponse, streamItems] = await Promise.all([
      this.authorizedRequest('/reader/api/0/subscription/list?output=json', auth),
      this.allStreamItems(auth),
    ]);
    const subscriptionsResult = subscriptionListSchema.parse(await subscriptionsResponse.json());

    const subscriptions = subscriptionsResult.subscriptions.map((subscription) => ({
      id: subscription.id,
      title: subscription.title,
      url: subscription.url ?? subscription.id.replace(/^feed\//, ''),
      siteUrl: subscription.htmlUrl ?? null,
      iconUrl: this.iconUrl(subscription.iconUrl),
      folderIds: subscription.categories.map((category) => folderId(category.id)),
      unreadCount: 0,
    }));
    const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));

    const articles = streamItems.map((item) => {
      const html = item.content?.content ?? item.summary?.content ?? '';
      const text = plainText(html);
      const subscription = subscriptionsById.get(item.origin.streamId);
      const read = item.categories.includes('user/-/state/com.google/read');
      if (subscription && !read) subscription.unreadCount += 1;
      return {
        id: item.id,
        feedId: item.origin.streamId,
        folderIds: subscription?.folderIds ?? [],
        title: item.title,
        author: item.author ?? null,
        source: item.origin.title ?? subscription?.title ?? 'Unknown feed',
        canonicalUrl: item.canonical?.[0]?.href ?? item.alternate?.[0]?.href ?? item.origin.htmlUrl ?? '#',
        publishedAt: publishedAt(item),
        readingMinutes: Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 220)),
        summary: text.slice(0, 240),
        contentHtml: html,
        read,
        starred: item.categories.includes('user/-/state/com.google/starred'),
      };
    });

    const folderMap = new Map<string, { id: string; title: string; unreadCount: number }>();
    for (const source of subscriptionsResult.subscriptions) {
      for (const category of source.categories) {
        const id = folderId(category.id);
        folderMap.set(id, {
          id,
          title: category.label ?? category.id.split('/').at(-1) ?? 'Folder',
          unreadCount: (folderMap.get(id)?.unreadCount ?? 0) + (subscriptionsById.get(source.id)?.unreadCount ?? 0),
        });
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      source: 'google-reader',
      folders: [...folderMap.values()],
      subscriptions,
      articles,
    };
  }

  async mutate(mutation: ArticleMutation) {
    await this.mutateMany([mutation]);
  }

  async mutateMany(mutations: ArticleMutation[]) {
    const auth = await this.authenticate();
    const token = await (await this.authorizedRequest('/reader/api/0/token', auth)).text();
    const groups = new Map<string, ArticleMutation[]>();
    for (const mutation of mutations) {
      const key = `${mutation.operation}:${mutation.value}`;
      groups.set(key, [...(groups.get(key) ?? []), mutation]);
    }

    for (const group of groups.values()) {
      const mutation = group[0];
      if (!mutation) continue;
      const tag = mutation.operation === 'read'
        ? 'user/-/state/com.google/read'
        : 'user/-/state/com.google/starred';
      const body = new URLSearchParams({ T: token, [mutation.value ? 'a' : 'r']: tag });
      for (const item of group) body.append('i', item.articleId);
      await this.authorizedRequest('/reader/api/0/edit-tag', auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    }
  }

  async subscribe(feedUrl: string) {
    const auth = await this.authenticate();
    const token = await (await this.authorizedRequest('/reader/api/0/token', auth)).text();
    const quickAddBody = new URLSearchParams({ quickadd: feedUrl, T: token });
    const quickAddResponse = await this.request(`${this.baseUrl}/reader/api/0/subscription/quickadd?output=json`, {
      method: 'POST',
      headers: {
        Authorization: `GoogleLogin auth=${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: quickAddBody,
    });

    if (quickAddResponse.ok) {
      const result = quickAddSchema.parse(await quickAddResponse.json());
      if (result.numResults < 1) throw new Error(result.error || 'The RSS service could not find a feed at that URL');
      return {
        id: result.streamId ?? `feed/${feedUrl}`,
        title: result.streamName ?? result.query ?? feedUrl,
        url: result.query ?? feedUrl,
      };
    }

    if (![404, 405].includes(quickAddResponse.status)) {
      throw new Error(`RSS service subscription failed (${quickAddResponse.status})`);
    }

    const editBody = new URLSearchParams({ ac: 'subscribe', s: `feed/${feedUrl}`, T: token });
    const editResponse = await this.authorizedRequest('/reader/api/0/subscription/edit', auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: editBody,
    });
    if ((await editResponse.text()).trim() !== 'OK') throw new Error('The RSS service did not confirm the subscription');
    return { id: `feed/${feedUrl}`, title: feedUrl, url: feedUrl };
  }
}
