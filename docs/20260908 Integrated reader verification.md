# Integrated reader verification

This is the staged evidence record for issue #11. It separates controlled synthetic results, authorized read-only Birchfeed observations, and gates that have not yet been run. The legacy snapshot route remains available because the 48-hour production observation, reference-network run, physical Android run, and application-update gate are still outstanding.

## Repeatable commands

Run the server-side 20,000-item traversal and 20-sample query benchmark:

```bash
npm run benchmark:reader-api
```

Start the isolated 20,000-item browser fixture. The fixture now seeds the paginated SQLite cache directly and never requires provider credentials:

```bash
npm run benchmark:dev
```

Open the printed Vite URL. The browser instrumentation and 20-run calculation rules remain defined in [the reader performance benchmark](./20260908%20Reader%20performance%20benchmark.md). Run `npm run check` for the controlled recovery, migration, pagination, reconciliation, outbox, job, and UI cases listed below.

## Environment and data

- Date: 2026-09-08, Asia/Jerusalem.
- Synthetic server dataset: 20,000 articles, 50 feeds, 2 KiB standard bodies, and a 64 KiB body every 500 articles.
- Browser: Playwright Headless Chrome 152.0.0.0 with a macOS `Intel Mac OS X 10_15_7` user agent.
- Desktop viewport: 1280 × 720 at device scale factor 1.
- Android-sized emulation: 390 × 844. This is not a physical Android result.
- Network: loopback, unthrottled, with no CPU throttling.
- Live dataset: the locally connected personal Birchfeed collection, used read-only. It contained 26,245 cached articles for the first-page series and 26,867 after the observed reconciliation.

## Measured results

Each p95 series below used one unrecorded warmup followed by 20 measured runs. p95 is the item at `ceil(0.95 × count)` in ascending order without interpolation.

| Scenario | Runs | p95 | Min–max | Decoded bytes | Mounted rows | Long task max | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Synthetic warm browser cache, desktop | 20 | 275.1 ms | 97.1–276.2 ms | cached | 18 | 173 ms | Pass, ≤1 s |
| Synthetic empty browser, populated server cache, first list | 20 | 89.0 ms | 72.8–90.8 ms | 43,676-byte metadata page; a separately eager-loaded 64 KiB body was the largest early response | 18 | 0 ms | Pass, ≤2 s and ≤256 KiB metadata |
| Synthetic cached keyboard selection, desktop | 20 | 7.0 ms | 1.6–7.1 ms | cached metadata | 30 | 0 ms | Pass, ≤100 ms |
| Synthetic warm browser cache, Android-sized emulation | 20 | 257.2 ms | 114.0–384.6 ms | cached | 18 | 152 ms | Pass as emulation only |
| Live Birchfeed cached Inbox first page | 20 | 27.98 ms | 25.71–548.10 ms | 71,020 bytes | not remeasured in this series | not remeasured | Pass, read-only |

The final isolated server benchmark traversed all 20,000 unique article IDs. A 100-row metadata response was 43,676 decoded bytes and its SQLite query p95 was 9.06 ms. Standard 2 KiB and large 64 KiB body query p95 values were 0.03 ms and 0.08 ms respectively. These are storage/query results; uncached body delivery on the reference network remains outstanding.

One complete empty-browser metadata backfill was observed diagnostically before the 20-run command exceeded its automation time limit. It reached all 20,000 cached items with 18 mounted rows and no long task. It is not recorded as a 20-run timing pass.

## Live read-only synchronization observation

Before the issue #11 scheduling fix, the cache reported `current` but its `lastSuccessAt` was still `2026-09-08T09:50:49.015Z`. The paginated client was reading status without scheduling work that had become due. Status checks now start a due durable background synchronization while continuing to serve the committed generation.

The first live check after the scheduler fix advanced `lastSuccessAt` to `2026-09-08T11:07:10.361Z`, cleared the error, and advanced collection/state/body versions from 4/5/4 to 5/6/5. It took 99.51 seconds and made 56 completed provider requests totaling 96,532,742 decoded bytes. The run first attempted incremental discovery, detected a subscription-structure fingerprint difference, and promoted itself to a safe full import. It published 26,867 articles only after completion; no failed checkpoint was advanced. A second due run reproduced the promotion and published 26,888 articles, proving that the first promotion was not a one-off provider change.

Code inspection isolated an order-sensitive field: compatible servers repeat folder category metadata on every subscription, but do not promise subscription order. The previous mapper let the last repeated label win, so an equivalent response in a new order could change the folder title and structure fingerprint. Folder titles are now selected deterministically, a controlled regression reverses provider subscription order, and fingerprint mismatches are logged as redacted hashes and counts.

The next live due run after that fix stayed incremental. It advanced `lastSuccessAt` to `2026-09-08T11:20:27.743Z` in 8.31 seconds using 6 completed provider requests and 455,307 decoded bytes. It examined 1,295 candidate IDs, downloaded and inserted 5 unknown bodies, and performed no full-body or authoritative state scan. The 48-hour observation must still establish that this remains stable. Periodic complete state-ID scans are expected and must remain separately visible in the server metrics.

## Controlled correctness and recovery coverage

The automated suite covers these scenarios without touching the personal collection:

- first import, unchanged incremental discovery, new and backdated articles, state-only changes, body reconciliation, and subscription changes that safely promote to a full import;
- generation-safe pagination across all articles, scoped counts and search, versioned body reads, body invalidation, change-token replay, and expired/mismatched cursor recovery;
- warm normalized IndexedDB loading, interrupted metadata backfill, legacy snapshot migration, body-cache eviction, multi-tab notifications, latest-intent reconciliation, and outbox replay after reload;
- coalesced refreshes, provider deadlines, credential replacement, stale-run fencing, interrupted imports, expired leases, forward-only migrations, serialized restore, and committed-generation rollback;
- 425-item failure/retry, 20,005-item chunking, accepted-before-restart recovery, ambiguous mid-job failure, idempotency conflicts, frozen target membership, and newer unread intent that wins before or during a bulk job;
- virtualized rendering, keyboard navigation across page boundaries, stable row identity, search cancellation, and persisted PWA update prompts.

The full suite is the reproducible evidence source for these controlled cases. It does not substitute for a production application update, physical-device behavior, or the 48-hour observation.

## Compatibility and rollback switch

`READER_CLIENT_PATH=paginated` is the default. Set `READER_CLIENT_PATH=snapshot` and restart the application to make the browser use only the compatibility snapshot API. With `READER_CACHE_ENABLED=true`, that snapshot is assembled from the last committed SQLite generation. Set `READER_CACHE_ENABLED=false` as well only when the original provider-direct, request-blocking server path is required.

An isolated rollback test loaded all 20,000 synthetic articles through `/api/reader/snapshot`, showed `Up to date`, mounted 18 rows, and produced no console errors. The compatibility response was 52,616,357 decoded bytes and 357,165 Brotli-encoded bytes. A clean reload made only `/api/reader/config` and `/api/reader/snapshot` reader requests. Reverting `READER_CLIENT_PATH` to `paginated` reused the preserved browser/server cache and resumed status, navigation, changes, list, and body APIs.

Switching paths does not reverse SQLite migrations or clear committed generations, browser article outboxes, acknowledgement barriers, queued mark-read jobs, or durable server jobs. The snapshot browser continues replaying individual queued mutations. It does not create or poll bulk jobs; queued/durable jobs remain stored and resume when the paginated path is restored. The feed-bearing SQLite database remains on the Railway volume and is not replicated offsite.

## Outstanding rollout gates

- Run every applicable 20-sample browser scenario on the named 10 Mbps download / 2 Mbps upload / 100 ms latency reference profile.
- Run the same matrix on a named physical Android device and record model, Android version, browser version, and viewport.
- Record 20 uncached standard/large article-body runs on the reference network.
- Exercise an actual PWA application update with a queued synthetic intent and verify convergence after activation.
- Begin an explicitly authorized production rollout, then observe at least 48 hours including a configured full reconciliation.
- During that window, explain or eliminate any repeating subscription-fingerprint promotion, duplicate run, data loss, checkpoint advance after failure, or routine full-body retransmission.
- Verify that a cold reader cache can be rebuilt from Birchfeed after a fresh deployment. A future configuration-only backup must be restore-tested separately and must not include reader or highlight content.

Only after every gate passes should obsolete snapshot callers be disabled and `/api/reader/snapshot` be retired in a separate pull request. Issue #11 and parent #1 must remain open until then.
