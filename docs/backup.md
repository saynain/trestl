# Back up and restore an installation

A Trestl backup is one file containing everything in the installation's
database. Use it to recover a lost or damaged server, to undo an upgrade, to move
to new hardware, or to switch between PGlite and PostgreSQL.

A backup contains:

- accounts, password hashes, roles, sessions, and API tokens (stored as hashes)
- every project, including private projects and private work items
- work items, comments, history, relationships, milestones, roadmaps, and project
  updates
- uploaded images and screenshots, and canvases with their embedded images
- authentication settings and integration connections, with credentials still
  encrypted by `APP_SECRET`

It does not contain `APP_SECRET` or other environment configuration, such as
`.env` or your Compose or Kubernetes files. Keep `APP_SECRET` in a separate
secret store; for the desktop app, that is the `app-secret` file in its data
folder. If you restore without it, everything else is recovered, but you have to
reconnect integrations.

Backups hold personal data, private work, and password hashes. Store them
encrypted, with the same access restrictions as the database itself. Only
restore backups you trust: restoring validates every table definition, but it
recreates whatever the file contains.

## Backup or project transfer?

|                               | Installation backup                | [Project transfer](project-transfer.md)    |
| ----------------------------- | ---------------------------------- | ----------------------------------------- |
| Purpose                       | Recovery and migration             | Copy work between installations           |
| Scope                         | The whole installation             | One project and its subprojects           |
| People, passwords, API tokens | Included                           | Not included                              |
| Other people's private work   | Included                           | Only what the exporting account can see   |
| Uploaded screenshots          | Included                           | Not included                              |
| Integration credentials       | Included, encrypted                | Never included                            |
| IDs and item numbers          | Kept                               | Newly assigned                            |
| Destination                   | A new, empty database              | An existing installation, as new projects |
| Who runs it                   | An operator with server access     | Any member, in the app                    |
| Compatible destinations       | The same Trestl release or a newer | Releases supporting transfer version 1    |

The JSON export in **Administration** is for inspection and portability. It
cannot restore an installation.

## Create a backup

The backup command uses the same configuration as the server: `DATABASE_URL`
for PostgreSQL, otherwise PGlite in `DATA_DIR`, and `APP_SECRET`.

### PostgreSQL

Backups read a consistent snapshot, so Trestl can keep running. With Docker
Compose:

```sh
docker compose exec -T app node --import tsx server/backup-cli.ts create --output - > trestl.trestl-backup
```

On Kubernetes, with the example namespace and Deployment:

```sh
kubectl exec -n trestl deploy/trestl -- node --import tsx server/backup-cli.ts create --output - > trestl.trestl-backup
```

From a source checkout, run `pnpm -s backup create`.

### PGlite

Stop Trestl first. A PGlite folder can only be opened by one process, including
a server in another container that shares the volume. The command refuses to
read a folder that a running server holds.

```sh
pnpm -s backup create
```

The file is written to `BACKUP_DIR` if it is set. Otherwise it goes to a folder
next to the data folder, `.data-backups/` by default. Choose another file or
folder with `--output`.

The desktop app backs itself up before each upgrade. For a manual backup,
follow [the desktop guide](desktop.md#local-data-and-backups).

Trestl backs up the schema that holds its tables, normally `public`. Keep other
applications' tables out of that schema: a table with a sequence, an identity
or generated column, or a custom type stops the backup.

### Check a backup

```sh
pnpm -s backup verify trestl.trestl-backup
```

`verify` reads the whole file. It checks every table against its stored SHA-256
digest, and reports whether the current `APP_SECRET` matches the one that
encrypted the backed-up credentials.

Files are gzip-compressed JSON lines, named `*.trestl-backup`. An interrupted
backup is left as `*.trestl-backup.partial`, never under the final name.

## Restore

A restore only writes into a new, empty database or folder. It never replaces
existing data. It runs in a single transaction: a damaged or incompatible
backup leaves the target unchanged. Use the same Trestl release as the backup,
or a newer one, and the same `APP_SECRET`.

### PGlite or a source checkout

```sh
APP_SECRET=… DATA_DIR=/path/to/new-folder pnpm -s backup restore trestl.trestl-backup
```

Then start Trestl with `DATA_DIR` set to that folder. To replace an existing
installation, stop it and rename its data folder. Keep that folder until the
restored installation works, then restore into the original path.

To restore into PostgreSQL instead, set `DATABASE_URL` to a new, empty
database. A backup restores into either engine, whichever engine created it.

### Desktop app

Restoring needs a source checkout of the same Trestl release as the installed
app (`git checkout v<version>`, then `pnpm install --frozen-lockfile`). Quit
Trestl and rename its `database` folder in the
[data folder](desktop.md#local-data-and-backups). Then restore into a new
`database` folder with the app's own key:

```sh
cd <checkout>
DATA="<data folder>"
APP_SECRET="$(cat "$DATA/app-secret")" pnpm -s backup restore \
  "$DATA/backups/<backup file>" --data-dir "$DATA/database"
```

Start Trestl. Keep the renamed folder until you have checked the restored data.

### Docker Compose on a new machine

Copy `.env` from your secret store, so that `APP_SECRET` and the database
settings match. With a new Compose volume, the database is empty:

```sh
docker compose up -d db
docker compose run --rm -T app node --import tsx server/backup-cli.ts restore - < trestl.trestl-backup
docker compose up -d
```

To restore next to an existing installation, create a second database instead
(`docker compose exec db createdb -U trestl trestl_restored`). Run the restore
with `-e DATABASE_URL=postgresql://trestl:<password>@db:5432/trestl_restored`.
Then set `POSTGRES_DB=trestl_restored` in `.env` and run
`docker compose up -d app`. The original database stays untouched.

### If `APP_SECRET` is lost

A restore refuses to continue if `APP_SECRET` is missing or differs from the
backup's. To recover everything except integration credentials, add
`--allow-secret-mismatch`. Then reconnect Git, GitHub, Confluence, and
authentication provider settings.

### Rehearse

Restore regularly into an isolated location to check that your backups work.
Use a different port and `INTEGRATION_SYNC_INTERVAL_MS=0`. Sign in, then check
projects, private items, comments, images, canvases, and the integration
settings.

## Upgrades

Each database records the Trestl release that last migrated it. When a newer
release starts, it writes a backup before running any migration. The backup is
named `trestl-<time>-<old version>-before-<new version>.trestl-backup` and goes
to:

- `BACKUP_DIR`, if set
- PGlite: a folder next to the data folder, `.data-backups/` by default
- Desktop: `backups/` in the app data folder

If the backup cannot be written, Trestl stops before changing anything. Free up
space or set `BACKUP_DIR`, then start Trestl again. Old backups are never
deleted automatically.

If a migration fails after the backup, Trestl stops and records the unfinished
upgrade. Later starts of the same release reuse that first backup instead of
copying partly migrated data, and older releases refuse to start. Fix the cause
and start the new release again, or restore the backup into a new database.

### PGlite 0.5 (PostgreSQL 18)

Trestl 0.6 and earlier stored PGlite data with PostgreSQL 17 (PGlite 0.3). Later
releases use PostgreSQL 18 (PGlite 0.5), which cannot open those folders. Folders
written by PGlite 0.4, also PostgreSQL 17, move the same way. On the
first start after the upgrade, Trestl moves the data:

1. The bundled older engine writes the pre-upgrade backup.
2. The current engine restores it into `<data folder>-pglite-upgrade`, and every
   table is compared with the backup.
3. The original folder is renamed to `<data folder>-pglite-0.3`, and the new one
   takes its place.

For the desktop app these are `database-pglite-0.3/` and `backups/` in its data
folder; for development, `.data-pglite-0.3/` and `.data-backups/`. The move needs
free disk space of about twice the data folder and takes about half a minute
per gigabyte. If any step
fails, the original folder stays in place and nothing changes. If Trestl stops
between the two renames, the next start completes the move.

Keep the original folder until you have checked the upgraded installation; then
you can delete it. To go back to Trestl 0.6, stop Trestl, move the new data
folder aside, rename `<data folder>-pglite-0.3` back, and install 0.6. Changes made
after the upgrade are not in the original folder. Trestl 0.6 cannot open the
upgraded folder: it stops at startup without changing it.

### PostgreSQL

PostgreSQL installations without `BACKUP_DIR` log a warning and upgrade without
a backup. Back up before you upgrade, or set `BACKUP_DIR` to a persistent volume.
For Docker Compose, add this in a `compose.override.yaml`:

```yaml
services:
  app:
    environment:
      BACKUP_DIR: /data/backups
    volumes:
      - trestl-backups:/data
volumes:
  trestl-backups:
```

Mount the volume at a folder that the image's `node` user owns, such as
`/data`. Docker creates a volume at a new path owned by `root`, and Trestl
cannot write there.

## Versions and rollback

- A backup restores into the release that created it, or any newer release.
  An older release refuses it.
- An older release also refuses to start against a database that a newer
  release has migrated. Running it could damage data.
- Backups are logical copies. They restore across PGlite and PostgreSQL, and
  across PostgreSQL major versions.
- To roll back an upgrade, stop the new release. Restore its pre-upgrade backup
  into a new, empty database, and start the older release against that.
  Changes made after the upgrade are not in that backup. Export the projects
  you need first.
- `pg_dump` remains a valid PostgreSQL backup, but it only restores into
  PostgreSQL.
