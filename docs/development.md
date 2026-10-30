# Local development

Use Node.js 22.9+ and pnpm 10.7.1. Node.js 22 is used by the Docker image and CI.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open http://127.0.0.1:5173. Vite serves the frontend and proxies API requests
and canvas WebSocket connections to the Fastify server on port 4317. Both reload when source files change.
Create the first administrator through the setup screen. There are no default
credentials. You can choose an empty workspace or disposable example data.

Data persists in `.data/` using embedded PGlite. No Docker, external database,
or integration credentials are required. Existing local data stays in place.
For integration configuration, copy `.env.example` to `.env` and fill in only
the settings you need. The development launcher loads it; shell variables
take precedence. Never replace an existing `.env` or encryption key casually.

Set `DATABASE_URL` to use PostgreSQL instead. Switching the URL selects another
database; it does not migrate your PGlite workspace. To move it, use [backup and
restore](backup.md). Only one process can open a PGlite folder at a time.

## Ports and isolated testing

The frontend defaults to 5173 and fails if occupied. `PORT` sets the API port;
`WEB_PORT` sets the frontend port. Use the displayed loopback URL.

To try a separate workspace without touching your normal data:

```sh
DATA_DIR=/tmp/trestl-dev-example PORT=4318 WEB_PORT=5174 pnpm dev
```

This assumes `DATABASE_URL` is unset in both the shell and `.env`. If it is
configured, it takes precedence over `DATA_DIR`; use a separate disposable
PostgreSQL database instead. Also clear any production `APP_ORIGIN` override
when testing locally.

## CLI browser login

Use the frontend origin shown by `pnpm dev`, so the browser and CLI reach the same installation:

```sh
pnpm -s cli login --profile local --url http://127.0.0.1:5173
```

Sign in with your local account and approve the matching code. The development launcher sets `APP_ORIGIN` to the frontend URL; Vite forwards both `/api` and `/cli-auth` to the backend. No Google configuration or separate token gateway is required. If you change `WEB_PORT`, use that port in the CLI URL too.

For the built app or default Docker Compose setup, use `http://localhost:4317` instead. When changing the Docker host/port or serving it behind HTTPS, set `APP_ORIGIN` to the same origin passed to `trestl login --url`.

## Built application

```sh
pnpm build
pnpm start
```

The API now serves the built frontend at http://localhost:4317. This uses the
same database configuration as development. See [Docker and
self-hosting](../deploy/README.md) for a packaged installation.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
pnpm test:cli-package
kubectl kustomize deploy/kubernetes/examples/basic
```

Tests create isolated databases and mock provider responses. Some require
loopback networking. The CLI package test builds, packs, installs, and exercises
the standalone CLI against a temporary server.

The container smoke test needs Docker and uses an isolated Compose project,
generated test credentials, and a temporary PostgreSQL volume. It verifies
setup, task persistence after restart, and database readiness during an outage,
then removes only its own containers and volume:

```sh
pnpm test:docker
```

For the optional Raycast extension:

```sh
cd extensions/raycast
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Code layout

| Path                  | Responsibility                                                |
| --------------------- | ------------------------------------------------------------- |
| `src/`                | React interface                                               |
| `server/`             | Fastify API, authorization, integrations, database migrations |
| `shared/`             | Shared domain types and logic                                 |
| `cli/`                | Standalone CLI and agent skill                                |
| `extensions/raycast/` | Optional Raycast client                                       |
| `tests/`              | Application and API regression tests                          |
| `deploy/`             | Portable self-hosting configuration                           |

The API lives under `/api/v1`; the running server exposes its OpenAPI document
at `/api/v1/openapi.json`. Browser sessions use HTTP-only cookies and the CLI
uses scoped bearer tokens. Database migrations run at application startup.

The current storage model uses PostgreSQL JSONB documents with substantial
filtering in application memory. Repository reconciliation runs in the API
process. Keep one application instance until distributed worker coordination
and concurrency testing support multiple instances.
