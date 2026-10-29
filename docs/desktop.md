# Trestl Desktop

Trestl Desktop runs the existing workspace in a native Tauri v2 window on macOS,
Windows, and Linux. The application includes its runtime, frontend, and PGlite
embedded PostgreSQL database. End users do not need Node.js, Docker, PostgreSQL,
or a web server. Core project, task, roadmap, and canvas features work offline;
remote repository and documentation integrations still need a connection.

## Install and get started

The desktop app and bundled server use **v0.6.0**, matching the web app and CLI.
Signed installers for this release are **pending signing configuration** and are
not included in its web/CLI downloads. The **Desktop installers** workflow
provides test artifacts from successful pull-request or branch workflow runs.
These are not signed release installers and do not provide a published updater feed.

Once signing is configured, the workflow attaches installers and
`desktop-SHA256SUMS` to the same [GitHub Release](https://github.com/saynain/trestl/releases)
as the CLI:

| Platform      | Architecture                             | Installer                      |
| ------------- | ---------------------------------------- | ------------------------------ |
| macOS 12+     | Apple Silicon and Intel, separate builds | `.dmg` containing `Trestl.app` |
| Windows 10/11 | x64                                      | NSIS `.exe` or `.msi`          |
| Linux         | x64                                      | `.AppImage`, `.deb`, `.rpm`    |

Windows installers include an offline WebView2 installer. Linux packages use the
system WebKitGTK 4.1 runtime. AppImages may need FUSE or the distribution's
AppImage extraction option. The app checks for updates in the background. You can also choose **Trestl →
Check for Updates…**. Download an update, then choose **Install and Restart**
when you are ready. Linux `.deb` and `.rpm` users update through their package
manager or download the newer package; AppImage installations update in the app.

Open the application and create your local administrator account. Choose an
empty workspace or the example projects. This account belongs to this desktop
installation. It does not require a Trestl cloud account. Desktop installations
use local accounts; organization OIDC/Google/proxy sign-in belongs to the hosted
web version.

Use the native **Trestl → Open Data Folder** menu to find your data. Standard
editing shortcuts, an integrated macOS title bar with real traffic lights,
window size/position restoration, external links in your
browser, and native download dialogs are supported. Closing the application
also stops the local database process. Launching a second copy focuses the
existing window.

## Updates

To see the installed version, choose **Trestl → About Trestl**. The footer of
**Trestl → Check for Updates…** also shows the current version, even when the
release feed is unavailable. Development builds can share a version number:
replacing a local `0.6.0` build with a newer `0.6.0` build requires a manual
installation because the updater only offers higher versions.

Trestl checks once after startup and every six hours while open. Checks that find
no update or cannot reach GitHub stay quiet. A newly available version opens a
small update window without taking keyboard focus. The menu's **Check for
Updates…** action always lets you check manually.

The update window shows the new version, release notes, download progress, and
**Install and Restart**. Downloads are verified against the public key shipped
with the app. Downloading does not interrupt your work. Before installation,
save and close open forms or editors; the app flushes canvas autosaves, waits for
pending API writes, and requires the database process to exit successfully. A
save failure or shutdown timeout stops installation. Local data and the persistent
encryption key remain in the app-data folder, outside the replaced application.

Updates work for macOS, Windows NSIS/MSI (preserving the installed package type),
and Linux AppImage. Linux `.deb`/`.rpm` installations show a link to downloads
instead of replacing files managed by the package manager. Updater downloads use
public GitHub Releases; a private repository's downloads will not work without
GitHub authentication, and no GitHub credential is bundled into the app.

Before publishing, rehearse an update with two separately versioned test builds
using the same dedicated test bundle identifier and signing key. Use a separate
app-data folder and a test feed configured only in a disposable source copy;
keep the production GitHub endpoint and download restrictions unchanged.
Create a task in the older build, check for updates, download, install, and
verify the automatic restart reports the newer version with the task and
`app-secret` preserved. Also verify a modified download is rejected and an
unsaved draft prevents installation. Repeat the check after upgrading to ensure
the same version is not offered again. Local feed testing does not replace
testing signed/notarized installers and public GitHub downloads on each platform.

## Local data and backups

| System  | Data folder                                            |
| ------- | ------------------------------------------------------ |
| macOS   | `~/Library/Application Support/app.trestl.desktop/`    |
| Windows | `%APPDATA%\app.trestl.desktop\`                        |
| Linux   | `${XDG_DATA_HOME:-~/.local/share}/app.trestl.desktop/` |

The folder contains `database/`, `app-secret`, `port`, and `desktop.log`, and
`backups/` after the first upgrade. Updating from Trestl 0.6 also keeps the
previous database as `database-pglite-0.3/`; see
[PGlite 0.5](backup.md#pglite-05-postgresql-18). `desktop.lock` exists while the
database is running. The persistent `app-secret`
encrypts integration credentials: back it up together with the database. The
webview also retains account cookies and appearance preferences in its own
operating-system storage. The desktop database is separate from development
`.data/` and all hosted installations.

Before an update migrates your data, Trestl writes a complete backup to
`backups/`. If that backup fails, Trestl does not start and leaves your data
unchanged. An older version refuses to open data that a newer one has migrated.
See [back up and restore an installation](backup.md) for the file format and for
restoring a backup with the `restore` command.

For a full copy, **quit Trestl**, wait for it to stop, and copy the entire data
folder to a safe location. To restore, quit Trestl and replace the data folder
with that copy. Preserve the original before replacing anything. Do not copy a
live database. Uninstalling the application is not a request to erase your
workspace.

For selective transfer between desktop and web installations, use
[project export/import](project-transfer.md). The administration JSON export is
an inspection/export format, not a full database restore.

## Build from source

Install Node.js 22.23.4+, pnpm 10.7.1, stable Rust, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
macOS requires Xcode command-line tools, Windows requires MSVC C++ build tools,
and Linux requires WebKitGTK 4.1 and GTK development libraries (see the workflow).

```sh
pnpm install --frozen-lockfile
pnpm desktop:dev
```

`desktop:dev` builds the desktop frontend and starts the native shell. Rust changes
reload through Tauri; restart the command after frontend/server changes to rebuild
the packaged resources. Use `pnpm dev` for the regular web hot-reload workflow.

```sh
pnpm typecheck
pnpm test:desktop
pnpm desktop:prepare
pnpm test:desktop-package
pnpm desktop:build
```

Build on each target OS and architecture; the preparation script deliberately
rejects a mismatched runtime target. It downloads official Node.js 22.23.4,
checks its SHA-256 against Node's published checksum manifest, and caches it in
`node_modules/.cache/trestl-desktop/`. A first build needs network access;
installed applications do not. Generated runtime/resources live in ignored
`src-tauri/binaries/` and `src-tauri/resources/`. Tauri emits installers under
`src-tauri/target/release/bundle/` (or the target triple's release directory).

## Release v0.6.0

Merge the tested release into `main` before tagging. The app, CLI, and desktop
share one version and release tag, which must point to a commit already in
main's history. Desktop publication can follow the web/CLI release after the
required signing configuration is available.

Before tagging, run `pnpm desktop:version`. The root package, CLI package,
Tauri config, Cargo manifest, and Cargo lockfile must all say `0.6.0`. The workflow
also checks the tag equals `v0.6.0`. Desktop installer releases currently use
stable `major.minor.patch` versions; use manual workflow artifacts for candidates.

Pushing the `v0.6.0` tag starts the image, CLI, and desktop workflows. Desktop
publication waits for the reusable application/container/Raycast CI and all four
native build jobs (Apple Silicon, Intel Mac, Windows x64, Linux x64). Each native
runner tests the bundled service, including first setup, writing a project and
task, restart persistence, origin isolation, and parent-process shutdown. macOS
also tests the runtime inside the finished `.app`; Windows extracts the MSI and
tests its shipped runtime and resources. Release builds verify the signatures of
that extracted application and runtime.

The seven installers are named
`trestl-desktop-0.6.0-<target-triple>.<extension>`. The publishing job validates the
complete set, verifies updater signatures with the same Minisign verifier used
by Tauri, calculates SHA-256 checksums, and attaches the files to the shared
GitHub Release. It uploads `latest.json` last, after every referenced artifact.
The feed includes separate Windows MSI and NSIS entries and both Mac architectures. `desktop-SHA256SUMS` is separate from the CLI's `SHA256SUMS`.
The CLI and desktop jobs can finish in either order without racing release
creation. Installers are never silently overwritten. For a partial upload, inspect
existing assets before retrying; do not move published tags or replace downloads
with a different build under the same version.

After downloading the installers and checksum file, verify with
`shasum -a 256 -c desktop-SHA256SUMS` on macOS or
`sha256sum -c desktop-SHA256SUMS` on Linux (download all listed files for a full
manifest check). On Windows, compare
`Get-FileHash .\trestl-desktop-0.6.0-x86_64-pc-windows-msvc.exe -Algorithm SHA256`
with the matching line in the checksum file.

## Signing setup

PR and branch workflow builds need no signing credentials. **Tagged releases
never publish unsigned desktop installers.** If required signing settings are
missing, the workflow reports desktop publication as pending and skips native
release builds and uploads. Invalid configured credentials still fail the build.
Configure these repository secrets before publishing desktop installers:

| Secret                       | Purpose                                               |
| ---------------------------- | ----------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64-encoded Developer ID Application `.p12`        |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the exported certificate                 |
| `APPLE_SIGNING_IDENTITY`     | Full `Developer ID Application: …` identity           |
| `APPLE_ID`                   | Apple account email for notarization                  |
| `APPLE_PASSWORD`             | Apple app-specific password, not the account password |
| `APPLE_TEAM_ID`              | Apple Developer team ID                               |
| `AZURE_CLIENT_ID`            | Windows signing service principal client ID           |
| `AZURE_CLIENT_SECRET`        | Service principal credential                          |
| `AZURE_TENANT_ID`            | Azure directory ID                                    |

For Windows, configure an Azure Artifact Signing account and certificate profile,
grant the service principal signing access, and set these repository variables:
`AZURE_SIGNING_ENDPOINT` (for example `https://wus2.codesigning.azure.net`),
`AZURE_SIGNING_ACCOUNT`, and `AZURE_SIGNING_PROFILE`. The workflow installs a
pinned `artifact-signing-cli` and uses Tauri's custom signing hook to sign the
application and both installers. It verifies Authenticode before uploading.
See [Tauri's Windows signing guide](https://v2.tauri.app/distribute/sign/windows/).
A valid signature does not guarantee immediate SmartScreen reputation.

Tauri imports the Apple certificate, signs the application and Node sidecar with
the included hardened-runtime/JIT entitlements, notarizes, and staples the app.
The workflow independently verifies code signatures, the notarization ticket,
and Gatekeeper assessment. See
[Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).
Credentials are never committed to the repository and signing runs only on
trusted version tags, not pull requests.

After configuring the signing settings and the existing updater private key,
rerun **Desktop installers** for the immutable `v0.6.0` tag. Do not move the tag,
replace existing release assets, or generate a new updater key. Verify all
installers, checksums, and `latest.json` before marking desktop downloads available.

## Updater signing key

Updater signatures are separate from Apple/Windows code signing. The public key
is committed in `src-tauri/updater.pub` and `tauri.conf.json`; the native updater
and bundler must use the same key. The release workflow needs the private half in
the repository secret `TAURI_SIGNING_PRIVATE_KEY`, and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key is password-protected. PR/manual
builds do not need private keys and do not produce publishable update feeds.

Keep a secure backup of the private key. **Do not generate a replacement key for
each release.** Installed apps trust the public key they shipped with. Losing or
replacing its private key breaks the update path for those users unless a key
migration is shipped first. Never commit the private key or place it in an app
bundle, log, release asset, or public environment variable.

For a local signed updater build, point `TAURI_SIGNING_PRIVATE_KEY` to the private
key file, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (an empty string for an
unprotected key to prevent an interactive prompt), run
`node scripts/desktop-release.mjs configure-updater`, then build
with `--config src-tauri/updater.release.json`. The generated override enables
`createUpdaterArtifacts`; ordinary local builds leave it disabled. Release CI
collects `.app.tar.gz` archives for macOS and signatures for those archives, both
Windows installers, and the Linux AppImage. It verifies all five signatures
before publishing any update manifest.

## Platform acceptance checks

Before publishing each platform's installers, validate installation, first-run
setup, restart persistence, import/export (including cancellation of the save
dialog), canvas editing/export, external links, second-launch focus, offline
operation, quit, and upgrade with a copied database. CI tests the packaged
service but does not replace native webview/installer QA on all platforms.

## Architecture and troubleshooting

Rust owns the native window and bundled Node process. Node starts the same
Fastify application and PGlite database used by the web version, listens only on
`127.0.0.1`, and announces readiness over a private pipe. A random one-use launch
credential establishes an HttpOnly session cookie before assets or API endpoints
are accessible. Requests validate Host and Origin. On macOS, only the exact local
origin receives permission to drag or zoom its own window; the webview receives
no native filesystem or shell IPC capabilities. Its only additional update
permission is to acknowledge save readiness. Update installation commands are
restricted to the separate bundled update window, whose navigation is locked to
local app content. Arbitrary web pages cannot use the local
API. The regular CLI/Raycast clients cannot connect to this private desktop
service; use a hosted installation for those clients.

The service reuses its last local port to preserve webview preferences, or chooses
a free one if it is occupied. A changed port can reset appearance/view preferences
but does not affect database contents. The shell passes only OS runtime variables,
and the service ignores inherited database and authentication configuration.

Quit requests a database flush and waits up to 15 seconds before forcing an
unresponsive process to exit. The stdin pipe closing also triggers a graceful
shutdown if the native shell crashes. A per-database lock prevents concurrent
writers; stale locks are recovered only when their process no longer exists.
If startup fails, read `desktop.log` in the data folder. Do not delete a lock
while a Trestl/trestl-node process is still running. Retain backups before trying
to repair a damaged database or secret file.
