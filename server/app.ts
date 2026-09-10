import { createsDependencyCycle, scheduleConflicts } from '../shared/dependencies.ts';
import { registerCanvases } from './canvases.ts';
import { roadmapUpdate } from './roadmap.ts';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { openDatabase, makeStore, type Store, type Database } from './db.ts';
import { sameWorkspace, workspaceOf } from './workspaces.ts';
import { nextItemIdentifier } from './item-identifiers.ts';
import { seedDemo } from './seed.ts';
import { openapi } from './openapi.ts';
import { registerIntegrations } from './integrations.ts';
import { registerConfluence } from './confluence.ts';
import type { AppContext } from './context.ts';
import type {
  User,
  ProjectCanvas,
  CanvasCollection,
  Project,
  WorkItem,
  Activity,
  ResourceLink,
  SavedView,
  Milestone,
  Relation,
} from '../shared/types.ts';

const id = randomUUID;
const now = () => new Date().toISOString();
function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode, expose: true });
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const passwordHash = (password: string) => {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
};
const passwordMatches = (password: string, stored: string) => {
  const [salt, key] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date')
  .nullable();
const reference = z.string().uuid().nullable();
const visibility = z.enum(['workspace', 'private']);
const projectAllowsUser = (project: Project, user: User) =>
  project.visibility !== 'private' ||
  project.ownerId === user.id ||
  !!project.memberIds?.includes(user.id);
const title = z.string().trim().min(1).max(240);
const description = z.string().max(100000);
const safeUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTP or HTTPS link without embedded credentials');
const projectInput = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/)
      .transform((v) => v.toUpperCase()),
    name: title,
    description: description.optional(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    icon: z.string().max(40).optional(),
    parentId: reference.optional(),
    lifecycle: z.enum(['ongoing', 'fixed']).optional(),
    status: z.enum(['active', 'planned', 'completed', 'archived']).optional(),
    startDate: date.optional(),
    dueDate: date.optional(),
    visibility: visibility.optional(),
    memberIds: z
      .array(z.string().uuid())
      .max(1000)
      .transform((ids) => [...new Set(ids)])
      .optional(),
  })
  .strict();
const itemInput = z
  .object({
    title,
    description: description.optional(),
    projectId: reference.optional(),
    parentId: reference.optional(),
    type: z.enum(['task', 'bug', 'idea', 'followup']).optional(),
    status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']).optional(),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
    assigneeId: reference.optional(),
    startDate: date.optional(),
    dueDate: date.optional(),
    followUpDate: date.optional(),
    recurrence: z.enum(['daily', 'weekly', 'monthly']).nullable().optional(),
    labels: z
      .array(z.string().trim().min(1).max(40))
      .max(30)
      .transform((values) =>
        values.filter(
          (value, index) =>
            values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index,
        ),
      )
      .optional(),
    visibility: visibility.optional(),
    position: z.number().finite().optional(),
    externalUrl: safeUrl.nullable().optional(),
  })
  .strict();
const userInput = z
  .object({
    name: title,
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(10).max(200),
  })
  .strict();
const viewInput = z
  .object({
    name: title,
    icon: z.string().max(40).default('filter'),
    filters: z.record(z.string().max(40), z.string().max(500)),
    layout: z.enum(['list', 'board']),
  })
  .strict();
const linkInput = z
  .object({
    projectId: reference.optional(),
    itemId: reference.optional(),
    title,
    url: safeUrl,
    kind: z.enum(['confluence', 'repository', 'link']),
  })
  .strict();
const milestoneInput = z
  .object({
    projectId: z.string().uuid(),
    title,
    dueDate: date.optional(),
    completed: z.boolean().optional(),
  })
  .strict();
function nextRecurrence(
  value: string | null,
  recurrence: NonNullable<WorkItem['recurrence']>,
  anchorDay?: number,
) {
  const d = new Date(`${value ?? now().slice(0, 10)}T12:00:00Z`);
  if (recurrence === 'monthly') {
    const day = anchorDay ?? d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, end));
  } else d.setUTCDate(d.getUTCDate() + (recurrence === 'daily' ? 1 : 7));
  return d.toISOString().slice(0, 10);
}
export async function createApp(
  options: {
    databaseUrl?: string;
    dataDir?: string;
    logger?: boolean;
    integrations?: boolean;
    githubFetch?: typeof fetch;
  } = {},
) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          serializers: {
            req(request) {
              return {
                method: request.method,
                url: request.url?.split('?')[0],
                hostname: request.hostname,
                remoteAddress: request.ip,
              };
            },
          },
        }
      : false,
    bodyLimit: 1024 * 1024,
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  const db = await openDatabase({
    databaseUrl: options.databaseUrl ?? process.env.DATABASE_URL,
    dataDir: options.dataDir ?? process.env.DATA_DIR,
  });
  const store = makeStore(db);
  await store.put('system', { id: 'mutation-lock' });
  app.decorateRequest('user', null);
  app.decorateRequest('tokenScope', null);
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addHook('onClose', async () => db.close());
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'validation_error',
        message: error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '),
      });
    const code = (error as { statusCode?: number }).statusCode ?? 500;
    if (code >= 500) request.log.error(error);
    return reply.code(code).send({
      error:
        code === 401
          ? 'unauthorized'
          : code === 403
            ? 'forbidden'
            : code === 404
              ? 'not_found'
              : code === 409
                ? 'conflict'
                : 'request_error',
      message:
        code >= 500 && !(error as { expose?: boolean }).expose
          ? 'An unexpected server error occurred'
          : (error as Error).message,
    });
  });
  const requireUser = (request: FastifyRequest) => request.user ?? fail(401, 'Sign in to continue');
  const canProjectIn = async (
    s: Store,
    user: User,
    projectId: string,
    visited = new Set<string>(),
  ): Promise<boolean> => {
    if (visited.has(projectId)) return false;
    visited.add(projectId);
    const project = await s.get<Project>('projects', projectId);
    if (!project || !sameWorkspace(user, project)) return false;
    if (!projectAllowsUser(project, user)) return false;
    return !project.parentId || canProjectIn(s, user, project.parentId, visited);
  };
  const canItemIn = async (
    s: Store,
    user: User,
    itemId: string,
    visited = new Set<string>(),
  ): Promise<boolean> => {
    if (visited.has(itemId)) return false;
    visited.add(itemId);
    const item = await s.get<WorkItem>('items', itemId);
    if (!item || !sameWorkspace(user, item)) return false;
    if (item.visibility === 'private' && item.creatorId !== user.id) return false;
    if (item.projectId && !(await canProjectIn(s, user, item.projectId))) return false;
    return !item.parentId || canItemIn(s, user, item.parentId, visited);
  };
  const ctx: AppContext = {
    githubFetch: options.githubFetch,
    db,
    store,
    requireUser,
    canProject: (user, p, source = store) => canProjectIn(source, user, p),
    canItem: (user, i, source = store) => canItemIn(source, user, i),
    fail,
    id,
    now,
  };
  app.decorate('context', ctx);
  const mutate = async <T>(fn: (s: Store, tx: Database) => Promise<T>): Promise<T> =>
    db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      return fn(makeStore(tx), tx);
    });
  const findItem = async (s: Store, user: User, key: string) =>
    (await s.get<WorkItem>('items', key)) ??
    (await s.list<WorkItem>('items')).find(
      (i) => sameWorkspace(user, i) && i.identifier.toLowerCase() === key.toLowerCase(),
    ) ??
    null;
  const checkedItem = async (s: Store, user: User, key: string) => {
    const item = await findItem(s, user, key);
    if (!item || !(await canItemIn(s, user, item.id))) return fail(404, 'Work item not found');
    return item;
  };
  const checkedProject = async (s: Store, user: User, key: string) => {
    const project =
      (await s.get<Project>('projects', key)) ??
      (await s.list<Project>('projects')).find(
        (p) => sameWorkspace(user, p) && p.key.toLowerCase() === key.toLowerCase(),
      );
    if (!project || !(await canProjectIn(s, user, project.id)))
      return fail(404, 'Project not found');
    return project;
  };
  const profileCookie = (userId: string) => `trestl_profile_${userId}`;
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure:
      process.env.SECURE_COOKIES === 'true' ||
      (process.env.NODE_ENV === 'production' && process.env.SECURE_COOKIES !== 'false'),
    maxAge: 30 * 86400,
  };
  const savedSession = async (secret: string | undefined) => {
    if (!secret) return undefined;
    return (
      await db.query<{ user_id: string; expires_at: Date | string }>(
        'SELECT user_id,expires_at FROM sessions WHERE hash=$1 AND expires_at>NOW()',
        [hash(secret)],
      )
    ).rows[0];
  };
  const rememberCurrent = async (request: FastifyRequest, reply: { setCookie: Function }) => {
    const secret = request.cookies.trestl_session;
    const row = await savedSession(secret);
    if (row)
      reply.setCookie(profileCookie(row.user_id), secret, {
        ...cookieOptions,
        maxAge: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
      });
  };
  const session = async (user: User, reply: { setCookie: Function }) => {
    const secret = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,$3)', [
      hash(secret),
      user.id,
      new Date(Date.now() + 30 * 86400000).toISOString(),
    ]);
    reply.setCookie('trestl_session', secret, cookieOptions);
    reply.setCookie(profileCookie(user.id), secret, cookieOptions);
  };
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/')) return;
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !bearer) {
      const origin = request.headers.origin;
      if (origin) {
        const allowed = process.env.APP_ORIGIN
          ? new URL(process.env.APP_ORIGIN).origin
          : `${request.protocol}://${request.host}`;
        if (origin !== allowed) fail(403, 'Request origin is not allowed');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site')
        fail(403, 'Cross-site requests are not allowed');
    }
    if (bearer) {
      const token = (
        await db.query<{ user_id: string; scope: string }>(
          'SELECT user_id,scope FROM tokens WHERE hash=$1',
          [hash(bearer)],
        )
      ).rows[0];
      if (token) {
        request.user = await store.get<User>('users', token.user_id);
        request.tokenScope = token.scope;
      }
    } else if (request.cookies.trestl_session) {
      const row = (
        await db.query<{ user_id: string }>(
          'SELECT user_id FROM sessions WHERE hash=$1 AND expires_at>NOW()',
          [hash(request.cookies.trestl_session)],
        )
      ).rows[0];
      if (row) request.user = await store.get<User>('users', row.user_id);
    }
    const route = request.url.split('?')[0];
    if (
      [
        '/api/v1/auth/status',
        '/api/v1/auth/setup',
        '/api/v1/auth/login',
        '/api/v1/openapi.json',
      ].includes(route)
    )
      return;
    requireUser(request);
    if (request.tokenScope === 'read' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      fail(403, 'This token is read-only');
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await db.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/api/v1/openapi.json', async () => openapi);
  app.get('/api/v1/auth/status', async (request) => ({
    needsSetup: (await store.list<User>('users')).length === 0,
    authenticated: !!request.user,
    ...(request.user ? { user: request.user } : {}),
  }));
  app.post(
    '/api/v1/auth/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = userInput.extend({ seedDemo: z.boolean().default(true) }).parse(request.body);
      const user = await mutate(async (s, tx) => {
        if ((await s.list('users')).length) fail(409, 'Workspace is already set up');
        const u: User = {
          id: id(),
          name: input.name,
          email: input.email,
          color: '#7c9b87',
          role: 'admin',
        };
        await tx.query('INSERT INTO credentials(user_id,email,password) VALUES($1,$2,$3)', [
          u.id,
          u.email,
          passwordHash(input.password),
        ]);
        await s.put('users', u);
        if (input.seedDemo) {
          await seedDemo(s, u, tx);
        }
        return u;
      });
      await session(user, reply);
      return reply.code(201).send(user);
    },
  );
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z
        .object({ email: z.string().toLowerCase(), password: z.string().max(200) })
        .parse(request.body);
      const row = (
        await db.query<{ user_id: string; password: string }>(
          'SELECT user_id,password FROM credentials WHERE email=$1',
          [input.email],
        )
      ).rows[0];
      if (!row || !passwordMatches(input.password, row.password))
        fail(401, 'Email or password is incorrect');
      const user = await store.get<User>('users', row.user_id);
      if (!user) fail(401, 'Email or password is incorrect');
      await rememberCurrent(request, reply);
      await session(user, reply);
      return user;
    },
  );
  app.post(
    '/api/v1/auth/profiles',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      requireUser(request);
      if (request.tokenScope) fail(403, 'Create profiles from a signed-in browser');
      const input = userInput.parse(request.body);
      const user = await mutate(async (s, tx) => {
        if ((await s.list<User>('users')).some((other) => other.email === input.email))
          fail(409, 'An account with this email already exists. Sign in to add it.');
        const user: User = {
          id: id(),
          workspaceId: id(),
          name: input.name,
          email: input.email,
          color: '#a394c4',
          role: 'admin',
        };
        await tx.query('INSERT INTO credentials(user_id,email,password) VALUES($1,$2,$3)', [
          user.id,
          user.email,
          passwordHash(input.password),
        ]);
        return s.put('users', user);
      });
      await rememberCurrent(request, reply);
      await session(user, reply);
      return reply.code(201).send(user);
    },
  );
  app.get('/api/v1/auth/profiles', async (request, reply) => {
    if (request.tokenScope) fail(403, 'Manage profiles from a signed-in browser');
    reply.header('Cache-Control', 'no-store');
    const users = new Map<string, User>();
    const current = requireUser(request);
    users.set(current.id, current);
    for (const [name, secret] of Object.entries(request.cookies)) {
      if (!name.startsWith('trestl_profile_')) continue;
      const row = await savedSession(secret);
      const user =
        row && name === profileCookie(row.user_id)
          ? await store.get<User>('users', row.user_id)
          : null;
      if (user) users.set(user.id, user);
      else reply.clearCookie(name, { path: '/' });
    }
    return { data: [...users.values()] };
  });
  app.post('/api/v1/auth/switch', async (request, reply) => {
    if (request.tokenScope) fail(403, 'Switch profiles from a signed-in browser');
    const { userId } = z.object({ userId: z.string().uuid() }).strict().parse(request.body);
    const secret = request.cookies[profileCookie(userId)];
    const row = await savedSession(secret);
    if (!row || row.user_id !== userId || !(await store.get<User>('users', userId)))
      fail(401, 'This account has expired. Add it again to sign in.');
    await rememberCurrent(request, reply);
    reply.setCookie('trestl_session', secret!, {
      ...cookieOptions,
      maxAge: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    });
    return { ok: true };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.cookies.trestl_session)
      await db.query('DELETE FROM sessions WHERE hash=$1', [hash(request.cookies.trestl_session)]);
    reply.clearCookie(profileCookie(requireUser(request).id), { path: '/' });
    reply.clearCookie('trestl_session', { path: '/' });
    return { ok: true };
  });
  app.patch('/api/v1/auth/account', async (request) => {
    const u = requireUser(request);
    if (request.tokenScope) fail(403, 'Update your account from a signed-in browser session');
    const input = z
      .object({
        name: title.optional(),
        email: z
          .email()
          .max(254)
          .transform((v) => v.toLowerCase())
          .optional(),
        currentPassword: z.string().max(200).optional(),
        password: z.string().min(10).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    return mutate(async (s, tx) => {
      const row = (
        await tx.query<{ password: string }>('SELECT password FROM credentials WHERE user_id=$1', [
          u.id,
        ])
      ).rows[0];
      if ((input.email && input.email !== u.email) || input.password) {
        if (!row || !input.currentPassword || !passwordMatches(input.currentPassword, row.password))
          fail(403, 'Your current password is required');
      }
      const email = input.email ?? u.email;
      if ((await s.list<User>('users')).some((other) => other.id !== u.id && other.email === email))
        fail(409, 'This email is already in use');
      const updated = { ...u, name: input.name ?? u.name, email };
      await tx.query('UPDATE credentials SET email=$1,password=$2 WHERE user_id=$3', [
        email,
        input.password ? passwordHash(input.password) : row.password,
        u.id,
      ]);
      if (input.password) {
        await tx.query('DELETE FROM sessions WHERE user_id=$1 AND hash<>$2', [
          u.id,
          hash(request.cookies.trestl_session ?? ''),
        ]);
      }
      return s.put('users', updated);
    });
  });
  const visibleData = async (user: User) => {
    // Fetch each collection once. Bootstrap may contain years of platform work;
    // walking parent chains through SQL would turn a single read into N+1 queries.
    const [allProjects, allItems, users, allViews, allLinks, allMilestones, allRelations] =
      await Promise.all([
        store.list<Project>('projects'),
        store.list<WorkItem>('items'),
        store.list<User>('users'),
        store.list<SavedView>('views'),
        store.list<ResourceLink>('links'),
        store.list<Milestone>('milestones'),
        store.list<Relation>('relations'),
      ]);
    const projectsById = new Map(allProjects.map((project) => [project.id, project]));
    const itemsById = new Map(allItems.map((item) => [item.id, item]));
    const projectAccess = new Map<string, boolean>(),
      itemAccess = new Map<string, boolean>();
    const visitingProjects = new Set<string>(),
      visitingItems = new Set<string>();
    const projectVisible = (projectId: string): boolean => {
      if (projectAccess.has(projectId)) return projectAccess.get(projectId)!;
      const project = projectsById.get(projectId);
      if (!project || visitingProjects.has(projectId)) return false;
      visitingProjects.add(projectId);
      const visible =
        sameWorkspace(user, project) &&
        projectAllowsUser(project, user) &&
        (!project.parentId || projectVisible(project.parentId));
      visitingProjects.delete(projectId);
      projectAccess.set(projectId, visible);
      return visible;
    };
    const itemVisible = (itemId: string): boolean => {
      if (itemAccess.has(itemId)) return itemAccess.get(itemId)!;
      const item = itemsById.get(itemId);
      if (!item || visitingItems.has(itemId)) return false;
      visitingItems.add(itemId);
      const visible =
        sameWorkspace(user, item) &&
        (item.visibility !== 'private' || item.creatorId === user.id) &&
        (!item.projectId || projectVisible(item.projectId)) &&
        (!item.parentId || itemVisible(item.parentId));
      visitingItems.delete(itemId);
      itemAccess.set(itemId, visible);
      return visible;
    };
    const projects = allProjects.filter((project) => projectVisible(project.id));
    const items = allItems.filter((item) => itemVisible(item.id));
    return {
      user,
      users: users.filter((member) => sameWorkspace(user, member)),
      projects,
      items,
      views: allViews.filter((view) => view.userId === user.id),
      links: allLinks.filter(
        (link) =>
          !!(link.projectId || link.itemId) &&
          (!link.projectId || projectVisible(link.projectId)) &&
          (!link.itemId || itemVisible(link.itemId)),
      ),
      relations: allRelations.filter(
        (relation) => itemVisible(relation.itemId) && itemVisible(relation.targetId),
      ),
      milestones: allMilestones.filter((milestone) => projectVisible(milestone.projectId)),
    };
  };
  app.get('/api/v1/bootstrap', async (request) => visibleData(requireUser(request)));
  app.get('/api/v1/projects', async (request) => ({
    data: (await visibleData(requireUser(request))).projects,
  }));
  // Moving a shared entity under a private parent changes access just like changing visibility.
  // Compare effective audiences against the prospective record before committing the move.
  const changesAudience = async (
    s: Store,
    collection: 'projects' | 'items',
    entity: Project | WorkItem,
  ) => {
    const prospective: Store = {
      ...s,
      get: async <T>(name: string, key: string): Promise<T | null> =>
        name === collection && key === entity.id ? (entity as T) : s.get<T>(name, key),
    };
    for (const member of await s.list<User>('users')) {
      const before =
        collection === 'projects'
          ? await canProjectIn(s, member, entity.id)
          : await canItemIn(s, member, entity.id);
      const after =
        collection === 'projects'
          ? await canProjectIn(prospective, member, entity.id)
          : await canItemIn(prospective, member, entity.id);
      if (before !== after) return true;
    }
    return false;
  };
  const validateProject = async (s: Store, u: User, p: Project) => {
    if (p.parentId) {
      await checkedProject(s, u, p.parentId);
      let parent = p.parentId;
      const seen = new Set([p.id]);
      while (parent) {
        if (seen.has(parent)) fail(400, 'Projects cannot contain a cycle');
        seen.add(parent);
        parent = (await s.get<Project>('projects', parent))?.parentId ?? '';
      }
    }
    if (p.startDate && p.dueDate && p.startDate > p.dueDate)
      fail(400, 'Due date must be on or after start date');
    if (
      (await s.list<Project>('projects')).some(
        (other) => other.id !== p.id && other.key === p.key && sameWorkspace(u, other),
      )
    )
      fail(409, 'Project key is already in use');
  };
  const validateProjectMembers = async (s: Store, p: Project) => {
    for (const memberId of p.memberIds ?? []) {
      const member = await s.get<User>('users', memberId);
      if (!member || !sameWorkspace(p, member))
        fail(400, 'Project members must belong to this workspace');
    }
    // The owner always has access and does not need an explicit membership.
    p.memberIds = (p.memberIds ?? []).filter((memberId) => memberId !== p.ownerId).sort();
  };
  app.post('/api/v1/projects', async (request, reply) => {
    const u = requireUser(request);
    const input = projectInput.parse(request.body);
    const result = await mutate(async (s) => {
      const p: Project = {
        id: id(),
        description: '',
        color: '#7c9b87',
        icon: 'folder',
        parentId: null,
        lifecycle: 'ongoing',
        status: 'active',
        startDate: null,
        dueDate: null,
        visibility: 'workspace',
        ownerId: u.id,
        workspaceId: workspaceOf(u),
        createdAt: now(),
        ...input,
      };
      await validateProject(s, u, p);
      await validateProjectMembers(s, p);
      return s.put('projects', p);
    });
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id', async (request) =>
    checkedProject(store, requireUser(request), request.params.id),
  );
  app.patch<{ Params: { id: string } }>('/api/v1/projects/:id', async (request) => {
    const u = requireUser(request),
      input = projectInput.partial().parse(request.body);
    return mutate(async (s) => {
      const old = await checkedProject(s, u, request.params.id);
      if (input.visibility && input.visibility !== old.visibility && old.ownerId !== u.id)
        fail(403, 'Only the owner can change project visibility');
      const p = { ...old, ...input };
      if (input.memberIds !== undefined) {
        const members = input.memberIds.filter((memberId) => memberId !== old.ownerId).sort();
        const oldMembers = [...(old.memberIds ?? [])].sort();
        if (old.ownerId !== u.id && JSON.stringify(members) !== JSON.stringify(oldMembers))
          fail(403, 'Only the owner can change project members');
        await validateProjectMembers(s, p);
      }
      await validateProject(s, u, p);
      if (
        old.ownerId !== u.id &&
        input.parentId !== undefined &&
        (await changesAudience(s, 'projects', p))
      )
        fail(403, 'Only the owner can move a project in a way that changes who can access it');
      return s.put('projects', p);
    });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/projects/:id/roadmap', async (request) => {
    const u = requireUser(request);
    const { expectedRevision, ...input } = roadmapUpdate.parse(request.body);
    return mutate(async (s) => {
      const project = await checkedProject(s, u, request.params.id);
      if ((project.roadmap?.revision ?? 0) !== expectedRevision)
        fail(
          409,
          'This roadmap changed while you were editing. Reload the latest version before saving.',
        );
      return s.put('projects', {
        ...project,
        roadmap: { ...input, revision: expectedRevision + 1 },
      });
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/projects/:id', async (request, reply) => {
    const u = requireUser(request);
    await mutate(async (s) => {
      const p = await checkedProject(s, u, request.params.id);
      if (p.ownerId !== u.id && u.role !== 'admin')
        fail(403, 'Only the owner or an admin can delete this project');
      if (
        (await s.list<Project>('projects')).some((x) => x.parentId === p.id) ||
        (await s.list<WorkItem>('items')).some((x) => x.projectId === p.id)
      )
        fail(409, 'Move or delete child projects and work items first');
      for (const l of await s.list<ResourceLink>('links'))
        if (l.projectId === p.id) await s.remove('links', l.id);
      for (const m of await s.list<Milestone>('milestones'))
        if (m.projectId === p.id) await s.remove('milestones', m.id);
      for (const canvas of await s.list<ProjectCanvas>('canvases'))
        if (canvas.projectId === p.id) await s.remove('canvases', canvas.id);
      for (const collection of await s.list<CanvasCollection>('canvasCollections'))
        if (collection.projectId === p.id) await s.remove('canvasCollections', collection.id);
      await s.remove('projects', p.id);
    });
    return reply.code(204).send();
  });
  const validateItem = async (s: Store, u: User, item: WorkItem) => {
    if (item.startDate && item.dueDate && item.startDate > item.dueDate)
      fail(400, 'Start date must be on or before the due date');
    if (item.projectId) await checkedProject(s, u, item.projectId);
    if (item.assigneeId) {
      const assignee = await s.get<User>('users', item.assigneeId);
      if (!assignee || !sameWorkspace(u, assignee))
        fail(400, 'Assignee does not exist in this workspace');
    }
    if (item.parentId) {
      await checkedItem(s, u, item.parentId);
      let parent = item.parentId;
      const seen = new Set([item.id]);
      while (parent) {
        if (seen.has(parent)) fail(400, 'Work items cannot contain a cycle');
        seen.add(parent);
        parent = (await s.get<WorkItem>('items', parent))?.parentId ?? '';
      }
    }
  };
  app.get('/api/v1/items', async (request) => {
    const query = z
      .object({
        q: z.string().max(1000).optional(),
        projectId: z.string().optional(),
        status: z
          .enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'])
          .optional(),
        priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
        type: z.enum(['task', 'bug', 'idea', 'followup']).optional(),
        assigneeId: z.string().optional(),
        parentId: z.string().optional(),
        visibility: visibility.optional(),
        cursor: z
          .string()
          .regex(/^\d+$/)
          .refine((v) => Number.isSafeInteger(Number(v)))
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .strict()
      .parse(request.query);
    if (query.projectId && query.projectId !== 'null')
      query.projectId = (await checkedProject(store, requireUser(request), query.projectId)).id;
    let items = (await visibleData(requireUser(request))).items;
    for (const key of [
      'projectId',
      'status',
      'priority',
      'assigneeId',
      'type',
      'parentId',
      'visibility',
    ] as const) {
      if (query[key])
        items = items.filter((i) =>
          query[key] === 'null' ? i[key] === null : i[key] === query[key],
        );
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      items = items.filter((i) =>
        `${i.title} ${i.description} ${i.identifier}`.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const offset = Number(query.cursor ?? '0');
    const limit = query.limit ?? 100;
    return {
      data: items.slice(offset, offset + limit),
      ...(items.length > offset + limit ? { nextCursor: String(offset + limit) } : {}),
    };
  });
  type RetryRecord = {
    id: string;
    fingerprint: string;
    itemId: string;
    result: WorkItem | Activity;
  };
  const retryContext = (
    request: FastifyRequest,
    user: User,
    operation: string,
    input: Record<string, unknown>,
  ) => {
    const raw = request.headers['idempotency-key'];
    if (raw === undefined) return undefined;
    const key = z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,128}$/)
      .parse(raw);
    return {
      id: hash(JSON.stringify([workspaceOf(user), user.id, operation, key])),
      fingerprint: hash(
        JSON.stringify(
          Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
        ),
      ),
    };
  };
  const replay = async (s: Store, user: User, retry: ReturnType<typeof retryContext>) => {
    if (!retry) return undefined;
    const record = await s.get<RetryRecord>('idempotency', retry.id);
    if (!record) return undefined;
    if (record.fingerprint !== retry.fingerprint)
      fail(
        409,
        'Idempotency key was already used with different input. Use a new key for a new operation.',
      );
    await checkedItem(s, user, record.itemId);
    return record.result;
  };
  app.post('/api/v1/items', async (request, reply) => {
    const u = requireUser(request),
      input = itemInput.parse(request.body);
    const retry = retryContext(request, u, 'create-item', input);
    const result = await mutate(async (s, tx) => {
      const previous = await replay(s, u, retry);
      if (previous) return previous;
      const stamp = now();
      const item: WorkItem = {
        id: id(),
        identifier: await nextItemIdentifier(tx, input.projectId ?? null, workspaceOf(u)),
        description: '',
        projectId: null,
        parentId: null,
        type: 'task',
        status: 'todo',
        priority: 'none',
        assigneeId: null,
        startDate: null,
        dueDate: null,
        followUpDate: null,
        recurrence: null,
        labels: [],
        visibility: 'workspace',
        creatorId: u.id,
        workspaceId: workspaceOf(u),
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: input.status === 'done' ? stamp : null,
        position: Date.now(),
        ...input,
      };
      await validateItem(s, u, item);
      const result = await s.put('items', item);
      if (retry) await s.put('idempotency', { ...retry, itemId: item.id, result });
      return result;
    });
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/v1/items/:id', async (request) => {
    const u = requireUser(request),
      item = await checkedItem(store, u, request.params.id);
    const relations = [];
    for (const r of await store.list<Relation>('relations'))
      if (
        (r.itemId === item.id || r.targetId === item.id) &&
        (await ctx.canItem(u, r.itemId)) &&
        (await ctx.canItem(u, r.targetId))
      )
        relations.push(r);
    return {
      item,
      activity: (await store.list<Activity>('activity'))
        .filter((a) => a.itemId === item.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      relations,
      links: (await visibleData(u)).links.filter((l) => l.itemId === item.id),
    };
  });
  app.patch<{ Params: { id: string } }>('/api/v1/items/:id', async (request) => {
    const u = requireUser(request),
      { expectedRevision, ...input } = itemInput
        .partial()
        .extend({ expectedRevision: z.number().int().min(0).max(2147483646).optional() })
        .parse(request.body);
    return mutate(async (s, tx) => {
      const old = await checkedItem(s, u, request.params.id);
      if (expectedRevision !== undefined && expectedRevision !== (old.revision ?? 0))
        fail(409, 'Work item changed. Read it again before updating.');
      if (
        old.source &&
        ['title', 'description', 'externalUrl'].some(
          (key) => key in input && input[key as keyof typeof input] !== old[key as keyof WorkItem],
        )
      )
        fail(
          409,
          'This linked issue owns its title, description, and original URL in the source repository. Edit it in GitHub or Gitea; planning fields and internal notes remain editable here.',
        );
      if (input.visibility && input.visibility !== old.visibility && old.creatorId !== u.id)
        fail(403, 'Only the creator can change item visibility');
      const item: WorkItem = { ...old, ...input, updatedAt: now() };
      item.completedAt = item.status === 'done' ? (old.completedAt ?? now()) : null;
      await validateItem(s, u, item);
      if (item.startDate !== old.startDate || item.dueDate !== old.dueDate) {
        const conflicts = scheduleConflicts(
          item,
          await s.list<WorkItem>('items'),
          await s.list<Relation>('relations'),
        );
        if (conflicts.length) {
          const { blocker, dependent } = conflicts[0];
          const visible =
            (await ctx.canItem(u, blocker.id, s)) && (await ctx.canItem(u, dependent.id, s));
          fail(
            409,
            visible
              ? `${dependent.identifier} must start after ${blocker.identifier} finishes on ${blocker.dueDate}. Adjust the linked schedule first.`
              : 'This schedule conflicts with a dependency you cannot access. Ask the project owner to review the linked schedule.',
          );
        }
      }
      if (
        old.creatorId !== u.id &&
        (input.projectId !== undefined || input.parentId !== undefined) &&
        (await changesAudience(s, 'items', item))
      )
        fail(403, 'Only the creator can move an item in a way that changes who can access it');
      if (item.projectId !== old.projectId)
        item.identifier = await nextItemIdentifier(tx, item.projectId, workspaceOf(item));
      const saved = await s.put('items', item, expectedRevision);
      const changes = Object.entries(input)
        .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(old[k as keyof WorkItem]))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : (v ?? 'cleared')}`);
      if (changes.length)
        await s.put('activity', {
          id: id(),
          itemId: item.id,
          userId: u.id,
          kind: 'event',
          body: changes.join(' · '),
          createdAt: now(),
        });
      if (item.status === 'done' && old.status !== 'done' && item.recurrence) {
        const recurrenceKey = item.id;
        const legacy = (await s.list<{ id: string }>('recurrences')).some((record) =>
          record.id.startsWith(`${item.id}:`),
        );
        if (!(await s.get('recurrences', recurrenceKey)) && !legacy) {
          const storedAnchor = await s.get<{
            id: string;
            startDay?: number;
            dueDay: number;
            followUpDay: number;
          }>('recurrenceAnchors', item.id);
          const day = (value: string | null) => Number((value ?? now().slice(0, 10)).slice(8, 10));
          const startDay =
            input.startDate !== undefined
              ? day(item.startDate || null)
              : (storedAnchor?.startDay ?? day(item.startDate || null));
          const dueDay =
            input.dueDate !== undefined
              ? day(item.dueDate)
              : (storedAnchor?.dueDay ?? day(item.dueDate));
          const followUpDay =
            input.followUpDate !== undefined
              ? day(item.followUpDate)
              : (storedAnchor?.followUpDay ?? day(item.followUpDate));
          const { source: _source, externalUrl: _externalUrl, ...nativeItem } = item;
          const next = {
            ...nativeItem,
            id: id(),
            identifier: await nextItemIdentifier(tx, item.projectId, workspaceOf(item)),
            status: 'todo' as const,
            completedAt: null,
            startDate: item.startDate
              ? nextRecurrence(item.startDate, item.recurrence, startDay)
              : null,
            dueDate: nextRecurrence(item.dueDate, item.recurrence, dueDay),
            followUpDate: item.followUpDate
              ? nextRecurrence(item.followUpDate, item.recurrence, followUpDay)
              : null,
            createdAt: now(),
            updatedAt: now(),
          };
          await s.put('items', next);
          await s.put('recurrenceAnchors', { id: next.id, startDay, dueDay, followUpDay });
          await s.put('recurrences', { id: recurrenceKey, itemId: next.id });
          await s.put('activity', {
            id: id(),
            itemId: item.id,
            userId: u.id,
            kind: 'event',
            body: `Created recurring follow-up ${next.identifier}`,
            createdAt: now(),
          });
        }
      } else if (
        input.startDate !== undefined ||
        input.dueDate !== undefined ||
        input.followUpDate !== undefined
      ) {
        const anchor = await s.get<{
          id: string;
          startDay?: number;
          dueDay: number;
          followUpDay: number;
        }>('recurrenceAnchors', item.id);
        if (anchor)
          await s.put('recurrenceAnchors', {
            ...anchor,
            ...(input.startDate !== undefined
              ? { startDay: Number((item.startDate ?? now().slice(0, 10)).slice(8, 10)) }
              : {}),
            ...(input.dueDate !== undefined
              ? { dueDay: Number((item.dueDate ?? now().slice(0, 10)).slice(8, 10)) }
              : {}),
            ...(input.followUpDate !== undefined
              ? { followUpDay: Number((item.followUpDate ?? now().slice(0, 10)).slice(8, 10)) }
              : {}),
          });
      }
      return saved;
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/items/:id', async (request, reply) => {
    await mutate(async (s) => {
      const item = await checkedItem(s, requireUser(request), request.params.id);
      if ((await s.list<WorkItem>('items')).some((x) => x.parentId === item.id))
        fail(409, 'Move or delete subtasks first');
      for (const a of await s.list<Activity>('activity'))
        if (a.itemId === item.id) await s.remove('activity', a.id);
      for (const l of await s.list<ResourceLink>('links'))
        if (l.itemId === item.id) await s.remove('links', l.id);
      for (const r of await s.list<Relation>('relations'))
        if (r.itemId === item.id || r.targetId === item.id) await s.remove('relations', r.id);
      await s.remove('items', item.id);
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/v1/items/:id/comments', async (request, reply) => {
    const u = requireUser(request),
      input = z
        .object({ body: z.string().trim().min(1).max(50000) })
        .strict()
        .parse(request.body);
    const result = await mutate(async (s) => {
      const item = await checkedItem(s, u, request.params.id);
      const retry = retryContext(request, u, `comment:${item.id}`, input);
      const previous = await replay(s, u, retry);
      if (previous) return previous;
      const result = await s.put('activity', {
        id: id(),
        itemId: item.id,
        userId: u.id,
        kind: 'comment',
        body: input.body,
        createdAt: now(),
      });
      if (retry) await s.put('idempotency', { ...retry, itemId: item.id, result });
      return result;
    });
    return reply.code(201).send(result);
  });
  app.get('/api/v1/views', async (request) => ({
    data: (await visibleData(requireUser(request))).views,
  }));
  app.post('/api/v1/views', async (request, reply) =>
    reply.code(201).send(
      await store.put('views', {
        ...viewInput.parse(request.body),
        id: id(),
        userId: requireUser(request).id,
      }),
    ),
  );
  app.patch<{ Params: { id: string } }>('/api/v1/views/:id', async (request) => {
    const input = viewInput.partial().parse(request.body);
    return mutate(async (s) => {
      const v = await s.get<SavedView>('views', request.params.id);
      if (!v || v.userId !== requireUser(request).id) fail(404, 'View not found');
      return s.put('views', { ...v, ...input });
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/views/:id', async (request, reply) => {
    await mutate(async (s) => {
      const v = await s.get<SavedView>('views', request.params.id);
      if (!v || v.userId !== requireUser(request).id) fail(404, 'View not found');
      await s.remove('views', v.id);
    });
    return reply.code(204).send();
  });
  const checkLink = async (s: Store, u: User, l: Pick<ResourceLink, 'projectId' | 'itemId'>) => {
    if (!l.projectId && !l.itemId) fail(400, 'A link must belong to a project or work item');
    if (l.projectId) await checkedProject(s, u, l.projectId);
    if (l.itemId) await checkedItem(s, u, l.itemId);
  };
  app.get('/api/v1/links', async (request) => ({
    data: (await visibleData(requireUser(request))).links,
  }));
  app.post('/api/v1/links', async (request, reply) => {
    const input = linkInput.parse(request.body);
    const result = await mutate(async (s) => {
      const l = { projectId: null, itemId: null, ...input, id: id() };
      await checkLink(s, requireUser(request), l);
      return s.put('links', l);
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/links/:id', async (request) => {
    const input = linkInput.partial().parse(request.body);
    return mutate(async (s) => {
      const l = await s.get<ResourceLink>('links', request.params.id);
      if (!l) fail(404, 'Link not found');
      await checkLink(s, requireUser(request), l);
      const next = { ...l, ...input };
      await checkLink(s, requireUser(request), next);
      return s.put('links', next);
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/links/:id', async (request, reply) => {
    await mutate(async (s) => {
      const l = await s.get<ResourceLink>('links', request.params.id);
      if (!l) fail(404, 'Link not found');
      await checkLink(s, requireUser(request), l);
      await s.remove('links', l.id);
    });
    return reply.code(204).send();
  });
  app.get('/api/v1/milestones', async (request) => ({
    data: (await visibleData(requireUser(request))).milestones,
  }));
  app.post('/api/v1/milestones', async (request, reply) => {
    const input = milestoneInput.parse(request.body);
    const result = await mutate(async (s) => {
      await checkedProject(s, requireUser(request), input.projectId);
      return s.put('milestones', {
        id: id(),
        revision: 1,
        dueDate: null,
        completed: false,
        ...input,
      });
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/milestones/:id', async (request) => {
    const { expectedRevision, ...input } = milestoneInput
      .partial()
      .extend({ expectedRevision: z.number().int().min(0).max(2147483646).optional() })
      .parse(request.body);
    return mutate(async (s) => {
      const m = await s.get<Milestone>('milestones', request.params.id);
      if (!m) fail(404, 'Milestone not found');
      await checkedProject(s, requireUser(request), m.projectId);
      if (expectedRevision !== undefined && expectedRevision !== (m.revision ?? 0))
        fail(409, 'Milestone changed. Read it again before updating.');
      const next = { ...m, ...input, revision: (m.revision ?? 0) + 1 };
      await checkedProject(s, requireUser(request), next.projectId);
      return s.put('milestones', next);
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/milestones/:id', async (request, reply) => {
    await mutate(async (s) => {
      const m = await s.get<Milestone>('milestones', request.params.id);
      if (!m) fail(404, 'Milestone not found');
      await checkedProject(s, requireUser(request), m.projectId);
      await s.remove('milestones', m.id);
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/v1/items/:id/relations', async (request, reply) => {
    const input = z
      .object({ targetId: z.string().uuid(), kind: z.enum(['blocks', 'related']) })
      .strict()
      .parse(request.body);
    const result = await mutate(async (s) => {
      const u = requireUser(request),
        item = await checkedItem(s, u, request.params.id);
      await checkedItem(s, u, input.targetId);
      if (item.id === input.targetId) fail(400, 'Cannot relate an item to itself');
      const relations = await s.list<Relation>('relations');
      const existing = relations.find(
        (r) => r.itemId === item.id && r.targetId === input.targetId && r.kind === input.kind,
      );
      if (existing) return existing;
      if (input.kind === 'blocks' && createsDependencyCycle(relations, item.id, input.targetId))
        fail(
          409,
          'This dependency would create a cycle. Remove a blocking link in the chain first.',
        );
      return s.put('relations', { id: id(), itemId: item.id, ...input });
    });
    return reply.code(201).send(result);
  });
  app.delete<{ Params: { id: string; relationId: string } }>(
    '/api/v1/items/:id/relations/:relationId',
    async (request, reply) => {
      await mutate(async (s) => {
        const item = await checkedItem(s, requireUser(request), request.params.id);
        const r = await s.get<Relation>('relations', request.params.relationId);
        if (!r || (r.itemId !== item.id && r.targetId !== item.id)) fail(404, 'Relation not found');
        await checkedItem(s, requireUser(request), r.itemId);
        await checkedItem(s, requireUser(request), r.targetId);
        await s.remove('relations', r.id);
      });
      return reply.code(204).send();
    },
  );
  const admin = (request: FastifyRequest) => {
    const u = requireUser(request);
    if (u.role !== 'admin' || (request.tokenScope && request.tokenScope !== 'admin'))
      fail(403, 'Administrator access is required');
    return u;
  };
  app.get('/api/v1/users', async (request) => {
    const user = requireUser(request);
    return {
      data: (await store.list<User>('users')).filter((member) => sameWorkspace(user, member)),
    };
  });
  app.post('/api/v1/users', async (request, reply) => {
    const current = admin(request);
    const input = userInput
      .extend({ role: z.enum(['admin', 'member']).default('member') })
      .parse(request.body);
    const u = await mutate(async (s, tx) => {
      if ((await s.list<User>('users')).some((u) => u.email === input.email))
        fail(409, 'A user with this email already exists');
      const user: User = {
        id: id(),
        name: input.name,
        email: input.email,
        role: input.role,
        workspaceId: workspaceOf(current),
        color: '#a394c4',
      };
      await tx.query('INSERT INTO credentials(user_id,email,password) VALUES($1,$2,$3)', [
        user.id,
        user.email,
        passwordHash(input.password),
      ]);
      return s.put('users', user);
    });
    return reply.code(201).send(u);
  });
  app.get('/api/v1/tokens', async (request) => ({
    data: (
      await db.query(
        'SELECT id,name,scope,created_at AS "createdAt" FROM tokens WHERE user_id=$1',
        [requireUser(request).id],
      )
    ).rows,
  }));
  app.post('/api/v1/tokens', async (request, reply) => {
    const u = requireUser(request);
    if (request.tokenScope) fail(403, 'Create tokens from a signed-in browser session');
    const input = z
      .object({ name: title, scope: z.enum(['read', 'write', 'admin']).default('write') })
      .strict()
      .parse(request.body);
    if (input.scope === 'admin') admin(request);
    const token = `ep_${randomBytes(32).toString('base64url')}`,
      tokenId = id(),
      createdAt = now();
    await db.query(
      'INSERT INTO tokens(id,hash,user_id,name,scope,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [tokenId, hash(token), u.id, input.name, input.scope, createdAt],
    );
    return reply
      .code(201)
      .send({ id: tokenId, token, name: input.name, scope: input.scope, createdAt });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/tokens/:id', async (request, reply) => {
    await db.query('DELETE FROM tokens WHERE id=$1 AND user_id=$2', [
      request.params.id,
      requireUser(request).id,
    ]);
    return reply.code(204).send();
  });
  app.get('/api/v1/export', async (request, reply) => {
    const data = await visibleData(requireUser(request)),
      ids = new Set(data.items.map((i) => i.id));
    reply.header('Content-Disposition', 'attachment; filename="trestl-export.json"');
    return {
      version: 1,
      exportedAt: now(),
      ...data,
      canvases: (await store.list<ProjectCanvas>('canvases')).filter(
        (canvas) =>
          data.projects.some((project) => project.id === canvas.projectId) &&
          sameWorkspace(data.user, canvas),
      ),
      canvasCollections: (await store.list<CanvasCollection>('canvasCollections')).filter(
        (collection) =>
          data.projects.some((project) => project.id === collection.projectId) &&
          sameWorkspace(data.user, collection),
      ),
      activity: (await store.list<Activity>('activity')).filter((a) => ids.has(a.itemId)),
      relations: (await store.list<Relation>('relations')).filter(
        (r) => ids.has(r.itemId) && ids.has(r.targetId),
      ),
    };
  });
  registerCanvases(app, ctx, mutate);
  if (options.integrations !== false) {
    await registerIntegrations(app, ctx);
    await registerConfluence(app, ctx);
  }
  return app;
}
