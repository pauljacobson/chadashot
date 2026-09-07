### Railway deployment guide

Chadashot deploys as one Docker-based Railway service from the repository root. The superseded FreshRSS deployment is excluded from Git and from the Docker build context; it is not part of the new service.

#### Required Railway configuration

- Connect the Chadashot GitHub repository and deploy from its root directory.
- Mount a persistent volume at `/data`.
- Set `APP_ORIGIN` to `https://chadashot.app`.
- Set `ENCRYPTION_KEY` to 32 random bytes encoded as base64. One way to generate it locally is `openssl rand -base64 32`.
- Set `BOOTSTRAP_TOKEN` to a separate long random value for the initial setup ceremony.
- Railway supplies `PORT`; Chadashot listens on it automatically.
- The deployment health check is `/api/health`.

Treat `ENCRYPTION_KEY` as permanent application data: changing it makes the saved Birchfeed and Readwise credentials unreadable. Store it in a password manager as well as Railway.

#### Safe replacement sequence

1. Export or back up the existing FreshRSS data before changing the current service.
2. Deploy Chadashot as a new Railway service with a new volume mounted at `/data`.
3. Verify the Railway health check before assigning the custom domain.
4. Move `chadashot.app` to the new service. The final domain must be active before creating a real passkey because passkeys are bound to that domain.
5. Open Chadashot, enter the Railway `BOOTSTRAP_TOKEN`, create the initial account, and register the first passkey.
6. Remove `BOOTSTRAP_TOKEN` from Railway after setup succeeds. The server also refuses bootstrap after an account exists.
7. Connect Birchfeed and Readwise from Settings, then verify sync, read/star mutations, highlights, and Reader saving.
8. Keep the old FreshRSS service or volume available until these checks pass, then retire it separately.

#### Rollback boundary

Do not reuse the old FreshRSS volume for Chadashot. A rollback should point the domain back to the old service; Chadashot's `/data` volume remains intact for a later retry.
