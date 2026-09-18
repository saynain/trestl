# Using Trestl

[Back to the project](../README.md) · [Self-hosting](../deploy/README.md)

## Work and personal profiles

Open the workspace picker below the Trestl logo in the top-left corner and choose **Add account**. Sign in to an existing account, or choose **Create one** for a separate, empty workspace where the new account is the administrator. Work and Personal labels help distinguish saved sign-ins. Profiles remember authenticated sessions for up to 30 days; switching opens the selected profile’s Home.

Projects, tasks, workspace members, exports, and repository connections are isolated between workspaces, including through the API. **Settings → Members** still adds collaborators to the current workspace. Existing installations retain their original workspace and data; creating a new profile does not seed or copy example projects.

## Gantt schedules and dependencies

Open a project's **Gantt** tab to plan work with start and due dates, drag or resize bars, inspect milestones, and schedule undated items. **Fit** brings the schedule into view; **Completed** includes finished work. Click a bar or dependency badge to edit dates and inspect linked tasks. **Manage relationships** opens the task detail, where **Relationships → Blocks** adds a dependency.

Choose a milestone in a work item’s **Properties** to link it to a release or checkpoint in the same project. The **Milestone** list filter supports a specific milestone or **No milestone**, and is preserved in saved views. Moving an item to another project clears its milestone; deleting a milestone unlinks its items.

Milestones show **done/total** progress from linked work you can access (canceled items remain in the total). Expand a milestone on the Roadmap or in the Gantt milestone list to open its linked work; click its name in the project Overview for the same detail. Completion is still a separate manual milestone setting.

Milestones can be clicked to edit their name, date, and completion state, or dragged to a new calendar date. Overlapping labels are arranged into separate rows. Click the **Milestones** row heading to find milestones outside the visible range or restore a cleared date. Edits use revision checks to avoid overwriting newer changes.

**Critical path** highlights zero-float tasks and the dependency links that drive the longest chain, using forward and backward passes of the [critical path method](https://www.pmi.org/learning/library/critical-path-method-calculations-scheduling-8040). Float is the number of calendar days a task can slip without extending the calculated chain. The calculation covers unfinished project tasks and their visible unfinished upstream blockers, independent of search, collapsed groups, and the Completed toggle. Full planned durations are used, including for tasks already in progress; due-date-only points count as one day. Completed and canceled work is excluded. All tied critical branches are highlighted.

This is a duration-and-dependency calculation: fixed start dates, gaps, resource limits, and standalone milestone dates are not constraints. Missing durations are excluded with a **Partial** notice; a circular chain stops the calculation. Task dates are not changed by enabling Critical path. Existing scheduling conflicts remain separately flagged.

Blocking links appear as directional arrows, with red dashed lines for overlapping schedules and badges for unfinished blockers. **Blocks** means finish-to-start: an unfinished dependent starts on the calendar day after its unfinished blocker's due date, or later. For an item with only a due date, that date is treated as the decision/deadline point. Completed and canceled tasks no longer constrain dates. **Related to** links are informational and do not constrain scheduling.

Date edits are checked on the server as well as in Gantt, including linked tasks outside the current project or filters. Conflicting edits are rejected with the linked tasks identified; adjust their schedules individually before retrying. Tasks with missing dates remain visibly flagged because their order cannot yet be verified. Existing conflicting schedules are shown for review, and creating a circular blocking chain is rejected. Bootstrap only includes relationships when both tasks are visible to the current user.

## Personal Home and inbox

Home is the default landing page in each workspace. Quick capture adds a private work item assigned to you in your **Personal inbox**, without requiring a project. Choose **Task**, **Follow-up** (with a review date), or **Someday** (an idea in Backlog). Items can stay in the inbox permanently, or move into a project later through their normal properties.

Home includes open items assigned to you, plus your own unassigned inbox captures. The same ownership rule applies to My work and saved My work views. Items assigned to someone else are excluded from your Home; your inbox still retains items you created without a project. Work and personal workspaces remain separate.

- **Needs attention:** due or overdue deadlines, reviews scheduled for today or earlier, and work in progress or review. A future follow-up date defers work until that review, unless its delivery deadline is already due.
- **Next up:** upcoming reviews and deadlines, plus undated tasks ready to pick up.
- **Someday:** backlog items without a deadline or review date. **Move to Next up** changes their status to Todo.
- **All my work:** all open items in this personal scope.

Open any row to edit its normal work-item properties, or complete it directly on Home. **Tomorrow** postpones a ready follow-up by one calendar day without changing its deadline. Dates use your browser’s local calendar. Completed and canceled items remain accessible in the inbox and My work through the existing display options. Home does not send push or email reminders.

## Workflows

- Create ongoing or time-bound projects, nest related projects, and keep work outside projects in your inbox.
- Capture tasks, ideas, bugs, and follow-ups with separate delivery and review dates.
- Work from lists, boards, project views, My Work, and saved views. Filter by status, priority, and ownership.
- Open a work item to focus on its Markdown description and discussion; edit planning attributes in the side panel.
- Choose **Settings → General → Work item view → Centered box** to open items in a centered dialog. The side panel remains the default; small screens use the full screen. UI preferences are saved per profile in the current browser.
- Toggle **zen mode** with **⌘B / Ctrl+B**, the sidebar button in the top bar, or Settings to hide the desktop sidebar. On mobile, the shortcut opens or closes navigation.
- Add subtasks, blockers and related work, recurring tasks, labels, milestones, and documentation links.
- Keep personal work private. When creating or editing a private project, select workspace members under **People with access** to collaborate with a specific group. Only the owner can change visibility or membership, and the owner always retains access. Workspace projects remain visible to all workspace members. Parent privacy still constrains nested projects, and individually private items remain visible only to their creators. The API exposes additional project members as `memberIds` (an omitted list means no additional members).
- Connect GitHub or Gitea repositories through Settings. Import issue descriptions and discussions while retaining local planning fields.
- Search and preview Confluence pages through your personal connection, and link documentation to work without copying it into a wiki.
- Create scoped API tokens, export accessible workspace data, and use the CLI or Raycast extension.

Recurring work creates the next occurrence when you complete the current item. Review dates and overdue work appear in the application; email, push notifications, and a separate notification delivery service are not implemented.

| Shortcut                | Action                                  |
| ----------------------- | --------------------------------------- |
| `⌘K` / `Ctrl K`         | Open command palette and search         |
| `⌘B` / `Ctrl B`         | Toggle sidebar (zen mode)               |
| `Shift B`               | Switch list / board                     |
| `C`                     | Create work item                        |
| `/`                     | Focus work search                       |
| `J` / `K`               | Navigate work list                      |
| `Enter`                 | Open focused work item                  |
| `Space`                 | Toggle completion on a focused work row |
| `⌘Enter` / `Ctrl Enter` | Submit work-item form or comment        |
| `Esc`                   | Close dialog or item preview            |

## Project roadmaps

Open a project’s **Roadmap** tab to curate features under **Current focus**, **Up next**, **Future possibilities**, and **Not prioritized**. Features have a purpose, area, short status update, scope, priority rationale, and an optional target date. Edit a feature to change its group or move it up/down within the group. Deferred features show their rationale directly on the roadmap. These are project-level planning records; they do not change work-item status or automatically link to milestones or tasks.

Use **Edit summary** to set the headline, review date, and a short “Since last review” update. **Present** hides the app navigation and editing controls for meetings; Escape or **Exit presentation** returns to the regular view. Feature cards still open read-only details in presentation mode. **Copy link** copies the presentation URL and retains existing project access requirements. **Print / PDF** uses the browser’s print dialog with a landscape print layout.

Roadmaps persist with their project and are included in the existing project, bootstrap, and JSON export responses. `PATCH /api/v1/projects/:id/roadmap` replaces the roadmap using `expectedRevision`; stale edits return 409 instead of overwriting a teammate’s changes. Existing projects start with an empty roadmap; only newly seeded example workspaces receive sample roadmap content.

## Project canvases

Open a project's **Canvases** tab and choose **Import .excalidraw** to create a canvas directly from a file, without creating a blank canvas first. Imports use the filename as the canvas name and join the selected collection. Invalid files create no canvas. Choose **New canvas** to sketch architecture diagrams, workflows, and ideas with the embedded Excalidraw editor. Each project can have multiple named canvases. Rename a canvas in the editor header; drawing and name changes autosave after a short pause. The header shows whether changes are saved. **Canvases** returns to the list after saving pending changes.

**Light / Dark** in the canvas header controls Excalidraw independently of the rest of Trestl. Canvases default to light mode, and your choice is remembered for your profile in this browser. Changing canvas appearance does not modify the shared diagram.

Use **Switch canvas** beside the project name in the editor header to search and open another canvas in the same project. On narrow screens, tap the project name and chevron. Pending edits save before switching; if saving fails, the current canvas stays open with its unsaved changes.

Organize diagrams into flat, project-wide **collections**. The overview includes **All canvases**, **Unsorted**, and collection filters with counts, name search, and sorting by recently edited, newest, or alphabetical. Use **New collection** to create one, and select a collection to rename or remove it. A canvas belongs to at most one collection; **Move to collection** in the card menu changes it. New canvases default to the selected collection. Removing a collection preserves every diagram in Unsorted. The editor switcher groups results by collection. Collections follow project access, persist across sessions, and are included in workspace exports.

The overview shows previews of saved diagrams. Use each card's **…** menu to rename, duplicate, or delete a canvas without opening the editor. Deletion requires confirmation; rename and delete reject stale changes. **Copy PNG** copies an image directly to the clipboard, and **Copy SVG source** copies SVG markup for pasting into compatible tools. Both formats can also be downloaded from the menu. Clipboard actions require a secure browser context and clipboard permission; downloads remain available if copying is blocked. Previews load as cards approach the viewport and use the diagram's saved background in light mode, independently of app appearance.

The editor menu supports importing `.excalidraw` files as new canvases, downloading editable files, exporting PNG/SVG, and deleting a canvas. **Save a copy** duplicates the current drawing, including unsaved changes. If someone else edits the same canvas, saving stops with a conflict instead of overwriting their work. Save a copy or download your changes before reloading the latest version. Network failures keep your edits in the open editor and offer retry/download; avoid closing the browser until they are saved or downloaded. Browser navigation is guarded while changes remain unsaved.

Canvases inherit workspace, project, and ancestor privacy. Scene JSON and embedded image data persist in the configured PostgreSQL/PGlite database, appear in accessible workspace JSON exports, and are removed when their project is deleted. The editor and drawing fonts are served by Trestl; no Excalidraw account is needed. Canvas lists load metadata only; full scenes load on demand.

The CLI supports `trestl canvases list|create|import|show|delete --project <id-or-key>` (see the CLI README). `show` returns a browser link. The API import endpoint is `POST /api/v1/projects/:projectId/canvases/import` with `{title, document, collectionId?}`, where `document` is the parsed native `.excalidraw` file. `GET /api/v1/projects/:projectId/canvases/:canvasId/show` returns `{id, title, revision, url}`; resolve its relative URL against the installation origin. The API uses `/api/v1/projects/:projectId/canvases` for list/create and `/:canvasId` for read/update/delete. Updates and deletes require `expectedRevision`; stale requests return 409. Collection list/create uses `/api/v1/projects/:projectId/canvas-collections`; rename/delete uses `/:collectionId` with `expectedRevision`. Canvas create/update accepts a project-local `collectionId` or `null` for Unsorted. Removing a collection increments affected canvas revisions to protect open editors from stale saves. Write requests are limited to 8 MiB including embedded images, and scenes to 20,000 elements. Supported images are PNG, JPEG, GIF, WebP, and SVG. Embedded web pages and simultaneous live collaboration are not supported. The OpenAPI document includes these endpoints.

## CLI

The CLI is independently installable and runs from any directory:

```sh
pnpm build:cli
npm pack ./cli
npm install --global ./trestl-cli-0.2.0.tgz
trestl login --profile work --url https://projects.example.com
```

Create a personal API token in Settings and paste it into the hidden login prompt. Credentials persist per profile; environment variables are optional. Token files use owner-only permissions on Unix and are stored as plaintext in `~/.config/trestl`, not an OS keychain. Use `trestl auth status` to check your selected profile and `trestl logout` to remove its saved token.

Inside another repository, set defaults and read work:

```sh
trestl profiles list
trestl init --profile work --project K8S
trestl list --status todo
trestl get K8S-12 --json
trestl search "upgrade" --page --limit 50 --json
```

`.trestl.json` contains only profile/project defaults. The CLI uses API filtering and direct item lookup, supports structured JSON errors and documented exit codes, sends revision checks on updates, and supports retry keys on creates/comments. `pnpm cli` still works from this source repository. The CLI package has no runtime dependencies beyond Node.js 22.9+ and is not published to npm.

See [the CLI guide](../cli/README.md) for installation, authentication, precedence, pagination, mutation safeguards, and agent integration. A reusable [Trestl agent skill](../cli/agent-skill/trestl/SKILL.md) is included in the package. CLI comments are internal Trestl comments and are never posted to connected repositories.

The native Raycast extension includes **Search Work Items**, **My Work**, **Search Projects**, and **Create Work Item**. Preview descriptions and activity, edit planning fields, complete work, and capture tasks with projects, assignees, and dates. Follow [the extension instructions](../extensions/raycast/README.md) for setup, token scopes, and shortcuts. It is not installed or published automatically.

## API and repository connections

The API lives under `/api/v1`. Send `Authorization: Bearer <token>` for integrations and scripts. The browser uses an HTTP-only session cookie. The [OpenAPI document](http://localhost:4317/api/v1/openapi.json) is served by the running app at `/api/v1/openapi.json` and describes the endpoint contract.

To enable integrations, an administrator sets `APP_SECRET` to a durable random value of at least 32 characters and restarts the server. Each user connects GitHub or saves a GitHub/Gitea token in **Settings → Integrations**, alongside their Confluence connection. No project or repository is required to save a connection. Tokens are encrypted in storage; keep `APP_SECRET` with your backup secrets, as changing it prevents existing tokens from being decrypted.

**GitHub App (recommended):** each self-hosted instance registers its own GitHub App and configures `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_SLUG`, together with `APP_ORIGIN`. Follow the [GitHub App setup guide](../docs/github-app.md) for exact callback URLs, read permissions, Docker configuration, and troubleshooting. Users click **Connect GitHub**, authorize in their browser, and select repositories on GitHub. Trestl automatically renews expiring user tokens and respects both personal and installation permissions. No central Trestl service is required. Use **Reconnect GitHub** to restore an expired or revoked authorization while retaining imports.

**Personal tokens (advanced):** **Use access token** remains available for GitHub and Gitea. GitHub's API origin is allowed by default. For Gitea, explicitly allow the exact server origin with `INTEGRATION_ALLOWED_ORIGINS`, for example `https://git.example.com`. Multiple origins are comma-separated. Internal HTTP origins can be allowed explicitly, but HTTPS is preferred for credentials in transit. Use provider credentials that can only read the repositories you intend to import.

Git connections are personal to your account in the current workspace and available in every project, including projects created later. Choose repository access and permissions at the provider when creating the token; for GitHub fine-grained tokens, grant Issues read access for the repositories you need ([GitHub issue API permissions](https://docs.github.com/en/rest/issues/issues)). Use **Update token** to replace credentials without recreating imports. Trestl reads providers and does not use write permissions even if a token grants them.

In any project's **Resources → Find Git issue**, choose a connection and enter `owner/repository#123` to preview and link an issue. Lookup uses your token on every request and does not import the repository or cache the issue. Linking shares its title and URL with project members; the provider still controls access to the original issue. Pull requests are not supported by this lookup.

Administrators can add **Repository imports** by choosing a saved connection, repository, and destination project. One connection can serve multiple repository imports. Existing repository credentials migrate automatically into their creator's personal connections, preserving imports and source identities. Deleting your saved connection stops its dependent imports; imported work and resource links are retained. You can always remove your own token, even after losing administrator access.

Sync runs when requested in Settings. Set `INTEGRATION_SYNC_INTERVAL_MS=300000` to reconcile every five minutes; the minimum periodic interval is 60000 milliseconds. A repository connection imports issues and comments, skips pull requests, and deduplicates repeated imports. After the initial import, title and description follow the source while status, priority, assignee, and dates remain local. Remote comment edits and deletions are reconciled. Imported work remains in Trestl if its source issue disappears or the connection is removed.

Imported items are **linked issues with local planning**. Lists and boards display the provider, repository, and original issue number; native Trestl items have no source badge. Use **Filter → Source** to select native items, a provider, or a specific repository, and **Save view** to keep that perspective. Search also recognizes original references such as `basis/kubernetes #14`.

Inside a linked item, the source header provides the original issue link and last synchronization time. Title and description are read-only in Trestl; use **Edit in Gitea/GitHub** to open the source issue. **Repository state** follows the provider on sync, while **Planning status** remains local. A closed source issue with unfinished local work shows a review notice. Imported comments identify their original author and provider; the local composer is explicitly **Add internal note**. Existing imports gain this metadata automatically, and disconnected items retain their origin and last known state. Recurring successors are new native tasks rather than additional mirrors of the same source issue.

Repository connections are **inbound only**. Internal notes and planning changes are never posted back to the source. There is no remote posting, two-way editing, or webhook receiver in this version.

### Confluence documentation

An administrator sets `CONFLUENCE_ALLOWED_ORIGINS` to a comma-separated list of exact HTTPS origins, for example `https://example.atlassian.net,https://docs.example.com`. The same durable `APP_SECRET` protects Confluence tokens. Each user connects their own account in **Settings → Integrations**:

- **Cloud:** site URL (optionally ending in `/wiki`), account email, and a personal API token.
- **Data Center:** application URL including any context path such as `/confluence`, and a personal access token.

Search and page previews call Confluence using that user's credentials, so the provider enforces their page permissions. Credentials are not shared between workspace members, and page content is not stored as a shared cache. Search returns up to 25 results; previews show up to 3,000 characters of plain text and a link to the original page. Refine the search to narrow larger result sets. These connections support reading and linking pages; Confluence editing, OAuth/SSO connections, and paginated search are not implemented. See Atlassian's [Cloud search API](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search/) and [Data Center access tokens](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html).
