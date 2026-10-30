# Container releases

The **Publish image** GitHub Actions workflow publishes to
`ghcr.io/saynain/trestl`. It runs the complete reusable CI workflow, builds a
`linux/amd64` image, smoke-tests that exact image with isolated PostgreSQL, and
pushes it without rebuilding. ARM64 publication is not configured yet.

The smoke test covers initial setup, authenticated requests, persistence after
an app restart, and database outage/recovery with Compose. It also runs the
image as one container with the embedded database, as in the
[quick start](quick-start.md), and checks that recreating the container keeps
its data and generated key. To test an already-built image:

```sh
TRESTL_SMOKE_IMAGE=trestl:test node scripts/test-docker.mjs
```

## Publish a pilot build

In GitHub, open **Actions → Publish image → Run workflow**, selecting `main`.
Alternatively:

```sh
gh workflow run publish-image.yml --repo saynain/trestl --ref main
```

Manual runs publish a unique `sha-<full-commit>-<run-id>-<attempt>` tag. Only
manual runs from `main` are accepted. The workflow summary records the source
commit, image tag and digest to hand to the deployment repository. There is no
automatic deployment and no mutable `latest` tag.

## Publish a version

The release commit also updates the image tag that new installations use:
`compose.yaml`, the [quick start](quick-start.md), the README, and the
website's install commands. Compose reads `compose.yaml` from `main`, so the
tag there must be published shortly after the release commit merges.

After merging and verifying a release commit on `main`, push a new version tag:

```sh
git tag v0.6.0 <release-commit>
git push origin refs/tags/v0.6.0
```

Use the next unused version, optionally with a prerelease suffix such as
`v0.6.0-rc.1`. The workflow rejects other tag formats and commits outside main's
history. Treat release tags as immutable: never move or reuse one. Deployment
repositories must pin digests, not rely on tags being technically immutable.

## GitHub authentication and visibility

Publication uses the job's short-lived `GITHUB_TOKEN` with `contents: read` and
`packages: write`; no personal publishing token is needed. The source label
links the package to its GitHub repository. GitHub Actions and the required
package permissions must be allowed by the account's policies.

The `ghcr.io/saynain/trestl` package is public, so pulling it needs no
credentials. New GHCR packages default to **private**, and this workflow does
not change visibility. If you publish the image from a fork or under another
name, set its visibility under **GitHub profile → Packages → Package
settings**; repository visibility does not change package visibility.

See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Replication into an internal registry

Keep registry endpoints, replication rules, credentials and deployment pins in
the internal platform's configuration, outside this product repository.

For Harbor:

1. Create a **GitHub Container Registry** endpoint for `https://ghcr.io`.
   The public package needs no credentials. To replicate a private package,
   such as one published from a private fork, use a GitHub account with package
   access and a personal access token **(classic)** with `read:packages`. The
   fine-grained token used for source mirroring does not replace this
   credential. Store the token using the platform's secret-management
   procedure; never in Git.
2. Create a pull-based replication rule matching `saynain/trestl` and the
   selected tag or release-tag pattern. Replicate into a normal private Harbor
   project. Verify the destination repository path after applying Harbor's
   namespace mapping. Start manually; scheduling can follow after validation.
3. Verify successful replication, the image platform, source revision label and
   destination digest. Confirm pull access with the cluster's own read-only
   registry credentials. Preserve deployed and rollback versions in retention.
4. Pin the verified Harbor image digest and corresponding full source commit
   for the Kubernetes base in the deployment repository. Let GitOps reconcile
   that explicit selection. Publishing or replicating an image does not update
   the running deployment by itself.

After the GHCR package becomes public, test anonymous replication before
removing the private-read credential. GitHub Actions never needs credentials or
network access to the internal registry or Kubernetes cluster.

See [Harbor replication endpoints](https://goharbor.io/docs/main/administration/configuring-replication/create-replication-endpoints/)
and [replication rules](https://goharbor.io/docs/main/administration/configuring-replication/create-replication-rules/).

The same release tag publishes the CLI to GitHub Releases.
[Desktop installers](desktop.md) publish from that tag when signing is configured;
otherwise desktop publication is explicitly pending while the image and CLI ship.

## Version information in Administration

Installation administrators can open **Administration → Server version** to see
this server's installed package version, commit, build identifier and build time.
The server checks the latest stable GitHub Release from `saynain/trestl` and links
to its release notes. It does not install or deploy updates.

Release checks use an anonymous GitHub request with a five-second timeout. Results
(including failures) are cached for 15 minutes. **Check for updates** bypasses that
cache at most once per minute across administrators. If the repository is private,
has no published release, GitHub rate limits requests, or the server is offline,
the running version remains visible and update status becomes unknown. No GitHub
integration credentials are used or sent by this feature.

Published images capture commit, tag/branch, workflow run identifier and UTC build
time through these non-secret Docker build arguments (also available as runtime
environment variables for other deployment systems):

- `TRESTL_BUILD_COMMIT`: full source commit.
- `TRESTL_BUILD_REF`: source tag or branch, such as `v0.6.0` or `main`.
- `TRESTL_BUILD_ID`: deployment/build identifier.
- `TRESTL_BUILD_DATE`: ISO 8601 UTC build timestamp.

The package version is always read from the installed server's `package.json`.
Source checkouts detect their commit, exact tag and modified tracked files at
startup. Desktop packaging captures equivalent metadata into its server bundle.
Containers built outside the publication workflow should provide the arguments;
missing provenance is displayed as unavailable. An equal-version custom build
is reported as development/unreleased unless identified by a clean matching
`v<package-version>` tag. A version ahead of the latest release is also unreleased,
not an update error. Older versions report an available update. Restart the server
after changing a source checkout or deployment metadata.
