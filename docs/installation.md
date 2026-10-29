# Installation setup

Trestl runs as one installation with one name and one user account per person. There is no central Trestl account, required hosted identity service, or workspace switcher. A project may represent an ongoing responsibility or a bounded delivery. Private projects and personal follow-ups coexist with shared work.

## First visit

Start Trestl as described in the [quick start](quick-start.md). Visit the installation URL, give it a name, and create the setup administrator's name, email, and password (at least ten characters). Example projects are optional and off by default. Setup is transactional and cannot be repeated once initialized. Complete it before making a fresh server generally accessible: until then, anyone who can reach it can become its administrator.

Setup continues with your first project: a name and the identifier prefix its work items use, such as `WEB-01`. You can skip this step. It ends with links to connect GitHub or Gitea and to add your team in **Administration**; both can wait.

The administrator opens **Administration** from the sidebar. General changes the installation name; People manages roles and account access. Account settings and logout are in the bottom account menu. Private means hidden from other users in the application; it is not protection against a server operator who can read the database.

## Authentication

Set a durable random `APP_SECRET` of at least 32 characters before storing provider or integration secrets. They are encrypted at rest with this key. With the embedded database and no `APP_SECRET`, Trestl generates one beside the data directory. Back it up privately with your deployment configuration. Use HTTPS and set `APP_ORIGIN` to the exact external origin; session cookies are then Secure automatically.

Select a mode in **Administration → Authentication**:

- **Local accounts:** administrators add people with an initial password in People. Users change their password in Account settings. Public self-registration is disabled.
- **Google:** create a web OAuth client in your own Google project. Enter its client ID and secret, the installation URL, and allowed email domains. Register the exact callback shown in the form. Trestl uses Google's OIDC discovery, verifies the signed ID token and verified email, and provisions allowed users as members.
- **OpenID Connect:** register a confidential web client with your identity provider. Supply the issuer URL, client ID, client secret, allowed email domains, and the displayed callback. The provider must expose discovery/JWKS and support Authorization Code with S256 PKCE, `openid email profile`, and a verified email claim. Saving verifies discovery; test an actual login separately.
- **Trusted proxy:** use an existing authentication gateway such as oauth2-proxy. Follow [the proxy deployment guide](proxy-auth.md) for identity headers, the shared secret, and token routing.

Google/OIDC callbacks are `/api/v1/auth/provider/callback`. Redirects are handled by the server; provider tokens are not handed to the frontend. OAuth state is bound to the initiating browser, expires after ten minutes, and is consumed once. Existing accounts are not automatically claimed by email: approve verified owners in the explicit linking field. An already signed-in account can also start `/api/v1/auth/provider/start` to link its matching provider identity.

The original setup administrator retains local password login in external modes. Test new authentication from a separate browser session before closing the administrator session. If a proxy blocks the whole URL, recovery requires operator access around that proxy. Provider-created users do not acquire a local password when switching to local mode.

Disabling a person in People revokes their Trestl sessions and API tokens. Removing access in an identity provider alone does not revoke already-issued Trestl API tokens. Apply offboarding in Trestl too.

## Integrations and clients

Shared Git credentials live on the server; the server needs DNS/network access to Gitea or GitHub. Gitea tokens should belong to a service account with read access to the intended repositories. See [GitHub App installations](github-installation.md) for organization access. Everyone in Trestl can use the shared credential's authorized repositories, regardless of their personal Git account.

CLI and Raycast currently use an installation URL plus a personal Trestl API token from Account settings. One token covers the same accessible projects as that account, limited by its scope. Browser-based OAuth authorization for native clients is a separate follow-up; do not put the Google/OIDC client secret in a CLI or extension.

## Migrating experimental workspaces

Back up before upgrading. Startup selects the only shared workspace, or the only workspace if exactly one exists. With multiple candidates, explicitly set `INSTALLATION_ID` to the intended workspace's existing ID. This selection is persisted; later changes to that environment variable do not silently switch the installation. Other workspace data is neither merged nor deleted. Export anything needed from those contexts before upgrading. Existing private project access and account roles remain in place. Old personal integration credentials remain personal until deliberately replaced by a shared connection.
