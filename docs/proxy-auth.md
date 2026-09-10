# Google sign-in behind Traefik and oauth2-proxy

Complete first-run installation setup before enabling the proxy. In **Administration → Authentication**, choose **Trusted authentication proxy**, set the installation URL, exact allowed email domains, and a randomly generated shared proxy secret. Add the setup administrator's verified email to the explicit account-linking list if they should also sign in through the proxy. Save, then configure the ingress below. New approved colleagues join as members; roles are managed in People.

All domains and emails in this document are fictitious. Keep actual deployment configuration and secrets outside this repository. This setup does not contact Google until you configure and start it.

## Trestl configuration

Set a durable `APP_SECRET` on the server before saving authentication or integration secrets. Keep it unchanged and include it in your private backup procedure. Configure `APP_ORIGIN` with the public origin and `SECURE_COOKIES=true` when serving HTTPS. Generate the separate proxy secret with `openssl rand -hex 32`; enter it in Trestl and set the same value as `TRESTL_PROXY_SECRET` in Traefik's environment.

Existing environment-based deployments can still use `AUTH_MODE=proxy`, `PROXY_AUTH_SECRET`, `PROXY_AUTH_ALLOWED_DOMAINS`, `PROXY_AUTH_ADMIN_EMAILS`, `PROXY_AUTH_PROVIDER`, and `PROXY_AUTH_LINK_EXISTING_EMAILS`. Saved settings take precedence. The selected installation is always used; proxy sign-in never creates another workspace. Complete first-run local setup before enabling the environment mode.

The allowlist matches exact email domains. oauth2-proxy must validate provider email claims; do not enable unverified-email options. Trestl binds accounts to a stable provider/user ID, not mutable email. Do not change the proxy's user-ID mode after provisioning. Switching from environment configuration to saved settings uses a different identity namespace; plan explicit verified account linking for that migration.

## Private oauth2-proxy configuration

Register a Google OAuth web client, with the public callback `https://projects.example.com/oauth2/callback`. Configure the consent screen for your organization. Use a current supported oauth2-proxy release and set:

```dotenv
OAUTH2_PROXY_PROVIDER=google
OAUTH2_PROXY_CLIENT_ID=REPLACE_PRIVATELY
OAUTH2_PROXY_CLIENT_SECRET=REPLACE_PRIVATELY
OAUTH2_PROXY_REDIRECT_URL=https://projects.example.com/oauth2/callback
OAUTH2_PROXY_EMAIL_DOMAINS=example.com
OAUTH2_PROXY_COOKIE_SECRET=REPLACE_WITH_OAUTH2_PROXY_COOKIE_SECRET
OAUTH2_PROXY_COOKIE_NAME=_trestl_oauth
OAUTH2_PROXY_COOKIE_SECURE=true
OAUTH2_PROXY_COOKIE_HTTPONLY=true
OAUTH2_PROXY_COOKIE_SAMESITE=lax
OAUTH2_PROXY_COOKIE_REFRESH=1h
OAUTH2_PROXY_REVERSE_PROXY=true
OAUTH2_PROXY_UPSTREAMS=static://202
OAUTH2_PROXY_SET_XAUTHREQUEST=true
OAUTH2_PROXY_PASS_BASIC_AUTH=false
OAUTH2_PROXY_PASS_ACCESS_TOKEN=false
OAUTH2_PROXY_SET_AUTHORIZATION_HEADER=false
OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true
OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:4180
```

Use the cookie-secret format required by oauth2-proxy (for example, a base64-encoded random 32-byte key). For group-restricted pilots, configure the Google group and its Admin SDK credentials following the provider documentation; a domain allowlist alone allows the entire domain. If cookies grow beyond one cookie, use oauth2-proxy's Redis session store rather than relying on the single-cookie forwarding example.

## Traefik routing and trust boundary

Copy [the Traefik v3 dynamic configuration](../deploy/traefik.proxy-auth.example.yml) into your private file-provider configuration. In **Traefik's** environment, set `TRESTL_PUBLIC_HOST` and `TRESTL_PROXY_SECRET`. These are Go-template substitutions performed by Traefik's file provider; they are not automatically read from the app's `.env` or interpolated by Docker Compose. Adapt the `websecure` entrypoint, TLS certificate resolver, and internal service addresses to your deployment.

The routes are deliberately separate:

- `/oauth2/` reaches oauth2-proxy for sign-in, callback, and logout.
- API requests with a Bearer authorization header reach Trestl's token validation path. Traefik removes identity headers and marks the request token-only. A missing, malformed, revoked, or unknown token cannot fall back to a browser cookie or a forwarded identity. Trestl still enforces permissions.
- Browser API requests without a Bearer token use `/oauth2/auth`, returning 401 when the proxy session expires rather than redirecting AJAX to an HTML login page. Page navigation uses the redirecting ForwardAuth endpoint.
- Browser requests have incoming identity headers removed, pass ForwardAuth, then receive the proxy's authenticated identity and the shared secret. Trestl verifies that secret before using identity headers and requires the configured origin on browser mutations.

Keep both app and oauth2-proxy backends on a private network accessible only through the intended ingress. Do not publish the app container port to the internet or add a second router without these controls. The base Compose file publishes a loopback port for local use; for container-to-container ingress use an appropriate private Docker network. Do not configure Traefik to trust arbitrary client-supplied forwarded headers. Do not log authorization, cookie, or proxy-secret headers or OAuth callback query strings.

Ordinary Trestl session cookies do not replace proxy authentication. The setup administrator's local recovery session is the exception. The supplied ingress still requires proxy authentication for browser routes, so recovering from a failed proxy requires an operator-only route or tunnel to the app. Preserve the configured Host/origin for origin checks and use HTTPS when Secure cookies are enabled. Do not expose a public proxy bypass.

Sign out clears the Trestl session and opens `/oauth2/sign_out`; this does not sign the person out of Google itself.

## Existing data and accounts

Back up the database before upgrading. See [installation migration](installation.md). Existing password accounts are linked only through the explicit verified-email list in Authentication (or `PROXY_AUTH_LINK_EXISTING_EMAILS` for environment mode). They must already belong to the installation. After the first successful proxy sign-in establishes a stable binding, remove the temporary email approval. An account already bound to another proxy identity cannot be reclaimed by email.

The setup administrator retains local recovery login. Other users authenticate through the configured provider. Switching back to local authentication does not create passwords for externally provisioned accounts.

## CLI, Raycast, and offboarding

Create a token in **Account settings → API tokens**, then configure your client once with this server URL and the token. Tokens act as your account in the installation; read-only tokens cannot write, and private project permissions still apply. Google access tokens are not Trestl personal API tokens.

Google account/group removal does not automatically revoke Trestl tokens. Disable the account in **Administration → People** when offboarding. This immediately denies Trestl access and deletes its personal tokens and Trestl sessions. Re-enabling does not resurrect old tokens. The installation owner cannot disable themselves. Google/group session refresh is separate and follows oauth2-proxy's refresh behavior.

## Verification before opening the pilot

Run `node --import tsx --test tests/proxy-auth.test.ts`. The tests use fictitious identities and check provisioning, stable identity, blocked domains, spoofing, cookie-only rejection, CSRF, private project permissions, token scopes, and offboarding. They do not contact Google.

With the private deployment running, verify a real Google callback, an allowed colleague, a denied external account, logout and re-entry, and CLI/Raycast access with a valid token. Invalid API tokens must receive JSON 401, never a successful request or a Google login page. Confirm the raw backend is not publicly reachable. Check the group restriction separately if configured.

References: [oauth2-proxy Traefik integration](https://oauth2-proxy.github.io/oauth2-proxy/configuration/integrations/traefik/), [Google provider](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/google/), [Traefik ForwardAuth](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/forwardauth/).
