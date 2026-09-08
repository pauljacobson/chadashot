# Reader performance benchmark

This document defines the baseline and repeatable measurement procedure for issue #2. It measures the existing full-snapshot reader path; it does not claim that the later cache, incremental synchronization, metadata pagination, lazy bodies, or bounded rendering work already exists.

## Safety and data handling

- Use the deterministic synthetic fixture for browser and state-changing scenarios. It contains 20,000 articles, 50 feeds with 400 articles each, old unread and starred items, 2 KiB standard bodies, and a 64 KiB body every 500 articles. All URLs use the reserved `example.invalid` domain.
- Live Birchfeed measurements are read-only. Do not run mutation, backlog, or reconnect scenarios against a production collection.
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

### Live read-only Birchfeed synchronization

The local development app used the configured Birchfeed connection and did not send state-changing requests.

| Measurement | Result |
| --- | ---: |
| Articles | 25,654 |
| Subscriptions | 809 |
| Provider requests | 50 |
| Provider decoded/identity bytes | 91,183,936 |
| Total synchronization | 61,480.65 ms |
| Authentication | 1,370.06 ms |
| Subscriptions | 2,000.97 ms |
| Content pages | 26 requests, 25,654 items, 59,232.16 ms |
| Unread IDs | 20 requests, 19,140 IDs, 33,037.23 ms |
| Starred IDs | 1 request, 0 IDs, 227.71 ms |
| Mapping | 698.20 ms |
| Serialized snapshot | 89,969,990 bytes in 162.12 ms |
| Response | Completed; 89,969,990 identity bytes |

This run confirms that full provider traversal and body transfer dominate. Mapping plus serialization was under one second; it does not explain the roughly 61-second synchronization.

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
