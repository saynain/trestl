# Trestl

A self-hosted project workspace for personal projects and small teams.
Capture tasks and follow-ups, organize ongoing responsibilities, and plan
projects with a finish line. Repositories are optional connections.

Trestl is licensed under [MIT](LICENSE). It is an early release: the core
workflows are usable, while operational scale and hosted-service features are
still developing.

## What you can do

- Capture private tasks, ideas, and follow-ups in your personal inbox.
- Organize nested projects and work in lists, boards, and saved views.
- Plan dates, dependencies, milestones, Gantt schedules, and project roadmaps.
- Keep diagrams in project canvases with the embedded Excalidraw editor.
- Collaborate through project sharing, assignments, and internal discussions.
- Link GitHub/Gitea issues and Confluence documentation.
- Use a standalone CLI, a scoped API, and an optional Raycast extension.

See the [user guide](docs/user-guide.md) for the complete workflows.

## Choose how to run it

| Mode                                      | Best for                                  | Data                                     |
| ----------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| [Development server](docs/development.md) | Local use and development with hot reload | PGlite in `.data/`, or PostgreSQL        |
| [Docker Compose](deploy/README.md)        | A packaged self-hosted installation       | PostgreSQL in a persistent Docker volume |
| [Kubernetes](deploy/kubernetes/README.md) | Running on an existing cluster            | External PostgreSQL                      |

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

The repository currently requires GitHub access while it is private.

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

Git issue synchronization is inbound. Email/push notification delivery,
native SSO, and a JSON import workflow are not implemented. JSON exports aid
portability but do not replace database backups. Database migrations run at
startup; back up before upgrading and retain your `APP_SECRET`.

The CLI and container image can be built from source. This repository does
not yet publish an npm package, a hosted SaaS, or a public container release.
