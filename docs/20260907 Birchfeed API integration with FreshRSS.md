# Birchfeed API integration with FreshRSS

## Conclusion

A self-hosted FreshRSS installation cannot be configured as a client of Birchfeed through FreshRSS’s built-in UI. Birchfeed and FreshRSS are both RSS aggregation/sync **servers**. Birchfeed’s statement that it supports “FreshRSS” means that a separate reader app which offers a **FreshRSS account type** can use Birchfeed’s FreshRSS-compatible Google Reader API. It does not mean that one FreshRSS server can use another sync service as its backend.

Therefore, there is no FreshRSS menu path at `chadashot.app` where Birchfeed’s URL, email, or API key should be entered. Do **not** put a Birchfeed key into FreshRSS’s “API password” field: that field creates a credential for clients connecting *to chadashot.app*, not for FreshRSS to connect outward.

## Verified facts

### Roles and protocol

- Birchfeed describes itself as an RSS syncing service which polls feeds, stores articles, and reading/starred state; a reader app “syncs against” Birchfeed. Its documented drop-in integration is for apps which already support **FreshRSS or Google Reader**. [Birchfeed developer documentation](https://birchfeed.app/developers#paths)
- Birchfeed’s homepage says that if an RSS **app** shows a Google Reader, FreshRSS, or Fever option, it can connect to Birchfeed. Its tested examples are Reeder Classic, NetNewsWire, Current, and Unread. [Birchfeed homepage](https://birchfeed.app/)
- FreshRSS likewise documents its Google Reader and Fever interfaces as APIs through which mobile/native **apps access FreshRSS**. It recommends Google Reader as the better API and calls Fever limited and less efficient. [FreshRSS mobile access documentation](https://freshrss.github.io/FreshRSS/en/users/06_Mobile_access.html)

The supported arrangement is therefore:

```text
native RSS reader (client)
        |
        | Google Reader/FreshRSS API, or Fever API
        v
Birchfeed (server and source of feeds/read/starred state)
```

It is **not**:

```text
FreshRSS server at chadashot.app -> Birchfeed server
```

### Birchfeed connection values for a compatible reader app

Preferred Google Reader/FreshRSS-compatible setup:

| Client field | Value |
|---|---|
| Account type | FreshRSS or Google Reader |
| Server/API URL | `https://birchfeed.app/api/greader.php` |
| Username | Birchfeed account email address |
| Password | Birchfeed API key (46 characters, beginning `bf_`) |

Birchfeed says API keys are created under **Settings**, are displayed only once, and should be one key per app/device. A key grants read/write access to feeds and reading state and can be revoked independently. [Birchfeed base URLs](https://birchfeed.app/developers#urls) and [API keys](https://birchfeed.app/developers#tokens)

For the Reader API, the traditional `ClientLogin` request accepts the account email as `Email` and the Birchfeed API key as `Passwd`. It returns the same key as the auth value. Subsequent calls use:

```http
Authorization: GoogleLogin auth=bf_your_token_here
```

[Birchfeed Reader API authentication](https://birchfeed.app/developers#greader)

Fever alternative:

| Client field | Value |
|---|---|
| Account type | Fever |
| Endpoint | `https://birchfeed.app/api/fever.php` |
| Email | Needed locally by the client to derive the digest, but not sent as a separate username |
| Password/key | Birchfeed API key |
| Wire credential | `api_key = md5(lowercase(email) + ":" + birchfeed_key)` |

The client sends the derived `api_key` as POST data. A bad Fever key returns HTTP 200 with `"auth": 0`. Fever cannot add or remove subscriptions, so the Reader API is preferable when the app manages feeds. [Birchfeed Fever API](https://birchfeed.app/developers#fever)

### FreshRSS’s actual API settings (the opposite direction)

FreshRSS 1.29.1—the version pinned by this repository—has these relevant paths:

1. As an administrator, open the cog/configuration menu, then **Administration → Authentication**.
2. Enable **Allow API access (required for mobile apps and sharing user queries)** and save.
3. Open the cog/configuration menu, then **Account → Profile**.
4. Under **External access via API**, set **API password (e.g., for mobile apps)**.

These paths and labels are visible in FreshRSS’s first-party UI source: [configuration menu](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/app/layout/header.phtml), [Authentication form](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/app/views/auth/index.phtml), and [Profile/API-password form](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/app/views/user/profile.phtml). FreshRSS’s user documentation describes the same two steps. [FreshRSS mobile access documentation at 1.29.1](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/docs/en/users/06_Mobile_access.md)

Those settings expose these local server endpoints to external client apps:

```text
https://chadashot.app/api/greader.php
https://chadashot.app/api/fever.php
```

They do not provide fields for another server URL or another provider’s credentials. A live, unauthenticated check on 2026-09-07 confirmed that `https://chadashot.app/api/` publishes those chadashot FreshRSS endpoints. This confirms that chadashot is acting as an API **server**, not as a Birchfeed client.

## Reverse-proxy and credential caveats

- FreshRSS requires HTTPS for API access because the API password is transmitted in clear text at the application-protocol level; FreshRSS warns that it may also appear in server logs if a client sends it via GET. Prefer clients which use POST for login. [FreshRSS profile warning source](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/app/views/user/profile.phtml) and [Google Reader API examples](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/docs/en/developers/06_GoogleReader_API.md)
- When clients connect **to FreshRSS**, reverse proxies/web servers must preserve API path information. FreshRSS documents Apache `AllowEncodedSlashes On`, and nginx configuration for `PATH_INFO` plus `fastcgi_split_path_info`; otherwise encoded stream IDs containing `%2F` can fail. The API status page offers full and partial configuration tests. [FreshRSS server configuration](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/docs/en/admins/10_ServerConfig.md) and [mobile API testing](https://github.com/FreshRSS/FreshRSS/blob/1.29.1/docs/en/users/06_Mobile_access.md#testing)
- Those chadashot reverse-proxy requirements are irrelevant when a separate client connects directly to `birchfeed.app`: chadashot is not in that network path. Birchfeed states that trailing and duplicate slashes are tolerated at its API. [Birchfeed base URLs](https://birchfeed.app/developers#urls)
- Treat a Birchfeed `bf_...` key like a password. It has full read/write access to the Birchfeed account’s feeds and reading state. Do not paste it into FreshRSS, repository files, logs, or URL query strings. [Birchfeed API keys](https://birchfeed.app/developers#tokens)

## What remains unresolved

- No official FreshRSS documentation or core UI/source reviewed here provides a remote Google Reader/FreshRSS/Fever **client** configuration. A third-party FreshRSS extension could theoretically add such a feature, but no specific extension was identified or claimed by either product’s official documentation.
- If the intended target is not the FreshRSS web application but another RSS app, the minimum information needed is the app’s name and a screenshot or exact labels of its account setup fields. The Birchfeed values above can then be mapped to that UI.
- If Birchfeed’s signed-in Settings screen presents credential labels that differ from “account email” and “API key,” provide those exact labels or a redacted screenshot. Do not provide the key itself.

## Practical next step

Use the Birchfeed credentials in a separate supported reader app by selecting that app’s **FreshRSS** or **Google Reader** account type and entering Birchfeed’s endpoint, email, and API key. Keep `chadashot.app` as an independent FreshRSS server, or migrate subscriptions between the two with OPML; direct ongoing server-to-server synchronization is not documented or supported by either product.
