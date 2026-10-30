# Self-hosting Trestl

The application serves its built frontend and API from the same origin. A single process also owns periodic repository reconciliation. Use one application replica with persistent PostgreSQL for shared deployments.

## Docker Compose

The [quick start](../docs/quick-start.md#run-it-for-your-team) sets up a new installation with four commands. `compose.yaml` runs the published release image, `ghcr.io/saynain/trestl`, with PostgreSQL 17. Its `.env` needs two independent values from `openssl rand -hex 32`: `APP_SECRET` and `POSTGRES_PASSWORD`. Hexadecimal database passwords avoid URL-encoding issues in the connection string. The Compose file refuses to start without both values, using Docker's [required-variable interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/). `.env.example` lists the other settings.

```sh
docker compose up -d
docker compose logs -f app
```

Open [localhost:4317](http://localhost:4317), then create your administrator account and first project. Set `TRESTL_IMAGE` in `.env` to run another release or [your own build](../docs/development.md#container-image). Compose binds the app to loopback and keeps PostgreSQL on its internal network. The named `postgres-data` volume retains data across restarts. Do not remove the volume unless you intend to delete the workspace.

For access from other machines, put an HTTPS reverse proxy in front of port 4317 and set:

```dotenv
APP_ORIGIN=https://projects.example.com
```

`APP_ORIGIN` must exactly match the public browser origin: the scheme, host, and a non-default port if used, without a path. Trestl refuses to start with a malformed value, and refuses changes from another address with a message naming both. The proxy must preserve the public Host header. Session cookies are always Secure with an HTTPS `APP_ORIGIN`. Otherwise `SECURE_COOKIES` decides; when it is unset, cookies are Secure only for requests that arrive over HTTPS. The provided Compose configuration sets `SECURE_COOKIES=false` for its loopback HTTP setup.

Keep `.env` outside version control. Repository credentials in the database are encrypted using `APP_SECRET`; store that key alongside your backup secrets. If you change the key, remove and reconnect repository integrations. TLS termination, DNS, certificate provisioning, and proxy configuration depend on your environment and are not deployed by this repository.

## Environment

| Variable                       | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                 | PostgreSQL connection string; absent uses PGlite                                                |
| `DATA_DIR`                     | PGlite directory, default `.data`; the image uses `/data/database`                              |
| `HOST` / `PORT`                | Listen address and port; defaults `127.0.0.1:4317`                                              |
| `APP_SECRET`                   | At least 32 characters; encrypts credentials. With PGlite, generated in `<DATA_DIR>-app-secret` |
| `APP_ORIGIN`                   | Public browser origin: scheme, host and optional port                                           |
| `SECURE_COOKIES`               | `true` or `false`; always Secure with an HTTPS `APP_ORIGIN`                                     |
| `TRESTL_IMAGE`                 | Compose only: the image to run, by default the latest release                                   |
| `INTEGRATION_ALLOWED_ORIGINS`  | Comma-separated exact self-hosted Git service origins                                           |
| `CONFLUENCE_ALLOWED_ORIGINS`   | Comma-separated exact HTTPS origins for personal Confluence connections                         |
| `INTEGRATION_SYNC_INTERVAL_MS` | Optional automatic sync; at least 60000, otherwise disabled when unset                          |

Trestl checks these values at startup. It stops with a message naming the setting when a value cannot work, and logs a warning for values that limit features, such as a missing or short `APP_SECRET`. With PGlite and no `APP_SECRET`, Trestl generates a key beside the data directory and uses it from then on; back it up with the data. A configured `APP_SECRET` always takes precedence.

Compose enables five-minute repository reconciliation by default. The `/health` endpoint reports process liveness. `/ready` checks database connectivity and returns 503 when it is unavailable. Neither endpoint requires authentication. Monitor integration sync status separately.

## Kubernetes

See [container releases](../docs/container-releases.md) for publishing tested
images to GHCR and replicating selected versions into an internal registry.

Use the [Kubernetes guide](kubernetes/README.md) for the reusable Kustomize base,
an example overlay, and the GitOps deployment workflow. Kubernetes requires an
external PostgreSQL database and one application replica. Environment-specific
hostnames, registry locations, database provisioning, and routes belong in your
own deployment repository.

## Upgrades

Back up before every upgrade: database migrations run when the new version starts, and an older version cannot open the migrated database. The [quick start](../docs/quick-start.md#upgrade) shows the steps for one container and for Compose. For Kubernetes, see its [operations notes](kubernetes/README.md#operations).

## Backup and restore

For Compose's PostgreSQL service, create a consistent logical backup:

```sh
docker compose exec -T db pg_dump -U trestl -d trestl -Fc > trestl.dump
```

Store the dump encrypted alongside a separately secured copy of `APP_SECRET`. Database backups include account credentials, sessions, personal data, and integration ciphertext. To verify a backup, restore it into a **new empty database in an isolated environment**:

```sh
pg_restore --no-owner --dbname "$RESTORE_DATABASE_URL" trestl.dump
```

Use a separate application instance pointed at the restored database and the same `APP_SECRET`, with periodic synchronization disabled. Verify login, projects, private item visibility, comments, and integration configuration before adopting the backup as a recovery point. This repository does not yet automate restoration drills. To copy selected projects from PGlite into a PostgreSQL-backed installation, use [project export/import](../docs/project-transfer.md); this does not migrate server configuration or accounts.

For a local PGlite installation, stop the application cleanly before copying the whole `.data` directory. Restore by placing the directory into a stopped, compatible installation and retaining its original integration encryption key. An API JSON export is useful for portability and inspection but does not contain all users' private data, credentials, or the database schema and cannot replace a database backup.

### Existing database volumes

Renaming the application does not rename an existing PostgreSQL database or role. For an existing Compose volume, set `POSTGRES_USER` and `POSTGRES_DB` in `.env` to its actual existing role and database before restarting. New installations default to `trestl`. Keep the volume and `APP_SECRET` intact. The local PGlite `.data/` directory is independent of the brand and remains compatible.

### Work item numbering

Each project has a persistent counter; each workspace also has its own inbox counter. Identifiers use a minimum of two digits (`PROJ-01`, `PROJ-99`, `PROJ-100`, `PROJ-1000`). Deleting an item does not recycle its number. Moving an item assigns the next number in its destination project or inbox, while its internal UUID stays unchanged. Manual creation, recurring follow-ups, demo data, and repository imports share the same allocator.

On the first startup with project numbering, an automatic transaction renumbers existing items from `01` in each project, preserving their previous numeric order. It also initializes counters and updates cached creation-retry identifiers. Later restarts do not renumber again. UUID-based links, relations, comments, and source repository issue numbers are preserved; old textual Trestl identifiers change. The `item_identifier_changes` table records the old and new identifiers for each migrated item. Back up the database before upgrading an existing installation.

### GitHub App sign-in

For browser-based GitHub connections, register a GitHub App for your instance using the [setup guide](../docs/github-app.md). Set `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG` in the application environment, with the correct public `APP_ORIGIN`. Compose forwards these variables; on Kubernetes, add them to the existing application Secret. No GitHub private key or central Trestl service is required. Disable query-string logging for the authorization callback at your proxy. Personal-token connections continue to work without a GitHub App.
