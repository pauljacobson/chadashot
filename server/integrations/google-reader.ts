import crypto from 'node:crypto';
import { z } from 'zod';
import type { Article, ArticleMutation, Folder, ReaderSnapshot, Subscription } from '../../shared/reader.js';
import type { ReaderPerformanceRun, ReaderPhase } from '../reader-performance.js';

export const BIRCHFEED_API_URL = 'https://birchfeed.app/api/greader.php';

export type GoogleReaderCredentials = {
  serverUrl: string;
  email: string;
  apiKey: string;
};

export type GoogleReaderImportSink = {
  stageStructure: (folders: Folder[], subscriptions: Subscription[]) => void | Promise<void>;
  stageArticles: (articles: Article[]) => void | Promise<void>;
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

const itemIdsSchema = z.object({
  itemRefs: z.array(z.object({ id: z.string() })),
  continuation: z.coerce.string().min(1).optional(),
});

const unreadCountSchema = z.object({
  unreadcounts: z.array(z.object({
    id: z.string(),
    count: z.coerce.number().int().nonnegative(),
  })),
});

const STREAM_PAGE_SIZE = 1_000;
const SESSION_CACHE_LIMIT = 32;
const AUTH_TTL_MS = 5 * 60 * 1_000;
const WRITE_TOKEN_TTL_MS = 2 * 60 * 1_000;
const MAX_REQUEST_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5_000;

type SessionCacheEntry = {
  auth?: { value: string; expiresAt: number };
  authPromise?: Promise<string>;
  writeToken?: { value: string; expiresAt: number };
  writeTokenPromise?: Promise<string>;
};

const sessionCache = new Map<string, SessionCacheEntry>();

export function clearGoogleReaderSessionCache() {
  sessionCache.clear();
}

function cachedSession(key: string) {
  const existing = sessionCache.get(key);
  if (existing) {
    sessionCache.delete(key);
    sessionCache.set(key, existing);
    return existing;
  }
  const created: SessionCacheEntry = {};
  sessionCache.set(key, created);
  while (sessionCache.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    sessionCache.delete(oldest);
  }
  return created;
}

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

function mapFolders(
  sources: z.infer<typeof subscriptionListSchema>['subscriptions'],
  unreadCounts: ReadonlyMap<string, number>,
  subscriptionsById: ReadonlyMap<string, Subscription>,
) {
  const folders = new Map<string, { id: string; titles: Set<string>; unreadCount: number }>();
  for (const source of sources) {
    for (const category of source.categories) {
      const id = folderId(category.id);
      const existing = folders.get(id) ?? { id, titles: new Set<string>(), unreadCount: 0 };
      existing.titles.add(category.label?.trim() || category.id.split('/').at(-1) || 'Folder');
      existing.unreadCount = unreadCounts.get(category.id)
        ?? existing.unreadCount + (subscriptionsById.get(source.id)?.unreadCount ?? 0);
      folders.set(id, existing);
    }
  }
  return [...folders.values()].map((folder) => ({
    id: folder.id,
    // Some compatible servers repeat category metadata per subscription and do
    // not guarantee subscription order. Stable selection prevents false
    // structure changes when equivalent responses arrive in a new order.
    title: [...folder.titles].sort((first, second) => first.localeCompare(second))[0] ?? 'Folder',
    unreadCount: folder.unreadCount,
  }));
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

export function normalizeGoogleReaderItemId(id: string) {
  const googleReaderPrefix = 'tag:google.com,2005:reader/item/';
  if (!id.startsWith(googleReaderPrefix)) return id;
  const hexadecimalId = id.slice(googleReaderPrefix.length);
  if (!/^[0-9a-f]+$/i.test(hexadecimalId)) return id;
  return BigInt(`0x${hexadecimalId}`).toString(10);
}

export class GoogleReaderClient {
  constructor(
    private readonly credentials: GoogleReaderCredentials,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly performanceRun?: ReaderPerformanceRun,
    private readonly signal?: AbortSignal,
  ) {}

  private get baseUrl() {
    return this.credentials.serverUrl.replace(/\/+$/, '');
  }

  private get sessionKey() {
    return crypto.createHash('sha256').update(JSON.stringify([
      this.baseUrl,
      this.credentials.email.trim().toLocaleLowerCase(),
      this.credentials.apiKey,
    ])).digest('base64url');
  }

  private retryDelay(response: Response, attempt: number) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1_000));
      const timestamp = Date.parse(retryAfter);
      if (Number.isFinite(timestamp)) return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, timestamp - Date.now()));
    }
    const ceiling = Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** attempt));
    return Math.floor(Math.random() * ceiling);
  }

  private async waitForRetry(milliseconds: number, signal?: AbortSignal) {
    if (milliseconds === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
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

  private async request(url: string, init?: RequestInit, phase?: ReaderPhase) {
    const signal = init?.signal && this.signal
      ? AbortSignal.any([init.signal, this.signal])
      : init?.signal ?? this.signal;
    for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
      if (phase) this.performanceRun?.providerRequestStarted(phase);
      try {
        const response = await this.fetchImplementation(url, { ...init, signal });
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === MAX_REQUEST_ATTEMPTS - 1) return response;
        if (phase) {
          this.performanceRun?.providerResponseIncomplete(phase, false);
          this.performanceRun?.recordRetry();
        }
        await this.waitForRetry(this.retryDelay(response, attempt), signal);
      } catch {
        if (phase) this.performanceRun?.providerResponseIncomplete(phase, attempt === MAX_REQUEST_ATTEMPTS - 1);
        if (signal?.aborted && signal.reason instanceof Error) throw signal.reason;
        if (attempt === MAX_REQUEST_ATTEMPTS - 1) {
          throw new Error('Could not reach the RSS service. Check the server URL and try again.');
        }
        if (phase) this.performanceRun?.recordRetry();
        await this.waitForRetry(Math.floor(Math.random() * Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** attempt))), signal);
      }
    }
    throw new Error('Could not reach the RSS service. Check the server URL and try again.');
  }

  private async responseText(response: Response, phase?: ReaderPhase, options: { pages?: number; items?: number } = {}) {
    try {
      const text = await response.text();
      if (phase) this.performanceRun?.providerResponseCompleted(phase, response, Buffer.byteLength(text, 'utf8'), options);
      return text;
    } catch (error) {
      if (phase) this.performanceRun?.providerResponseIncomplete(phase);
      throw error;
    }
  }

  private async responseJson(response: Response, phase: ReaderPhase, options: { pages?: number; items?: number } = {}) {
    return JSON.parse(await this.responseText(response, phase, options)) as unknown;
  }

  private async authenticate(phase?: ReaderPhase) {
    const session = cachedSession(this.sessionKey);
    if (session.auth && session.auth.expiresAt > Date.now()) return session.auth.value;
    if (session.authPromise) return session.authPromise;
    const operation = this.authenticateUncached(phase);
    session.authPromise = operation;
    try {
      const auth = await operation;
      session.auth = { value: auth, expiresAt: Date.now() + AUTH_TTL_MS };
      return auth;
    } finally {
      session.authPromise = undefined;
    }
  }

  private async authenticateUncached(phase?: ReaderPhase) {
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
    }, phase);
    if (!response.ok) {
      if (phase) this.performanceRun?.providerResponseIncomplete(phase);
      throw new Error('The RSS service rejected the email or API key');
    }
    const auth = (await this.responseText(response, phase)).split('\n').find((line) => line.startsWith('Auth='))?.slice(5);
    if (!auth) throw new Error('The RSS service returned an invalid authentication response');
    return auth;
  }

  private async authorizedRequest(path: string, auth: string, init?: RequestInit, phase?: ReaderPhase) {
    const send = (currentAuth: string) => this.request(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `GoogleLogin auth=${currentAuth}`,
          ...init?.headers,
        },
      }, phase);
    let response = await send(auth);
    if (response.status === 401 || response.status === 403) {
      const session = cachedSession(this.sessionKey);
      if (session.auth?.value === auth) session.auth = undefined;
      session.writeToken = undefined;
      session.writeTokenPromise = undefined;
      response = await send(await this.authenticate(phase));
    }
    if (!response.ok) {
      if (phase) this.performanceRun?.providerResponseIncomplete(phase);
      throw new Error(`RSS service request failed (${response.status})`);
    }
    return response;
  }

  private async writeToken(auth: string) {
    const session = cachedSession(this.sessionKey);
    if (session.writeToken && session.writeToken.expiresAt > Date.now()) return session.writeToken.value;
    if (session.writeTokenPromise) return session.writeTokenPromise;
    const operation = (async () => {
      const token = await (await this.authorizedRequest('/reader/api/0/token', auth)).text();
      if (!token) throw new Error('The RSS service returned an invalid write token');
      return token;
    })();
    session.writeTokenPromise = operation;
    try {
      const token = await operation;
      session.writeToken = { value: token, expiresAt: Date.now() + WRITE_TOKEN_TTL_MS };
      return token;
    } finally {
      session.writeTokenPromise = undefined;
    }
  }

  async validateCredentials() {
    await this.authenticate();
  }

  private async forEachStreamItemPage(
    auth: string,
    consume: (items: z.infer<typeof streamItemSchema>[]) => void | Promise<void>,
    options: { startTimeSeconds?: number; order?: 'newest' | 'oldest' } = {},
  ) {
    const itemIds = new Set<string>();
    const continuationTokens = new Set<string>();
    let continuation: string | undefined;

    do {
      const query = new URLSearchParams({ output: 'json', n: String(STREAM_PAGE_SIZE) });
      query.set('r', options.order === 'oldest' ? 'o' : 'n');
      if (options.startTimeSeconds) query.set('ot', String(options.startTimeSeconds));
      if (continuation) query.set('c', continuation);
      const response = await this.authorizedRequest(
        `/reader/api/0/stream/contents/user/-/state/com.google/reading-list?${query}`,
        auth,
        undefined,
        'contentPages',
      );
      const text = await this.responseText(response, 'contentPages');
      const page = streamSchema.parse(JSON.parse(text));
      this.performanceRun?.recordItems('contentPages', page.items.length, 1);
      const uniqueItems = page.items.filter((item) => {
        if (itemIds.has(item.id)) return false;
        itemIds.add(item.id);
        return true;
      });
      await consume(uniqueItems);

      const nextContinuation = page.continuation;
      if (!nextContinuation) break;
      if (continuationTokens.has(nextContinuation)) {
        throw new Error('RSS service returned a repeating continuation token');
      }
      continuationTokens.add(nextContinuation);
      continuation = nextContinuation;
    } while (continuation);

  }

  private async allStreamItems(auth: string) {
    const items = [] as z.infer<typeof streamItemSchema>[];
    await this.forEachStreamItemPage(auth, (page) => { items.push(...page); });
    return items;
  }

  private async allStateItemIds(auth: string, state: 'unread' | 'starred') {
    const itemIds = new Set<string>();
    const continuationTokens = new Set<string>();
    let continuation: string | undefined;

    do {
      const query = new URLSearchParams({
        output: 'json',
        n: String(STREAM_PAGE_SIZE),
        s: state === 'unread'
          ? 'user/-/state/com.google/reading-list'
          : 'user/-/state/com.google/starred',
      });
      if (state === 'unread') query.set('xt', 'user/-/state/com.google/read');
      if (continuation) query.set('c', continuation);
      const phase = state === 'unread' ? 'unreadIds' : 'starredIds';
      const response = await this.authorizedRequest(`/reader/api/0/stream/items/ids?${query}`, auth, undefined, phase);
      const page = itemIdsSchema.parse(await this.responseJson(response, phase));
      this.performanceRun?.recordItems(phase, page.itemRefs.length, 1);
      for (const item of page.itemRefs) itemIds.add(normalizeGoogleReaderItemId(item.id));

      const nextContinuation = page.continuation;
      if (!nextContinuation) break;
      if (continuationTokens.has(nextContinuation)) {
        throw new Error('RSS service returned a repeating continuation token');
      }
      continuationTokens.add(nextContinuation);
      continuation = nextContinuation;
    } while (continuation);

    return itemIds;
  }

  private async allReadingListItemIds(auth: string, startTimeSeconds: number) {
    const itemIds = new Set<string>();
    const continuationTokens = new Set<string>();
    let continuation: string | undefined;
    do {
      const query = new URLSearchParams({
        output: 'json',
        n: String(STREAM_PAGE_SIZE),
        r: 'n',
        s: 'user/-/state/com.google/reading-list',
        ot: String(startTimeSeconds),
      });
      if (continuation) query.set('c', continuation);
      const response = await this.authorizedRequest(`/reader/api/0/stream/items/ids?${query}`, auth, undefined, 'contentPages');
      const page = itemIdsSchema.parse(await this.responseJson(response, 'contentPages'));
      this.performanceRun?.recordItems('contentPages', page.itemRefs.length, 1);
      for (const item of page.itemRefs) itemIds.add(normalizeGoogleReaderItemId(item.id));
      const nextContinuation = page.continuation;
      if (!nextContinuation) break;
      if (continuationTokens.has(nextContinuation)) throw new Error('RSS service returned a repeating continuation token');
      continuationTokens.add(nextContinuation);
      continuation = nextContinuation;
    } while (continuation);
    return itemIds;
  }

  async snapshot(): Promise<ReaderSnapshot> {
    const measure = <T>(phase: ReaderPhase, operation: () => Promise<T>) => this.performanceRun
      ? this.performanceRun.measure(phase, operation)
      : operation();
    const auth = await measure('authentication', () => this.authenticate('authentication'));
    const [subscriptionData, streamItems, unreadItemIds, starredItemIds] = await Promise.all([
      measure('subscriptions', async () => {
        const [subscriptionsResponse, unreadCountResponse] = await Promise.all([
          this.authorizedRequest('/reader/api/0/subscription/list?output=json', auth, undefined, 'subscriptions'),
          this.authorizedRequest('/reader/api/0/unread-count?output=json', auth, undefined, 'subscriptions'),
        ]);
        const subscriptionsResult = subscriptionListSchema.parse(await this.responseJson(subscriptionsResponse, 'subscriptions'));
        const unreadCountResult = unreadCountSchema.parse(await this.responseJson(unreadCountResponse, 'subscriptions'));
        this.performanceRun?.recordItems('subscriptions', subscriptionsResult.subscriptions.length);
        return { subscriptionsResult, unreadCountResult };
      }),
      measure('contentPages', () => this.allStreamItems(auth)),
      measure('unreadIds', () => this.allStateItemIds(auth, 'unread')),
      measure('starredIds', () => this.allStateItemIds(auth, 'starred')),
    ]);

    const mapSnapshot = () => {
      const { subscriptionsResult, unreadCountResult } = subscriptionData;
      const unreadCounts = new Map(unreadCountResult.unreadcounts.map((entry) => [entry.id, entry.count] as const));
      const subscriptions = subscriptionsResult.subscriptions.map((subscription) => ({
        id: subscription.id,
        title: subscription.title,
        url: subscription.url ?? subscription.id.replace(/^feed\//, ''),
        siteUrl: subscription.htmlUrl ?? null,
        iconUrl: this.iconUrl(subscription.iconUrl),
        folderIds: subscription.categories.map((category) => folderId(category.id)),
        unreadCount: unreadCounts.get(subscription.id) ?? 0,
      }));
      const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
      const articles = streamItems.map((item) => {
        const html = item.content?.content ?? item.summary?.content ?? '';
        const text = plainText(html);
        const subscription = subscriptionsById.get(item.origin.streamId);
        const comparableId = normalizeGoogleReaderItemId(item.id);
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
          read: !unreadItemIds.has(comparableId),
          starred: starredItemIds.has(comparableId),
        };
      });
      const folders = mapFolders(subscriptionsResult.subscriptions, unreadCounts, subscriptionsById);
      return {
        generatedAt: new Date().toISOString(),
        source: 'google-reader' as const,
        folders,
        subscriptions,
        articles,
      };
    };
    return this.performanceRun ? this.performanceRun.measureSync('mapping', mapSnapshot) : mapSnapshot();
  }

  /**
   * Streams mapped article pages to durable storage. Provider requests remain
   * concurrent, but only one content page is retained while its batch commits.
   */
  async importTo(sink: GoogleReaderImportSink) {
    const measure = <T>(phase: ReaderPhase, operation: () => Promise<T>) => this.performanceRun
      ? this.performanceRun.measure(phase, operation)
      : operation();
    const auth = await measure('authentication', () => this.authenticate('authentication'));
    const contextPromise = Promise.all([
      measure('subscriptions', async () => {
        const [subscriptionsResponse, unreadCountResponse] = await Promise.all([
          this.authorizedRequest('/reader/api/0/subscription/list?output=json', auth, undefined, 'subscriptions'),
          this.authorizedRequest('/reader/api/0/unread-count?output=json', auth, undefined, 'subscriptions'),
        ]);
        const subscriptionsResult = subscriptionListSchema.parse(await this.responseJson(subscriptionsResponse, 'subscriptions'));
        const unreadCountResult = unreadCountSchema.parse(await this.responseJson(unreadCountResponse, 'subscriptions'));
        this.performanceRun?.recordItems('subscriptions', subscriptionsResult.subscriptions.length);
        return { subscriptionsResult, unreadCountResult };
      }),
      measure('unreadIds', () => this.allStateItemIds(auth, 'unread')),
      measure('starredIds', () => this.allStateItemIds(auth, 'starred')),
    ]);

    const mapContext = (providerContext: Awaited<typeof contextPromise>) => {
      const [{ subscriptionsResult, unreadCountResult }, unreadItemIds, starredItemIds] = providerContext;
      const unreadCounts = new Map(unreadCountResult.unreadcounts.map((entry) => [entry.id, entry.count] as const));
      const subscriptions = subscriptionsResult.subscriptions.map((subscription) => ({
        id: subscription.id,
        title: subscription.title,
        url: subscription.url ?? subscription.id.replace(/^feed\//, ''),
        siteUrl: subscription.htmlUrl ?? null,
        iconUrl: this.iconUrl(subscription.iconUrl),
        folderIds: subscription.categories.map((category) => folderId(category.id)),
        unreadCount: unreadCounts.get(subscription.id) ?? 0,
      }));
      const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
      const folders = mapFolders(subscriptionsResult.subscriptions, unreadCounts, subscriptionsById);
      return { subscriptions, subscriptionsById, folders, unreadItemIds, starredItemIds };
    };

    const mappedContextPromise = contextPromise.then((context) => {
      return this.performanceRun
        ? this.performanceRun.measureSync('mapping', () => mapContext(context))
        : mapContext(context);
    });
    const structure = mappedContextPromise.then((context) => sink.stageStructure(context.folders, context.subscriptions));
    const articles = measure('contentPages', () => this.forEachStreamItemPage(auth, async (items) => {
      const context = await mappedContextPromise;
      const mapArticles = () => items.map((item) => {
        const html = item.content?.content ?? item.summary?.content ?? '';
        const text = plainText(html);
        const subscription = context.subscriptionsById.get(item.origin.streamId);
        const comparableId = normalizeGoogleReaderItemId(item.id);
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
          read: !context.unreadItemIds.has(comparableId),
          starred: context.starredItemIds.has(comparableId),
        } satisfies Article;
      });
      const mapped = this.performanceRun ? this.performanceRun.measureSync('mapping', mapArticles) : mapArticles();
      await sink.stageArticles(mapped);
    }));
    await Promise.all([structure, articles]);
  }

  private async incrementalContext(auth: string) {
    const [subscriptionsResponse, unreadCountResponse] = await Promise.all([
      this.authorizedRequest('/reader/api/0/subscription/list?output=json', auth, undefined, 'subscriptions'),
      this.authorizedRequest('/reader/api/0/unread-count?output=json', auth, undefined, 'subscriptions'),
    ]);
    const subscriptionsResult = subscriptionListSchema.parse(await this.responseJson(subscriptionsResponse, 'subscriptions'));
    const unreadCountResult = unreadCountSchema.parse(await this.responseJson(unreadCountResponse, 'subscriptions'));
    this.performanceRun?.recordItems('subscriptions', subscriptionsResult.subscriptions.length);
    const unreadCounts = new Map(unreadCountResult.unreadcounts.map((entry) => [entry.id, entry.count] as const));
    const subscriptions = subscriptionsResult.subscriptions.map((subscription) => ({
      id: subscription.id,
      title: subscription.title,
      url: subscription.url ?? subscription.id.replace(/^feed\//, ''),
      siteUrl: subscription.htmlUrl ?? null,
      iconUrl: this.iconUrl(subscription.iconUrl),
      folderIds: subscription.categories.map((category) => folderId(category.id)),
      unreadCount: unreadCounts.get(subscription.id) ?? 0,
    }));
    const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    const folders = mapFolders(subscriptionsResult.subscriptions, unreadCounts, subscriptionsById);
    return { subscriptions, subscriptionsById, folders };
  }

  private mapIncrementalItems(
    items: z.infer<typeof streamItemSchema>[],
    subscriptionsById: Map<string, Subscription>,
  ) {
    return items.map((item) => {
      const html = item.content?.content ?? item.summary?.content ?? '';
      const text = plainText(html);
      const subscription = subscriptionsById.get(item.origin.streamId);
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
        // Birchfeed does not expose read/starred tags on sampled item bodies.
        // The independent authoritative state scan corrects these defaults.
        read: false,
        starred: false,
      } satisfies Article;
    });
  }

  async discoverSince(
    startTimeSeconds: number,
    knownIds: ReadonlySet<string>,
    structureMatches: (folders: Folder[], subscriptions: Subscription[]) => boolean = () => true,
  ) {
    const measure = <T>(phase: ReaderPhase, operation: () => Promise<T>) => this.performanceRun
      ? this.performanceRun.measure(phase, operation)
      : operation();
    const auth = await measure('authentication', () => this.authenticate('authentication'));
    const [context, candidateIds] = await Promise.all([
      measure('subscriptions', () => this.incrementalContext(auth)),
      measure('contentPages', () => this.allReadingListItemIds(auth, startTimeSeconds)),
    ]);
    const unknownIds = [...candidateIds].filter((id) => !knownIds.has(id));
    const articles: Article[] = [];
    const structureChanged = !structureMatches(context.folders, context.subscriptions);
    if (structureChanged) {
      return {
        folders: context.folders,
        subscriptions: context.subscriptions,
        candidateIds,
        unknownIds,
        articles,
        structureChanged,
      };
    }
    for (let offset = 0; offset < unknownIds.length; offset += 100) {
      const ids = unknownIds.slice(offset, offset + 100);
      const body = new URLSearchParams();
      for (const id of ids) body.append('i', id);
      const response = await this.authorizedRequest('/reader/api/0/stream/items/contents', auth, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      }, 'contentPages');
      const page = streamSchema.parse(await this.responseJson(response, 'contentPages'));
      this.performanceRun?.recordItems('contentPages', page.items.length, 1);
      articles.push(...this.mapIncrementalItems(page.items, context.subscriptionsById));
    }
    return {
      folders: context.folders,
      subscriptions: context.subscriptions,
      candidateIds,
      unknownIds,
      articles,
      structureChanged,
    };
  }

  async reconcileBodiesSince(startTimeSeconds: number, consume: (articles: Article[]) => void | Promise<void>) {
    const measure = <T>(phase: ReaderPhase, operation: () => Promise<T>) => this.performanceRun
      ? this.performanceRun.measure(phase, operation)
      : operation();
    const auth = await measure('authentication', () => this.authenticate('authentication'));
    const contextPromise = measure('subscriptions', () => this.incrementalContext(auth));
    let candidates = 0;
    await measure('contentPages', () => this.forEachStreamItemPage(auth, async (items) => {
      const context = await contextPromise;
      const articles = this.mapIncrementalItems(items, context.subscriptionsById);
      candidates += articles.length;
      await consume(articles);
    }, { startTimeSeconds, order: 'newest' }));
    return { candidates };
  }

  async authoritativeState() {
    const measure = <T>(phase: ReaderPhase, operation: () => Promise<T>) => this.performanceRun
      ? this.performanceRun.measure(phase, operation)
      : operation();
    const auth = await measure('authentication', () => this.authenticate('authentication'));
    const [unreadIds, starredIds] = await Promise.all([
      measure('unreadIds', () => this.allStateItemIds(auth, 'unread')),
      measure('starredIds', () => this.allStateItemIds(auth, 'starred')),
    ]);
    return { unreadIds, starredIds };
  }

  async mutate(mutation: ArticleMutation) {
    await this.mutateMany([mutation]);
  }

  async mutateMany(mutations: ArticleMutation[]) {
    const auth = await this.authenticate();
    const token = await this.writeToken(auth);
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
    const token = await this.writeToken(auth);
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
