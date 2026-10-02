# CLI releases

`Publish CLI` builds a standalone npm tarball and `SHA256SUMS`, pushes both into an OCI artifact at `ghcr.io/<owner>/<repository>-cli`, pulls that exact digest back, and compares it with the original package. It uses the repository's short-lived `GITHUB_TOKEN`; no registry password is needed in repository secrets.

A `v<version>` tag publishes the same files as GitHub Release assets. The tag must match `cli/package.json` and point to a commit already on `main`. The workflow runs the reusable application, container and Raycast CI first, including an offline install and browser-pairing test of the packed CLI. Existing release assets are not overwritten. Inspect a failed partial release before retrying; never move a published version tag.

Manual runs on `main` publish a unique `sha-<commit>-<run>-<attempt>` registry tag for testing, without creating a GitHub Release. Use the immutable digest from the workflow summary to install or mirror that build.

For a new release:

1. Update the root, CLI, Tauri config, Cargo manifest, and Cargo lockfile versions together (`pnpm desktop:version` checks them), and the README's pinned examples. Add release notes at `docs/releases/v<version>.md`; the workflow uses this file as the GitHub Release description. Run CI on `main`.
2. Tag that exact commit `v<version>` and push the tag. The application image, CLI, and desktop workflows run. Signed desktop installers publish when signing is configured; otherwise the desktop workflow reports publication as pending. See [desktop releases](desktop.md#release-v060).
3. Verify the release assets and registry digest in Actions. Install the downloaded tarball and test browser login against a server running the matching version.

This workflow does not publish an npm registry package. GitHub Release downloads avoid requiring ORAS for ordinary users; GHCR provides the same package for registry-based distribution and mirrors.

A private repository's releases require GitHub access. GHCR packages default to private and have their own visibility/access settings. Opening the source repository does not by itself guarantee anonymous artifact access. Before an open-source launch, deliberately make both intended packages public and verify downloads without credentials. The publishing workflow never changes visibility.
