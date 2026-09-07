import { z } from 'zod';
import type { ArticleMutation, ReaderSnapshot } from '../../shared/reader.js';

export const BIRCHFEED_API_URL = 'https://birchfeed.app/api/greader.php';

export type GoogleReaderCredentials = {
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
    categories: z.array(z.object({ id: z.string(), label: z.string().optional() })).default([]),
  })),
});

const streamSchema = z.object({
  items: z.array(z.object({
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
  })),
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

function publishedAt(item: z.infer<typeof streamSchema>['items'][number]) {
  if (item.published) return new Date(item.published * 1000).toISOString();
  if (item.updated) return new Date(item.updated * 1000).toISOString();
  if (item.timestampUsec) return new Date(Number(item.timestampUsec) / 1000).toISOString();
  return new Date(0).toISOString();
}

export class GoogleReaderClient {
  constructor(
    private readonly credentials: GoogleReaderCredentials,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly baseUrl = BIRCHFEED_API_URL,
  ) {}

  private async authenticate() {
    const body = new URLSearchParams({
      Email: this.credentials.email,
      Passwd: this.credentials.apiKey,
      accountType: 'HOSTED_OR_GOOGLE',
      service: 'reader',
      source: 'chadashot',
    });
    const response = await this.fetchImplementation(`${this.baseUrl}/accounts/ClientLogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error('Birchfeed rejected the email or API key');
    const auth = (await response.text()).split('\n').find((line) => line.startsWith('Auth='))?.slice(5);
    if (!auth) throw new Error('Birchfeed returned an invalid authentication response');
    return auth;
  }

  private async authorizedRequest(path: string, auth: string, init?: RequestInit) {
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `GoogleLogin auth=${auth}`,
        ...init?.headers,
      },
    });
    if (!response.ok) throw new Error(`Birchfeed request failed (${response.status})`);
    return response;
  }

  async validateCredentials() {
    await this.authenticate();
  }

  async snapshot(): Promise<ReaderSnapshot> {
    const auth = await this.authenticate();
    const [subscriptionsResponse, streamResponse] = await Promise.all([
      this.authorizedRequest('/reader/api/0/subscription/list?output=json', auth),
      this.authorizedRequest('/reader/api/0/stream/contents/user/-/state/com.google/reading-list?output=json&n=300', auth),
    ]);
    const subscriptionsResult = subscriptionListSchema.parse(await subscriptionsResponse.json());
    const streamResult = streamSchema.parse(await streamResponse.json());

    const subscriptions = subscriptionsResult.subscriptions.map((subscription) => ({
      id: subscription.id,
      title: subscription.title,
      url: subscription.url ?? subscription.id.replace(/^feed\//, ''),
      siteUrl: subscription.htmlUrl ?? null,
      folderIds: subscription.categories.map((category) => folderId(category.id)),
      unreadCount: 0,
    }));
    const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));

    const articles = streamResult.items.map((item) => {
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
      source: 'birchfeed',
      folders: [...folderMap.values()],
      subscriptions,
      articles,
    };
  }

  async mutate(mutation: ArticleMutation) {
    const auth = await this.authenticate();
    const token = await (await this.authorizedRequest('/reader/api/0/token', auth)).text();
    const tag = mutation.operation === 'read'
      ? 'user/-/state/com.google/read'
      : 'user/-/state/com.google/starred';
    const body = new URLSearchParams({ i: mutation.articleId, T: token, [mutation.value ? 'a' : 'r']: tag });
    await this.authorizedRequest('/reader/api/0/edit-tag', auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  }
}
