# Open-source clients for FreshRSS

_Checked 2026-09-07 against official project repositories/docs and FreshRSS’s official client list._

## Bottom line

A mature, independent, self-hosted web frontend for FreshRSS does **not yet appear to exist**. FreshRSS’s official list currently contains one genuine “Web (self-hosted)” client, **FriRSS**. It is real, feature-rich, actively released, and explicitly built on FreshRSS’s Google Reader API—but its repository began in May 2026 and its author describes it as a personal, largely “vibe coded” project. That makes it promising rather than mature. [FreshRSS client list](https://github.com/FreshRSS/FreshRSS#apis--native-apps), [FriRSS README](https://github.com/Fripix/Frirss#about), [FriRSS repository metadata](https://api.github.com/repos/Fripix/Frirss)

The mature self-hosted web reader is **FreshRSS’s own included interface**. FreshRSS officially says that this responsive UI works in mobile and desktop browsers; separate apps are optional API clients. [FreshRSS mobile-access documentation](https://freshrss.github.io/FreshRSS/en/users/06_Mobile_access.html)

## Roles that should not be conflated

1. **Locally installed clients** consume the Google Reader-compatible API from `chadashot.app` and keep read/starred state synchronized. They are open source, but they are not self-hosted browser applications.
2. **Separate self-hosted web frontends** run as another web service while FreshRSS continues to fetch feeds and own the canonical data. FriRSS is the only verified current example on FreshRSS’s official list.
3. **Alternative self-hosted aggregators** fetch and store feeds themselves. Having a Google Reader-compatible API often means they expose an API *to their own clients*; it does not mean they can consume FreshRSS as a backend.

FreshRSS recommends its Google Reader API over Fever because Fever has fewer features and is less efficient and less safe. API access must be enabled and each FreshRSS user must set an API password. [FreshRSS mobile-access documentation](https://freshrss.github.io/FreshRSS/en/users/06_Mobile_access.html)

## Best options

| Option | Category and platform | License | Verified FreshRSS relationship | Maintenance evidence | Candid tradeoff |
|---|---|---|---|---|---|
| **FreshRSS built-in web reader** | Included self-hosted web UI; desktop and mobile browsers | [AGPL-3.0](https://github.com/FreshRSS/FreshRSS/blob/edge/LICENSE.txt) | It is the same application and data store, not a separate API client. FreshRSS explicitly documents browser access. | [FreshRSS 1.29.1](https://github.com/FreshRSS/FreshRSS/releases/tag/1.29.1) was released 2026-05-20; the official repository remains active. | Most mature and least operational complexity, but it does not provide a fundamentally separate UI/product experience. |
| **FriRSS** | **Separate self-hosted web frontend**; Docker deployment plus installable mobile PWA | [MIT](https://github.com/Fripix/Frirss/blob/main/LICENSE) | Its first-party README says it sits on FreshRSS through the Google Reader API, replaces only the interface, and accepts a FreshRSS server URL, username, and API password. FreshRSS also lists it as a GReader client. [Installation](https://github.com/Fripix/Frirss#installation) | [v1.4.9](https://github.com/Fripix/Frirss/releases/tag/v1.4.9) shipped 2026-09-03, with frequent recent releases. | The closest match to the request, with Docker, offline support, multiple users/servers, and a PWA. However, it is only months old; the author candidly calls it a personal, largely AI-built project. It adds another database, credential store, proxy, deployment, and security surface. Active is not the same as mature. |
| **FeedFlow** | Locally installed on Android, iOS, macOS, Windows, and Linux | [Apache-2.0](https://github.com/prof18/feed-flow/blob/main/LICENSE) | The project documents direct FreshRSS sync; FreshRSS lists it as a GReader client. [FeedFlow README](https://github.com/prof18/feed-flow#keep-control-over-sync-and-storage), [FreshRSS client list](https://github.com/FreshRSS/FreshRSS#apis--native-apps) | [1.17.0](https://github.com/prof18/feed-flow/releases/tag/1.17.0-all) shipped 2026-09-01. | Best single client family across nearly every mainstream platform, with offline reading. It must be installed per device and does not provide a self-hosted URL for arbitrary browsers. FreshRSS’s matrix still leaves several detailed compatibility capabilities unverified (`?`). |
| **Capy Reader** | Locally installed on Android 11+ | [GPL-3.0](https://github.com/jocmp/capyreader/blob/main/LICENSE) | Its README explicitly supports FreshRSS, and FreshRSS lists GReader sync, feed management, labels, favourites, and its highest sync-speed rating. [Capy README](https://github.com/jocmp/capyreader), [FreshRSS client list](https://github.com/FreshRSS/FreshRSS#apis--native-apps) | Stable [2026.07.1212](https://github.com/jocmp/capyreader/releases/tag/2026.07.1212) shipped 2026-07-18; the project also published an August nightly and says releases occur roughly weekly. | Strongest Android-specific choice and better-verified FreshRSS feature coverage than most clients, but Android-only. |
| **RSS Guard** | Locally installed on Windows, Linux/BSD, macOS, and OS/2 | [GPL-3.0](https://github.com/martinrotter/rssguard/blob/master/LICENSE.md) | Its README explicitly lists FreshRSS among supported Google Reader API services; FreshRSS lists offline use, feeds, labels, favourites, and podcasts. [RSS Guard README](https://github.com/martinrotter/rssguard), [FreshRSS client list](https://github.com/FreshRSS/FreshRSS#apis--native-apps) | Long-running project (copyright dates 2011–2026); [5.2.5](https://github.com/martinrotter/rssguard/releases/tag/5.2.5) shipped 2026-08-20. | The most mature power-user desktop option here, but it is a conventional desktop application rather than a polished hosted web interface or mobile client. |

## Self-hosted projects that are alternatives, not FreshRSS frontends

These projects are open-source self-hosted readers, but their first-party documentation describes them as feed aggregators with their own data stores and client-facing APIs—not as clients of a remote FreshRSS account:

- **Miniflux** ([Apache-2.0](https://github.com/miniflux/v2/blob/main/LICENSE)) fetches feeds, stores them in PostgreSQL, supplies its own responsive web UI, and exposes Fever/Google Reader and REST APIs to clients. Its documented integrations do not include consuming FreshRSS. It would replace `chadashot.app`, not provide another UI over it. [Official README](https://github.com/miniflux/v2)
- **CommaFeed** ([Apache-2.0](https://github.com/Athou/commafeed/blob/master/LICENSE)) is a self-hosted Google Reader-inspired aggregator with its own databases and server-side polling. Its Fever and Google Reader APIs are explicitly for native apps connecting *to CommaFeed*; no first-party FreshRSS-backend integration is documented. [Official README](https://github.com/Athou/commafeed)
- **Nextcloud News** ([AGPL-3.0](https://github.com/nextcloud/news/blob/master/COPYING)) identifies itself as an RSS/Atom aggregator installed into Nextcloud and exposes its own REST API for client developers. It is not documented as a FreshRSS client. [Official README](https://github.com/nextcloud/news)

None appears in FreshRSS’s official client list as a consumer of FreshRSS. They can be considered only if replacing FreshRSS is acceptable; do not expect subscriptions, read state, or stars to remain live-synchronized with `chadashot.app`.

## Recommendation for `chadashot.app`

Keep FreshRSS as the sole aggregation/sync backend and use its built-in web reader as the dependable self-hosted default. It is the only mature hosted web experience in this stack and avoids operating a second credential-bearing service.

If a different web UI is important, trial **FriRSS** alongside—not instead of—FreshRSS. Put it behind HTTPS, back up its data volume, use a dedicated FreshRSS API password, and retain FreshRSS’s UI as the fallback while FriRSS develops a longer security and maintenance track record.

For installed apps, choose **FeedFlow** for one consistent client across desktop and mobile; choose **Capy Reader** on Android when FreshRSS feature coverage and sync performance matter most; choose **RSS Guard** for a mature, feature-heavy desktop client. All three use `chadashot.app` as the source of truth, so Birchfeed is unnecessary for this arrangement.
