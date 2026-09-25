# Live canvas collaboration

Open the same canvas in two signed-in Trestl sessions to draw together. The
**Share** button copies its URL; the link does not grant access. Both people
must already have access to the project, including any private ancestor.

The editor shows who is present, their cursors and selections. Shape changes,
text, images, canvas names, background color, and grid size synchronize.
Each person's zoom, pan, selection, and light/dark appearance remain local.
Undo/redo uses the local editor's history; receiving an edit does not add the
other person's action to that history.

**Saved** means the server has committed the changes to the existing database.
While disconnected, the editor shows **Reconnecting…** and keeps unsaved edits
in the open tab. It retries automatically and merges pending edits into the
latest saved scene. Keep the tab open until it shows Saved, or use **Download
my copy** to preserve work before leaving. Unsaved edits do not survive closing
the tab or a browser crash. Existing `.excalidraw`, PNG, SVG, copy, and import
workflows remain available.

## Deployment

No separate service or paid Excalidraw account is required. The existing
Fastify server hosts WebSockets at
`/api/v1/projects/:projectId/canvases/:canvasId/live`.

- Keep one Trestl app instance, as required by the existing deployment model.
  Rooms and presence are in memory; the database stores committed canvases.
  Multiple live replicas need a shared room/presence backplane before scaling.
- The reverse proxy must forward WebSocket upgrades on `/api/`, preserve the
  original Host/Origin information, and allow long-lived connections. HTTPS
  deployments use `wss:` automatically. Configure `APP_ORIGIN` as usual.
- The Vite development proxy forwards upgrades too. No additional port is used.
- Heartbeats run every 15 seconds. Connections refresh every five minutes to
  renew upstream authentication, and reconnect after server restarts.

## Synchronization and access

Clients send only changed elements, with at most one unacknowledged edit batch
per connection. The server merges edits in a database transaction and then
broadcasts the committed scene. Excalidraw element versions order changes;
the smaller version nonce deterministically breaks ties. Simultaneous changes
to separate shapes are retained. Competing changes to the same shape resolve
to one complete element, rather than merging individual text characters or
properties. Canvas title/background/grid changes follow server arrival order.

Deleted elements remain as versioned tombstones to prevent stale clients from
restoring them. Unused image bytes are removed; an undo that restores an image
also supplies its bytes. The existing 8 MB scene and 20,000 element limits
include retained tombstones. Rooms allow up to 40 open editors, with bounded
message queues and payloads. Large scenes are more expensive because outgoing
scene updates contain complete snapshots.

Upgrade requests use the normal authentication and origin checks, including
read-only token restrictions. Live connections recheck credentials, account
status, workspace membership, and project access before accepting changes or
broadcasting content. An idle scan also removes revoked users and picks up
ordinary REST changes/deletions within about one second. Revoked access stops
syncing and leaves a download option for any local unsaved work.

Run `node --import tsx --test tests/canvas-collaboration.test.ts` for merge,
client recovery, two-user socket, persistence, and access regression coverage.
The full checks remain `pnpm typecheck`, `pnpm test`, `pnpm build`, and
`pnpm format:check`.
