### Chadashot custom RSS client — proposed product specification

**Status:** Proposed v0.1  
**Date:** 2026-09-07  
**Primary user:** Paul  
**Primary devices:** Android phone and desktop browser  
**Deployment:** Personal web application deployed from GitHub to Railway at `chadashot.app`

### Product definition

Chadashot is a focused personal reading client that uses Birchfeed as its RSS aggregation and synchronization service. It provides a quieter, more personal interface than a general-purpose RSS reader while leaving feed polling, subscription state, unread state, and starring in Birchfeed.

The client is an installable Progressive Web App. It uses passkeys for passwordless authentication, follows the device's light or dark appearance, supports offline reading of recently synchronized articles, and can send selected passages to Readwise.

The first release is intentionally single-user and single-provider. The design should keep the data-source boundary clean enough to point at FreshRSS later, but it should not carry the complexity of a general multi-provider product.

### Product principles

1. **Reading comes first.** The interface should emphasize article titles and article text rather than dashboards, counts, or decorative cards.
2. **Fast on a phone.** Core actions remain reachable with one hand and have visible controls even when swipe gestures are also supported.
3. **Quietly capable.** Search, shortcuts, highlighting, offline state, and synchronization are available without filling the screen with permanent toolbars.
4. **System-native appearance.** Light and dark themes follow the operating-system/browser setting automatically.
5. **The service is the source of truth.** Birchfeed owns subscriptions and read/starred state; the client caches and queues changes but does not become a second aggregator.
6. **Secrets stay on the server.** Birchfeed and Readwise keys never enter browser storage or application logs.

### Goals for the first useful release

- Sign in with a passkey on Android and desktop.
- Install and launch the client as a PWA.
- Connect one Birchfeed account through its Google Reader-compatible API.
- Browse all articles, unread articles, starred articles, folders, and individual feeds.
- Read sanitized feed content in a focused reading view.
- Mark articles read/unread and starred/unstarred with optimistic updates.
- Add and remove subscriptions when supported by the configured Birchfeed API key.
- Cache recent content for offline reading and queue state changes made offline.
- Select text, optionally add a note, and save the highlight to Readwise.
- Save the current article to Readwise Reader as a separate explicit action.
- Follow the device's light/dark preference without a separate theme account setting.

### Non-goals for the initial release

- Multiple application users, public registration, organizations, or sharing accounts.
- Multiple simultaneous RSS providers.
- Fever API support.
- Running a feed fetcher or replacing Birchfeed/FreshRSS.
- Full-text extraction from arbitrary article pages. The initial reader renders sanitized content supplied by the feed and offers “Open original” for truncated feeds.
- Bidirectional Readwise synchronization or editing highlights after they have been sent.
- Guaranteeing that highlights created through the Readwise Highlights API appear attached to the corresponding document inside Readwise Reader.
- Bluesky, AT Protocol, ActivityPub, email newsletters, podcasts, or text-to-speech.
- Theme customization beyond following the system preference.

### Information architecture

#### Primary destinations

- **Inbox:** unread items across all feeds.
- **All:** all synchronized items, newest first.
- **Starred:** items starred in Birchfeed.
- **Feeds:** an expandable tree of Birchfeed folders/labels with their feeds nested beneath them; feeds without a recognized folder appear under Uncategorized. A toggle above the tree limits it to feeds containing unread items and hides folders left empty by that filter.
- **Preferences:** personal interface choices, including system appearance and alphabetical or most-recent folder/feed ordering.
- **Settings:** service connections, passkeys, offline storage, and application information. Each connected service has a confirmation-protected Disconnect action that removes only Chadashot's stored credential and does not alter the remote account or previously synchronized content.

“Read later” should not be invented as a separate state in the first release. Starred remains the portable saved-item state supported by the RSS service. Saving to Reader is an explicit outbound action rather than another local queue.

#### Desktop layout

Use a three-pane layout:

1. A narrow navigation sidebar containing destinations, an expandable folder/feed tree with favicons and unread counts, connection status, and settings.
2. An article list showing source, title, excerpt, age, unread state, and star.
3. A reading pane with article metadata, reading actions, selected-text controls, and the article body.

The sidebar and list pane can each be collapsed. The reading column should remain comfortably narrow even on large monitors.

#### Mobile layout

Use one primary pane at a time:

- Inbox/list is the initial screen.
- Selecting an item pushes the reading screen into view.
- A bottom navigation bar exposes Inbox, Starred, Feeds, Preferences, and Settings.
- The reading screen uses a compact top bar for Back, Star, Save to Reader, and More.
- Selecting article text opens a small contextual action bar: Highlight, Add note, and Copy.

Swiping an article may mark it read or star it, but every gesture must have an equivalent visible action and an undo message.

### Visual direction

- Calm editorial appearance with generous whitespace and limited chrome.
- Warm-neutral surfaces, near-black text, and a muted green primary accent.
- Pale amber is reserved for text highlights and synchronization warnings.
- One sans-serif UI family; article content may use a readable serif family supplied by the system font stack.
- Normal and medium weights only; hierarchy comes primarily from size, spacing, and color.
- Compact controls on desktop and touch targets of approximately 44 by 44 CSS pixels on mobile.
- No gradients, glass effects, oversized rounded cards, or dashboard-style metric tiles.

### Core interaction requirements

#### Reading and navigation

- Opening an unread article marks it read after either two seconds of visible reading or a meaningful scroll, whichever happens first.
- The user can disable automatic marking in Preferences.
- Article-list position and reading position are restored when navigating back.
- The desktop client supports keyboard navigation: `j`/`k` for next/previous, `Enter` to open, `m` to toggle read, `s` to toggle star, `/` to search, and `?` for shortcut help.
- A progress indicator is shown only while reading a long article.
- “Open original” always opens the canonical URL in a new browser tab.

#### Search

- Initial search covers the locally synchronized article title, source, author, and cached feed content.
- Search results clearly indicate when the device is offline and therefore searching only cached material.
- Provider-side historical search may be added if Birchfeed's supported API surface proves reliable in the compatibility spike.

#### Highlighting

1. The user selects text in the reading pane.
2. A contextual bar offers **Highlight**, **Add note**, and **Copy**.
3. Highlight creates a local record immediately and colors the selected passage pale amber.
4. If Readwise is connected, the record enters an outbound synchronization queue.
5. Success changes the local state to “Saved to Readwise.” Failure retains the highlight and exposes Retry without losing the selection.
6. Add note opens a small text field before saving.

The Readwise payload should contain the selected text, article title, author when known, canonical source URL, highlight timestamp, note, and a stable `highlight_url` generated by Chadashot. That stable URL allows subsequent submissions to update rather than duplicate the highlight.

#### Save article to Reader

“Save to Reader” is distinct from highlighting. It sends the article's canonical URL and available metadata to the Reader document-save endpoint. If feed content is complete and legally appropriate to forward, the application may include sanitized HTML; otherwise Reader should fetch the canonical URL itself.

The user receives one of three outcomes: Saved, Already in Reader, or Retry needed. A successful response may expose “Open in Reader.”

### RSS service integration

#### Protocol choice

Use the Google Reader-compatible API as the first integration surface. FreshRSS recommends it over Fever and documents subscription, unread-count, tag, stream, write-token, and subscription-edit endpoints. The connection screen accepts an explicit server or API URL so the same adapter can work with Birchfeed or another compatible service; Birchfeed's documented `https://birchfeed.app/api/greader.php` endpoint is prefilled.

The application stores the complete API base URL explicitly. It must not blindly append FreshRSS-specific paths to an arbitrary service root.

#### Required provider operations

- Authenticate through `accounts/ClientLogin` using the Birchfeed account email and a dedicated API key.
- Add a feed or website URL through the write-token-protected `subscription/quickadd` endpoint, with `subscription/edit` and `ac=subscribe` as the compatibility fallback.
- Fetch subscriptions, folders/tags, unread counts, article streams, continuation pages, and individual item content.
- Obtain and refresh the write token required for mutations.
- Mark read/unread, star/unstar, and mark a stream read.
- Add, edit, move, and remove subscriptions where Birchfeed supports the corresponding operation.

#### Provider boundary

The application does not need a plugin system, but network operations should sit behind one small `ReaderSource` interface. Application state must consume normalized subscriptions, folders, articles, and mutations rather than raw Google Reader response objects.

```text
Birchfeed Google Reader API
          │
          ▼
   BirchfeedSource
          │ normalized domain objects
          ▼
 application services ── local cache/outbox ── React interface
```

A future `FreshRssSource` can initially reuse the same implementation with a different compatibility profile. FreshRSS-only operations such as its private “actualize feeds” action must never enter the shared interface.

### Readwise integration

#### Supported in the initial integration

- Validate a personal Readwise access token server-side.
- Create highlights with `POST https://readwise.io/api/v2/highlights/`.
- Include a highlight note and stable source metadata.
- Save whole documents with `POST https://readwise.io/api/v3/save/`.
- Respect `429` responses and the `Retry-After` header.
- Queue failed or offline requests and retry with bounded exponential backoff.

#### Important API limitation

The public Reader API currently documents creating and listing documents, but not creating a highlight attached to a particular Reader document. The original Readwise API does document highlight creation. Therefore:

- **Highlight** is guaranteed to save to Readwise.
- **Save to Reader** is guaranteed to save the article as a Reader document.
- The first release must not claim that the new highlight will appear anchored inside that Reader document.

If Readwise publishes a supported Reader-highlight endpoint, the integration can later attach locally stored selections to Reader documents without changing the reading interface.

### Authentication and account recovery

#### First-run bootstrap

- Public registration does not exist.
- A fresh deployment creates no default account and exposes a one-time setup route only while the user table is empty.
- Deployment requires a high-entropy bootstrap token supplied as an environment secret. The setup route accepts that token, creates Paul's initial account, and immediately starts passkey registration.
- Account creation and first-passkey registration complete as one setup transaction. An account without a usable credential must not be left behind after a failed ceremony.
- After successful registration, the database records setup completion and the bootstrap token is no longer accepted, even if the deployment variable still exists. The variable should then be removed from Railway.

#### Local development authentication

- Local development may use `AUTH_MODE=development` to provide a fixed test identity without invoking WebAuthn on every restart.
- Development authentication is accepted only when the application is running in development mode and the request originates from a loopback host.
- The service must refuse to start if development authentication is configured together with a production environment.
- Browser-level authentication tests still run real WebAuthn ceremonies against `localhost`, which browsers treat as a secure context.
- Staging and production never expose the development identity or an authentication bypass.

#### Passkey behavior

- Use discoverable credentials so the sign-in screen can present “Sign in with a passkey” without first asking for a username.
- Require user verification through the device screen lock, fingerprint, face recognition, PIN, or password-manager verification.
- Bind verification to the exact production origin and relying-party ID.
- Store challenges server-side with a short expiry and consume each challenge once.
- Permit multiple named passkeys, including Android/Google Password Manager and a desktop password manager or security key.
- Store the credential public key, credential ID, signature counter, transports, backup state, creation date, and last-used date.

#### Sessions

- Create an opaque random server-side session after successful WebAuthn verification.
- Deliver it through an `HttpOnly`, `Secure`, `SameSite=Lax` cookie.
- Use a 30-day rolling expiry with a maximum lifetime and explicit revocation.
- Protect state-changing application endpoints with same-origin checks and a CSRF token where required.
- Logout revokes the server session and clears cached private data from IndexedDB and Cache Storage.

#### Recovery

- The first setup ceremony creates one passkey and a set of one-time recovery codes. The codes are shown once and must be copied or downloaded before entering the reader.
- Settings supports multiple named passkeys so an Android device, password manager, or hardware key can each provide access.
- Each recovery code can create one authenticated session and is then invalidated. Regenerating the set invalidates all older unused codes.
- There is no password fallback, email reset, public registration, or security-question flow in the initial release.

### PWA and offline behavior

- Provide an application manifest with standalone display, app name, short name, start URL, theme/background colors, 192-pixel and 512-pixel icons, maskable icon, and Android install screenshots.
- Cache the versioned application shell and static assets through the service worker.
- Prompt before activating a new application version when unsynchronized actions exist; otherwise update unobtrusively.
- Do not blindly cache authenticated API responses in service-worker Cache Storage.
- Store normalized subscriptions, the most recent article lists and bodies, the last authenticated offline identity, and the read/star mutation outbox in IndexedDB.
- Default offline budget: the latest 200 articles or 100 MB, whichever is reached first. Make this limit configurable later.
- Queue read/star mutations while offline, coalesce repeated changes to the same article state, and replay them in chronological order when connectivity returns.
- Display one quiet status label: Offline, Syncing, Up to date, or Action needed.
- Provide an explicit “Clear offline data” control.

### Synchronization cadence

- Birchfeed remains responsible for polling publisher feeds; Chadashot never polls individual publisher URLs.
- Synchronize immediately after sign-in and PWA launch.
- Synchronize when the application regains focus after at least one minute, when connectivity returns, and after a manual refresh gesture.
- While the application is visible, poll Birchfeed approximately every three minutes with overlap protection and backoff after errors or rate limiting.
- Stop the foreground timer while the application is hidden. Mobile browsers cannot be relied on to run periodic background work consistently.
- Push notifications are not part of the initial release. A later server-side job may poll Birchfeed every five to ten minutes and send opt-in Web Push notifications if timely article alerts become desirable.

### System theme behavior

- Declare support for both color schemes and use `prefers-color-scheme` as the only theme source in the first release.
- Update surfaces, text, dividers, focus rings, highlight colors, form controls, browser theme color, and PWA launch background together.
- React immediately when the system appearance changes without reloading.
- Use dark neutral backgrounds rather than pure black and retain readable contrast for muted metadata.
- Respect `prefers-reduced-motion` for pane transitions and progress effects.

### Proposed technical architecture

#### Runtime and deployment

- One Node.js 24 TypeScript service deployed as a Docker container on Railway.
- GitHub is the deployment source. Pull requests run verification; the protected production branch is deployed to Railway after merge.
- React 19 and Vite for the client.
- Express 5 for the same-origin JSON API and static production assets.
- SQLite in WAL mode on the Railway persistent volume.
- Explicit SQL migration files from the first release.
- `@simplewebauthn/server` and `@simplewebauthn/browser` 13.3.x for WebAuthn ceremony generation and verification.
- `vite-plugin-pwa` for manifest generation, service-worker registration, and update prompting.

One process is sufficient for a personal app. A separate reverse proxy, Redis, background-worker deployment, and message broker are unnecessary initially.

#### Production cutover from FreshRSS

- Develop and verify the new client without altering the live FreshRSS deployment.
- Before cutover, export FreshRSS subscriptions as OPML and take a recoverable backup of its Railway volume.
- Give the new application a fresh persistent volume mounted at its own data path; do not treat the existing FreshRSS database as an application database.
- Verify the production container, health endpoint, migrations, and bootstrap guard on a Railway-provided staging address.
- Switch `chadashot.app` to the new service only when the release is ready. Because passkeys are bound to their relying-party domain, complete Paul's real account-and-passkey onboarding after the custom domain and HTTPS certificate are active.
- Keep the prior FreshRSS service or volume available for rollback until Birchfeed synchronization, passkey login, PWA installation, and Readwise actions have been verified in production.
- Removing the prior FreshRSS service and volume is a separate destructive step and is not part of an automatic deployment.

#### Logical modules

```text
Web/PWA interface
    │
    ├── authentication client
    ├── reading/list state
    ├── IndexedDB cache and outbox
    └── selection/highlight anchoring
            │
            ▼
Same-origin application API
    ├── passkey and session service
    ├── BirchfeedSource adapter
    ├── Readwise integration
    ├── synchronization coordinator
    └── encrypted credential store
            │
            ▼
          SQLite
```

#### Suggested data model

- `users`: one local user record.
- `passkey_credentials`: credential ID, public key, counter, transports, backup metadata, name, timestamps.
- `sessions`: hashed opaque token, creation, expiry, last activity, revocation.
- `rss_connections`: API base, account identifier, encrypted API token, compatibility profile, last successful sync.
- `integration_credentials`: encrypted Readwise token and validation timestamp.
- `subscriptions` and `folders`: normalized cached provider records.
- `articles`: normalized metadata, sanitized feed content, state, timestamps, cache expiry.
- `reading_positions`: article and last known position.
- `highlights`: selected text, optional note, local anchor data, stable external URL, Readwise state and identifiers.
- `outbox`: mutation type, payload, attempt count, next attempt, last error.
- `settings`: small typed user-preference records.

#### Secret handling

- Encrypt provider tokens with an authenticated cipher.
- Supply the master encryption key through the deployment secret store; never place it in SQLite or a backup containing SQLite.
- Redact credentials and sensitive query parameters from structured logs.
- Never send Birchfeed or Readwise tokens to the browser.

### Security requirements

- HTTPS is mandatory in production because WebAuthn is origin-bound and API credentials must be protected in transit.
- Sanitize all feed HTML before rendering and use a restrictive Content Security Policy.
- Do not render arbitrary scriptable embeds in article content.
- Avoid server-side full-text fetching in the MVP. If it is later introduced, implement IP pinning, public-address validation on every redirect, size/time limits, and content-type checks to prevent SSRF.
- Rate-limit passkey challenges, verification failures, bootstrap attempts, and outbound proxy calls.
- Use exact-origin comparison before attaching an RSS credential to an outbound request.
- Do not include tokens, article bodies, or highlight text in ordinary operational logs.
- Backups must include schema and user data but exclude or separately protect the deployment master key.

### Accessibility requirements

- Meet WCAG 2.2 AA contrast and interaction requirements for the primary flows.
- Preserve browser focus indicators and logical keyboard order.
- All icon-only actions have accessible names and visible tooltips on desktop.
- Touch actions have non-overlapping targets of approximately 44 CSS pixels.
- Selected text remains legible in light and dark modes.
- Dynamic sync and save results use polite announcements; failures requiring action use an alert.
- Reading text supports browser zoom to at least 200 percent without horizontal page scrolling.

### Quality and verification strategy

#### Automated checks

- Unit tests for normalization, pagination, mutation coalescing, highlight anchoring, and retry behavior.
- Contract tests using recorded redacted Birchfeed responses.
- An opt-in live compatibility suite using a dedicated Birchfeed API key and disposable test feed.
- Integration tests for passkey challenge expiry, replay rejection, origin/RP validation, counters, and multiple credentials.
- Browser-level tests at desktop and Android-sized viewports for sign-in, installability, offline launch, read/star queues, selection highlighting, Readwise retry, and system-theme changes.
- Security regression tests for token leakage, XSS payloads in feed content, CSRF, unauthorized connection access, and unsafe redirects.

#### Manual release checks

- Install from Chrome on Android and launch from the home screen.
- Sign in with an Android passkey and a second desktop passkey.
- Switch the operating system between light and dark while the app remains open.
- Read cached content in airplane mode, mutate state, and confirm reconciliation after reconnecting.
- Create a Readwise highlight and save an article to Reader using non-sensitive test content.
- Confirm no provider token appears in browser storage, browser network responses, server logs, or exported backups.

### Acceptance criteria for MVP

The MVP is complete when all of the following are true:

- A fresh deployment can be bootstrapped exactly once and two passkeys can be registered.
- The same account can sign in from current Chrome on Android and a desktop browser.
- The installed PWA launches in standalone mode and follows system light/dark changes.
- Birchfeed subscriptions, folders, unread counts, articles, read state, and stars synchronize reliably.
- The most recent cached articles remain readable offline.
- Offline read/star changes synchronize without duplication or lost state.
- Selecting text creates a durable local highlight and sends it to Readwise when connected.
- Saving an article produces a valid Readwise Reader document or a clear retryable error.
- Logging out removes the local private cache and revokes the active session.
- No production credential is exposed to client storage or logs.

### Delivery sequence

#### Phase 0 — compatibility spike

- Connect to Birchfeed with a disposable API key.
- Exercise the precise read and write endpoints needed by the MVP.
- Capture sanitized fixtures and document deviations from FreshRSS behavior.
- Decide whether subscription management belongs in MVP based on actual Birchfeed responses.

#### Phase 0.5 — delivery foundation

- Establish GitHub pull-request checks, production-branch protection, Railway Docker deployment, health checks, migration execution, secret configuration, and a fresh application data volume.

#### Phase 1 — reading foundation

- Application shell, system theme, responsive navigation, provider adapter, article lists, reader, read/star mutations, and SQLite migrations.

#### Phase 2 — secure personal access

- Loopback-only development identity, production startup guard, one-time account-and-passkey onboarding, multiple passkeys, secure sessions, passkey management, and recovery procedure.

#### Phase 3 — PWA and offline

- Manifest, install experience, update prompt, IndexedDB cache, outbox, offline status, and reconciliation.

#### Phase 4 — Readwise

- Token validation, local highlighting, reliable highlight outbox, notes, Save to Reader, rate-limit handling, and sync status.

#### Later integrations

- Android Web Share integration for destinations already installed on the device.
- Bluesky posting through AT Protocol OAuth and `app.bsky.feed.post`, with explicit account connection and a preview before publication.
- ActivityPub sharing only after selecting a concrete server/API target; ActivityPub federation alone does not define a universal authenticated “compose post” client API for every implementation.

### Decisions recommended now

1. Use Birchfeed rather than running FreshRSS as the production aggregation service.
2. Use the Google Reader-compatible API, not Fever.
3. Build a small new client while borrowing patterns and selected MIT-licensed utilities from FriRSS where they pass review.
4. Keep `chadashot.app` as the product name/domain unless a separate name emerges during implementation.
5. Make Readwise highlight creation and Reader document saving separate actions in the interface.
6. Do not include full-text extraction, multi-user auth, OIDC, or social posting in MVP.

### Primary references

- [Birchfeed developer documentation](https://birchfeed.app/developers)
- [FreshRSS Google Reader-compatible API documentation](https://github.com/FreshRSS/FreshRSS/blob/edge/docs/en/developers/06_GoogleReader_API.md)
- [Readwise Highlight API](https://readwise.io/api_deets)
- [Readwise Reader API](https://readwise.io/reader_api)
- [SimpleWebAuthn documentation](https://simplewebauthn.dev/)
- [Web app manifest guidance](https://web.dev/learn/pwa/web-app-manifest)
- [Passkey registration guidance](https://web.dev/articles/passkey-registration)
- [`prefers-color-scheme` reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-color-scheme)
