# Quick start

Run Trestl on your own computer or server in about five minutes. You need
[Docker](https://docs.docker.com/get-started/get-docker/). Choose one:

- **Try it** with one container and its embedded database. There is nothing to configure.
- **Run it for your team** with Docker Compose and PostgreSQL.

Both serve Trestl at [localhost:4317](http://localhost:4317) and finish with a
short setup in your browser. For a workspace on your own computer without
Docker, use the [desktop app](desktop.md).

## Try it with one container

```sh
docker run -d --name trestl --restart unless-stopped \
  -p 127.0.0.1:4317:4317 -v trestl-data:/data \
  ghcr.io/saynain/trestl:v0.6.0
```

Open [localhost:4317](http://localhost:4317) and [finish setup](#finish-setup-in-your-browser).
The `trestl-data` volume holds the embedded PostgreSQL database (PGlite) and
`database-app-secret`, the key Trestl generates to encrypt Git and sign-in
credentials. `docker logs trestl` shows startup messages.

Published images are built for `linux/amd64`. Docker Desktop on Apple silicon
runs them with emulation and prints a platform warning. On other ARM hosts,
[build the image](development.md#container-image) yourself.

## Run it for your team

```sh
mkdir trestl && cd trestl
curl -fsSLO https://raw.githubusercontent.com/saynain/trestl/main/compose.yaml
printf 'APP_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
docker compose up -d
```

Open [localhost:4317](http://localhost:4317) and finish setup. Compose runs the
latest Trestl release with PostgreSQL 17. Only Trestl can reach the database,
and its data lives in the `postgres-data` volume. `APP_SECRET` encrypts Git and
sign-in credentials: keep `.env` private and store a copy with your backups.
`docker compose logs app` shows startup messages.

## Finish setup in your browser

1. Name the installation and create the administrator account. There are no
   default credentials.
2. Create your first project.
3. Optionally connect GitHub or Gitea, or add your team. Both open
   **Administration**, and both can wait.

Until setup is finished, anyone who can open Trestl can become its
administrator. Both commands above accept connections from this computer only,
so finish setup before you open Trestl to others.

## Open it to your team

Put an HTTPS reverse proxy in front of port 4317, and set `APP_ORIGIN` to the
address people open:

```dotenv
APP_ORIGIN=https://projects.example.com
```

With Compose, add the line to `.env` and run `docker compose up -d`. For one
container, recreate it with the setting; the volume keeps your data:

```sh
docker rm -f trestl
docker run -d --name trestl --restart unless-stopped \
  -p 127.0.0.1:4317:4317 -v trestl-data:/data \
  -e APP_ORIGIN=https://projects.example.com \
  ghcr.io/saynain/trestl:v0.6.0
```

Sign-in cookies are Secure whenever `APP_ORIGIN` uses HTTPS. The proxy must keep
the original `Host` header and forward WebSocket upgrades on `/api/`. For a
team, prefer Compose: PostgreSQL can be backed up while Trestl runs.

## Settings

Trestl checks its settings when it starts. A value that cannot work stops it
with a message that names the setting, such as
`APP_ORIGIN "projects.example.com" is not a URL`. Values that only limit
features, such as a missing `APP_SECRET`, are logged as warnings.

| Setting          | Default                                          | Purpose                                                   |
| ---------------- | ------------------------------------------------ | --------------------------------------------------------- |
| `APP_ORIGIN`     | The address of each request                      | The address people open; required behind a reverse proxy  |
| `APP_SECRET`     | Generated beside the embedded database           | Encrypts Git and sign-in credentials; Compose requires it |
| `SECURE_COOKIES` | Secure when `APP_ORIGIN` or the request is HTTPS | Set `true` to force Secure cookies                        |
| `DATABASE_URL`   | The embedded database in `/data/database`        | A PostgreSQL connection URL                               |

See the [environment reference](../deploy/README.md#environment) for every setting.

## Upgrade

Read the [release notes](https://github.com/saynain/trestl/releases) first, and
**back up before every upgrade**. The new version migrates the database when it
starts, and an older version cannot open the result.

For one container, stop it, copy its data, then start the new version on the same volume:

```sh
docker stop trestl
docker cp trestl:/data "trestl-backup-$(date +%F)"
docker rm trestl
docker run -d --name trestl --restart unless-stopped \
  -p 127.0.0.1:4317:4317 -v trestl-data:/data \
  ghcr.io/saynain/trestl:vX.Y.Z
```

For Compose, dump the database, set `TRESTL_IMAGE=ghcr.io/saynain/trestl:vX.Y.Z`
in `.env`, then start the new version:

```sh
docker compose exec -T db pg_dump -U trestl -d trestl -Fc > "trestl-$(date +%F).dump"
docker compose up -d
```

Keep `APP_SECRET`, or the generated `database-app-secret`, with every backup.
See [backup and restore](../deploy/README.md#backup-and-restore) to verify and
restore a backup. **Administration → Server version** shows whether an update
is available.

### Containers from v0.6.0 and earlier

Earlier images kept the embedded database in `/app/.data`. A newer image finds
that data and refuses to start empty beside it. Move it into the new layout once:

```sh
docker stop trestl && docker rm trestl
docker run --rm -v trestl-data:/data alpine sh -c \
  'mkdir /data/database && find /data -mindepth 1 -maxdepth 1 ! -name database -exec mv {} /data/database/ \; && chown -R 1000:1000 /data'
```

Then start the new version with `-v trestl-data:/data` as shown above.

## Other ways to run Trestl

- [Desktop app](desktop.md): native, offline, with its own embedded database.
- [Kubernetes](../deploy/kubernetes/README.md): an existing cluster with external PostgreSQL.
- [From source](development.md): for development and contributions.

Next, see [installation and accounts](installation.md) for sign-in options, the
[user guide](user-guide.md), and the [CLI](../cli/README.md) for terminals and
coding agents.
