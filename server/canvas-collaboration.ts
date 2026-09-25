import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { Database, Store } from './db.ts';
import type { ProjectCanvas, User } from '../shared/types.ts';
import {
  canvasFingerprint,
  mergeCanvas,
  type CanvasPresence,
  type CanvasServerMessage,
} from '../shared/canvas-collaboration.ts';
import { canvasBodyLimit, canvasElement, canvasFile, canvasScene } from './canvases.ts';
import { sameWorkspace, workspaceOf, workspaceUser } from './workspaces.ts';
import { authSettings } from './auth-settings.ts';

const changes = z
  .object({
    elements: z
      .array(
        canvasElement.extend({
          version: z.number().int().nonnegative().max(2147483646),
          versionNonce: z.number().int().nonnegative().max(2147483647),
          isDeleted: z.boolean().optional(),
        }),
      )
      .max(20000)
      .refine((elements) => new Set(elements.map((e) => e.id)).size === elements.length),
    files: z.record(z.string().max(200), canvasFile),
    appState: z
      .object({
        viewBackgroundColor: z.string().max(100).optional(),
        gridSize: z.number().positive().nullable().optional(),
      })
      .strict(),
    title: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
const presence = z
  .object({
    pointer: z
      .object({ x: z.number(), y: z.number(), tool: z.enum(['pointer', 'laser']) })
      .strict()
      .optional(),
    button: z.enum(['up', 'down']).optional(),
    selectedElementIds: z
      .record(z.string().max(200), z.boolean())
      .refine((value) => Object.keys(value).length <= 20000)
      .optional(),
  })
  .strict();
const message = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('changes'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      changes,
    })
    .strict(),
  z.object({ type: z.literal('presence'), presence }).strict(),
]);
type Peer = {
  socket: WebSocket;
  request: FastifyRequest;
  user: User;
  presence: CanvasPresence;
  alive: boolean;
};
type Room = {
  canvasId: string;
  projectId: string;
  peers: Set<Peer>;
  revision: number;
  pending: Promise<void>;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function registerCanvasCollaboration(
  app: FastifyInstance,
  ctx: AppContext,
  mutate: <T>(fn: (store: Store, tx: Database) => Promise<T>) => Promise<T>,
) {
  const rooms = new Map<string, Room>();
  let closing = false;
  const send = (peer: Peer, value: CanvasServerMessage) => {
    if (peer.socket.readyState !== 1) return;
    if (peer.socket.bufferedAmount > canvasBodyLimit * 2) {
      peer.socket.close(1013, 'Connection is too slow. Reconnect to sync.');
      return;
    }
    peer.socket.send(JSON.stringify(value));
  };
  const close = (peer: Peer, code: number, reason: string) => {
    send(peer, { type: 'error', message: reason, fatal: true });
    peer.socket.close(code, reason);
  };
  async function checkedCanvas(
    store: Store,
    user: User,
    room: Pick<Room, 'canvasId' | 'projectId'>,
  ) {
    if (!(await ctx.canProject(user, room.projectId, store)))
      ctx.fail(404, 'Canvas is no longer available');
    const canvas = await store.get<ProjectCanvas>('canvases', room.canvasId);
    if (!canvas || canvas.projectId !== room.projectId || !sameWorkspace(user, canvas))
      ctx.fail(404, 'Canvas is no longer available');
    return canvas!;
  }
  // Recheck long-lived connections, including logout, revoked tokens, disabled
  // users, and changes to project membership. Never trust a cached room roster.
  async function authorized(peer: Peer, room: Room) {
    if (peer.socket.readyState !== 1) return false;
    const user = await workspaceUser(ctx.store, peer.user.id, workspaceOf(peer.user));
    if (!user || user.disabledAt) {
      close(peer, 4403, 'Canvas access was removed');
      return false;
    }
    const bearer = peer.request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (bearer) {
      const token = (
        await ctx.db.query<{ scope: string }>(
          'SELECT scope FROM tokens WHERE hash=$1 AND user_id=$2 AND workspace_id=$3',
          [hash(bearer), user.id, workspaceOf(user)],
        )
      ).rows[0];
      if (!token || token.scope === 'read') {
        close(peer, 4403, 'Canvas access was removed');
        return false;
      }
    } else {
      const configured = await authSettings(ctx.store);
      if (configured && configured.mode !== peer.request.authMode) {
        close(peer, 4401, 'Sign in again to collaborate');
        return false;
      }
      if (peer.request.sessionMethod !== 'proxy') {
        const session = (
          await ctx.db.query(
            'SELECT user_id FROM sessions WHERE hash=$1 AND user_id=$2 AND workspace_id=$3 AND expires_at>NOW()',
            [hash(peer.request.cookies.trestl_session ?? ''), user.id, workspaceOf(user)],
          )
        ).rows[0];
        if (!session) {
          close(peer, 4401, 'Sign in again to collaborate');
          return false;
        }
      }
    }
    try {
      await checkedCanvas(ctx.store, user, room);
    } catch {
      close(peer, 4404, 'Canvas is no longer available');
      return false;
    }
    peer.user = user;
    return true;
  }
  async function eligible(room: Room) {
    const peers: Peer[] = [];
    for (const peer of room.peers) if (await authorized(peer, room)) peers.push(peer);
    return peers;
  }
  async function broadcastPresence(room: Room) {
    const peers = await eligible(room);
    const value = { type: 'presence' as const, peers: peers.map((p) => p.presence) };
    peers.forEach((peer) => send(peer, value));
  }
  async function broadcastScene(room: Room, canvas: ProjectCanvas, sender?: Peer, ack?: number) {
    room.revision = Math.max(room.revision, canvas.revision);
    for (const peer of await eligible(room))
      send(peer, { type: 'scene', canvas, ...(peer === sender ? { ack } : {}) });
  }
  function enqueue(room: Room, job: () => Promise<void>) {
    room.pending = room.pending.then(job).catch((error) => app.log.error(error));
    return room.pending;
  }

  app.get<{ Params: { projectId: string; canvasId: string } }>(
    '/api/v1/projects/:projectId/canvases/:canvasId/live',
    {
      websocket: true,
      preValidation: async (request) => {
        const user = ctx.requireUser(request);
        if (request.tokenScope === 'read') ctx.fail(403, 'This token is read-only');
        await checkedCanvas(ctx.store, user, request.params);
        if ((rooms.get(request.params.canvasId)?.peers.size ?? 0) >= 40)
          ctx.fail(429, 'This canvas has too many open editors');
      },
    },
    (socket, request) => {
      const user = ctx.requireUser(request);
      const room = rooms.get(request.params.canvasId) ?? {
        ...request.params,
        peers: new Set<Peer>(),
        revision: 0,
        pending: Promise.resolve(),
      };
      rooms.set(room.canvasId, room);
      const peer: Peer = {
        socket,
        request,
        user,
        alive: true,
        presence: { id: ctx.id(), userId: user.id, name: user.name, color: user.color },
      };
      let outstanding = 0,
        windowStart = Date.now(),
        messages = 0;
      // Upstream identity proxies are rechecked by a fresh handshake periodically.
      const lifetime = setTimeout(
        () => socket.close(1012, 'Refreshing collaboration session'),
        5 * 60_000,
      );
      lifetime.unref();
      socket.on('error', (error) => request.log.debug(error));
      socket.on('pong', () => {
        peer.alive = true;
      });
      socket.on('message', (raw, binary) => {
        if (Date.now() - windowStart >= 1000) {
          windowStart = Date.now();
          messages = 0;
        }
        if (++messages > 80 || outstanding >= 20) {
          socket.close(1013, 'Too many updates');
          return;
        }
        let input: z.infer<typeof message>;
        try {
          if (binary) throw new Error('Text messages required');
          input = message.parse(JSON.parse(raw.toString()));
        } catch {
          send(peer, {
            type: 'error',
            message: 'Invalid canvas update. Download a copy before reloading.',
            fatal: true,
          });
          socket.close(4400, 'Invalid canvas update');
          return;
        }
        outstanding++;
        void enqueue(room, async () => {
          try {
            if (!(await authorized(peer, room))) return;
            if (input.type === 'presence') {
              peer.presence = { ...peer.presence, ...input.presence };
              await broadcastPresence(room);
              return;
            }
            const canvas = await mutate(async (store) => {
              const current = await checkedCanvas(store, peer.user, room);
              const merged = mergeCanvas(current, input.changes);
              canvasScene.parse(merged.scene);
              if (Buffer.byteLength(JSON.stringify(merged)) > canvasBodyLimit - 1024)
                ctx.fail(
                  413,
                  'This canvas exceeds the 8 MB limit. Remove large images or download a copy.',
                );
              if (
                canvasFingerprint({ title: current.title, scene: current.scene }) ===
                canvasFingerprint(merged)
              )
                return current;
              return store.put('canvases', {
                ...current,
                ...merged,
                revision: current.revision + 1,
                updatedBy: peer.user.id,
                updatedAt: ctx.now(),
              });
            });
            // An acknowledgement means the transaction has committed to storage.
            await broadcastScene(room, canvas, peer, input.id);
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 404) {
              close(peer, 4404, 'Canvas is no longer available');
              return;
            }
            if (!(error instanceof z.ZodError) && !status) request.log.error(error);
            send(peer, {
              type: 'error',
              fatal: false,
              message:
                status && status < 500
                  ? (error as Error).message
                  : 'Unable to save this canvas. Retry or download a copy.',
            });
          } finally {
            outstanding--;
          }
        });
      });
      socket.on('close', () => {
        clearTimeout(lifetime);
        room.peers.delete(peer);
        if (!room.peers.size && rooms.get(room.canvasId) === room) rooms.delete(room.canvasId);
        else if (!closing) void enqueue(room, () => broadcastPresence(room));
      });
      room.peers.add(peer);
      void enqueue(room, async () => {
        if (!(await authorized(peer, room))) return;
        const canvas = await checkedCanvas(ctx.store, user, room);
        send(peer, { type: 'scene', canvas, clientId: peer.presence.id });
        if (canvas.revision > room.revision) await broadcastScene(room, canvas);
        await broadcastPresence(room);
      });
    },
  );

  // Pick up normal REST updates/deletions and revoke access even for idle peers.
  // A bounded scan also keeps the existing HTTP API compatible with live editors.
  let refreshing = false;
  const refresh = setInterval(() => {
    if (refreshing || closing) return;
    refreshing = true;
    void Promise.all(
      [...rooms.values()].map((room) =>
        enqueue(room, async () => {
          const peers = await eligible(room);
          if (!peers.length) return;
          const canvas = await checkedCanvas(ctx.store, peers[0].user, room);
          if (canvas.revision > room.revision) await broadcastScene(room, canvas);
        }),
      ),
    ).finally(() => {
      refreshing = false;
    });
  }, 1000);
  refresh.unref();
  const heartbeat = setInterval(() => {
    for (const room of rooms.values())
      for (const peer of room.peers) {
        if (!peer.alive) peer.socket.terminate();
        else {
          peer.alive = false;
          peer.socket.ping();
        }
      }
  }, 15_000);
  heartbeat.unref();
  app.addHook('preClose', async () => {
    closing = true;
    clearInterval(refresh);
    clearInterval(heartbeat);
    for (const room of rooms.values()) for (const peer of room.peers) peer.socket.terminate();
    await Promise.all([...rooms.values()].map((room) => room.pending));
    rooms.clear();
  });
}
