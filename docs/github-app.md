# Legacy personal GitHub App setup

For new shared connections, use the [guided GitHub App setup](github-installation.md), which supports development activity, webhooks, and optional two-way issue updates. This page describes the retained personal user-token flow.

Each Trestl installation can use its own GitHub App. No central Trestl service, shared developer credentials, or paid GitHub organization is required. A personal GitHub account can register and install an app. GitHub.com is supported by this browser flow; GitHub Enterprise Server and Gitea can continue using personal tokens.

## 1. Choose the public Trestl address

Set `APP_ORIGIN` to the exact origin people use in their browsers, such as `https://work.example.com`. Include a nonstandard port if needed; do not include a subpath, query, or fragment. In production use HTTPS and `SECURE_COOKIES=true`. Keep the existing durable `APP_SECRET` (at least 32 characters); changing it makes saved credentials unreadable.

For local development, use `APP_ORIGIN=http://127.0.0.1:5173` with `pnpm dev`. Vite proxies `/api` to the backend. For `pnpm start`, use the actual app port, normally `http://127.0.0.1:4317`. HTTP is supported only on loopback addresses. The browser must use the same hostname throughout; `localhost` and `127.0.0.1` have different cookies.

## 2. Register the app on GitHub

Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**. Replace `https://work.example.com` below with your exact `APP_ORIGIN`.

| Setting | Value |
| --- | --- |
| GitHub App name | A unique name for your installation, e.g. `Trestl – My workspace` |
| Homepage URL | `https://work.example.com` |
| Callback URL | `https://work.example.com/api/v1/git/github-app/callback` |
| Request user authorization (OAuth) during installation | **Unchecked**; Trestl starts its own authorization flow with state and PKCE |
| Setup URL | `https://work.example.com/api/v1/git/github-app/setup` |
| Redirect on update | Checked, so repository changes return to Trestl |
| Webhook → Active | **Unchecked**; this implementation uses on-demand reads and optional scheduled reconciliation |
| Repository permissions → Issues | **Read-only** |
| Repository permissions → Metadata | Read-only (GitHub supplies this automatically) |
| Other repository, organization and account permissions | No access |
| Where can this GitHub App be installed? | **Any account**, if other people or organizations will use this instance; **Only on this account** for an exclusively personal installation |

Keep **user-to-server token expiration enabled** under Optional Features. Trestl requires expiring user tokens and automatically renews them. It does not require repository contents, write permissions, device flow, or an app private key. This is a **GitHub App**, not an OAuth App; both use an OAuth browser flow but their permission models differ.

## 3. Configure the server

Generate a **client secret** in the GitHub App settings. Copy the **Client ID** (not the numeric App ID) and the app slug from `https://github.com/apps/YOUR-SLUG`.

```dotenv
APP_ORIGIN=https://work.example.com
SECURE_COOKIES=true
GITHUB_APP_CLIENT_ID=Iv23.example
GITHUB_APP_CLIENT_SECRET=your-generated-client-secret
GITHUB_APP_SLUG=your-app-slug
```

Keep these values in your instance's private environment, not in source control. `.env.example` contains empty placeholders, and Docker Compose forwards all three GitHub settings. Restart Trestl after configuring them; with Compose, recreate the app container using `docker compose up -d --build app`.

Your reverse proxy must forward the callback and setup paths under `/api` to Trestl. Do not log query strings for these paths: OAuth callbacks contain temporary authorization codes. Trestl's own request logger excludes query strings.

## 4. Connect a personal GitHub account

1. Sign in to Trestl and open **Settings → Integrations → Connect GitHub**.
2. Choose the correct GitHub account and authorize the app.
3. If no accessible installation exists yet, Trestl sends you to GitHub to install it. Select your personal account or an organization, then choose repositories.
4. GitHub returns you to Trestl. Settings displays installation access verified through GitHub's API. You can also use **Choose repositories**, **Manage access**, or **Refresh access** later.
5. In any project's **Resources → Find Git issue**, use `owner/repository#123`. Administrators can also reuse this connection for repository imports.

GitHub authorization and app installation are separate steps. Organization access may require an owner's approval. A connection can therefore be authorized before it has access to any repositories; Settings shows the remaining step. An installation ID supplied in a redirect never grants access by itself.

Existing personal-token connections remain available under **Use access token**. They are not silently converted or removed. Existing imports keep their connection; you can remove an import and recreate it with your GitHub App connection without deleting its imported work.

## Credential and permission lifecycle

Trestl uses **GitHub App user access tokens**, so it can read only resources accessible to both the app installation and that GitHub user. It does not use installation tokens to bypass personal permissions. GitHub credentials remain personal to a Trestl account and workspace, and are encrypted at rest using `APP_SECRET`. Neither access nor refresh tokens are returned to the frontend or included in exports.

GitHub normally issues an eight-hour access token and a six-month refresh token. Trestl renews expiring access tokens on demand, including during scheduled imports, and stores each replacement refresh token. Refresh is serialized per connection across app instances. If authorization expires or is revoked, use **Reconnect GitHub** with the same GitHub account; the connection ID and dependent imports are retained. To use a different account, add a new connection.

**Disconnect** deletes local credentials, cancels pending reconnects, and stops dependent imports. Existing work and resource links remain. It does not uninstall the app or revoke other Trestl profiles' grants. To revoke access on GitHub itself, open **GitHub Settings → Applications → Authorized GitHub Apps**; installation repository access is managed under **Installed GitHub Apps**. Removing installation access is enforced by GitHub on subsequent API requests.

## Troubleshooting

- **Connect GitHub is disabled:** verify the three `GITHUB_APP_*` values, `APP_ORIGIN`, and `APP_SECRET`, then restart the app. An app slug is the URL slug, not its display name.
- **Expired sign-in / invalid state:** start again from Settings in the same browser, Trestl account, and session. Sign-in attempts expire after ten minutes and can be used only once. Starting another attempt invalidates the previous one in that session.
- **Callback fails:** verify the exact callback URL and Client ID, enable expiring user tokens, and check that this is a GitHub App. When reconnecting, choose the previously connected GitHub account.
- **No repositories:** install the app on the relevant account, choose repositories, or ask the organization owner for approval. For organizations using SAML SSO, establish the required GitHub SSO session and reconnect.
- **Issue is unavailable:** check both your own GitHub permissions and the installation's repository selection and Issues read permission. Pull requests are not supported by the issue lookup.
- **Tokens cannot be decrypted:** restore the original `APP_SECRET` or reconnect affected accounts.
- **App client changed:** reconnect affected connections. Rotating the client secret alone does not change connection identity; update the environment and restart Trestl.

## Scope and upstream references

This implementation covers personal authorization, installation access visibility, automatic token renewal, issue lookup, and the existing read-only repository imports. This legacy flow remains read-only. Guided app registration, webhooks, and optional writes are available through the separate shared connection described in the [current integration guide](github-installation.md).

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [User authorization, state, PKCE and personal permission boundaries](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Installation setup URLs and untrusted installation IDs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
