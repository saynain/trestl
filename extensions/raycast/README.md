# Trestl for Raycast

A native Raycast extension for a self-hosted Trestl workspace. Browse work, read descriptions and activity, capture tasks, and update planning fields without switching to a browser.

## Commands

| Command               | Workflow                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search Work Items** | Search titles, descriptions, and identifiers, with an optional launch query, status filter, and paginated results. Press Enter to preview an item.                                                      |
| **My Work**           | Browse items assigned to the account that owns your API token, with the same search, status filters, and actions.                                                                                       |
| **Search Projects**   | Search project names and keys, filter project status, browse directly assigned work, or capture an item in that project. Defaults to active projects; select All Projects to include archived work.     |
| **Create Work Item**  | Capture a task, bug, idea, or follow-up. Accepts an optional title argument and supports drafts, Markdown descriptions, project, status, priority, assignee, delivery and review dates, and visibility. |

Item previews include Markdown descriptions, activity, status, priority, type, visibility, dates, recurrence, labels, and documentation links. Actions support editing, setting status or priority, completing/reopening work, opening Trestl, and copying identifiers and links. Completing recurring work uses the server's normal next-occurrence behavior.

Search and My Work include all statuses by default. Project work lists show items directly assigned to that project; child projects can be opened separately. Discussion is readable in previews. The extension does not post comments or sync changes to GitHub, Gitea, or Confluence. Imported titles and descriptions remain source-owned; local planning fields remain editable.

## Install locally

Requires macOS, Raycast, Node.js 22.9 or newer, pnpm 10.7.1, and a running Trestl server. Keep this directory inside the Trestl checkout: it imports the shared domain types from `../../shared`.

From the repository root:

```sh
pnpm --dir extensions/raycast install --frozen-lockfile
pnpm --dir extensions/raycast dev
```

`ray develop` imports the extension into Raycast and watches for changes. Open one of the four commands in Raycast to configure it. This does not require publishing to the Store. See Raycast's [local extension development guide](https://developers.raycast.com/basics/create-your-first-extension).

## Connection preferences

Create a personal API token in **Trestl → Settings**. A **read** token supports all browsing commands; a **write** token is required to create and update work. Your account's normal visibility and editing permissions still apply. A read token will receive an access error if you invoke a mutation action.

| Preference         | Local development       | Built app / deployment         |
| ------------------ | ----------------------- | ------------------------------ |
| Server URL         | `http://localhost:4317` | `https://projects.example.com` |
| Web URL            | `http://127.0.0.1:5173` | Leave empty to use Server URL  |
| Personal API Token | Your token              | Your token                     |

Use origins, without `/api/v1`, paths, query strings, or embedded credentials. Remote URLs require HTTPS; HTTP is supported only for loopback hosts. The token uses Raycast's [password preference](https://developers.raycast.com/api-reference/preferences). Requests have a 20-second timeout and reject redirects to avoid forwarding credentials. Work data is held in memory, without a persistent extension cache. Capture drafts are managed by Raycast.

Use **Open Extension Preferences** in any command's actions to change connections or replace an expired token. **Refresh** retries failures and reloads data. Error screens distinguish authentication, permissions, missing work, rate limiting, server failures, and invalid responses. A successful create or edit returns to the previous view. A success toast also offers to open the item in Trestl.

## Shortcuts

| Shortcut | Action                                                    |
| -------- | --------------------------------------------------------- |
| Enter    | Preview selected work / browse selected project           |
| ⌘O       | Open in Trestl                                            |
| ⌘N       | Capture work, using the current project when browsing one |
| ⌘E       | Edit selected work                                        |
| ⌘⇧D      | Complete or reopen selected work                          |
| ⌘⇧C      | Copy item link                                            |
| ⌘R       | Refresh / retry                                           |

Use Raycast's command preferences to assign hotkeys or aliases to the four commands.

## Development and verification

```sh
pnpm --dir extensions/raycast typecheck
pnpm --dir extensions/raycast test
pnpm --dir extensions/raycast format:check
pnpm --dir extensions/raycast build
pnpm test
```

The extension's unit tests cover URL validation, credential handling, request construction, cancellation, failure responses, pagination deduplication, links, and local calendar dates. The root suite includes `tests/raycast.test.ts`, which runs the client against an isolated real Trestl server to verify bearer authentication, read/write scopes, item detail, pagination, recurrence, and clearing planning fields.

`build` validates and bundles all four commands into local `dist/`. It does not publish or install them. Source distribution is MIT licensed; publishing to the Raycast Store requires your own Raycast author identity and store review.

For a manual Raycast smoke test after importing: configure a read token, search and preview work, filter My Work, browse a project, then switch to a write token and capture a private test item. Edit its dates and priority, complete/reopen it, copy/open its link, and verify the corresponding changes in Trestl. Check an invalid token and an unreachable URL to exercise retry and preferences actions. These native UI interactions require an installed and configured extension.
