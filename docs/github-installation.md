# GitHub integration for self-hosted Trestl

Trestl connects directly to a GitHub App owned by your account or organization. The guided setup uses GitHub’s App Manifest flow to prepare URLs and permissions and save generated credentials automatically. No central Trestl service or shared app key is involved. GitHub.com is supported; the existing token flow remains available for other Git servers.

## Before connecting

Set `APP_ORIGIN` to the exact address used in the browser, such as `https://work.example.com`, and keep a durable `APP_SECRET` of at least 32 characters. Use HTTPS and secure cookies in production. Loopback HTTP works for development. The same hostname must be used throughout setup.

Choose how updates arrive:

- **As activity happens:** GitHub must reach `APP_ORIGIN/hooks/github/<app-id>`. Trestl verifies the signature against the raw request bytes, records the delivery, and queues synchronization. Periodic reconciliation also recovers missed events.
- **Check periodically:** use this for private networks, VPNs, or local development. Only outbound HTTPS access to GitHub is needed on the server; the administrator’s browser must reach Trestl for the return step.

Behind an authentication proxy, route only `/hooks/github/…` directly to Trestl without an interactive login challenge. Keep normal authentication on `/api/` and the application. This webhook endpoint authenticates GitHub signatures and provides no browser or data access. Preserve the request body unchanged. GitHub’s callback under `/api/v1/admin/github-apps/callback` uses the signed-in administrator session; do not log its query string.

## Guided setup

1. Open **Administration → Integrations → GitHub → Connect GitHub**.
2. Choose a personal account or organization, enter its GitHub login, and choose a unique app name.
3. Select webhook delivery or polling. Optionally request issue write access for two-way updates and explicit comments. An organization owner or a member allowed to manage apps may need to complete this step.
4. Click **Create app on GitHub**, confirm creation, and return to Trestl. The manifest exchange is bound to the initiating administrator session and expires after one hour. Only one use is accepted.
5. Click **Install / choose repositories**, select an account and repository access on GitHub, and return.
6. Click **Check installation**, then **Connect installation**. Trestl verifies the installation with the app’s own credentials before saving a shared connection. Pending approval or suspended installations are shown explicitly.
7. Under **Repositories & workflows**, connect a repository to a project. Use **Workflow** to choose target branches and status rules.

Apps are private to their owner by default. Select **Allow installing this app on other GitHub accounts or organizations** when the installation needs repositories owned by other accounts. This changes the app’s installation visibility; repository access still requires an authorized installation.

App keys and webhook secrets are encrypted in the database with `APP_SECRET`. They never appear in API responses or project exports. Back up the database and encryption secret together. Guided setup does not need the legacy `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, or `GITHUB_APP_SLUG` environment variables.

## Permissions and audiences

The default app requests read access to Metadata, Issues, Pull requests, Contents, and Checks. Contents access supports branches and commits. Trestl does not clone repositories or execute repository code. Optional issue write permission enables two-way issue updates, publishing a task, and explicitly posting a comment.

Shared credentials make selected repositories available to everyone in the Trestl installation. Project visibility controls imported work and development activity. Choose repository access appropriate for that audience. Connecting repositories to projects never changes GitHub’s repository permissions.

## Linking work and automating status

- Put a task ID such as `APP-01` in a PR title or branch name.
- In a PR description, use `fixes APP-01`, `closes APP-01`, or `resolves APP-01`. Multiple references on a line are supported.
- Use `related to APP-01`, `references APP-01`, or `part of APP-01` to link context without automation.
- Commit messages support the same explicit relationship words. Commit linking imports the default branch’s last 30 days initially and changes since the last successful sync thereafter.
- In a task, **Link PR** creates a manual relationship; choose whether it should participate in status automation. **Copy branch & start work** assigns an unassigned task to you and moves it to In progress.
- Use **Unlink** to remove an incorrect relationship. It stays removed during automatic synchronization; manually linking the PR again restores it.

Default rules move draft PRs to In progress, open/review-requested PRs to In review, and merged PRs to Done. Approval and closing without merging do not change status by default. Each rule can target any Trestl status or do nothing. Target branch filters accept comma-separated names and `*` patterns, for example `main, release/*`.

A merged PR cannot complete a task while another connected closing PR is open or in draft. Related references do not change status. Completed and canceled tasks are protected from ordinary open/review events. Canonical GitHub reads prevent stale webhook payloads from regressing stored state; repeated unchanged snapshots do not create repeated automation events.

Review and check summaries appear beside a PR. “Approved” means an effective approving review exists and no effective change-request review remains; it is not a branch-protection readiness verdict. Check summaries cover GitHub check runs, not legacy commit statuses. Review, merge, and code-diff editing remain on GitHub.

## Optional issue synchronization

Under **Repository imports**, select **GitHub ↔ Trestl** with a write-enabled app. Existing inbound imports can be disconnected and recreated in two-way mode; their source identities preserve imported tasks. The initial synchronization establishes a baseline before publishing changes.

Title, description, labels, and open/closed state synchronize in both directions. A local Done or Canceled state maps to closed; reopening remotely moves a closed local task to Todo. Priority, assignee, scheduling, and internal notes stay in Trestl. Changes to different fields merge. Conflicting changes to the same field remain visible on the task until the user reviews both versions and selects one. Resolution checks that neither the local revision nor the fetched remote version changed since review.

Native tasks can be explicitly published to a two-way repository. The issue body carries a hidden task marker so a later sync can recover an interrupted create response without creating another task. If publication reports an uncertain outcome, synchronize the repository before trying again. A publish attempt with no recoverable issue may require administrator investigation; blindly repeating the remote create is intentionally avoided.

**Comment on GitHub** posts a comment attributed to the Trestl user through the app. The normal discussion composer remains internal. A repeated request ID does not post twice; an uncertain send asks the user to check GitHub. Incoming comment edits and deletions continue to reconcile.

## Health, retries, and maintenance

`GITHUB_SYNC_INTERVAL_MS` defaults to 300000 and has a minimum of 60000. The in-process worker checks durable jobs every five seconds, coalesces repeated events, and retries failures with increasing delays up to an hour. Delivery IDs are retained for seven days. The UI shows last successful synchronization, sanitized failures, and the last verified webhook time. Issue imports use `INTEGRATION_SYNC_INTERVAL_MS`; guided apps and two-way imports reconcile every five minutes when no legacy interval is configured.

Run one Trestl application instance, as with the existing repository reconciler. Development list reads are bounded at 2,000 records per collection (PR history, branches, commits in the sync window, and reviews per PR). Exceeding a bound reports a failure rather than silently treating partial data as complete. Large repositories need further incremental backfill work.

Use **Install / choose repositories** for new repository access, then **Check installation → Refresh connection**. Use GitHub’s installation settings to suspend, revoke, or restrict access; subsequent reads and token requests enforce it. Disconnecting a Git connection removes its dependent repository configuration and stops imports while preserving tasks and activity. Disconnect all of an app’s connections before removing its saved credentials. Removing local credentials does not delete the app on GitHub.

For key rotation, the current manual path is to create and verify a replacement connection, reconnect repositories/imports, then disconnect the old connection and revoke its key on GitHub. Do not replace `APP_SECRET` to rotate an app key.

## Existing-app fallback

Use **Existing apps & other Git connections → Add connection → GitHub App · organization**. Supply the numeric App ID, installation ID, and PEM private key. This retained manual connection uses Issues and Metadata read access for inbound imports. Guided setup is required for the new development and write-enabled connection metadata.

The [legacy personal GitHub App flow](github-app.md) remains compatible with existing credentials. It uses user access tokens and retains its personal permission boundary.

## References

- [Registering an app from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)
