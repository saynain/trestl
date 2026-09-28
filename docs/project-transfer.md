# Move a project between installations

Use project export/import to copy work from a local Trestl installation to a team
server, or between two self-hosted installations. It works across PGlite and
PostgreSQL because the file contains application records, not a database dump.
Both installations must run a release supporting project transfer version 1.

1. On the source, open the project's **⋯ Project options → Export project** and choose
   **Download project**. The file ends in `.trestl-project.json`.
2. On the destination, open **Projects → Import project** and select the file.
3. Review the proposed project names and keys, visibility, and assignee mappings.
   Existing names and keys receive suggested alternatives. The server checks for
   conflicts again when importing.
4. Confirm the review and choose **Import as new projects**. Trestl opens the new
   root project after the import finishes.

The source stays untouched. An import creates a new root project and preserves
its subproject hierarchy, work item hierarchy, descriptions, tags, dates,
statuses, recurrence, comments and history, internal relationships, resource
links, milestones, roadmaps, project health updates, canvas collections, and canvas scenes with embedded
images. IDs and work item numbers are newly allocated. Original work item
identifiers remain available in the item details. Original author names and dates
are retained and identified as imported history, including former contributors.

You own all imported projects. All projects default to **Private**, independently
of their visibility on the source. You can explicitly choose **Workspace** during
review; parent-project privacy still applies. Source-private work items stay
private to the importing account. Map source assignees to active destination
members, or leave them unassigned. This does not create users, invite people, copy
memberships, or grant access to private projects. Manage project members after
import if needed.

Export includes only content the exporting account can access. Private content
belonging to other users and relationships outside the exported tree are omitted.
Resource links with references outside the tree are omitted too. Existing URLs in
Markdown and canvas content keep their original destinations; they are not
rewritten to the new installation. Review those links after migration.
Screenshots uploaded into work item descriptions or comments stay on the source installation and are not included in the project file. Re-upload them on the destination if needed.

Authentication settings, passwords, API tokens, and integration credentials are
never part of a project export. Repository-linked issues become ordinary,
independent work items with their external URL retained. No webhooks or live sync
are enabled by importing. Configure the destination's integrations separately;
import does not automatically reconnect copied issues to repository sync.

The importer validates the file before writing and commits all imported content
in one transaction. A failed transaction leaves no partial project. Retrying the
same submitted request returns the same import rather than creating duplicates.
If the connection fails, use **Retry import** in the dialog. Starting a separate
import creates another copy. Files are limited to 32 MB; export smaller
subprojects separately when needed. The file contains project content and should
be handled with the same access restrictions as the source project.

This feature does not merge with existing projects, synchronize installations,
restore server configuration, or accept the installation-wide JSON export from
Administration. Keep database backups for complete server recovery.

## API

- `GET /api/v1/projects/:id/export` downloads a versioned project package.
- `POST /api/v1/project-import/preview` accepts `{ "package": <export> }` and
  returns counts, assignee choices, warnings, and proposed `options`. It writes
  nothing.
- `POST /api/v1/project-import` accepts `{ "package": <export>, "options":
<reviewed options>, "requestId": <UUID> }`. Reuse the exact body and request ID
  when retrying. A successful request returns the new root `projectId`, all
  `projectIds`, and `itemCount`.

Options contain `projects` (each with source `id`, destination `name`, `key`, and
`visibility`) and `assignees` (source user IDs mapped to destination user IDs or
`null`). Every source project must have exactly one entry. Import requires a
signed-in installation member or a write-scoped token. Read tokens can export
accessible projects but cannot import. File contents are treated as untrusted
input; account IDs from the source never establish destination ownership or access.

Project health updates retain their status, Markdown text, original dates, and author names.
Imported authors are labeled as imported history, not matched to local accounts. Re-exporting
preserves this provenance and the ordering of updates. Older files without project updates
remain importable and produce an empty update history.
