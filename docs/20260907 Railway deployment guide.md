### Railway deployment guide

Chadashot deploys as one Docker-based Railway service from the repository root. The superseded FreshRSS deployment is excluded from Git and from the Docker build context; it is not part of the new service.

#### Required Railway configuration

- Connect the Chadashot GitHub repository and deploy from its root directory.
- Mount a persistent volume at `/data`.
- Keep `DATA_DIR=/data`. The container startup wrapper gives the unprivileged application user access to Railway's root-owned mount before starting Chadashot.
- Chadashot stores both its SQLite database and its redacted application log on that volume. By default the log is retained at up to 5 MiB and is also emitted to Railway's service console.
- Set `APP_ORIGIN` to `https://chadashot.app`.
- Set `ENCRYPTION_KEY` to 32 random bytes encoded as base64. One way to generate it locally is `openssl rand -base64 32`.
- Set `BOOTSTRAP_TOKEN` to a separate long random value for the initial setup ceremony, then remove it from Railway immediately after the first account and passkey are created.
- Railway supplies `PORT`; Chadashot listens on it automatically.
- Optional logging controls are `LOG_LEVEL` (`debug`, `info`, `warn`, or `error`), `LOG_OUTPUT` (`console`, `file`, or `both`), and `LOG_MAX_BYTES`. The defaults are `info`, `both`, and 5 MiB.
- Keep `READER_CACHE_ENABLED=true` for normal operation. `false` is a temporary application rollback to the legacy blocking reader route; it does not reverse the forward-only cache migration.
- `READER_SYNC_LEASE_MS` defaults to 45 seconds. The importing web process heartbeats every 15 seconds, and another process may take ownership only after the lease expires.
- Reader synchronization defaults are `READER_ROUTINE_SYNC_INTERVAL_MS=180000`, `READER_STATE_SYNC_INTERVAL_MS=900000`, `READER_BODY_SYNC_INTERVAL_MS=21600000`, `READER_FULL_SYNC_INTERVAL_MS=86400000`, and `READER_SYNC_OVERLAP_SECONDS=21600`. They bound discovery delay while keeping complete state, body, and collection reconciliation less frequent.
- The deployment health check is `/api/health`.

Treat `ENCRYPTION_KEY` as permanent application data: changing it makes the saved Birchfeed and Readwise credentials unreadable. Store it in a password manager as well as Railway.

#### Source and configuration recovery

GitHub is the source of truth for Chadashot's application code and deployment configuration. The production container does not replicate `/data/chadashot.sqlite` to Cloudflare R2 because that database is dominated by rebuildable Birchfeed articles, bodies, indexes, and synchronization state.

Keep `ENCRYPTION_KEY` in a password manager or offline recovery record outside both GitHub and Railway. Changing or losing it makes saved Birchfeed and Readwise credentials unreadable. Keep the non-secret Railway configuration documented here and in `.env.example`.

Railway's persistent volume remains the working copy of runtime state. If the volume is lost, redeploy from GitHub, bootstrap a new account and passkey, reconnect Birchfeed and Readwise, and rebuild the reader cache from Birchfeed. A future offsite backup may export only application configuration—account/passkey records, recovery-code hashes, encrypted integration settings, and schema metadata—but it must exclude highlights, sessions, authentication challenges, and every `reader_*` table.

#### Database migrations

Chadashot uses a small built-in migration runner rather than an ORM-specific tool. Each schema change has a monotonically increasing version and name, runs inside a SQLite transaction, and is recorded in `schema_migrations` before the server accepts traffic. This is the recommended mechanism for the project because it is deterministic, deploys with the application, and is easy to test against both an empty database and an older database snapshot.

Migration rules:

- Add a new migration for every schema change; never edit one that may already have run in production.
- Keep migrations forward-only. For rollback, restore the pre-deployment database backup and deploy the previous application image together.
- Test both a clean database and an upgrade from the previous schema in CI.
- Take or verify a recoverable Railway volume snapshot before deploying a migration that rewrites tables or removes data.
- Keep application code compatible with the migration it ships with; the server applies migrations before it begins listening.

#### Reader import process model

Run one Railway web service and do not add a separate reader worker in this phase. A request serves the latest committed SQLite generation immediately and asks the same web process to refresh in the background. Routine runs discover IDs inside an overlapping time window and request bodies only for unknown IDs. Scheduled state, changed-body, and daily full reconciliation cover provider capabilities that have no reliable incremental marker. Short transactions stage at most 500 articles at a time; no transaction stays open during a Birchfeed request. Every data-changing phase verifies the current fencing token and advances its checkpoint in the same SQLite transaction.

The lease is stored in SQLite rather than process memory so overlapping Railway deployments cannot publish competing generations. Its default 45-second expiry and 15-second heartbeat allow a replacement process to recover after an old process stops. An expired or replaced owner is fenced from publication even if its old provider request later completes. A failed or interrupted generation remains uncommitted and the last successful generation remains readable.

Only `reader_accounts.current_generation_id` is served. An incomplete generation cannot become visible merely because its staging rows remain on the Railway volume; a new process resumes with a new fenced import after the restored lease expires.

#### Safe replacement sequence

1. The existing FreshRSS instance contains no data that needs preserving, so detach or delete its old volume rather than mounting it into Chadashot.
2. Point the Railway service at this GitHub repository's root. Keep the Dockerfile builder, `/api/health` health check, and create a fresh volume mounted at `/data`.
3. Add the required production variables and remove obsolete FreshRSS or Litestream/R2 variables from the service.
4. Deploy and verify the health check before completing the custom-domain cutover. The final `chadashot.app` domain must be active before creating a real passkey because passkeys are bound to that domain.
5. Open Chadashot, enter the Railway `BOOTSTRAP_TOKEN`, create the initial account, register the first passkey, and save the one-time recovery codes.
6. Remove `BOOTSTRAP_TOKEN` from Railway after setup succeeds. The server also refuses bootstrap after an account exists.
7. Add a second passkey from Settings → Account security, then verify that one recovery code can sign in and is rejected when reused.
8. Connect Birchfeed and Readwise from Settings, then verify synchronization, read/star mutations, persistent highlights, and Reader document saving.
9. Confirm the service logs contain no Litestream startup or R2 replication attempts.

#### Rollback boundary

Do not reuse the old FreshRSS volume for Chadashot. Before account creation, rollback can simply redeploy the old FreshRSS image if desired. After Chadashot contains account or highlight data, rollback means deploying the previous Chadashot image with a matching database backup; keep its `/data` volume intact during any application rollback. For a cache-only rollback on a compatible image, set `READER_CACHE_ENABLED=false`. This preserves the migrated tables, committed cache, and browser outbox while routing reads through the legacy full-synchronization path.
