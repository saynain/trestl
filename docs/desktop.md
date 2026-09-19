# Trestl Desktop

Trestl Desktop runs the existing workspace in a native Tauri v2 window on macOS,
Windows, and Linux. The application includes its runtime, frontend, and PGlite
embedded PostgreSQL database. End users do not need Node.js, Docker, PostgreSQL,
or a web server. Core project, task, roadmap, and canvas features work offline;
remote repository and documentation integrations still need a connection.

## Install and get started

Starting with v0.4.0, the **Desktop installers** workflow attaches installers and
`desktop-SHA256SUMS` to the same [GitHub Release](https://github.com/saynain/trestl/releases)
as the CLI. Downloads require repository access while the repository is private.
Pull requests and manual workflow runs produce unsigned test artifacts only:

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
installation. It does not require a Trestl cloud account. Local uses its own
accounts; saved remote connections use the hosted installation's sign-in method.

Use the native **Trestl → Open Data Folder** menu to find your data. Standard
editing shortcuts, an integrated macOS title bar with real traffic lights,
window size/position restoration, external links in your
browser, and native download dialogs are supported. Closing the application
also stops the local database process. Launching a second copy focuses the
existing window.

## Local and remote connections

Choose **Local** in the sidebar or **Connections → Switch Connection…**
(`⌘⇧K` on macOS, `Ctrl+Shift+K` on Windows/Linux). Add the base HTTPS address of
an existing Trestl installation. The app discovers its installation name and
shows the address underneath, so similarly named installations remain distinct.
HTTP is allowed only for loopback addresses used in development. Installations
must be served at the domain root; subpath hosting is not supported.

**Local** always refers to the database on this computer. Each remote connection
loads that server's own interface and uses that server's database. Nothing is
synchronized or copied between installations. Sign in separately to each remote
connection; existing browser logins are not imported. Password sign-in and
identity-provider redirects use the connection's isolated webview. Providers
that disallow embedded browsers or require unsupported popup flows may need
**Open in browser**; this opens the web application and does not transfer its
browser session back to the desktop app.

Switching hides the previous workspace and preserves its current page and drafts
while Trestl remains open. Use `⌘1` / `Ctrl+1` to return to Local. The last active
connection is reopened at its home page on the next launch. If it cannot be
reached, Trestl returns to Local and shows the connection error. Remote work
requires a network connection; it has no offline editing or synchronization.
The local database process continues running while a remote connection is active.

Saved logins are isolated per connection, including installations on the same
hostname at different ports. They persist between launches on Windows, Linux,
and macOS 14+. On macOS 12/13, remote sessions are isolated but temporary; sign
in again after quitting. Session expiration and logout are still controlled by
the remote installation.

The connection's **•••** menu shows its reported server version and lets you open
it in a browser, close its session, or remove it. **Close session** closes the
workspace but retains the connection and saved login. **Remove connection** also
clears its webview browsing data and forgets the address; it does not delete
server data or revoke sessions server-side. Both ask you to save drafts first.
Quitting with remote sessions open also warns that those workspaces will close.

### Desktop and server versions

The desktop and server do not need identical Trestl versions. Remote mode loads
the server's frontend with its matching API. A small, separately versioned
optional desktop bridge supplies the connection button and integrated macOS
chrome. Servers without a recognized bridge still work with ordinary native
window chrome and the **Connections** menu. Older servers may not report their
version. A future server that requires web features unavailable in the operating
system's webview can still require an OS update or use of **Open in browser**.
This design avoids a frontend/API version mismatch; it does not guarantee every
future server or identity provider will work in every older webview.

Only the connection's exact origin can request the picker or report its own
name/version. It cannot access the local database, install updates, or invoke
filesystem commands. Redirected sign-in pages receive no desktop permissions.
Connection metadata is stored atomically in `connections.json`; cookies remain
in separate operating-system webview stores. A damaged or unsupported metadata
file leaves Local available and is preserved for recovery.

## Updates

To see the installed version, choose **Trestl → About Trestl**. The footer of
**Trestl → Check for Updates…** also shows the current version, even when the
release feed is unavailable. Development builds can share a version number:
replacing a local `0.4.0` build with a newer `0.4.0` build requires a manual
installation because the updater only offers higher versions.

Trestl checks once after startup and every six hours while open. Checks that find
no update or cannot reach GitHub stay quiet. A newly available version opens a
small update window without taking keyboard focus. The menu's **Check for
Updates…** action always lets you check manually.

The update window shows the new version, release notes, download progress, and
**Install and Restart**. Downloads are verified against the public key shipped
with the app. Downloading does not interrupt your work. Before installation,
save and close open forms or editors. For each open remote workspace, save your
work and choose **Connections → Switch Connection… → ••• → Close session**;
installation is blocked until all remote sessions are closed. The app then
flushes Local's canvas autosaves, waits for pending API writes, and requires the database process to exit successfully. A
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

The folder contains `database/`, `app-secret`, `port`, and `desktop.log`.
`desktop.lock` exists while the database is running. The persistent `app-secret`
encrypts integration credentials: back it up together with the database. The
webview also retains account cookies and appearance preferences in its own
operating-system storage. The desktop database is separate from development
`.data/` and all hosted installations.

For a full backup, **quit Trestl**, wait for it to stop, and copy the entire data
folder to a safe location. To restore, quit Trestl and replace the data folder
with that backup. Preserve the original before replacing anything. Do not copy
a live database or run an older version against data migrated by a newer one.
Uninstalling the application is not a request to erase your workspace.

For selective transfer between desktop and web installations, use
[project export/import](project-transfer.md). The administration JSON export is
an inspection/export format, not a full database restore.

## Build from source

Install Node.js 22.23.2+, pnpm 10.7.1, stable Rust, and the
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
rejects a mismatched runtime target. It downloads official Node.js 22.23.2,
checks its SHA-256 against Node's published checksum manifest, and caches it in
`node_modules/.cache/trestl-desktop/`. A first build needs network access;
installed applications do not. Generated runtime/resources live in ignored
`src-tauri/binaries/` and `src-tauri/resources/`. Tauri emits installers under
`src-tauri/target/release/bundle/` (or the target triple's release directory).

## Release v0.4.0

The desktop branch is based on `v0.4.0`. Integrate it into that release branch,
finish the platform checks below, and merge the release into `main`. The existing
CLI/image publishing rule is retained: a release tag must point to a commit
already incorporated into `main`.

Before tagging, run `pnpm desktop:version`. The root package, CLI package,
Tauri config, Cargo manifest, and Cargo lockfile must all say `0.4.0`. The workflow
also checks the tag equals `v0.4.0`. Desktop installer releases currently use
stable `major.minor.patch` versions; use manual workflow artifacts for candidates.

Pushing the `v0.4.0` tag starts the image, CLI, and desktop workflows. Desktop
publication waits for the reusable application/container/Raycast CI and all four
native build jobs (Apple Silicon, Intel Mac, Windows x64, Linux x64). Each native
runner tests the bundled service, including first setup, writing a project and
task, restart persistence, origin isolation, and parent-process shutdown. macOS
also tests the runtime inside the finished `.app`; Windows extracts the MSI and
tests its shipped runtime and resources. Release builds verify the signatures of
that extracted application and runtime.

The seven installers are named
`trestl-desktop-0.4.0-<target-triple>.<extension>`. The publishing job validates the
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
`Get-FileHash .\trestl-desktop-0.4.0-x86_64-pc-windows-msvc.exe -Algorithm SHA256`
with the matching line in the checksum file.

## Signing setup

PR and manual builds need no signing credentials. **Tagged desktop releases fail
instead of publishing unsigned macOS or Windows installers.** Configure these
repository secrets before tagging:

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
operation, quit, and upgrade with a copied database. Also test switching between
Local and at least two remote installations (including an older server), separate
logins, retained drafts while switching, session persistence after restart,
remote unavailability, close/remove cancellation, and update blocking while a
remote session is open. Exercise the deployed installation's real identity
provider on each platform; browser preview tests cannot verify native cookie
isolation or embedded sign-in behavior. CI tests the packaged
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
