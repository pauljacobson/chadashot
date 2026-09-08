# Birchfeed incremental synchronization

This document records the capability evidence, safe stopping rule, cadence, and fallback selected for issue #6. Live probes were read-only and emitted only counts, field names, booleans, and a hash of the endpoint host.

## Capability matrix

| Capability | Live Birchfeed result, 2026-09-08 | Use |
| --- | --- | --- |
| Descending stream order (`r=n`) | 10/10 items ordered by `timestampUsec` and `crawlTimeMsec`; publication dates were not monotonic | Safe only with modified/ingest time plus overlap |
| Ascending stream order (`r=o`) | 10/10 items ordered by `timestampUsec` and `crawlTimeMsec`; publication dates were not monotonic | Diagnostic/full-scan option, not routine cursor |
| `ot` cutoff | Seven-day query returned a paginated result; a future cutoff returned zero items | Routine modified/ingest-time window |
| ID discovery | `stream/items/ids` accepted `ot`, returned 10 IDs and a continuation | Discover candidate new IDs without bodies |
| Selective content | `stream/items/contents` returned both requested IDs | Fetch bodies only for unknown IDs during routine sync |
| State markers | `unread-count` returned 654 entries and `newestItemTimestampUsec` markers | Change hint only; not authoritative item state |
| Full unread/starred sets | Existing full scans succeeded and paginate independently | Authoritative scheduled state reconciliation |
| Per-item state categories | Neither 20 newest nor 20 oldest sampled items exposed read/starred tags | New items begin unread/unstarred until authoritative state scan |
| Continuation safety | Existing client rejects repeated tokens | All scans retain duplicate/repetition guards |
| Body modification marker without body | Not available from item-ID discovery | Scheduled bounded content overlap plus daily full fallback |
| Deleted-item stream | Not verified/supported | Daily full reconciliation is authoritative |

The public FreshRSS Google Reader implementation is supporting evidence, not proof of Birchfeed behavior. It applies `ot` to publication or modified time, orders by its continuation ID, and supports selective item lookup. The live results above are the authority for the selected Birchfeed path: [FreshRSS Google Reader API documentation](https://github.com/FreshRSS/FreshRSS/blob/edge/docs/en/developers/06_GoogleReader_API.md) and [FreshRSS API source](https://github.com/FreshRSS/FreshRSS/blob/edge/p/api/greader.php).

## Safe stopping rule

Routine discovery starts at the last successfully committed routine cutoff minus a six-hour overlap and follows every continuation until the provider ends the result. Only then may the routine checkpoint advance in the same transaction as new items.

The rule never stops merely because it sees a known ID. Backdated publications, identical timestamps, delayed ingestion, and backfilled items remain discoverable because the live endpoint orders by ingest/modified time and the overlap includes boundary ties. A failed or repeated-continuation scan commits neither data nor checkpoint, so retry starts from the prior safe cutoff.

Subscription identity is checked independently. A new, removed, or changed subscription/folder fingerprint requests a full generation import immediately; this is how a newly subscribed feed's old history enters the cache rather than waiting for its articles to cross a recent-time cursor.

## Selected cadence and traffic boundary

| Work | Default cadence | Provider traffic | Healthy maximum expected delay |
| --- | --- | --- | --- |
| Routine discovery | 3 minutes | subscription metadata, changed/new IDs in six-hour overlap, selective bodies for unknown IDs | routine interval plus provider run time |
| State reconciliation | 15 minutes | complete unread and starred ID scans plus unread counts | 15 minutes plus provider run time |
| Existing-body reconciliation | 6 hours | bounded content stream since the prior successful body cutoff minus six hours | 6 hours plus provider run time |
| Full reconciliation | 24 hours, credential change, subscription fingerprint change, or checkpoint gap | complete content, subscription, unread and starred traversal | immediate on trigger; otherwise 24 hours |

An unchanged routine discovery downloads zero article bodies. The six-hour body reconciliation may redownload unchanged boundary bodies because the API exposes no body-change marker separately from content; metrics report candidate, changed, unchanged, request, and byte counts explicitly.

## Live validation

The first issue #6 run correctly treated the existing issue #5 cache as checkpointless and rebuilt it once. The immediately following routine run used the committed overlap cursor against the same connected Birchfeed account:

| Measurement | Full checkpoint bootstrap | Unchanged routine pass | Reduction |
| --- | ---: | ---: | ---: |
| Provider requests | 50 | 4 | 92.0% |
| Provider decoded bytes | 91,581,385 | 376,404 | 99.59% |
| Provider run time | 93.43 s | 6.73 s | 92.8% |
| Candidate article IDs | 25,799 bodies traversed | 396 IDs | — |
| Article bodies downloaded | 25,799 | 0 | 100% |

The routine pass found every candidate in the local generation, inserted nothing, and advanced its checkpoint only after the complete ID window succeeded. Cached page delivery stayed independent from that background work. The remaining roughly 27 MB gzip compatibility snapshot and its serialization/compression cost belong to the pagination and virtualization work in the next issue; they are not Birchfeed synchronization traffic.

## State and write ordering

Unread and starred absence is authoritative only after both complete state scans finish. An incomplete scan never turns unseen articles into read or unstarred. State data and its checkpoint commit together. Confirmed local mutation overrides from issue #5 are applied after provider state so an older scan cannot undo a newer write.

## Sessions, retries, and fallback

Authentication is cached for five minutes and write tokens for two minutes, keyed by a non-reversible credential hash. Authentication cache entries are invalidated on credential changes or authentication rejection. Read requests use at most three attempts for transport, 429, and 5xx responses, honor bounded `Retry-After`, and add jitter; permanent 4xx responses do not retry.

If an advertised incremental operation is rejected or violates its continuation/order contract, the run records the limitation, advances no checkpoint, and requests the tested full-import path. `READER_CACHE_ENABLED=false` remains the broader legacy rollback from issue #5.
