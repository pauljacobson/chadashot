# chadashot

A minimal Railway deployment wrapper for a self-hosted [FreshRSS](https://freshrss.org/) instance.

## Architecture

- Official FreshRSS Docker image, pinned in `Dockerfile`
- One Railway web service
- SQLite database
- One Railway persistent volume mounted at `/var/www/FreshRSS/data`
- FreshRSS's built-in cron for feed refreshes

The FreshRSS source is not copied into this repository. Application updates are made by changing the pinned image version in `Dockerfile` and redeploying.

## Run locally

Docker is required.

```bash
docker build -t chadashot .
docker volume create chadashot_data
docker run --rm \
  --name chadashot \
  --env-file .env.example \
  -p 8080:80 \
  -v chadashot_data:/var/www/FreshRSS/data \
  chadashot
```

Open <http://localhost:8080> and complete the FreshRSS installer using SQLite.

Stop the container with `Ctrl-C`. The named volume preserves the local installation. Remove it only when you deliberately want to erase the local FreshRSS data:

```bash
docker volume rm chadashot_data
```

## Deploy to Railway

### 1. Create the service

Create a Railway project from this GitHub repository. Railway will detect the root-level `Dockerfile` automatically.

### 2. Attach persistent storage

Before completing the FreshRSS installer, attach a Railway persistent volume to the FreshRSS service with this mount path:

```text
/var/www/FreshRSS/data
```

Do not mount the volume at `/var/www/FreshRSS`, because that would hide the application files supplied by the Docker image.

### 3. Configure variables

Set these service variables in Railway:

```dotenv
TZ=Etc/UTC
CRON_MIN=13,43
FRESHRSS_ENV=production
LISTEN=0.0.0.0:80
PORT=80
```

Change `TZ` to the desired [PHP timezone](https://www.php.net/manual/en/timezones.php). `CRON_MIN=13,43` refreshes feeds twice per hour.

Do not commit passwords or other secrets to this repository.

### 4. Enable public networking

Generate a Railway domain, targeting port `80`, or configure a custom domain.

### 5. Install FreshRSS

Open the public URL and complete FreshRSS's web installer:

1. Confirm the requirements check passes.
2. Select **SQLite** as the database.
3. Create the administrator account with a strong password.
4. Confirm the installation's public base URL.
5. Keep anonymous access and public user registration disabled unless intentionally required.

### 6. Configure backups

Enable Railway backups for the attached volume. The volume contains the SQLite database, configuration, users, and other persistent application data.

It is also useful to export FreshRSS subscriptions periodically as OPML.

## Updating FreshRSS

1. Check the [FreshRSS releases](https://github.com/FreshRSS/FreshRSS/releases).
2. Change `FRESHRSS_VERSION` in `Dockerfile`.
3. Build and test the new image locally.
4. Commit and push the change to trigger a Railway deployment.
5. Verify login and feed refreshes after deployment.

The persistent volume remains attached across deployments. Railway services with volumes can experience brief downtime while redeploying.

## Extensions

Railway currently allows one volume per service, and that volume is reserved for FreshRSS data. If third-party extensions are needed, add them to the Docker image through this repository rather than installing them only into the running container.

## References

- [FreshRSS installation](https://github.com/FreshRSS/FreshRSS#installation)
- [FreshRSS Docker documentation](https://github.com/FreshRSS/FreshRSS/blob/edge/Docker/README.md)
- [Railway volumes](https://docs.railway.com/reference/volumes)
