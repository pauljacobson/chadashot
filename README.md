# Chadashot

Chadashot is a personal RSS reading client for Birchfeed. It is an installable Progressive Web App with a responsive desktop and Android interface, passkey authentication, system light/dark appearance, and separate Readwise highlight and Reader document-saving actions.

The previous FreshRSS deployment wrapper has been moved to a local, Git-ignored archive while the new client is developed. GitHub will remain the source for Railway deployments, and the new application will replace the existing FreshRSS service only after the client is ready for production cutover.

## Project status

The initial review version includes the responsive reading interface, fixture-backed local use, live Birchfeed synchronization, read and star mutations, encrypted service credentials, production passkey onboarding, and both Readwise actions. The product specification, deployment guide, and supporting research are in [`docs/`](docs/).

## Run locally

Requires Node.js 24 or later.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. Local development authentication only accepts loopback requests and cannot be enabled when `NODE_ENV=production`.

The fixture reader works without secrets. To connect Birchfeed or Readwise locally, add a generated `ENCRYPTION_KEY` to `.env`; enter the service credentials in the app's Settings panel rather than in the environment file.

Run all verification checks with:

```bash
npm run check
```

## Deploy to Railway

Railway builds the root [`Dockerfile`](Dockerfile), checks `/api/health`, and stores the SQLite database in a volume mounted at `/data`. Production requires `APP_ORIGIN`, `ENCRYPTION_KEY`, and an initial `BOOTSTRAP_TOKEN`. Follow the staged [Railway deployment guide](docs/20260907%20Railway%20deployment%20guide.md) before replacing the current FreshRSS service.

## Current decisions

- Birchfeed is the production RSS aggregation service.
- The client uses Birchfeed's Google Reader-compatible API.
- The connection endpoint is configurable for Birchfeed or another compatible service; Birchfeed's documented endpoint is prefilled.
- Fever support is deferred.
- The production app remains at `chadashot.app`.
- Railway deploys the application from this GitHub repository.
- Local development uses a tightly scoped development identity; production uses one-time onboarding followed by passkey authentication.
- Readwise highlight creation and Reader document saving are separate first-release actions.
