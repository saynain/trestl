# Mentions in work items

Descriptions (including new items) and comments support searchable mentions:

| Trigger | Reference | Search by |
| --- | --- | --- |
| `@` | Person | Name or email |
| `/` | Work item | Identifier or title |
| `$` | Project | Name or key |

Type a trigger at the start of a line or after a space, then choose a suggestion.
Use the arrow keys and Enter or Tab, or click a suggestion. Escape dismisses the
menu. Only people in the current workspace and projects/items you can access are
offered. Code blocks, inline code, and existing links do not offer suggestions.

Selected mentions are stored as Markdown links with stable IDs. The editor shows
the Markdown source; the description and comment render names
and clickable item/project references. Renames and item moves retain the target.
Unavailable targets render a placeholder. Person mentions identify a person;
they do not assign work or grant access. New mentions notify that person in the
app when they can access the work item.

Saving a description or comment automatically creates an ordinary **Related to**
relationship for each selected work item and a project relationship for each
selected project. Project overviews list the work items that reference them.
Saving the same references again does not create duplicates, and self-references
do not create item relationships. Merely typing `/ABC-01` without selecting a
suggestion remains plain text.

Removing a mention from the text preserves its relationship. Remove relationships
explicitly in the work item's Relationships section. Removing a relationship
does not change the text; adding a new mention in a subsequent comment can create
the relationship again.

## API behavior

Mentions use `[@Name](#/mention/user/UUID)`, `[/KEY-01](#/mention/item/UUID)`, and
`[$Project](#/mention/project/UUID)` in existing description and comment fields.
New references are validated and relationships are created in the same database
transaction as the text save. An inaccessible or missing target fails the save;
neither partial relationships nor a partial comment/description are retained.

Item relationships retain the existing `relations` representation. Project
relationships are returned in `projectRelations` on bootstrap and item detail
responses, with `id`, `itemId`, and `projectId` fields. Both endpoints must be
visible to the current user. Remove one with
`DELETE /api/v1/items/{id}/project-relations/{relationId}`.

Mention IDs are local to an installation. Project transfer bundles do not
currently remap these references or include the new project relationships;
reselect mentions after importing a project into another installation.


## In-app notifications

The notification bell and **Notifications** sidebar entry show your unread count.
The inbox defaults to **Unread**; switch to **All** to revisit read notifications.
Opening a notification marks it read and opens the item. Comment notifications
scroll to and highlight the relevant comment. Individual notifications can be
marked read or unread, and **Mark all as read** clears the current backlog.

Notifications persist between logins. The app checks for updates every 30 seconds
while visible and when the window regains focus. This first version covers new
people mentions in descriptions and comments; it does not send email, browser
push, or notifications for assignment/status changes. Existing mentions are not
backfilled, self-mentions are silent, and editing text around an unchanged mention
does not create a new notification. A new comment mentioning someone does.

Recipients only receive notifications for items they can access. Revoking access
hides existing notifications and their unread counts; deleting an item removes
its notifications. Notification read state belongs to each recipient.

API endpoints:

- `GET /api/v1/notifications`: your accessible notifications, newest first.
- `PATCH /api/v1/notifications/{id}` with `{ "read": true }` or `{ "read": false }`.
- `POST /api/v1/notifications/read-all` with `{}`.

Notifications are also included in the authenticated bootstrap response.
