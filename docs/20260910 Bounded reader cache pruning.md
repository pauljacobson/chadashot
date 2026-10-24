# Bounded reader cache pruning

Issue #43 closes the generation-retention defect in the transactional reader cache. A published account now retains its current committed generation and only staging work protected by the same account, fencing token, and unexpired lease. Superseded committed, failed, and abandoned staging generations are pruning candidates. The synchronized article collection itself remains uncapped.

## Safety and consistency contract

`ReaderCache.prune()` is the only generation-deletion interface. It discovers candidates without changing data, then deletes at most the requested number. Each generation receives its own `BEGIN IMMEDIATE` transaction. The transaction rechecks the account's current pointer and the staging lease/fence protection after acquiring the writer lock. It removes the generation's FTS rows by indexed row ID before relying on existing foreign-key cascades for metadata, bodies, state, relationships, and navigation rows. The loop pauses between generations so normal writes have a chance to proceed. Per-phase timings separate writer-lock wait, FTS work, relational cascade work, and commit time in structured logs.

The paginated list, body, navigation, and change readers select the account generation and execute every dependent query within one short deferred read transaction. A concurrent publication and prune can therefore finish while an in-flight reader continues from its original SQLite snapshot. A later request carrying an old generation cursor still receives the existing reset response.

Migration 10 adds an indexed `reader_article_search_keys` row-ID map without rebuilding the existing FTS5 table. Article triggers keep the map and search index together. The same migration rebuilds mark-read job tables so `generation_id` remains immutable historical/idempotency data but no longer references the physical cache generation. Jobs and target rows are copied before the old target and job tables are dropped; target order, status, attempts, counters, errors, timestamps, and uniqueness constraints are preserved.

## Automatic scheduling

Automatic pruning is enabled by default with `READER_CACHE_AUTO_PRUNE=true`. It runs in a worker thread for file-backed databases so synchronous `better-sqlite3` deletion does not block the web process. A pass removes up to `READER_CACHE_PRUNE_MAX_DELETES` generations (100 by default), one transaction at a time, and waits `READER_CACHE_PRUNE_PAUSE_MS` (two seconds by default) between deletions. This drains an existing backlog during startup while preserving short windows for normal writes. Timers are stopped and the synchronization run is published or failed before cleanup begins. A pruning error is logged as an independent outcome and cannot change the synchronization result or checkpoint.

Set `READER_CACHE_AUTO_PRUNE=false` only as an operational rollback. This stops automatic deletion without reverting migration 10 or changing which generation is served. Lower the maximum or increase the pause when a slower storage volume needs a gentler cleanup pass.

Routine synchronization fingerprints only subscription IDs, folder IDs, and subscription-to-folder membership. Provider metadata such as titles, feed URLs, website URLs, icons, and unread counts does not define collection structure. Changed titles and URLs are applied to the current committed generation during the routine transaction instead of promoting the run to a full import. This prevents volatile provider metadata from continually creating replacement generations.

## Storage guard

Every full-import path, including initialization and an incremental run promoted after subscription changes, passes one storage guard before creating a staging generation. The estimate uses the current generation's persisted logical byte count, a 2.5 multiplier for duplicated FTS/index storage, a 512 MiB minimum initial-stage estimate, reusable SQLite free pages, a WAL reserve of the greater of 256 MiB or 35% of the staged estimate, and a separate 128 MiB maintenance reserve.

Reusable pages reduce additional database-file allocation but never satisfy the WAL or maintenance reserve. Cleanup has its own filesystem requirement because deleting a production-shaped generation can write that generation's pages into the WAL. If either operation lacks filesystem headroom, it is deferred with a structured reason containing only byte counts. The cache releases its lease, stops its timers, leaves the successful checkpoint unchanged, and continues serving the current generation. With no committed generation it retains the explicit initialization state. Automatic retry uses a 15-minute backoff; an explicit refresh reassesses capacity immediately.

## Declared budgets and local benchmark

Automatic cleanup was enabled against these pre-deployment budgets:

- generation writer-lock duration: at most 10,000 ms;
- web-process event-loop delay: at most 100 ms; and
- concurrent list-plus-navigation reader latency: at most 250 ms p95.

On 2026-09-10, `npm run benchmark:reader-cache-prune` ran against a disposable clone of a production-shaped local database. This is local evidence, not a measurement of the deployed Railway database. All declared gates passed. Collection-specific row counts, database sizes, and account-derived timing/storage measurements are omitted from this document; these results are not relabeled as synthetic evidence.

The benchmark command requires a disposable, file-backed database whose schema may be migrated and whose first eligible generation may be deleted:

```bash
npm run benchmark:reader-cache-prune -- --data-dir /path/to/disposable-clone
```

## Operator backlog command

Inspect an existing database without running migrations or making data changes:

```bash
npm run reader-cache:prune -- --dry-run --max-delete 5 --data-dir /path/to/data
```

The report contains candidate classifications, row/body counts, duration, page and free-page counts, database/WAL bytes, and filesystem headroom. It does not contain article bodies, titles, feed URLs, or credentials. A write run omits `--dry-run` and refuses to begin without cleanup headroom. `--max-delete` bounds the number of one-generation transactions.

Do not run a production write command until a verified backup, dry run, explicit production authorization, and post-change foreign-key/reader checks are in place. This implementation does not run `VACUUM`, truncate the WAL, resize a Railway volume, or change R2. Pruning makes database pages reusable and stops allocation from growing with generation history; WAL checkpointing and physical compaction remain separate maintenance operations.
