# Container releases

The **Publish image** GitHub Actions workflow publishes to
`ghcr.io/saynain/trestl`. It runs the complete reusable CI workflow, builds a
`linux/amd64` image, smoke-tests that exact image with isolated PostgreSQL, and
pushes it without rebuilding. ARM64 publication is not configured yet.

The smoke test covers initial setup, authenticated requests, persistence after
an app restart, and database outage/recovery. To test an already-built image:

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

After merging and verifying a release commit on `main`, push a new version tag:

```sh
git tag v0.1.0 <release-commit>
git push origin v0.1.0
```

Use the next unused version, optionally with a prerelease suffix such as
`v0.1.0-rc.1`. The workflow rejects other tag formats and commits outside main's
history. Treat release tags as immutable: never move or reuse one. Deployment
repositories must pin digests, not rely on tags being technically immutable.

## GitHub authentication and visibility

Publication uses the job's short-lived `GITHUB_TOKEN` with `contents: read` and
`packages: write`; no personal publishing token is needed. The source label
links the package to its GitHub repository. GitHub Actions and the required
package permissions must be allowed by the account's policies.

New GHCR packages default to **private**. After first publication, confirm the
package visibility and repository access under **GitHub profile → Packages →
trestl → Package settings**. This workflow does not change visibility. If a
package already exists, its current visibility remains in effect.

When ready for public distribution, change the package visibility explicitly.
Changing repository visibility is not a substitute for checking package
visibility. A public image exposes its packaged code, including Trestl's server
TypeScript, even if the source repository is private.

See [GitHub's container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Replication into an internal registry

Keep registry endpoints, replication rules, credentials and deployment pins in
the internal platform's configuration, outside this product repository.

For Harbor:

1. Create a **GitHub Container Registry** endpoint for `https://ghcr.io`.
   While the package is private, use a GitHub account with package access and a
   personal access token **(classic)** with `read:packages`. The fine-grained
   token used for source mirroring does not replace this credential. Store the
   token using the platform's secret-management procedure; never in Git.
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
