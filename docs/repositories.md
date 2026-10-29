# Repository attachments

A project can have GitHub and Gitea repositories attached to it. Attachments
live on the project's **Resources** tab; credentials stay in
**Administration → Integrations**.

## Who can do what

| Action                                                  | Who                                                  |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Add, replace, or disconnect a shared Git connection     | Workspace administrators                             |
| Attach or detach a repository, change its mode, default | The project owner and workspace admins               |
| Sync an inbound mirror now                              | The project owner and workspace admins               |
| See attached repositories, their mode and sync health   | Everyone who can access the project                  |
| Enable two-way after reviewing its preview              | The project owner and workspace admins, in a browser |
| Publish an opted-in field once two-way exists           | The project owner, project members and admins        |
| See credentials                                         | Nobody; secrets never leave the server               |

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
| Two-way        | An inbound mirror where the fields the project opts into may flow back. Off by default.         |

Attachments are read-only unless a project owner enables two-way. A repository
can mirror issues (inbound or two-way) into one project per installation,
because each issue becomes one work item. It can be attached as Reference to
any number of projects. Switching a mirror to Reference, or detaching it, keeps
the imported items in the project and marks them disconnected. Switching back
reconnects the same items instead of importing duplicates.

When access is checked, Trestl also explains when a credential could never
publish to the repository, for example a GitHub App connection, which Trestl
always uses read-only, or a token with read-only access to the repository. The
two-way option shows that reason instead of failing later.

## Field ownership

The server enforces the two-way column. Everything not opted into stays in
Trestl.

| Field                                  | Reference       | Inbound mirror      | Two-way                                           |
| -------------------------------------- | --------------- | ------------------- | ------------------------------------------------- |
| Link to the repository                 | Shown           | Shown               | Shown                                             |
| Title and description                  | Not imported    | Repository          | Repository                                        |
| Open or closed state                   | Not imported    | Repository          | Repository                                        |
| Repository comments                    | Not imported    | Repository → Trestl | Repository → Trestl                               |
| Replies                                | Never published | Never published     | Trestl → repository when opted in                 |
| Status                                 | Trestl          | Trestl              | Trestl; closes or reopens the issue when opted in |
| Assignee                               | Trestl          | Trestl              | Trestl; published when opted in                   |
| Priority, dates, labels and follow-ups | Trestl          | Trestl              | Trestl, never published                           |
| Internal notes and private items       | Trestl          | Trestl              | Trestl, never published                           |

## Enabling two-way

Only the project owner or a workspace administrator can enable two-way, from a
signed-in browser session; API tokens cannot. In the repository's settings,
choose **Two-way**, pick what may flow back (replies, status, assignee), and
select **Preview**. The preview shows:

- the destination repository and whether it is private or public,
- which connection publishes (a shared connection publishes on everyone's
  behalf; a personal one publishes as its owner),
- who can read published content,
- every field and who owns it, with the published ones highlighted, and
- what is never published.

Two-way is enabled only after you confirm that exact preview. If the
repository, connection, visibility or selection changes, the confirmation no
longer matches and you review the preview again. Switching back to inbound
mirror or Reference withdraws consent; enabling two-way again needs a new
preview.

In this version two-way records the project's choice. Trestl does not write to
GitHub or Gitea yet. Replies and field sync will publish through the rules
below when they arrive.

## Publication rules

Every outbound operation passes one server-side check, and is rejected unless
all of these hold:

1. The repository is in two-way mode and the project opted into that field
   (replies, status or assignee).
2. The connection can publish. GitHub App connections never can, and the last
   access check must have found write access.
3. The person is the project owner, a project member, or a workspace
   administrator. Being able to see a workspace project is not enough, so a
   shared credential never lets every workspace member publish.
4. A personal connection publishes only for its owner.
5. The token is not read-only.
6. The item follows this repository, is connected, and is not private.
7. A reply is the person's own comment, written after two-way was enabled.
   Earlier notes, imported comments and internal notes are never published.

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
