# Transactional reader cache

Issue #5 introduces durable full-import storage. It deliberately keeps the large compatibility snapshot response; incremental discovery belongs to #6 and paginated list/body APIs belong to #7.

## Data model

Migration 4 adds normalized tables for accounts, folders, subscriptions and folder membership, article metadata, article bodies, article state and folder membership, import generations, sync runs, checkpoints, leases, and confirmed state overrides.

Article bodies are stored separately from metadata and state. No collection-size cap is applied. The article and folder indexes are shaped for later generation-scoped feed/folder/date pagination without changing the storage contract.

Each provider/account/credential identity has three monotonically increasing versions:

- collection version advances when a complete generation publishes;
- body version advances with that complete generation; and
- state version advances on publication and after every confirmed mutation batch.

Credential replacement produces a new hashed account key and explicitly invalidates the prior identity. Neither plaintext credentials nor email addresses are stored in cache identity columns or logs.

## Import and publication

The Google Reader client keeps provider requests concurrent but streams each de-duplicated content page to a sink. Chadashot stages no more than 500 articles in one short SQLite transaction. Subscriptions and folders use the same 500-record bound. Provider requests run outside all SQLite transactions.

A generation starts as `staging`. The final `BEGIN IMMEDIATE` transaction verifies the current owner and unexpired fencing token, applies confirmed mutation overrides, marks the generation committed, advances all versions, changes the account's current generation pointer, records the checkpoint, and completes the sync run. A crash before that transaction leaves the prior pointer and checkpoint unchanged.

## Serving and failure behavior

With no committed generation, `/api/reader/snapshot` starts or joins background initialization and returns `202` with a small progress body and `Retry-After: 2`. It never represents an empty cache as a completed collection.

With a committed generation, the route reads that generation immediately and starts a refresh in the background when the last attempt is at least three minutes old. The compatibility response includes `cacheStatus` plus version headers. During a stalled refresh it reports `refreshing`; after a failed refresh it reports `stale` and retains the last error while continuing to serve the last good collection.

## Lease and restart recovery

The selected Railway model is one web service with the import running in its web process. A separate worker is unnecessary in this phase. SQLite still owns coordination because old and new Railway processes can overlap during deployment.

The default lease lasts 45 seconds and is heartbeated every 15 seconds. Acquisition increments a durable fencing token. An expired lease may be replaced after restart, but every stage and publish transaction verifies the owner and token. A fenced-out worker can record failure but cannot publish its stale generation.

## Mutation race barrier

Only a successful provider mutation writes cached state. The same transaction increments state version, updates the committed generation, adjusts unread counters, and records an operation-specific override. A new generation applies overrides before publication. An override is cleared only when an import that began after the mutation contains the same provider state; an older racing import cannot reintroduce stale read or star values.

## Backup and rollback

All cache state is ordinary SQLite data and is included in the existing Litestream/R2 replica. Restore tests serialize and reopen a committed database and confirm that bodies and state remain readable. Staging data may also restore, but only the committed account pointer is served.

Set `READER_CACHE_ENABLED=false` to route reads through the legacy full-synchronization path without reversing migration 4. This leaves committed generations and browser-queued writes intact for a later re-enable.
