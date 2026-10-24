# Paginated reader API

This document defines the cache-backed server contract introduced for issue #7. The legacy `/api/reader/snapshot` route remains available during browser migration and production verification; new clients should use the scoped APIs below.

## Endpoints

All endpoints require the normal Chadashot session and operate only on the authenticated reader account's currently committed SQLite generation.

| Endpoint | Purpose | Cache behavior |
| --- | --- | --- |
| `GET /api/reader/navigation` | Global counts plus folder/feed counts, unread activity, and latest publication time | ETag changes only with collection or state revisions |
| `GET /api/reader/articles` | Cursor-paginated metadata for a scope/filter/search | ETag and cursor bind to collection and state revisions; no article HTML |
| `GET /api/reader/articles/:articleId/body` | One sanitized provider body | Body-specific ETag includes the body revision and content identity |
| `GET /api/reader/status` | Initialization, refresh, stale/error, progress, and revision status | `no-store` |
| `POST /api/reader/refresh` | Explicitly schedule background refresh without waiting for FreshRSS | Returns `202`; current cached data remains readable |
| `GET /api/reader/changes` | Versioned metadata/state/body-invalidations and removals for IndexedDB | Bounded repeatable pages; no article HTML |

`GET /api/reader/articles` accepts `scope=inbox|all|starred|uncategorized|folder|feed`, `scopeId` for folder/feed, `read=all|unread|read`, `search`, `limit` from 1 through 100, and an opaque `cursor`. Inbox is the unread collection, matching the existing browser behavior. Results are ordered by `publishedAt DESC, id DESC`; the ID is the deterministic tie-breaker.

The response's `total` always describes the complete matching result, not the loaded page. Navigation counts and feed/folder activity are computed independently of page traversal. Folder and feed scopes use normalized relationships from the committed generation.

## Search

SQLite FTS5's trigram tokenizer indexes title, source, author, and summary. This preserves the existing case-insensitive substring behavior for searches of at least three characters without scanning article bodies. One- and two-character searches use a metadata-only `LIKE` fallback because trigram indexes cannot represent them. Search never inspects article HTML, and the search identity is part of the cursor.

## Cursor and generation contract

Metadata cursors encode version, account identity, generation, collection revision, state revision, scope, read filter, exact search, and the last publication/ID key. A malformed or cross-query cursor returns `400 invalid_reader_cursor`. If a new generation or read-state revision appears between pages, the server returns `409 reader_cursor_expired` with `reset: true` and `preserveQueuedWrites: true`.

Restarting at the first page is deliberate: silently continuing through a changed filtered collection could omit or duplicate articles. A body-only revision does not expire metadata cursors or metadata/navigation ETags.

## Change feed

The first request without a token establishes the current change sequence and returns no historical events. Later requests replay immutable events through a fixed target sequence. A page can contain:

- `upsert` with current metadata/state plus `metadataChanged`, `stateChanged`, and `bodyChanged` invalidation flags;
- `delete` with the removed article ID;
- `navigation` when collection structure/aggregates changed.

Bodies are never embedded in the change feed. A `bodyChanged` consumer fetches that article's body endpoint. Full-generation publication records new, changed, and removed IDs transactionally with publication; confirmed local mutations record state changes after provider success. Seven days of client inactivity expires the opaque token and returns the same recoverable reset contract. Rebuilding normalized IndexedDB must preserve the separate durable queued-write store from issue #4.

## Conditional versions

Express evaluates `If-None-Match` after the route sets its explicit ETag, returning an empty `304` for unchanged data. Metadata and navigation depend on collection/state revisions. Article bodies depend on body revision and that body's content identity. State-only changes therefore do not invalidate body responses, and body-only changes do not invalidate metadata/navigation responses.

## Deterministic benchmark

Run:

```bash
npm run benchmark:reader-api
```

The benchmark imports the existing synthetic 20,000-article fixture, performs one warmup plus 20 first-page/body queries, and traverses the complete collection with 100-row keyset pages. The 2026-09-08 local result was:

| Measurement | Result | Gate |
| --- | ---: | --- |
| Traversal | 20,000 rows, 20,000 unique IDs | no omission/duplicate; pass |
| 100-row decoded metadata response | 43,630 bytes | no more than 256 KiB; pass |
| First-page SQLite query p95 | 10.44 ms | server-cache first page no more than 2 s; pass locally |
| Standard body query p95, 2 KiB fixture | 0.03 ms | server query component only |
| Large body query p95, 64 KiB fixture | 1.11 ms | server query component only |

The body targets remain those declared in the issue #2 benchmark: cached p95 of 100/150 ms and uncached reference-network p95 of 500/750 ms for 2/64 KiB bodies. The query measurements isolate SQLite and are not substitutes for the required 20-run browser/network timings. Physical Android and the 10 Mbps down, 2 Mbps up, 100 ms RTT profile remain outstanding until issues #8 and #9 consume these APIs.

## Compatibility and rollback

Browser hydration remains on the legacy snapshot until issue #8. This allows side-by-side production verification of counts, ordering, bodies, and state before removing compatibility code in issue #11. `READER_CACHE_ENABLED=false` remains the broader cache rollback; migration 6 is forward-only and safe to leave applied because the legacy route does not depend on the new FTS/change tables.
