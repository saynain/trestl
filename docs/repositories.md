# Repository attachments

A project can have GitHub and Gitea repositories attached to it. Attachments
live on the project's **Resources** tab; credentials stay in
**Administration → Integrations**.

## Who can do what

| Action                                                  | Who                                    |
| ------------------------------------------------------- | -------------------------------------- |
| Add, replace, or disconnect a shared Git connection     | Workspace administrators               |
| Attach or detach a repository, change its mode, default | The project owner and workspace admins |
| Sync an inbound mirror now                              | The project owner and workspace admins |
| See attached repositories, their mode and sync health   | Everyone who can access the project    |
| See credentials                                         | Nobody; secrets never leave the server |

Attaching uses a connection the person attaching can already use: a shared
connection in their installation or their own legacy personal connection.
Management requires a signed-in browser session or an administrator-scoped
API token.

## Attaching a repository

1. Open the project's **Resources** tab and choose **Attach repository**.
2. Choose a Git connection and a repository. Trestl suggests repositories the
   connection can read; you can also type `owner/repository`.
3. **Check access** reads the repository's metadata and issues with that
   connection. Trestl only sends GET requests.
4. Choose a mode and attach.

Trestl records the provider's repository ID when it checks access, so later
work can follow renames and transfers.

## Modes

| Mode           | What happens                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Reference      | The repository is linked to the project. Issues are not imported.                               |
| Inbound mirror | Issues and comments are imported into the project and kept up to date. Nothing is written back. |
| Two-way        | Not available yet. It stays disabled until publication rules and the sync journal exist.        |

A repository can mirror issues into one project per installation, because each
issue becomes one work item. It can be attached as Reference to any number of
projects. Switching an inbound mirror to Reference, or detaching it, keeps the
imported items in the project and marks them disconnected. Switching back
reconnects the same items instead of importing duplicates.

When access is checked, Trestl also explains when a credential could never
publish to the repository, for example a GitHub App installation that only
requests read access to issues, or a token with read-only access to the
repository. The two-way option shows that reason.

## Default repository

One repository per project is the default destination for new items. The first
attached repository becomes the default; detaching the default promotes the
oldest remaining repository. **Find Git issue** starts from the default.

## Sync health

Each repository shows its mode, the connection it uses, and its last
successful sync or last error. Inbound mirrors sync when they are attached,
when someone selects **Sync**, and every `INTEGRATION_SYNC_INTERVAL_MS` if it
is set to at least 60000 milliseconds.

## Upgrading

Repository imports configured in Administration before attachments existed
become inbound mirrors on the same project, with the same IDs, sync history and
imported items. The oldest import in each project becomes its default. The
`/api/v1/integrations` endpoints keep working for scripts.
