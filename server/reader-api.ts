import crypto from 'node:crypto';
import { z } from 'zod';
import type { ReaderArticleBody, ReaderArticleMetadata, ReaderArticlePage, ReaderVersions } from '../shared/reader.js';
import type { AppDatabase } from './database.js';
import type { ReaderCacheIdentity } from './reader-cache.js';

const scopeSchema = z.enum(['inbox', 'all', 'starred', 'uncategorized', 'folder', 'feed']);
const readFilterSchema = z.enum(['all', 'unread', 'read']);

export type ReaderArticleQuery = {
  scope: z.infer<typeof scopeSchema>;
  scopeId?: string;
  read: z.infer<typeof readFilterSchema>;
  search?: string;
  limit: number;
  cursor?: string;
};

const articleCursorSchema = z.object({
  version: z.literal(1),
  accountKey: z.string(),
  generation: z.string(),
  collectionVersion: z.number().int().nonnegative(),
  stateVersion: z.number().int().nonnegative(),
  scope: scopeSchema,
  scopeId: z.string().nullable(),
  read: readFilterSchema,
  search: z.string(),
  publishedAt: z.string(),
  articleId: z.string(),
});

const deltaTokenSchema = z.object({
  version: z.literal(1),
  accountKey: z.string(),
  afterSequence: z.number().int().nonnegative(),
  targetSequence: z.number().int().nonnegative(),
  issuedAt: z.number().int().nonnegative(),
});

type ReaderContext = {
  generation: string;
  versions: ReaderVersions;
};

export class ReaderCursorError extends Error {
  constructor(
    message: string,
    readonly code: 'malformed' | 'incompatible' | 'expired',
  ) {
    super(message);
    this.name = 'ReaderCursorError';
  }
}

export class ReaderCacheUnavailableError extends Error {
  constructor() {
    super('The reader cache is still initializing');
    this.name = 'ReaderCacheUnavailableError';
  }
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value: string) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new ReaderCursorError('The cursor is malformed', 'malformed');
  }
}

function searchExpression(search: string) {
  return `"${search.normalize('NFKC').replaceAll('"', '""')}"`;
}

function likeExpression(search: string) {
  return `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function hash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 18);
}

export class ReaderApi {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly afterContext?: () => void,
  ) {}

  private context(identity: ReaderCacheIdentity): ReaderContext {
    const row = this.database.prepare(`
      SELECT current_generation_id, collection_version, state_version, body_version
      FROM reader_accounts WHERE account_key = ? AND invalidated_at IS NULL
    `).get(identity.accountKey) as {
      current_generation_id: string | null;
      collection_version: number;
      state_version: number;
      body_version: number;
    } | undefined;
    if (!row?.current_generation_id) throw new ReaderCacheUnavailableError();
    return {
      generation: row.current_generation_id,
      versions: {
        collection: row.collection_version,
        state: row.state_version,
        body: row.body_version,
      },
    };
  }

  private parseArticleCursor(identity: ReaderCacheIdentity, query: ReaderArticleQuery, context: ReaderContext) {
    if (!query.cursor) return null;
    let cursor: z.infer<typeof articleCursorSchema>;
    try {
      cursor = articleCursorSchema.parse(decode(query.cursor));
    } catch (error) {
      if (error instanceof ReaderCursorError) throw error;
      throw new ReaderCursorError('The cursor is malformed', 'malformed');
    }
    const normalizedSearch = query.search?.trim() ?? '';
    if (
      cursor.accountKey !== identity.accountKey
      || cursor.scope !== query.scope
      || cursor.scopeId !== (query.scopeId ?? null)
      || cursor.read !== query.read
      || cursor.search !== normalizedSearch
    ) {
      throw new ReaderCursorError('The cursor does not match this scope, filter, or search', 'incompatible');
    }
    if (
      cursor.generation !== context.generation
      || cursor.collectionVersion !== context.versions.collection
      || cursor.stateVersion !== context.versions.state
    ) {
      throw new ReaderCursorError('The collection changed while paging; restart from the first page', 'expired');
    }
    return cursor;
  }

  articles(identity: ReaderCacheIdentity, query: ReaderArticleQuery): ReaderArticlePage & { etag: string } {
    const read = this.database.transaction(() => {
    const context = this.context(identity);
    this.afterContext?.();
    const cursor = this.parseArticleCursor(identity, query, context);
    const conditions = ['a.generation_id = @generation'];
    const parameters: Record<string, string | number> = { generation: context.generation };
    if (query.scope === 'inbox') conditions.push('state.is_read = 0');
    if (query.scope === 'starred') conditions.push('state.is_starred = 1');
    if (query.scope === 'uncategorized') {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM reader_subscription_folders sf
        WHERE sf.generation_id = a.generation_id AND sf.subscription_id = a.feed_id
      )`);
    }
    if (query.scope === 'folder') {
      conditions.push(`EXISTS (
        SELECT 1 FROM reader_article_folders af
        WHERE af.generation_id = a.generation_id AND af.article_id = a.id AND af.folder_id = @scopeId
      )`);
      parameters.scopeId = query.scopeId ?? '';
    }
    if (query.scope === 'feed') {
      conditions.push('a.feed_id = @scopeId');
      parameters.scopeId = query.scopeId ?? '';
    }
    if (query.read === 'unread') conditions.push('state.is_read = 0');
    if (query.read === 'read') conditions.push('state.is_read = 1');
    const normalizedSearch = query.search?.trim() ?? '';
    if (normalizedSearch) {
      if ([...normalizedSearch].length >= 3) {
        conditions.push(`EXISTS (
          SELECT 1 FROM reader_article_search
          WHERE generation_id = a.generation_id AND article_id = a.id AND reader_article_search MATCH @search
        )`);
        parameters.search = searchExpression(normalizedSearch);
      } else {
        conditions.push(`(
          a.title LIKE @searchLike ESCAPE '\\' OR a.source LIKE @searchLike ESCAPE '\\'
          OR COALESCE(a.author, '') LIKE @searchLike ESCAPE '\\' OR a.summary LIKE @searchLike ESCAPE '\\'
        )`);
        parameters.searchLike = likeExpression(normalizedSearch);
      }
    }
    const baseWhere = conditions.join(' AND ');
    const total = (this.database.prepare(`
      SELECT COUNT(*) AS count FROM reader_articles a
      JOIN reader_article_state state ON state.generation_id = a.generation_id AND state.article_id = a.id
      WHERE ${baseWhere}
    `).get(parameters) as { count: number }).count;
    if (cursor) {
      conditions.push('(a.published_at < @publishedAt OR (a.published_at = @publishedAt AND a.id < @articleId))');
      parameters.publishedAt = cursor.publishedAt;
      parameters.articleId = cursor.articleId;
    }
    parameters.limit = query.limit + 1;
    const rows = this.database.prepare(`
      SELECT a.id, a.feed_id, a.title, a.author, a.source, a.canonical_url, a.published_at,
        a.reading_minutes, a.summary, state.is_read, state.is_starred,
        COALESCE((
          SELECT json_group_array(folder_id) FROM (
            SELECT folder_id FROM reader_article_folders
            WHERE generation_id = a.generation_id AND article_id = a.id ORDER BY folder_id
          )
        ), '[]') AS folder_ids
      FROM reader_articles a
      JOIN reader_article_state state ON state.generation_id = a.generation_id AND state.article_id = a.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT @limit
    `).all(parameters) as Array<{
      id: string; feed_id: string; title: string; author: string | null; source: string; canonical_url: string;
      published_at: string; reading_minutes: number; summary: string; is_read: number; is_starred: number; folder_ids: string;
    }>;
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const articles: ReaderArticleMetadata[] = pageRows.map((row) => ({
      id: row.id,
      feedId: row.feed_id,
      folderIds: JSON.parse(row.folder_ids) as string[],
      title: row.title,
      author: row.author,
      source: row.source,
      canonicalUrl: row.canonical_url,
      publishedAt: row.published_at,
      readingMinutes: row.reading_minutes,
      summary: row.summary,
      read: Boolean(row.is_read),
      starred: Boolean(row.is_starred),
    }));
    const last = hasMore ? pageRows.at(-1) : undefined;
    const nextCursor = last ? encode({
      version: 1,
      accountKey: identity.accountKey,
      generation: context.generation,
      collectionVersion: context.versions.collection,
      stateVersion: context.versions.state,
      scope: query.scope,
      scopeId: query.scopeId ?? null,
      read: query.read,
      search: normalizedSearch,
      publishedAt: last.published_at,
      articleId: last.id,
    }) : null;
    return {
      accountKey: identity.accountKey,
      generation: context.generation,
      versions: context.versions,
      total,
      articles,
      nextCursor,
      etag: `"reader-articles-${hash([
        context.generation,
        context.versions.collection,
        context.versions.state,
        query.scope,
        query.scopeId,
        query.read,
        normalizedSearch,
      ])}"`,
    };
    });
    return read.deferred();
  }

  body(identity: ReaderCacheIdentity, articleId: string): (ReaderArticleBody & { etag: string }) | null {
    const read = this.database.transaction(() => {
    const context = this.context(identity);
    this.afterContext?.();
    const row = this.database.prepare(`
      SELECT content_html FROM reader_article_bodies WHERE generation_id = ? AND article_id = ?
    `).get(context.generation, articleId) as { content_html: string } | undefined;
    if (!row) return null;
    return {
      accountKey: identity.accountKey,
      articleId,
      contentHtml: row.content_html,
      bodyVersion: context.versions.body,
      etag: `"reader-body-${context.versions.body}-${hash([articleId, row.content_html])}"`,
    };
    });
    return read.deferred();
  }

  navigation(identity: ReaderCacheIdentity) {
    const read = this.database.transaction(() => {
    const context = this.context(identity);
    this.afterContext?.();
    const scopes = new Map((this.database.prepare(`
      SELECT id, total_count, unread_count FROM reader_navigation_activity
      WHERE generation_id = ? AND kind = 'scope'
    `).all(context.generation) as Array<{ id: string; total_count: number; unread_count: number }>)
      .map((row) => [row.id, row] as const));
    const feeds = this.database.prepare(`
      SELECT subscription.id, subscription.title, subscription.url, subscription.site_url, subscription.icon_url,
        activity.unread_count, activity.total_count, activity.latest_published_at,
        COALESCE((
          SELECT json_group_array(folder_id) FROM (
            SELECT folder_id FROM reader_subscription_folders
            WHERE generation_id = subscription.generation_id AND subscription_id = subscription.id ORDER BY folder_id
          )
        ), '[]') AS folder_ids
      FROM reader_subscriptions subscription
      JOIN reader_navigation_activity activity
        ON activity.generation_id = subscription.generation_id AND activity.kind = 'feed' AND activity.id = subscription.id
      WHERE subscription.generation_id = ?
      ORDER BY activity.latest_published_at DESC, subscription.title, subscription.id
    `).all(context.generation) as Array<{
      id: string; title: string; url: string; site_url: string | null; icon_url: string | null; unread_count: number;
      total_count: number; latest_published_at: string | null; folder_ids: string;
    }>;
    const folders = this.database.prepare(`
      SELECT folder.id, folder.title, activity.unread_count, activity.total_count, activity.latest_published_at
      FROM reader_folders folder
      JOIN reader_navigation_activity activity
        ON activity.generation_id = folder.generation_id AND activity.kind = 'folder' AND activity.id = folder.id
      WHERE folder.generation_id = ?
      ORDER BY activity.latest_published_at DESC, folder.title, folder.id
    `).all(context.generation) as Array<{
      id: string; title: string; unread_count: number; total_count: number; latest_published_at: string | null;
    }>;
    const result = {
      generation: context.generation,
      versions: context.versions,
      counts: {
        all: scopes.get('all')?.total_count ?? 0,
        inbox: scopes.get('inbox')?.total_count ?? 0,
        starred: scopes.get('starred')?.total_count ?? 0,
        uncategorized: scopes.get('uncategorized')?.total_count ?? 0,
      },
      folders: folders.map((folder) => ({
        id: folder.id,
        title: folder.title,
        unreadCount: folder.unread_count,
        totalCount: folder.total_count,
        latestPublishedAt: folder.latest_published_at,
      })),
      feeds: feeds.map((feed) => ({
        id: feed.id,
        title: feed.title,
        url: feed.url,
        siteUrl: feed.site_url,
        iconUrl: feed.icon_url,
        folderIds: JSON.parse(feed.folder_ids) as string[],
        unreadCount: feed.unread_count,
        totalCount: feed.total_count,
        latestPublishedAt: feed.latest_published_at,
      })),
    };
    return {
      accountKey: identity.accountKey,
      ...result,
      etag: `"reader-navigation-${hash([context.versions.collection, context.versions.state])}"`,
    };
    });
    return read.deferred();
  }

  changes(identity: ReaderCacheIdentity, token: string | undefined, limit: number) {
    const read = this.database.transaction(() => {
    const context = this.context(identity);
    this.afterContext?.();
    const maximumSequence = (this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) AS value FROM reader_change_log WHERE account_key = ?
    `).get(identity.accountKey) as { value: number }).value;
    if (!token) {
      return {
        accountKey: identity.accountKey,
        changes: [],
        hasMore: false,
        token: encode({
          version: 1,
          accountKey: identity.accountKey,
          afterSequence: maximumSequence,
          targetSequence: maximumSequence,
          issuedAt: this.clock().getTime(),
        }),
        versions: context.versions,
        etag: `"reader-changes-${maximumSequence}"`,
      };
    }
    let parsed: z.infer<typeof deltaTokenSchema>;
    try {
      parsed = deltaTokenSchema.parse(decode(token));
    } catch (error) {
      if (error instanceof ReaderCursorError) throw error;
      throw new ReaderCursorError('The change token is malformed', 'malformed');
    }
    if (parsed.accountKey !== identity.accountKey) {
      throw new ReaderCursorError('The change token belongs to another reader account', 'incompatible');
    }
    if (this.clock().getTime() - parsed.issuedAt > 7 * 24 * 60 * 60 * 1_000) {
      throw new ReaderCursorError('The change token expired; rebuild local reader data and retain queued writes', 'expired');
    }
    const targetSequence = parsed.afterSequence === parsed.targetSequence ? maximumSequence : parsed.targetSequence;
    const rows = this.database.prepare(`
      SELECT sequence, article_id, metadata_changed, state_changed, body_changed, deleted,
        collection_version, state_version, body_version, payload_json
      FROM reader_change_log
      WHERE account_key = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence LIMIT ?
    `).all(identity.accountKey, parsed.afterSequence, targetSequence, limit + 1) as Array<{
      sequence: number; article_id: string | null; metadata_changed: number; state_changed: number;
      body_changed: number; deleted: number; collection_version: number; state_version: number;
      body_version: number; payload_json: string | null;
    }>;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const afterSequence = page.at(-1)?.sequence ?? targetSequence;
    return {
      accountKey: identity.accountKey,
      changes: page.map((row) => ({
        sequence: row.sequence,
        kind: row.article_id === null ? 'navigation' : row.deleted ? 'delete' : 'upsert',
        articleId: row.article_id,
        metadataChanged: Boolean(row.metadata_changed),
        stateChanged: Boolean(row.state_changed),
        bodyChanged: Boolean(row.body_changed),
        deleted: Boolean(row.deleted),
        versions: {
          collection: row.collection_version,
          state: row.state_version,
          body: row.body_version,
        },
        payload: row.payload_json ? JSON.parse(row.payload_json) as unknown : null,
      })),
      hasMore,
      token: encode({
        ...parsed,
        afterSequence,
        targetSequence,
        issuedAt: hasMore ? parsed.issuedAt : this.clock().getTime(),
      }),
      versions: context.versions,
      etag: `"reader-changes-${parsed.afterSequence}-${targetSequence}"`,
    };
    });
    return read.deferred();
  }
}
