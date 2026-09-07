### Railway deployment guide

Chadashot deploys as one Docker-based Railway service from the repository root. The superseded FreshRSS deployment is excluded from Git and from the Docker build context; it is not part of the new service.

#### Required Railway configuration

- Connect the Chadashot GitHub repository and deploy from its root directory.
- Mount a persistent volume at `/data`.
- Keep `DATA_DIR=/data`. The container startup wrapper gives the unprivileged application user access to Railway's root-owned mount before starting Chadashot.
- Chadashot stores both its SQLite database and its redacted application log on that volume. By default the log is retained at up to 5 MiB and is also emitted to Railway's service console.
- Set `APP_ORIGIN` to `https://chadashot.app`.
- Set `ENCRYPTION_KEY` to 32 random bytes encoded as base64. One way to generate it locally is `openssl rand -base64 32`.
- Set `BOOTSTRAP_TOKEN` to a separate long random value for the initial setup ceremony.
- Railway supplies `PORT`; Chadashot listens on it automatically.
- Optional logging controls are `LOG_LEVEL` (`debug`, `info`, `warn`, or `error`), `LOG_OUTPUT` (`console`, `file`, or `both`), and `LOG_MAX_BYTES`. The defaults are `info`, `both`, and 5 MiB.
- The deployment health check is `/api/health`.

Treat `ENCRYPTION_KEY` as permanent application data: changing it makes the saved Birchfeed and Readwise credentials unreadable. Store it in a password manager as well as Railway.

#### Optional Cloudflare R2 backups

Railway volume backups and Cloudflare R2 serve different purposes. Enable Railway's native volume backups as the fastest same-platform restore path. Chadashot can additionally upload a consistent SQLite backup to a private R2 bucket, which provides an off-platform copy.

Create a private R2 bucket and an S3 API token restricted to that bucket, then add these Railway variables:

```text
BACKUP_S3_ENDPOINT=https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com
BACKUP_S3_REGION=auto
BACKUP_S3_BUCKET=<PRIVATE_BUCKET_NAME>
BACKUP_S3_ACCESS_KEY_ID=<SCOPED_ACCESS_KEY_ID>
BACKUP_S3_SECRET_ACCESS_KEY=<SCOPED_SECRET_ACCESS_KEY>
BACKUP_S3_PREFIX=chadashot
BACKUP_INTERVAL_HOURS=24
```

All four endpoint/bucket/credential values are required together; omitting all of them disables offsite backups. Chadashot creates the first backup about one minute after startup and repeats it at the configured interval. Successful uploads and failures appear in Settings → Application logs. Objects are organized by year and month under the configured prefix.

Configure an R2 lifecycle rule to expire backups after the chosen retention period; 30–90 daily copies is a reasonable starting point for this personal app. Keep `ENCRYPTION_KEY` outside both Railway and R2 as part of the recovery record. Integration credentials inside SQLite are encrypted with that key, recovery codes are stored only as hashes, and saved highlight text remains readable inside the database backup.

Test restoration before relying on the backup: stop writes to Chadashot, retrieve a recent `.sqlite` object, place it at `/data/chadashot.sqlite`, and start the service. The migration runner will then apply any newer application migrations. Do not restore a database created by a newer application release into an older release unless that release explicitly supports the newer schema.

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
3. Add the required production variables and, if desired, the R2 variables above. Remove obsolete FreshRSS variables from the service.
4. Deploy and verify the health check before completing the custom-domain cutover. The final `chadashot.app` domain must be active before creating a real passkey because passkeys are bound to that domain.
5. Open Chadashot, enter the Railway `BOOTSTRAP_TOKEN`, create the initial account, register the first passkey, and save the one-time recovery codes.
6. Remove `BOOTSTRAP_TOKEN` from Railway after setup succeeds. The server also refuses bootstrap after an account exists.
7. Add a second passkey from Settings → Account security, then verify that one recovery code can sign in and is rejected when reused.
8. Connect Birchfeed and Readwise from Settings, then verify synchronization, read/star mutations, persistent highlights, and Reader document saving.
9. If R2 is configured, wait for the first `Offsite database backup uploaded` log entry and confirm the object exists in the private bucket.

#### Rollback boundary

Do not reuse the old FreshRSS volume for Chadashot. Before account creation, rollback can simply redeploy the old FreshRSS image if desired. After Chadashot contains account or highlight data, rollback means deploying the previous Chadashot image with a matching database backup; keep its `/data` volume intact during any application rollback.
