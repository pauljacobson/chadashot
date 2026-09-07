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
- The deployment health check is `/api/health`.

Treat `ENCRYPTION_KEY` as permanent application data: changing it makes the saved Birchfeed and Readwise credentials unreadable. Store it in a password manager as well as Railway.

#### Optional Cloudflare R2 backups

Railway volume backups and Cloudflare R2 serve different purposes. Enable Railway's native volume backups as the fastest same-platform restore path. For an off-platform copy, the production container includes Litestream and Railway supplies its R2 connection entirely through service variables. Backup scheduling and Cloudflare credentials are not handled by Chadashot application code.

A separate Railway cron/template service is a good fit for PostgreSQL or MySQL because it can connect to those servers over the network. It cannot safely back up Chadashot's local SQLite file: Railway attaches a volume to one service, and a second service cannot share that mount. Running Litestream beside Chadashot in the same container keeps SQLite locking local and supported while retaining Railway as the configuration surface.

Create a private R2 bucket and an S3 API token restricted to that bucket, then add these Railway variables:

```text
LITESTREAM_REPLICA_URL=s3://<PRIVATE_BUCKET_NAME>/chadashot?endpoint=<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com&region=auto
LITESTREAM_ACCESS_KEY_ID=<SCOPED_ACCESS_KEY_ID>
LITESTREAM_SECRET_ACCESS_KEY=<SCOPED_SECRET_ACCESS_KEY>
```

All three values are required together; omitting all of them disables offsite replication. Litestream restores `/data/chadashot.sqlite` from R2 when the volume is empty, starts Chadashot, and sends changes to R2 every ten seconds. Its logs appear in Railway's service logs rather than Settings → Application logs because Litestream is infrastructure, not part of the application.

Litestream creates a daily full snapshot and retains a rolling 30-day point-in-time history. Give the scoped R2 token permission to read, write, list, and delete objects in this bucket so Litestream can restore and enforce retention. Do not add an R2 lifecycle rule shorter than 30 days because deleting individual objects can break an incremental restore chain. Keep `ENCRYPTION_KEY` outside both Railway and R2 as part of the recovery record. Integration credentials inside SQLite are encrypted with that key, recovery codes are stored only as hashes, and saved highlight text remains readable inside the database replica.

Test restoration before relying on the backup: confirm Litestream has created objects in R2, deploy the same image and variables with a fresh `/data` volume in a temporary Railway environment, and verify that the account and articles return. The migration runner will apply any newer application migrations after Litestream restores the database. Do not restore a database created by a newer application release into an older release unless that release explicitly supports the newer schema.

#### Database migrations

Chadashot uses a small built-in migration runner rather than an ORM-specific tool. Each schema change has a monotonically increasing version and name, runs inside a SQLite transaction, and is recorded in `schema_migrations` before the server accepts traffic. This is the recommended mechanism for the project because it is deterministic, deploys with the application, and is easy to test against both an empty database and an older database snapshot.

Migration rules:

- Add a new migration for every schema change; never edit one that may already have run in production.
- Keep migrations forward-only. For rollback, restore the pre-deployment database backup and deploy the previous application image together.
- Test both a clean database and an upgrade from the previous schema in CI.
- Take or verify a Railway/R2 backup before deploying a migration that rewrites tables or removes data.
- Keep application code compatible with the migration it ships with; the server applies migrations before it begins listening.

#### Safe replacement sequence

1. The existing FreshRSS instance contains no data that needs preserving, so detach or delete its old volume rather than mounting it into Chadashot.
2. Point the Railway service at this GitHub repository's root. Keep the Dockerfile builder, `/api/health` health check, and create a fresh volume mounted at `/data`.
3. Add the required production variables and, if desired, the three Litestream/R2 variables above. Remove obsolete FreshRSS variables from the service.
4. Deploy and verify the health check before completing the custom-domain cutover. The final `chadashot.app` domain must be active before creating a real passkey because passkeys are bound to that domain.
5. Open Chadashot, enter the Railway `BOOTSTRAP_TOKEN`, create the initial account, register the first passkey, and save the one-time recovery codes.
6. Remove `BOOTSTRAP_TOKEN` from Railway after setup succeeds. The server also refuses bootstrap after an account exists.
7. Add a second passkey from Settings → Account security, then verify that one recovery code can sign in and is rejected when reused.
8. Connect Birchfeed and Readwise from Settings, then verify synchronization, read/star mutations, persistent highlights, and Reader document saving.
9. If R2 is configured, confirm the Litestream startup and replication messages in Railway's service logs, then confirm objects exist under the `chadashot` prefix in the private bucket.

#### Rollback boundary

Do not reuse the old FreshRSS volume for Chadashot. Before account creation, rollback can simply redeploy the old FreshRSS image if desired. After Chadashot contains account or highlight data, rollback means deploying the previous Chadashot image with a matching database backup; keep its `/data` volume intact during any application rollback.
