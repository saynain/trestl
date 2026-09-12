# Kubernetes

Trestl runs as one non-root application pod and a ClusterIP Service, backed by
an external PostgreSQL database. The app serves both the frontend and API on
port 4317. No application PVC is needed when using PostgreSQL; canvas images
also live in the database.

## What is included

- `base/`: a portable Deployment and Service. No Namespace, database operator,
  ingress controller, certificate issuer, or company-specific configuration.
- `examples/basic/`: an editable standalone example with a Namespace and
  ConfigMap. Its image and hostname are placeholders, not published services.

Use the base in your deployment repository. That repository owns the namespace,
database provisioning and backups, hostname, routes, TLS, network policies,
resource sizing, registry credentials, and image digest. With an existing
GitOps platform, let the platform own the namespace rather than copying the
example's Namespace resource into a second application.

## Prerequisites

1. Build the image from a selected Trestl revision and push it to your registry:

   ```sh
   docker build -t registry.example.com/trestl:v0.2.0 .
   docker push registry.example.com/trestl:v0.2.0
   ```

   Build for your cluster's CPU architecture, for example with
   `docker buildx build --platform linux/amd64 --push ...` when building an
   amd64 image on an ARM computer. The Dockerfile supports both; validate the
   architecture you deploy. Pin the resulting digest in your deployment repo.

2. Provision PostgreSQL and a database/user for Trestl. The application performs
   its schema migrations at startup, so this user currently needs DDL rights
   within its own database. Keep PostgreSQL private, configure backups, and
   prove a restore. An existing operator such as CloudNativePG can manage it;
   Trestl does not install or require a specific operator.

3. Provision a `trestl-secrets` Secret in the target namespace through your
   normal secret-management mechanism. Required keys:

   | Key            | Value                                                   |
   | -------------- | ------------------------------------------------------- |
   | `DATABASE_URL` | PostgreSQL connection URL, with URL-encoded credentials |
   | `APP_SECRET`   | Durable random value of at least 32 characters          |

   Generate the application key with `openssl rand -hex 32`. Keep it with your
   backup secrets. Do not commit the Secret values. Configure database TLS and
   its trusted CA according to your PostgreSQL installation. Optional provider
   credentials also belong in Secrets. See the [environment
   reference](../README.md#environment).

## Configure and render

Edit the example's image and `APP_ORIGIN` before deploying. `APP_ORIGIN` must
exactly match the browser's HTTPS origin. The base enables secure cookies.
When using a private registry, add its `imagePullSecrets` to the pod spec.

```sh
kubectl kustomize deploy/kubernetes/examples/basic
```

After creating the namespace and Secret, and reviewing your target context,
validate against your own cluster:

```sh
kubectl apply --dry-run=server -k deploy/kubernetes/examples/basic
kubectl apply -k deploy/kubernetes/examples/basic
kubectl -n trestl rollout status deployment/trestl
```

The example does not expose the service outside the cluster. Attach your own
HTTPS Ingress or Gateway API HTTPRoute to Service `trestl`, port 80. Preserve
the public Host header. Internal deployments should use internal DNS and an
internal gateway/load balancer. Permit that controller to reach the app and
allow required database, DNS, and integration traffic in your network policies.
An SSO proxy does not create Trestl user sessions; the pilot can use native
accounts. Native application SSO is not implemented yet.

## GitOps

For a deployment repository, replace the example's local base path with a
remote base pinned to a full commit SHA:

```yaml
resources:
  - https://github.com/saynain/trestl.git//deploy/kubernetes/base?ref=FULL_COMMIT_SHA
```

Replace `FULL_COMMIT_SHA` with the actual source revision. Use your internal
Gitea mirror URL if that is the cluster's source. For a private repository,
configure the renderer's credentials for that base and verify access; Argo CD
remote bases must be accessible with the invoking repository's credentials.
See [Argo CD private remote bases](https://argo-cd.readthedocs.io/en/stable/user-guide/kustomize/#private-remote-bases).

Use Kustomize's `images` configuration to replace `trestl` with your registry
image and `digest: sha256:...`. Promote the base revision and image digest
together when a release changes manifests. The normal flow is:

1. Test and build a selected product revision.
2. Publish the image and record its digest.
3. Review a deployment-repository change selecting that revision and digest.
4. Let Argo CD reconcile the approved deployment.

Source mirroring and publishing an image do not themselves select a production
release. Keep the first sync manual until routing, persistence, and recovery
have been exercised. Each resource should have a single Argo CD owner.

## Operations

- Keep `replicas: 1` and `strategy: Recreate`. Repository reconciliation is
  in-process; overlapping instances are not supported. Updates have a short
  interruption. Do not add an HPA yet.
- `/health` is process liveness. `/ready` checks the database and returns 503
  on failure. The startup probe allows up to five minutes for initialization.
- Logs go to stdout; SIGTERM closes the server and database connection.
- Database migrations run before the HTTP listener starts. Back up before
  upgrades. Reverting an image does not undo schema/data migrations; verify
  compatibility or restore into an isolated database before recovery.
- Secret and environment changes require a pod restart; references alone do
  not reload running processes.
- Follow [backup and restore](../README.md#backup-and-restore), including
  retaining `APP_SECRET`. Replicas and persistent volumes do not replace a
  tested backup.
