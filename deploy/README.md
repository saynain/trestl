# Self-hosting Trestl

The application serves its built frontend and API from the same origin. A single process also owns periodic repository reconciliation. Use one application replica with persistent PostgreSQL for shared deployments.

## Docker Compose

Copy `.env.example` to `.env` in the repository root. Generate two independent values with `openssl rand -hex 32` and set `APP_SECRET` and `POSTGRES_PASSWORD`. Hexadecimal database passwords avoid URL-encoding issues in the connection string. The Compose file refuses to start without both values, using Docker's [required-variable interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

```sh
cp .env.example .env
# Edit .env and set the two generated secrets.
docker compose up --build -d
docker compose logs -f app
```

Open [localhost:4317](http://localhost:4317), then create your administrator account. Compose binds the app to loopback and keeps PostgreSQL on its internal network. The named `postgres-data` volume retains data across restarts. Do not remove the volume unless you intend to delete the workspace.

For access from other machines, put an HTTPS reverse proxy in front of port 4317 and set:

```dotenv
SECURE_COOKIES=true
APP_ORIGIN=https://projects.example.com
```

`APP_ORIGIN` must exactly match the public browser origin, including scheme and a non-default port if used. The proxy must preserve the public Host header. The provided Compose configuration uses `SECURE_COOKIES=false` solely for its loopback HTTP setup. The app defaults to secure cookies when `NODE_ENV=production` unless explicitly overridden.

Keep `.env` outside version control. Repository credentials in the database are encrypted using `APP_SECRET`; store that key alongside your backup secrets. If you change the key, remove and reconnect repository integrations. TLS termination, DNS, certificate provisioning, and proxy configuration depend on your environment and are not deployed by this repository.

## Environment

| Variable                       | Purpose                                                                 |
| ------------------------------ | ----------------------------------------------------------------------- |
| `DATABASE_URL`                 | PostgreSQL connection string; absent uses PGlite                        |
| `DATA_DIR`                     | PGlite directory, default `.data`                                       |
| `HOST` / `PORT`                | Listen address and port; defaults `127.0.0.1:4317`                      |
| `APP_SECRET`                   | At least 32 characters; encrypts integration credentials                |
| `APP_ORIGIN`                   | Public browser origin for session request checks                        |
| `SECURE_COOKIES`               | Set `true` for HTTPS deployments                                        |
| `INTEGRATION_ALLOWED_ORIGINS`  | Comma-separated exact self-hosted Git service origins                   |
| `CONFLUENCE_ALLOWED_ORIGINS`   | Comma-separated exact HTTPS origins for personal Confluence connections |
| `INTEGRATION_SYNC_INTERVAL_MS` | Optional automatic sync; at least 60000, otherwise disabled when unset  |

Compose enables five-minute repository reconciliation by default. The `/health` endpoint reports process liveness. `/ready` checks database connectivity and returns 503 when it is unavailable. Neither endpoint requires authentication. Monitor integration sync status separately.

## Kubernetes

Use the [Kubernetes guide](kubernetes/README.md) for the reusable Kustomize base,
an example overlay, and the GitOps deployment workflow. Kubernetes requires an
external PostgreSQL database and one application replica. Environment-specific
hostnames, registry locations, database provisioning, and routes belong in your
own deployment repository.

## Backup and restore

For Compose's PostgreSQL service, create a consistent logical backup:

```sh
docker compose exec -T db pg_dump -U trestl -d trestl -Fc > trestl.dump
```

Store the dump encrypted alongside a separately secured copy of `APP_SECRET`. Database backups include account credentials, sessions, personal data, and integration ciphertext. To verify a backup, restore it into a **new empty database in an isolated environment**:

```sh
pg_restore --no-owner --dbname "$RESTORE_DATABASE_URL" trestl.dump
```

Use a separate application instance pointed at the restored database and the same `APP_SECRET`, with periodic synchronization disabled. Verify login, projects, private item visibility, comments, and integration configuration before adopting the backup as a recovery point. This repository does not yet automate restoration drills or migrate local PGlite data into PostgreSQL.

For a local PGlite installation, stop the application cleanly before copying the whole `.data` directory. Restore by placing the directory into a stopped, compatible installation and retaining its original integration encryption key. An API JSON export is useful for portability and inspection but does not contain all users' private data, credentials, or the database schema and cannot replace a database backup.

### Existing database volumes

Renaming the application does not rename an existing PostgreSQL database or role. For an existing Compose volume, set `POSTGRES_USER` and `POSTGRES_DB` in `.env` to its actual existing role and database before restarting. New installations default to `trestl`. Keep the volume and `APP_SECRET` intact. The local PGlite `.data/` directory is independent of the brand and remains compatible.

### Work item numbering

Each project has a persistent counter; each workspace also has its own inbox counter. Identifiers use a minimum of two digits (`PROJ-01`, `PROJ-99`, `PROJ-100`, `PROJ-1000`). Deleting an item does not recycle its number. Moving an item assigns the next number in its destination project or inbox, while its internal UUID stays unchanged. Manual creation, recurring follow-ups, demo data, and repository imports share the same allocator.

On the first startup with project numbering, an automatic transaction renumbers existing items from `01` in each project, preserving their previous numeric order. It also initializes counters and updates cached creation-retry identifiers. Later restarts do not renumber again. UUID-based links, relations, comments, and source repository issue numbers are preserved; old textual Trestl identifiers change. The `item_identifier_changes` table records the old and new identifiers for each migrated item. Back up the database before upgrading an existing installation.

### GitHub App sign-in

For browser-based GitHub connections, register a GitHub App for your instance using the [setup guide](../docs/github-app.md). Set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` in the application environment, with the correct public `APP_ORIGIN`. Compose forwards these variables; on Kubernetes, add them to the existing application Secret. No GitHub private key or central Trestl service is required. Disable query-string logging for the authorization callback at your proxy. Personal-token connections continue to work without a GitHub App.
