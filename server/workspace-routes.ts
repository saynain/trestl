import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { makeStore, type Store } from './db.ts';
import type { User, Workspace } from '../shared/types.ts';
import {
  addMembership,
  membership,
  userWorkspaces,
  workspaceOf,
  workspaceUser,
} from './workspaces.ts';

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const { store, db, requireUser } = ctx;
  const fail: AppContext['fail'] = ctx.fail;
  const mutate = <T>(fn: (s: Store) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      return fn(makeStore(tx));
    });
  const browser = (request: FastifyRequest) => {
    const u = requireUser(request);
    if (request.tokenScope) fail(403, 'Manage workspaces from a signed-in browser');
    return u;
  };
  const admin = async (s: Store, u: User) => {
    const current = await workspaceUser(s, u.id, workspaceOf(u));
    const w = await s.get<Workspace>('workspaces', workspaceOf(u));
    if (!current || current.role !== 'admin' || !w)
      fail(403, 'Workspace administrator access is required');
    if (w.kind === 'personal')
      fail(400, 'Personal workspaces are private. Create a shared workspace to collaborate.');
    return w;
  };
  app.get('/api/v1/workspaces', async (request) => ({
    data: (await userWorkspaces(store, requireUser(request).id)).filter(
      (w) => w.id === workspaceOf(requireUser(request)),
    ),
  }));
  app.post('/api/v1/workspaces', async () =>
    fail(410, 'This server has one installation. Rename it in Administration.'),
  );
  app.patch('/api/v1/workspaces/current', async (request) => {
    const u = browser(request);
    const { name } = z
      .object({ name: z.string().trim().min(1).max(80) })
      .strict()
      .parse(request.body);
    return mutate(async (s) => s.put('workspaces', { ...(await admin(s, u)), name }));
  });
  app.patch<{ Params: { userId: string } }>(
    '/api/v1/workspaces/current/members/:userId',
    async (request) => {
      const u = browser(request);
      const { role } = z
        .object({ role: z.enum(['admin', 'member']) })
        .strict()
        .parse(request.body);
      return mutate(async (s) => {
        const w = await admin(s, u);
        if (request.params.userId === w.ownerId)
          fail(400, 'The workspace owner must remain an administrator');
        if (!(await membership(s, w.id, request.params.userId))) fail(404, 'Member not found');
        return addMembership(s, w.id, request.params.userId, role);
      });
    },
  );
}
