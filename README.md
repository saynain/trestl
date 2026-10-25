<img src="public/trestl-mark.svg" alt="" width="60" height="48" />

# Trestl

A self-hosted project workspace for personal projects and small teams.
Capture tasks and follow-ups, organize ongoing responsibilities, and plan
projects with a finish line. Repositories are optional connections.

Trestl is licensed under [MIT](LICENSE). It is an early release: the core
workflows are usable, while operational scale and hosted-service features are
still developing.

## What you can do

- Capture private tasks, ideas, and follow-ups in your personal inbox.
- Add screenshots and Mermaid diagrams to work item descriptions and comments.
- Organize nested projects and work in lists, boards, and saved views.
- Plan dates, dependencies, milestones, Gantt schedules, and project roadmaps.
- Post project health updates and review active projects together in a weekly meeting.
- Draw together in project canvases with live edits, collaborator cursors, and the
  embedded Excalidraw editor. See [canvas collaboration](docs/canvas-collaboration.md).
- Collaborate through project sharing, assignments, and internal discussions.
- Link GitHub/Gitea issues and Confluence documentation.
- Use a standalone CLI, a scoped API, and an optional Raycast extension.

See the [user guide](docs/user-guide.md) for the complete workflows.

## Install the desktop app

The desktop app and its bundled server are aligned to **v0.6.0**. Signed macOS,
Windows, and Linux release installers are pending signing configuration; they
are not included in the current web/CLI release. Test installers are available
from successful **Desktop installers** workflow runs in GitHub Actions.
The app includes its runtime and local database; no server setup is needed. See the
[desktop guide](docs/desktop.md) for platform requirements, backups, and checksum
verification. Downloads require access while this repository is private.

## Install the CLI

Download the tarball and checksum from [GitHub Releases](https://github.com/saynain/trestl/releases/latest), or pull the identical artifact from `ghcr.io/saynain/trestl-cli:v0.6.0` using ORAS. Node.js 22.9+ is required on macOS, Linux and Windows.

```sh
gh release download v0.6.0 --repo saynain/trestl --pattern 'trestl-cli-*.tgz' --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS  # Linux: sha256sum -c SHA256SUMS
npm install --global ./trestl-cli-0.6.0.tgz --ignore-scripts
trestl login --profile work --url https://projects.example.com
trestl auth status --profile work
```

Sign in in your browser and approve the code displayed in your terminal. Your CLI uses the same user and permissions as the app. Use `--scope read` for read-only access. See the [CLI guide](cli/README.md) for Windows checksums, GHCR installation, automation and token revocation. Downloads require access while the repository/packages are private.

### Project updates and weekly review

Open a project's **Overview → Write update** to share progress, blockers, and next steps
with an **On track**, **At risk**, or **Off track** health status. The latest update appears
above the project description; expand **Previous updates** to read its history.
Health is independent of the project's lifecycle status.

Open **All projects → Weekly review** for projects whose status is **Active**, including
active subprojects. The review shows the latest update, author, owner, and target date,
with off-track and at-risk projects first. Search by project name or key, filter by health,
or choose **Needs update** for missing updates and those at least seven days old.
You can write an update directly from the review. Existing project permissions apply.

Updates are stored in the installation database and included in portable project transfers.
Imported updates retain their original health, text, date, and author name, labeled as imported history.

## Choose how to run it

| Mode                                      | Best for                                     | Data                                     |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| [Desktop app](docs/desktop.md)            | A native, offline workspace on your computer | PGlite in the OS app-data folder         |
| [Development server](docs/development.md) | Local use and development with hot reload    | PGlite in `.data/`, or PostgreSQL        |
| [Docker Compose](deploy/README.md)        | A packaged self-hosted installation          | PostgreSQL in a persistent Docker volume |
| [Kubernetes](deploy/kubernetes/README.md) | Running on an existing cluster               | External PostgreSQL                      |

### Local development

Use Node.js 22.9+ and pnpm 10.7.1:

```sh
git clone https://github.com/saynain/trestl.git
cd trestl
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://127.0.0.1:5173** and create your administrator account. There
are no default credentials. You can start empty or opt into example projects.
Data persists in `.data/`; no external services are required. The API runs on
port 4317. Existing local users can continue running `pnpm dev` as before.

### Demo preview

Run `pnpm preview:demo` to build and serve the app with its real API at **http://127.0.0.1:4318**. Sign in as `demo@trestl.local` with password `TrestlDemo2026!`. The isolated demo includes overdue work, blocking dependencies, milestones, project updates, private captures, and a roadmap linked to delivery work.

This command uses a separate database under your temporary directory and does not load `.env`. Set `PREVIEW_PORT` or `PREVIEW_DATA_DIR` to run another isolated preview. The demo database persists across restarts.

The repository currently requires GitHub access while it is private.

### One installation, your account, and your projects

On first visit, name the installation and create its administrator with an email and password. There are no default credentials and no automatic Personal workspaces. The same installation supports one person or a team. Keep private follow-ups in your inbox and choose private, selected-person, or installation-wide access for projects.

**Administration** contains General, Authentication, People, Integrations, and Export. Administrators can rename the installation, configure local accounts, Google, OpenID Connect (OIDC), or a trusted proxy, and manage access. Click your account at the bottom of the sidebar for **Account settings** (Profile, Appearance, API tokens) and **Sign out**.

With local authentication, administrators create colleague accounts in People. With external authentication, approved people are provisioned as members when they sign in. The setup administrator retains a local password for recovery. Trestl manages project permissions in every authentication mode.

Git connections configured in Administration are shared with the installation. A Gitea service token or GitHub App installation gives everyone access to the repositories allowed by those credentials. Repository imports still follow Trestl project visibility. Existing personal Git credentials are preserved as personal; they are never silently shared. Confluence search currently uses each person's own credentials.

Personal API tokens act as your account within this server, subject to the token's scope and current permissions. Configure a CLI or Raycast client with the installation URL and one token. Disabling an account revokes its tokens and sessions.

See [installation setup and authentication](docs/installation.md), [proxy deployment](docs/proxy-auth.md), and [GitHub organization connections](docs/github-installation.md).

Existing data is preserved. Startup selects the sole existing shared workspace, or the sole workspace if only one exists. If several legacy workspaces are candidates, startup stops and asks the operator to set `INSTALLATION_ID` to the intended existing workspace ID. Selection does not merge, delete, or expose other workspaces' data. Back up first; export any other needed data using the previous version before upgrading. Do not run an older version against the migrated database.

### Docker Compose

With Docker and the Compose plugin installed:

```sh
cp .env.example .env
# Generate two independent values with: openssl rand -hex 32
# Put them in APP_SECRET and POSTGRES_PASSWORD in .env.
docker compose up --build -d
```

Open **http://localhost:4317**. Compose starts the application and PostgreSQL;
its database is separate from your development `.data/` directory. If you
already have a `.env`, edit it instead of overwriting it. See the
[self-hosting guide](deploy/README.md) for HTTPS, configuration, and backups.

### Kubernetes

Build the same Docker image, provide PostgreSQL and a Secret, and consume the
portable Kustomize base from your deployment repository. Preview the example:

```sh
kubectl kustomize deploy/kubernetes/examples/basic
```

The example includes placeholders that must be configured before deployment.
Follow the [Kubernetes guide](deploy/kubernetes/README.md) for image pinning,
TLS, routing, credentials, and GitOps. Keep your own hostnames and cluster
configuration outside the product repository.

## Documentation

- [User guide](docs/user-guide.md)
- [Transfer projects between installations](docs/project-transfer.md)
- [Desktop app: downloads, local storage, and backups](docs/desktop.md)
- [Development and checks](docs/development.md)
- [Docker, configuration, backups, and upgrades](deploy/README.md)
- [Kubernetes deployment](deploy/kubernetes/README.md)
- [GitHub App integration](docs/github-app.md)
- [CLI and agent integration](cli/README.md)
- [Raycast extension](extensions/raycast/README.md)
- [Contributing](CONTRIBUTING.md)

The running server exposes its API contract at `/api/v1/openapi.json`.

## Current operating limits

Run **one application instance**. Repository reconciliation runs in-process,
while substantial filtering and authorization use application memory over
PostgreSQL JSONB documents. Large installations need further query and load
work. Kubernetes support is a deployment path, not a high-availability claim.

Git issue synchronization is inbound. Email/push notification delivery and
installation-wide JSON restore are not implemented. Project export/import supports
portability but does not replace database backups. Database migrations run at
startup; back up before upgrading and retain your `APP_SECRET`.

The CLI and container image can be built from source or published through the release workflows. The CLI is distributed through GitHub Releases and GHCR, not the npm registry. This project does not provide a hosted SaaS. Private artifacts require access until their visibility is explicitly changed for an open-source launch.

### Authentication proxy deployments

For a dedicated company installation behind Traefik and oauth2-proxy, see [Google/proxy authentication](docs/proxy-auth.md). Proxy authentication provides automatic approved-user provisioning and personal API-token access for CLI and Raycast. Every authentication mode uses one installation. Local authentication remains the default. Keep actual domains, emails, and secrets in private deployment configuration.

## Website and documentation

The [Astro website](website/README.md) lives in `website/` and builds separately from the application. Its interactive demo reuses the product UI with isolated sample data, and its documentation is generated from this repository's guides. Run `pnpm --dir website install --frozen-lockfile`, then `pnpm --dir website build` after installing root dependencies. Deploy `website/dist/` to a static host.
