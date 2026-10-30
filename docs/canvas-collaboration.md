# Live canvas collaboration

[Back to the project](../README.md) · [User guide](user-guide.md#project-canvases)

Trestl uses the embedded Excalidraw editor with its own collaboration layer.
Two or more people can draw on the same project canvas through the existing
Trestl server. No separate collaboration service or paid Excalidraw account
is required.

## Start a shared session

1. Sign in to the same Trestl installation and give your colleague access to
   the project, including any private ancestor project.
2. Open **Project → Canvases** and create or open a canvas.
3. Click **Share** and send the copied URL to your colleague. The link does
   not grant access; they must sign in with an account that can open the project.
4. Keep the same canvas open in both sessions. The header shows **Live** when
   connected, then the number of editors and their initials when someone joins.

Remote colleagues need a shared, reachable installation URL. A `localhost` URL
refers to each person's own computer, and the desktop app's private local
installation is not exposed to remote collaborators. The public website demo
keeps edits in the current browser frame and does not connect visitors together.

The editor shows who is present, their cursors and selections. Shape changes,
text, images, canvas names, background color, and grid size synchronize.
Each person's zoom, pan, selection, and light/dark appearance remain local.
Undo/redo uses the local editor's history; receiving an edit does not add the
other person's action to that history.

## Saves and connection recovery

**Saved** means the server has committed the changes to the existing database.
While disconnected, the editor shows **Reconnecting…** and keeps unsaved edits
in the open tab. It retries automatically and merges pending edits into the
latest saved scene. Keep the tab open until it shows Saved, or use **Download
my copy** to preserve work before leaving. Unsaved edits do not survive closing
the tab or a browser crash. Existing `.excalidraw`, PNG, SVG, copy, and import
workflows remain available.

## How an edit reaches your colleague

1. The browser opens an authenticated WebSocket at
   `/api/v1/projects/:projectId/canvases/:canvasId/live`. The server checks
   access and sends the latest saved canvas and the people currently present.
2. A drawing change appears immediately in the local editor. The client sends
   changed elements in batches throttled to 80 ms, with at most one batch
   awaiting acknowledgement. Actual update frequency also depends on network
   latency and database commit time.
3. The server serializes updates for that canvas, merges the changed elements
   with the latest database version inside a transaction, and saves the result
   with a new revision when its content changes.
4. After the transaction commits, the server broadcasts the complete saved
   canvas to the connected editors and acknowledges the sender's batch.
   Clients combine that snapshot with their own newer pending edits.
5. Cursors and selections use separate presence messages throttled to 50 ms.
   Presence stays in server memory and is not written to the database.

If a connection drops before acknowledgement, the client keeps both that batch
and any newer edits. It reconnects with increasing delays of one to ten seconds,
loads the latest saved scene, and resends the pending changes. Version checks
make replaying an already committed element safe. The pending journal is kept
in memory only; it is not an offline disk backup.

## Deployment

The existing Fastify server hosts the WebSocket endpoint alongside the API.

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

Excalidraw element versions order changes: the higher version wins, with the
smaller version nonce breaking ties deterministically. Simultaneous changes
to separate shapes are retained. For example, moving box A while your colleague
edits box B preserves both changes. Competing changes to the same shape resolve
to one complete element, rather than merging individual text characters or
properties. If you both type in the same text element, one version wins. Canvas
title/background/grid changes follow server arrival order.

Deleted elements remain as versioned tombstones to prevent stale clients from
restoring them. Unused image bytes are removed; an undo that restores an image
also supplies its bytes. The existing 8 MB scene and 20,000 element limits
include retained tombstones. Rooms allow up to 40 open editors, with bounded
message queues and payloads. Large scenes are more expensive because outgoing
scene updates contain complete snapshots.

Upgrade requests use the normal authentication and origin checks, including
read-only token restrictions. Live connections recheck credentials, account
status, installation membership, and project access before accepting changes or
broadcasting content. An idle scan also removes revoked users and picks up
ordinary REST changes/deletions within about one second. Revoked access stops
syncing and leaves a download option for any local unsaved work.

## Implementation and testing

- `src/components/CanvasEditor.tsx` connects Excalidraw to the collaboration
  controller and renders connection status, cursors, and recovery controls.
- `src/lib/canvas-collaboration.ts` manages pending edits, acknowledgements,
  presence, and reconnects.
- `shared/canvas-collaboration.ts` defines the protocol and element merge rules.
- `server/canvas-collaboration.ts` handles authenticated rooms, database saves,
  broadcasts, and access revalidation.
- `website/demo/canvas-collaboration.ts` keeps the public demo local to its frame.

Run `node --import tsx --test tests/canvas-collaboration.test.ts` for merge,
client recovery, two-user socket, persistence, and access regression coverage.
The full checks remain `pnpm typecheck`, `pnpm test`, `pnpm build`, and
`pnpm format:check`.
