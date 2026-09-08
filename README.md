# Chadashot

Chadashot is a personal RSS reading client for Birchfeed. It is an installable Progressive Web App with a responsive desktop and Android interface, passkey authentication, system light/dark appearance, and separate Readwise highlight and Reader document-saving actions.

The previous FreshRSS deployment wrapper has been moved to a local, Git-ignored archive while the new client is developed. GitHub will remain the source for Railway deployments, and the new application will replace the existing FreshRSS service only after the client is ready for production cutover.

## Project status

The initial review version includes the responsive reading interface, an expandable folder/feed tree with favicons and persistent ordering preferences, fixture-backed local use, live Birchfeed synchronization, manual feed subscriptions, offline article caching and queued read/star changes, encrypted service credentials with explicit disconnect controls, production passkey onboarding with recovery codes and multiple passkeys, persistent Readwise highlights, Reader document saving, versioned database migrations, and optional Litestream replication to Cloudflare R2. The product specification, deployment guide, and supporting research are in [`docs/`](docs/).

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

## Deploy to Railway

Railway builds the root [`Dockerfile`](Dockerfile), checks `/api/health`, and stores the SQLite database and bounded application log in a volume mounted at `/data`. Production requires `APP_ORIGIN`, `ENCRYPTION_KEY`, and an initial `BOOTSTRAP_TOKEN`. Optional Railway environment variables enable Litestream to continuously replicate SQLite to a private Cloudflare R2 bucket and restore it when a new volume starts empty. Follow the staged [Railway deployment guide](docs/20260907%20Railway%20deployment%20guide.md) before replacing the current FreshRSS service.

## Current decisions

- Birchfeed is the production RSS aggregation service.
- The client uses Birchfeed's Google Reader-compatible API.
- The connection endpoint is configurable for Birchfeed or another compatible service; Birchfeed's documented endpoint is prefilled.
- Fever support is deferred.
- The production app remains at `chadashot.app`.
- Railway deploys the application from this GitHub repository.
- Local development uses a tightly scoped development identity; production uses one-time onboarding followed by passkey authentication.
- Readwise highlight creation and Reader document saving are separate first-release actions.
