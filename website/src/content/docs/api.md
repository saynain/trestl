# API reference

Use Trestl's JSON API to work with the same projects, tasks, and permissions as the application. Requests go to **your installation**, under `/api/v1`.

## Authenticate

Create a personal API token in **Account settings → API tokens**. Choose the scope your integration needs. Tokens act as your account and remain subject to its current project access.

```sh
export TRESTL_URL="https://projects.example.com"
# Set TRESTL_TOKEN to your personal API token in your environment.
curl --fail-with-body \
  -H "Authorization: Bearer $TRESTL_TOKEN" \
  "$TRESTL_URL/api/v1/items"
```

Keep tokens out of source control and URLs. Disabling an account revokes its sessions and tokens. For installations behind an authentication gateway, follow the [proxy routing guide](/docs/self-hosting/proxy-auth/).

## Explore the contract

Your running server exposes its contract at `/api/v1/openapi.json`. Use that document when generating a client for a deployed version.

The [downloadable OpenAPI document](/docs/openapi.json) on this website is generated from the server source at build time. It includes request schemas, endpoint parameters, authentication, and responses. You can also [read the contract source](https://github.com/saynain/trestl/blob/main/server/openapi.ts).

## Common resources

| Resource   | Path                                    | Purpose                                        |
| ---------- | --------------------------------------- | ---------------------------------------------- |
| Work items | `/api/v1/items`                         | Find, create, and update tasks and follow-ups. |
| Projects   | `/api/v1/projects`                      | Organize work and manage project metadata.     |
| Roadmap    | `/api/v1/projects/{id}/roadmap`         | Read and replace a project's roadmap.          |
| Canvases   | `/api/v1/projects/{projectId}/canvases` | Manage project diagrams.                       |

Consult the OpenAPI contract for the supported methods and required fields on each path.

## Update safely

Revision-protected mutations require `expectedRevision`. Fetch the current record, apply your change using that revision, and handle **409 Conflict** by reading the latest state before retrying. Avoid overwriting a teammate's edits.

Project visibility, ancestor privacy, and token scope still apply through the API. Git issue synchronization is inbound; local planning changes are not posted back to Git providers.

## Prefer the CLI for agent workflows

The [Trestl CLI](/docs/integrations/cli/) handles profiles, browser sign-in, structured JSON output, pagination, and mutation safeguards. It is a useful starting point for scripts and coding agents.
