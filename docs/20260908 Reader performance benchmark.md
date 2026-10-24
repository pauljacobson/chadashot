# Reader performance benchmark

This document defines the baseline and repeatable measurement procedure for issue #2. It measures the existing full-snapshot reader path; it does not claim that the later cache, incremental synchronization, metadata pagination, lazy bodies, or bounded rendering work already exists.

## Safety and data handling

- Use the deterministic synthetic fixture for browser and state-changing scenarios. It contains 20,000 articles, 50 feeds with 400 articles each, old unread and starred items, 2 KiB standard bodies, and a 64 KiB body every 500 articles. All URLs use the reserved `example.invalid` domain.
- Live FreshRSS-compatible provider measurements are read-only. Do not run mutation, backlog, or reconnect scenarios against a production collection.
- Metrics contain run IDs, phase names, counts, durations, byte counts, and completion state. They do not contain credentials, article/highlight text, article/feed IDs, or private URLs.
- Encoded provider bytes come from `Content-Length` when present. For an identity response without that header they equal the fully decoded body bytes. For a compressed response with no usable `Content-Length`, encoded bytes remain unknown. An incomplete response never contributes an inferred byte total.

## Instrumentation

Each server synchronization logs one `Reader synchronization measured` event with a UUID run ID. It includes:

- authentication, subscriptions, content-page traversal, unread IDs, starred IDs, and mapping durations;
- provider requests, completed/incomplete responses, pages, items, encoded bytes, decoded bytes, retries, and coalesced triggers;
- first-run or prior-run changed/unchanged article counts;
- serialization duration and decoded response bytes; and
- browser-to-app request/response counts plus normal completion or disconnect state.

The browser exposes a redacted snapshot through:

```js
window.__CHADASHOT_PERFORMANCE__.snapshot()
```

It records shell, first cached list, first server-backed list, first article, synchronization completion, snapshot persistence, outbox replay, cached article opening, response bytes, trigger type, mounted rows, and long tasks. Reset a page's in-memory measurements with `window.__CHADASHOT_PERFORMANCE__.reset()`.

## Repeatable local procedure

Start the isolated benchmark instance. It uses `data/performance`, port 8788 for the API, and a separate Vite port, so it cannot read or modify the normal local integration database.

```bash
npm run benchmark:dev
```

Open the printed Vite URL in a desktop browser. Record the exact browser version, operating system, viewport, and whether the network is loopback/unthrottled or uses the reference profile. Perform one unrecorded warmup and at least 20 measured runs for every timing scenario. Calculate p95 as the value at `ceil(0.95 × sample count)` after sorting ascending; do not interpolate.

For the reference network profile, use Chrome DevTools network throttling with 10 Mbps download, 2 Mbps upload, and 100 ms latency. Leave CPU throttling disabled unless the result explicitly names it. The 52.6 MB legacy fixture response takes at least about 42 seconds to transfer at 10 Mbps before protocol overhead, so loopback baselines are useful for isolating browser work but are not substitutes for the reference-network acceptance run.

### Empty browser cache

Clear site data for the benchmark origin before each run, reload, wait for both `synchronization-complete` and `snapshot-persistence`, and save the performance snapshot. No `first-usable-cached-list` event should appear.

### Warm browser cache

Complete one synchronization, reload without clearing site data, and save the performance snapshot after `first-usable-cached-list`. Waiting for synchronization completion is optional when the measurement is only the cached-list gate; if the request is aborted by the next reload, treat it as incomplete and do not record transfer bytes for it.

### Populated server cache, unchanged refresh, and small incremental update

These scenarios are not representable on the baseline implementation because it has no server article cache or incremental provider contract. Keep them explicitly unavailable until issues #5 and #6 add those states. Later implementations must use the same 20-run rule and fixture rather than relabeling a full snapshot as an incremental run.

### Offline backlog and reconnect

Use only the isolated synthetic instance. Load the collection, take the browser offline, toggle a star to create one queued mutation, restore connectivity, then wait for an `outbox-replay` event with one attempted/completed mutation and the next reader response. Repeat after a warmup. Issue #4 is expected to change the ordering without changing this scenario's meaning.

### Article opening and mounted rows

For cached opening, switch to Starred, select 20 different synthetic articles, and record `article-open` durations. For the structural row gate, switch to All articles and inspect both the DOM count and `maximumMountedRows`.

The lazy-body acceptance fixtures and targets are:

| Body | Cached p95 target | Uncached p95 target on reference network |
| --- | ---: | ---: |
| Standard, 2 KiB HTML | 100 ms | 500 ms |
| Large, 64 KiB HTML | 150 ms | 750 ms |

The baseline cannot produce an uncached-body result because every legacy snapshot includes every body. Record that case only after the versioned body API exists; do not substitute a full-snapshot startup time.

## Baseline results — 2026-09-08

### Live read-only FreshRSS-compatible synchronization

The local development app used a configured FreshRSS-compatible connection and did not send state-changing requests. Full provider traversal and body transfer dominated the observed synchronization; mapping and serialization were smaller contributors.

Collection-specific counts, timings, and transfer measurements are omitted from this document. This qualitative observation comes from a live provider and is separate from the synthetic desktop results below.

### Synthetic desktop browser

Environment: Playwright Headless Chrome 152.0.0.0, reported macOS user agent `Intel Mac OS X 10_15_7`, 1280 × 720 viewport, device scale factor 1, loopback/unthrottled network, no CPU throttling. Each timing series used one warmup followed by 20 measured runs.

| Scenario | p95 | Min–max | Gate status |
| --- | ---: | ---: | --- |
| Warm cache, first usable cached list | 87.5 ms | 39.4–148.7 ms | Passes locally; reference network/device still required |
| Empty cache, first server-backed list | 280.9 ms | 230.8–434.8 ms | Passes loopback only; no populated server cache exists |
| Empty cache, first article | 443.9 ms | 395.0–449.1 ms | Diagnostic only; legacy body is bundled in snapshot |
| Empty cache, synchronization complete | 281.0 ms | 230.8–434.8 ms | Diagnostic loopback result |
| Empty cache, browser persistence | 32.7 ms | 21.7–34.0 ms | Diagnostic |
| Cached article selection | 42.7 ms | 10.1–50.0 ms | Passes 2 KiB cached target locally |

Every synthetic reader response was 52,616,357 decoded identity bytes, so the ≤256 KiB first-page metadata gate fails by about 205 times. The default Inbox mounted 2,879 rows, and All articles mounted all 20,000 rows; both fail the ≤200-row gate. Rendering All articles took about 30 seconds in the observed run and produced a maximum 1,397 ms long task. These failures are expected baselines for issues #7 and #9, not target adjustments.

## Outstanding acceptance evidence

- Run all applicable timing scenarios on the named 10 Mbps / 2 Mbps / 100 ms reference profile after the paginated cache-backed API exists.
- Run the same scenarios on a named physical Android device and record its model, Android version, browser version, viewport, and results. No physical Android device was available for this baseline.
- Add populated-server-cache, unchanged-refresh, small-incremental-update, and uncached-body results when their owning issues provide those states.
- Any proposed budget adjustment must be supported by those measurements and recorded explicitly in parent issue #1.

## Issue #3 safeguard results

The refresh coordinator is intentionally process-local for the current Railway deployment model. Its key combines the authenticated user with a one-way generation derived from the encrypted integration record. Equivalent callers in the same Node.js process share one promise and provider run. Credential replacement or disconnection invalidates all old runs, and every completed result is checked against the current generation before it can be returned. The default provider deadline is 120 seconds and is configurable through `READER_SYNC_TIMEOUT_MS`.

This guard does not coordinate separate Node.js processes and does not survive a restart. Production must therefore remain a single application process until issue #5 moves ownership and recovery to the durable cache design. A restart safely loses only in-flight ownership; it does not publish a stale result.

A controlled burst of ten fixture-backed API requests produced one authentication, one content traversal, one shared run ID, and a coalesced-trigger count of nine. A rejected run released ownership for the next request, a deliberately non-settling provider returned 504 at its configured test deadline, and changing credentials caused the old request to return 409 while the new generation synchronized successfully.

Compression retains the decoded legacy snapshot contract and negotiates Brotli, gzip, or identity with `Vary: Accept-Encoding`. The byte counter runs after encoding and records process CPU used between response start and completion. Process CPU is diagnostic rather than exclusive per-request CPU when responses overlap.

| Encoding | Encoded bytes | Reduction from 52,616,357 decoded bytes | Response phase | Process CPU |
| --- | ---: | ---: | ---: | ---: |
| Identity | 52,616,357 | 0% | 25.96 ms | 20,474 µs user + 4,754 µs system |
| Gzip level 6 | 820,746 | 98.44% | 112.62 ms | 145,615 µs user + 2,802 µs system |
| Brotli quality 4 | 357,165 | 99.32% | 59.54 ms | 89,393 µs user + 3,399 µs system |

These unusually large ratios reflect deliberately repetitive synthetic bodies. They demonstrate correct encoding and measurement, not a forecast for real feeds. An aborted Brotli request logged 49,152 partial bytes while leaving completed encoded bytes unknown, confirming that disconnects do not become false transfer totals. Compression reduces browser transfer but does not remove the provider traversal required by a full synchronization.

## Issue #7 paginated API result

The cache-backed API now passes the structural server gates. `npm run benchmark:reader-api` traversed all 20,000 unique IDs in 100-row keyset pages, produced a 43,630-byte decoded first page, and measured the SQLite first-page query at 10.44 ms p95 after one warmup and 20 runs. The standard 2 KiB and large 64 KiB body query components measured 0.03 ms and 1.11 ms p95 respectively. See [the paginated reader API contract](./20260908%20Paginated%20reader%20API.md) for generation resets, search, change replay, and remaining end-to-end evidence.
