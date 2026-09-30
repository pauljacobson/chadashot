# Chadashot

Chadashot is a personal RSS reading client for Birchfeed. It is an installable Progressive Web App with a responsive desktop and Android interface, passkey authentication, system light/dark appearance, and separate Readwise highlight and Reader document-saving actions.

The previous FreshRSS deployment wrapper has been moved to a local, Git-ignored archive while the new client is developed. GitHub will remain the source for Railway deployments, and the new application will replace the existing FreshRSS service only after the client is ready for production cutover.

## Project status

The initial review version includes the responsive reading interface, an expandable folder/feed tree with favicons and persistent ordering preferences, fixture-backed local use, a durable transactional server cache for live Birchfeed data, manual feed subscriptions, offline article caching and queued read/star changes, encrypted service credentials with explicit disconnect controls, production passkey onboarding with recovery codes and multiple passkeys, persistent Readwise highlights, Reader document saving, and versioned database migrations. The product specification, deployment guide, and supporting research are in [`docs/`](docs/).

## Run locally

Requires Node.js 24 or later.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. Local development authentication only accepts loopback requests and cannot be enabled when `NODE_ENV=production`.

The fixture reader works without secrets. Local development automatically creates a private encryption key under the ignored `data/` directory when one is not supplied. Enter Birchfeed and Readwise credentials in the app's Settings panel rather than in the environment file. Production always requires an explicit `ENCRYPTION_KEY`.

Run all verification checks with:

```bash
npm run check
```

The isolated 20,000-article benchmark and current baseline are documented in the [reader performance benchmark](docs/20260908%20Reader%20performance%20benchmark.md).
The cache generation, lease, recovery, and rollback contract is documented in the [transactional reader cache design](docs/20260908%20Transactional%20reader%20cache.md).
The bounded generation lifecycle, storage guard, cleanup budgets, and operator workflow are documented in [bounded reader cache pruning](docs/20260910%20Bounded%20reader%20cache%20pruning.md).
The integrated measurements, rollout gates, and compatibility-switch procedure are tracked in the [integrated reader verification](docs/20260908%20Integrated%20reader%20verification.md).

## Deploy to Railway

Railway builds the root [`Dockerfile`](Dockerfile), checks `/api/health`, and stores the SQLite database and bounded application log in a volume mounted at `/data`. Production requires `APP_ORIGIN`, `ENCRYPTION_KEY`, and an initial `BOOTSTRAP_TOKEN`. GitHub is the source backup; the application does not replicate its feed-bearing SQLite database offsite. Follow the staged [Railway deployment guide](docs/20260907%20Railway%20deployment%20guide.md) before replacing the current FreshRSS service.

## Background reader updates

Production checks the connected RSS provider at startup and every five minutes after the previous check completes, using the same persisted owner identity, import leases, storage guard, and incremental checkpoints as device requests. No active browser session is required. Initial onboarding and a saved RSS connection are required. Fixture mode and disabled reader caching skip background imports.

Set `READER_BACKGROUND_SYNC_ENABLED=false` to disable polling, or tune `READER_BACKGROUND_SYNC_INTERVAL_MS` (default `300000`, minimum one minute). Development and tests leave polling off unless explicitly enabled. Failed full maintenance imports wait six hours before retrying while incremental checks continue; an unsuccessful first import retries sooner. Shutdown aborts running imports and releases their leases.

Five-minute polling adds up to 288 checks a day, plus checks triggered by device use. Based on recent logs, routine checks without body reconciliation downloaded roughly 0.34–0.52 MB, suggesting about 98–150 MB/day for those checks alone. State scans, new articles, body reconciliation, and daily full maintenance add traffic; roughly 0.3–0.5 GB/day is an initial estimate rather than measured hosted usage. Failed maintenance attempts can add more. The loop uses the existing process and bounded cache retention; it creates no extra service or copy of the database. Periodic outbound requests may prevent Railway sleeping, so compute costs could increase materially if the service previously slept. Freshness also depends on the RSS provider discovering new content. Review synchronization logs and Railway usage after rollout; a ten-minute interval halves routine polling traffic.

## Current decisions

- Birchfeed is the production RSS aggregation service.
- The client uses Birchfeed's Google Reader-compatible API.
- The connection endpoint is configurable for Birchfeed or another compatible service; Birchfeed's documented endpoint is prefilled.
- Fever support is deferred.
- The production app remains at `chadashot.app`.
- Railway deploys the application from this GitHub repository.
- Local development uses a tightly scoped development identity; production uses one-time onboarding followed by passkey authentication.
- Readwise highlight creation and Reader document saving are separate first-release actions.
