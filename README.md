# Chadashot

Chadashot is a planned personal RSS reading client for Birchfeed. It will be an installable Progressive Web App with a responsive desktop and Android interface, passkey authentication, offline reading, and separate Readwise highlight and Reader document-saving actions.

The previous FreshRSS deployment wrapper has been moved to a local, Git-ignored archive while the new client is developed. GitHub will remain the source for Railway deployments, and the new application will replace the existing FreshRSS service only after the client is ready for production cutover.

## Project status

The first application foundation is in development. It currently provides the responsive reading interface, fixture-backed synchronization, local development identity, system light/dark appearance, and typed server boundary. The product specification and supporting research are in [`docs/`](docs/).

## Run locally

Requires Node.js 24 or later.

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. Local development authentication only accepts loopback requests and cannot be enabled when `NODE_ENV=production`.

Run all verification checks with:

```bash
npm run check
```

## Current decisions

- Birchfeed is the production RSS aggregation service.
- The client uses Birchfeed's Google Reader-compatible API.
- Fever support is deferred.
- The production app remains at `chadashot.app`.
- Railway deploys the application from this GitHub repository.
- Local development uses a tightly scoped development identity; production uses one-time onboarding followed by passkey authentication.
- Readwise highlight creation and Reader document saving are separate first-release actions.
