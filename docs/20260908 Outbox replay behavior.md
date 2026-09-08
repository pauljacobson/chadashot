# Outbox replay behavior

This document records the transitional client synchronization contract introduced for issue #4. It keeps the existing mutation API and 300-item server limit while separating reader loading from queued-write replay.

## Reader loading

- Cached data is restored with pending and recently acknowledged local intent overlaid before the startup refresh.
- The server snapshot request starts independently of the outbox worker. A stalled, rate-limited, or rejected mutation batch cannot delay the reader response from becoming usable.
- Pending write count and replay errors remain visible after reader data loads.

## Bounded replay

- The worker submits at most 300 mutations per request and processes one batch at a time.
- A 1,000-item outbox therefore uses at most four requests; the existing 425-item mark-read case uses two requests of 300 and 125.
- One in-flight promise coalesces simultaneous triggers in a tab. The browser Web Locks API prevents another tab on the same origin from replaying the outbox concurrently.
- Authentication failures, retryable network/429/5xx failures, and permanent API rejections have distinct user-visible messages.
- Only fully successful chunks are acknowledged. A failed or ambiguous chunk and all later chunks remain in IndexedDB for inspection or retry.

## Revision and snapshot safety

Each queued record has a revision. A completed request can remove only the same revision it submitted, so an older completion cannot remove a newer toggle for that article and operation.

Successful revisions move atomically from the outbox to a durable acknowledgement barrier. The barrier continues to overlay the submitted value until a fresh provider snapshot contains that value. Cached snapshots never count as provider confirmation. This prevents an eventually consistent snapshot from reverting a successful local change, including across page reloads and offline restarts.

## Current boundary

This worker is intentionally a bridge to the durable semantic write model in issue #10. It does not raise the server batch limit, invent provider idempotency, or claim that an ambiguous provider response was successful.

## Verification

Automated coverage includes:

- reader data resolving while replay remains stalled;
- 1,000- and 425-item batch boundaries;
- same-tab and cross-tab duplicate-trigger guards;
- success followed by a 429 with the remaining mutations retained;
- authentication, retryable, and permanent error classification;
- a newer toggle arriving while an older revision is in flight;
- stale snapshot reconciliation and acknowledgement persistence across restart; and
- clearing cached identity, snapshots, pending mutations, and acknowledgements together.
