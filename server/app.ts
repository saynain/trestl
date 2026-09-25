import {
  initializeCliLogin,
  registerCliDeviceEndpoints,
  registerCliApproval,
} from './cli-login.ts';
import { compareProjectUpdates } from '../shared/project-updates.ts';
import { addMentionRelations } from './mentions.ts';
import { authSettings, configuredProxy, registerAuthSettings } from './auth-settings.ts';
import { registerServerVersion } from './version.ts';
import { createInstallation, installation, migrateInstallation } from './installation.ts';
import {
  authenticateProxy,
  proxyAuthConfig,
  validateProxyAuth,
  type ProxyAuthConfig,
} from './proxy-auth.ts';
import { createsDependencyCycle, scheduleConflicts } from '../shared/dependencies.ts';
import { registerProjectTransfer } from './project-transfer.ts';
import { registerCanvases } from './canvases.ts';
import { roadmapUpdate } from './roadmap.ts';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { registerDesktopGateway } from './desktop-gateway.ts';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { openDatabase, makeStore, type Store, type Database } from './db.ts';
import {
  sameWorkspace,
  workspaceOf,
  migrateWorkspaces,
  workspaceUser,
  workspaceMembers,
  userWorkspaces,
  addMembership,
} from './workspaces.ts';
import { registerWorkspaceRoutes } from './workspace-routes.ts';
import { nextItemIdentifier } from './item-identifiers.ts';
import { seedDemo } from './seed.ts';
import { openapi } from './openapi.ts';
import { registerIntegrations } from './integrations.ts';
import { registerConfluence } from './confluence.ts';
import type { AppContext } from './context.ts';
import type {
  User,
  Workspace,
  ProjectCanvas,
  CanvasCollection,
  Project,
  ProjectUpdate,
  WorkItem,
  Activity,
  ResourceLink,
  SavedView,
  Milestone,
  Relation,
  ProjectRelation,
  MentionNotification,
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
    milestoneId: reference.optional(),
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
    proxyAuth?: ProxyAuthConfig | null;
    desktopToken?: string;
  } = {},
) {
  const environmentProxy =
    options.proxyAuth === undefined
      ? proxyAuthConfig()
      : options.proxyAuth && validateProxyAuth(options.proxyAuth);
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-trestl-proxy-secret"]',
            'res.headers["set-cookie"]',
          ],
          serializers: {
            req(request) {
              return {
                method: request.method,
                url: request.url
                  ?.split('?')[0]
                  .replace(/\/invitations\/[^/]+/, '/invitations/[redacted]'),
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
  await initializeCliLogin(db);
  const store = makeStore(db);
  await store.put('system', { id: 'mutation-lock' });
  await migrateWorkspaces(db);
  await migrateInstallation(db);
  await db.query(
    "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'local'",
  );
  app.decorateRequest('user', null);
  app.decorateRequest('authMode', 'local');
  app.decorateRequest('sessionMethod', null);
  app.decorateRequest('tokenScope', null);
  await app.register(cookie);
  if (options.desktopToken) registerDesktopGateway(app, options.desktopToken);
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
  const saveMentions = (
    s: Store,
    u: User,
    item: WorkItem,
    body: string,
    previous = '',
    activityId: string | null = null,
  ) =>
    addMentionRelations(
      s,
      u,
      item,
      body,
      previous,
      {
        item: (targetId) => checkedItem(s, u, targetId),
        project: (projectId) => checkedProject(s, u, projectId),
        recipientCanRead: (recipient) => canItemIn(s, recipient, item.id),
      },
      activityId,
    );
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
  const session = async (user: User, reply: { setCookie: Function }, method = 'local') => {
    const workspaceId = workspaceOf(user);
    await db.query(
      "UPDATE entities SET data=data || jsonb_build_object('lastWorkspaceId',$1::text) WHERE collection='users' AND id=$2",
      [workspaceId, user.id],
    );
    const secret = randomBytes(32).toString('base64url');
    await db.query(
      'INSERT INTO sessions(hash,user_id,expires_at,workspace_id,auth_method) VALUES($1,$2,$3,$4,$5)',
      [
        hash(secret),
        user.id,
        new Date(Date.now() + 30 * 86400000).toISOString(),
        workspaceId,
        method,
      ],
    );
    reply.setCookie('trestl_session', secret, cookieOptions);
  };
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const route = request.url.split('?')[0];
    const site = await installation(store);
    const configured = await authSettings(store);
    const proxyAuth = site
      ? configured
        ? configured.mode === 'proxy'
          ? await configuredProxy(store, configured)
          : null
        : environmentProxy
          ? { ...environmentProxy, installationId: site.workspaceId }
          : null
      : null;
    request.authMode = configured?.mode ?? (proxyAuth ? 'proxy' : 'local');
    const authorization = request.headers.authorization;
    const bearer = authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (authorization && !bearer) fail(401, 'A valid Bearer token is required');
    if (proxyAuth && request.headers['x-trestl-api-only'] === 'true' && !bearer)
      fail(401, 'This API route requires a personal API token');
    if (
      proxyAuth &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !bearer &&
      request.headers.origin !== proxyAuth.origin
    )
      fail(403, 'Request origin is not allowed');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !bearer) {
      const origin = request.headers.origin;
      if (origin) {
        const allowed =
          proxyAuth?.origin ??
          configured?.origin ??
          (process.env.APP_ORIGIN
            ? new URL(process.env.APP_ORIGIN).origin
            : `${request.protocol}://${request.host}`);
        if (origin !== allowed) fail(403, 'Request origin is not allowed');
      }
      if (request.headers['sec-fetch-site'] === 'cross-site')
        fail(403, 'Cross-site requests are not allowed');
    }
    if (bearer) {
      const token = (
        await db.query<{ user_id: string; scope: string; workspace_id: string }>(
          'SELECT user_id,scope,workspace_id FROM tokens WHERE hash=$1',
          [hash(bearer)],
        )
      ).rows[0];
      if (token && site && token.workspace_id === site.workspaceId) {
        request.user = await workspaceUser(store, token.user_id, token.workspace_id);
        request.tokenScope = token.scope;
      }
      if (!request.user) fail(401, 'Invalid API token');
    } else if (proxyAuth) {
      const recovery =
        request.cookies.trestl_session &&
        (
          await db.query<{ user_id: string; auth_method: string }>(
            'SELECT user_id,auth_method FROM sessions WHERE hash=$1 AND expires_at>NOW()',
            [hash(request.cookies.trestl_session)],
          )
        ).rows[0];
      if (recovery && recovery.auth_method === 'local' && recovery.user_id === site?.ownerId) {
        request.user = await workspaceUser(store, recovery.user_id, site.workspaceId);
        request.sessionMethod = 'local';
      } else {
        request.user = await authenticateProxy(request, db, proxyAuth);
        request.sessionMethod = 'proxy';
      }
      if (request.user) {
        const saved = await savedSession(request.cookies.trestl_session);
        const context =
          saved &&
          (
            await db.query<{ workspace_id: string }>(
              'SELECT workspace_id FROM sessions WHERE hash=$1',
              [hash(request.cookies.trestl_session!)],
            )
          ).rows[0];
        if (
          !saved ||
          saved.user_id !== request.user.id ||
          context?.workspace_id !== proxyAuth.installationId
        )
          await session(request.user, reply, request.sessionMethod ?? 'proxy');
      }
    } else if (request.cookies.trestl_session) {
      const row = (
        await db.query<{ user_id: string; workspace_id: string; auth_method: string }>(
          'SELECT user_id,workspace_id,auth_method FROM sessions WHERE hash=$1 AND expires_at>NOW()',
          [hash(request.cookies.trestl_session)],
        )
      ).rows[0];
      if (row) {
        request.sessionMethod = row.auth_method;
        if (
          site &&
          row.workspace_id === site.workspaceId &&
          (request.authMode === 'local'
            ? row.auth_method === 'local'
            : row.auth_method === 'oidc' ||
              (row.auth_method === 'local' && row.user_id === site.ownerId))
        )
          request.user = await workspaceUser(store, row.user_id, row.workspace_id);
      }
    }
    if (request.user?.disabledAt) fail(403, 'Your Trestl account is disabled');
    if (
      request.authMode !== 'local' &&
      request.method === 'PATCH' &&
      route === '/api/v1/auth/account' &&
      request.sessionMethod !== 'local'
    )
      fail(403, 'Your identity is managed by the sign-in provider.');
    if (
      [
        '/api/v1/auth/provider/start',
        '/api/v1/auth/provider/callback',
        '/api/v1/auth/status',
        '/api/v1/auth/setup',
        '/api/v1/auth/login',
        '/api/v1/auth/register',
        '/api/v1/openapi.json',
      ].includes(route) ||
      (request.method === 'GET' && /^\/api\/v1\/invitations\/[^/]+$/.test(route))
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
    needsSetup: !(await installation(store)),
    authMode: request.authMode,
    installationName: (
      await store.get<Workspace>('workspaces', (await installation(store))?.workspaceId ?? '')
    )?.name,
    localLogin: request.authMode === 'local',
    authenticated: !!request.user,
    ...(request.user ? { user: request.user } : {}),
  }));
  app.post(
    '/api/v1/auth/setup',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = userInput
        .extend({
          installationName: z.string().trim().min(1).max(80).default('Trestl'),
          seedDemo: z.boolean().default(false),
        })
        .parse(request.body);
      const user = await mutate(async (s, tx) => {
        if ((await s.list('users')).length) fail(409, 'Installation is already set up');
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
        const home = await createInstallation(s, u, input.installationName);
        u.workspaceId = home.id;
        u.lastWorkspaceId = home.id;
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
      const account = await store.get<User>('users', row.user_id);
      const site = await installation(store);
      const user = account && site && (await workspaceUser(store, account.id, site.workspaceId));
      if (!user || user.disabledAt) fail(401, 'Email or password is incorrect');
      if (request.authMode !== 'local' && user.id !== site?.ownerId)
        fail(403, 'Use your organization’s sign-in provider.');
      await session(user, reply);
      return user;
    },
  );
  app.post('/api/v1/auth/register', async () =>
    fail(403, 'Ask an administrator to create your account.'),
  );
  app.get('/api/v1/auth/profiles', async (request) => ({ data: [requireUser(request)] }));
  app.post('/api/v1/auth/profiles', async () =>
    fail(410, 'Account profiles are managed by the client, not this installation.'),
  );
  app.post('/api/v1/auth/switch', async () => fail(410, 'This server has one installation.'));
  registerWorkspaceRoutes(app, ctx);
  registerAuthSettings(app, ctx, session);
  registerServerVersion(app, ctx);
  registerCliApproval(app, ctx);
  registerCliDeviceEndpoints(
    app,
    db,
    () => process.env.APP_ORIGIN || `http://localhost:${process.env.PORT ?? 4317}`,
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    if (request.cookies.trestl_session)
      await db.query('DELETE FROM sessions WHERE hash=$1', [hash(request.cookies.trestl_session)]);
    reply.clearCookie(profileCookie(requireUser(request).id), { path: '/' });
    reply.clearCookie('trestl_session', { path: '/' });
    return {
      ok: true,
      ...(request.authMode === 'proxy' ? { redirectUrl: '/oauth2/sign_out' } : {}),
    };
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
      const updated = { ...(await s.get<User>('users', u.id))!, name: input.name ?? u.name, email };
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
      await s.put('users', updated);
      return { ...updated, workspaceId: u.workspaceId, role: u.role };
    });
  });
  const visibleData = async (user: User) => {
    // Fetch each collection once. Bootstrap may contain years of platform work;
    // walking parent chains through SQL would turn a single read into N+1 queries.
    const [
      allProjects,
      allItems,
      users,
      allViews,
      allLinks,
      allMilestones,
      allRelations,
      allUpdates,
      allProjectRelations,
      allNotifications,
    ] = await Promise.all([
      store.list<Project>('projects'),
      store.list<WorkItem>('items'),
      workspaceMembers(store, workspaceOf(user)),
      store.list<SavedView>('views'),
      store.list<ResourceLink>('links'),
      store.list<Milestone>('milestones'),
      store.list<Relation>('relations'),
      store.list<ProjectUpdate>('projectUpdates'),
      store.list<ProjectRelation>('projectRelations'),
      store.list<MentionNotification>('notifications'),
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
    const milestoneItems = new Map<string, WorkItem[]>();
    for (const item of items) {
      if (!item.milestoneId) continue;
      const linked = milestoneItems.get(item.milestoneId) ?? [];
      linked.push(item);
      milestoneItems.set(item.milestoneId, linked);
    }
    return {
      user,
      authMode:
        (await authSettings(store))?.mode ??
        (environmentProxy ? ('proxy' as const) : ('local' as const)),
      installation: true,
      workspace: await store.get<Workspace>('workspaces', workspaceOf(user)),
      workspaces: (await userWorkspaces(store, user.id)).filter((w) => w.id === workspaceOf(user)),
      users: users.filter((member) => sameWorkspace(user, member)),
      projects,
      projectUpdates: allUpdates.filter((update) => projectVisible(update.projectId)),
      items,
      views: allViews.filter((view) => view.userId === user.id && sameWorkspace(user, view)),
      links: allLinks.filter(
        (link) =>
          !!(link.projectId || link.itemId) &&
          (!link.projectId || projectVisible(link.projectId)) &&
          (!link.itemId || itemVisible(link.itemId)),
      ),
      relations: allRelations.filter(
        (relation) => itemVisible(relation.itemId) && itemVisible(relation.targetId),
      ),
      projectRelations: allProjectRelations.filter(
        (r) => itemVisible(r.itemId) && projectVisible(r.projectId),
      ),
      notifications: allNotifications
        .filter((n) => n.recipientId === user.id && sameWorkspace(n, user) && itemVisible(n.itemId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
      milestones: allMilestones
        .filter((milestone) => projectVisible(milestone.projectId))
        .map((milestone) => {
          const linked = (milestoneItems.get(milestone.id) ?? []).filter(
            (item) => item.projectId === milestone.projectId,
          );
          return {
            ...milestone,
            itemIds: linked.map((item) => item.id),
            progress: {
              total: linked.length,
              done: linked.filter((item) => item.status === 'done').length,
            },
          };
        }),
    };
  };
  app.get('/api/v1/bootstrap', async (request) => visibleData(requireUser(request)));
  app.get('/api/v1/notifications', async (request) => ({
    data: (await visibleData(requireUser(request))).notifications,
  }));
  app.patch<{ Params: { id: string } }>('/api/v1/notifications/:id', async (request) => {
    const input = z.object({ read: z.boolean() }).strict().parse(request.body);
    const u = requireUser(request);
    return mutate(async (s) => {
      const notification = await s.get<MentionNotification>('notifications', request.params.id);
      if (
        !notification ||
        notification.recipientId !== u.id ||
        !sameWorkspace(notification, u) ||
        !(await canItemIn(s, u, notification.itemId))
      )
        fail(404, 'Notification not found');
      return s.put('notifications', {
        ...notification,
        readAt: input.read ? (notification.readAt ?? now()) : null,
      });
    });
  });
  app.post('/api/v1/notifications/read-all', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    const u = requireUser(request);
    await mutate(async (s) => {
      const stamp = now();
      for (const notification of await s.list<MentionNotification>('notifications')) {
        if (
          notification.recipientId === u.id &&
          sameWorkspace(notification, u) &&
          !notification.readAt &&
          (await canItemIn(s, u, notification.itemId))
        )
          await s.put('notifications', { ...notification, readAt: stamp });
      }
    });
    return reply.code(204).send();
  });
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
    for (const member of await workspaceMembers(s, workspaceOf(entity))) {
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
      const member = await workspaceUser(s, memberId, workspaceOf(p));
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
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/updates', async (request) => {
    const project = await checkedProject(store, requireUser(request), request.params.id);
    const updates = (await store.list<ProjectUpdate>('projectUpdates'))
      .filter((update) => update.projectId === project.id)
      .sort(compareProjectUpdates);
    return { data: updates };
  });
  app.post<{ Params: { id: string } }>('/api/v1/projects/:id/updates', async (request, reply) => {
    const user = requireUser(request);
    const input = z
      .object({
        health: z.enum(['on_track', 'at_risk', 'off_track']),
        body: z.string().trim().min(1).max(20000),
      })
      .parse(request.body);
    const update = await mutate(async (s) => {
      const project = await checkedProject(s, user, request.params.id);
      return s.put<ProjectUpdate>('projectUpdates', {
        id: id(),
        projectId: project.id,
        authorId: user.id,
        health: input.health,
        body: input.body,
        createdAt: now(),
      });
    });
    return reply.code(201).send(update);
  });
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
      for (const update of await s.list<ProjectUpdate>('projectUpdates'))
        if (update.projectId === p.id) await s.remove('projectUpdates', update.id);
      for (const r of await s.list<ProjectRelation>('projectRelations'))
        if (r.projectId === p.id) await s.remove('projectRelations', r.id);
      await s.remove('projects', p.id);
    });
    return reply.code(204).send();
  });
  const validateItem = async (s: Store, u: User, item: WorkItem, previous?: WorkItem) => {
    if (item.startDate && item.dueDate && item.startDate > item.dueDate)
      fail(400, 'Start date must be on or before the due date');
    if (item.projectId) await checkedProject(s, u, item.projectId);
    if (item.milestoneId) {
      const milestone = await s.get<Milestone>('milestones', item.milestoneId);
      if (!milestone || milestone.projectId !== item.projectId)
        fail(400, 'Choose a milestone in this work item’s project');
    }
    if (item.assigneeId) {
      const assignee = await workspaceUser(s, item.assigneeId, workspaceOf(u));
      if (!assignee || !sameWorkspace(u, assignee))
        fail(400, 'Assignee does not exist in this workspace');
      if (assignee.disabledAt && item.assigneeId !== previous?.assigneeId)
        fail(400, 'This account is disabled. Choose an active assignee.');
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
        milestoneId: z.string().optional(),
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
      'milestoneId',
      'visibility',
    ] as const) {
      if (query[key])
        items = items.filter((i) =>
          query[key] === 'null' ? i[key] == null : i[key] === query[key],
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
        milestoneId: null,
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
      await saveMentions(s, u, item, item.description);
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
    const visible = await visibleData(u);
    return {
      item,
      activity: (await store.list<Activity>('activity'))
        .filter((a) => a.itemId === item.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      relations,
      projectRelations: visible.projectRelations.filter((r) => r.itemId === item.id),
      links: visible.links.filter((l) => l.itemId === item.id),
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
      if (item.projectId !== old.projectId && input.milestoneId === undefined)
        item.milestoneId = null;
      item.completedAt = item.status === 'done' ? (old.completedAt ?? now()) : null;
      await validateItem(s, u, item, old);
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
      if (input.description !== undefined)
        await saveMentions(s, u, item, item.description, old.description);
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
            // Keep historical ownership, but do not assign new recurring work to disabled accounts.
            assigneeId:
              item.assigneeId &&
              !(await workspaceUser(s, item.assigneeId, workspaceOf(u)))?.disabledAt
                ? item.assigneeId
                : null,
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
      return { item: saved };
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/items/:id', async (request, reply) => {
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().min(0).max(2147483646).optional() })
      .parse(request.body ?? {});
    await mutate(async (s) => {
      const item = await checkedItem(s, requireUser(request), request.params.id);
      if (expectedRevision !== undefined && expectedRevision !== (item.revision ?? 0))
        fail(409, 'Work item changed. Read it again before deleting.');
      if ((await s.list<WorkItem>('items')).some((x) => x.parentId === item.id))
        fail(409, 'Move or delete subtasks first');
      for (const a of await s.list<Activity>('activity'))
        if (a.itemId === item.id) await s.remove('activity', a.id);
      for (const l of await s.list<ResourceLink>('links'))
        if (l.itemId === item.id) await s.remove('links', l.id);
      for (const r of await s.list<Relation>('relations'))
        if (r.itemId === item.id || r.targetId === item.id) await s.remove('relations', r.id);
      for (const r of await s.list<ProjectRelation>('projectRelations'))
        if (r.itemId === item.id) await s.remove('projectRelations', r.id);
      for (const n of await s.list<MentionNotification>('notifications'))
        if (n.itemId === item.id) await s.remove('notifications', n.id);
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
      await saveMentions(s, u, item, input.body, '', result.id);
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
        workspaceId: workspaceOf(requireUser(request)),
      }),
    ),
  );
  app.patch<{ Params: { id: string } }>('/api/v1/views/:id', async (request) => {
    const input = viewInput.partial().parse(request.body);
    return mutate(async (s) => {
      const v = await s.get<SavedView>('views', request.params.id);
      if (!v || v.userId !== requireUser(request).id || !sameWorkspace(v, requireUser(request)))
        fail(404, 'View not found');
      return s.put('views', { ...v, ...input });
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/views/:id', async (request, reply) => {
    await mutate(async (s) => {
      const v = await s.get<SavedView>('views', request.params.id);
      if (!v || v.userId !== requireUser(request).id || !sameWorkspace(v, requireUser(request)))
        fail(404, 'View not found');
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
  app.get<{ Params: { id: string } }>('/api/v1/milestones/:id', async (request) => {
    const milestone = (await visibleData(requireUser(request))).milestones.find(
      (m) => m.id === request.params.id,
    );
    if (!milestone) fail(404, 'Milestone not found');
    return milestone;
  });
  app.post('/api/v1/milestones', async (request, reply) => {
    const input = milestoneInput.parse(request.body);
    const user = requireUser(request);
    const retry = retryContext(request, user, 'create-milestone', input);
    const result = await mutate(async (s) => {
      await checkedProject(s, user, input.projectId);
      if (retry) {
        const previous = await s.get<{ id: string; fingerprint: string; result: Milestone }>(
          'idempotency',
          retry.id,
        );
        if (previous) {
          if (previous.fingerprint !== retry.fingerprint)
            fail(
              409,
              'Idempotency key was already used with different input. Use a new key for a new operation.',
            );
          const current = await s.get<Milestone>('milestones', previous.result.id);
          if (!current) fail(404, 'Milestone not found');
          await checkedProject(s, user, current.projectId);
          return previous.result;
        }
      }
      const result = await s.put('milestones', {
        id: id(),
        revision: 1,
        dueDate: null,
        completed: false,
        ...input,
      });
      if (retry) await s.put('idempotency', { ...retry, result });
      return result;
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
      if (
        next.projectId !== m.projectId &&
        (await s.list<WorkItem>('items')).some((item) => item.milestoneId === m.id)
      )
        fail(409, 'Unlink work items before moving this milestone to another project');
      return s.put('milestones', next);
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/milestones/:id', async (request, reply) => {
    await mutate(async (s) => {
      const m = await s.get<Milestone>('milestones', request.params.id);
      if (!m) fail(404, 'Milestone not found');
      await checkedProject(s, requireUser(request), m.projectId);
      for (const item of await s.list<WorkItem>('items'))
        if (item.milestoneId === m.id)
          await s.put('items', { ...item, milestoneId: null, updatedAt: now() });
      await s.remove('milestones', m.id);
    });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>('/api/v1/items/:id/relations', async (request) => {
    const u = requireUser(request),
      item = await checkedItem(store, u, request.params.id);
    const data = [];
    for (const relation of await store.list<Relation>('relations')) {
      if (relation.itemId !== item.id && relation.targetId !== item.id) continue;
      const outgoing = relation.itemId === item.id;
      const relatedId = outgoing ? relation.targetId : relation.itemId;
      if (!(await ctx.canItem(u, relatedId))) continue;
      const relatedItem = await store.get<WorkItem>('items', relatedId);
      if (!relatedItem) continue;
      data.push({
        ...relation,
        direction: outgoing ? 'outgoing' : 'incoming',
        relatedItem: {
          id: relatedItem.id,
          identifier: relatedItem.identifier,
          title: relatedItem.title,
        },
      });
    }
    return { data };
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
  app.delete<{ Params: { id: string; relationId: string } }>(
    '/api/v1/items/:id/project-relations/:relationId',
    async (request, reply) => {
      await mutate(async (s) => {
        const u = requireUser(request);
        const item = await checkedItem(s, u, request.params.id);
        const relation = await s.get<ProjectRelation>(
          'projectRelations',
          request.params.relationId,
        );
        if (!relation || relation.itemId !== item.id) fail(404, 'Relationship not found');
        await checkedProject(s, u, relation.projectId);
        await s.remove('projectRelations', relation.id);
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
      data: await workspaceMembers(store, workspaceOf(user)),
    };
  });
  app.post('/api/v1/users', async (request, reply) => {
    const current = admin(request);
    const workspace = await store.get<Workspace>('workspaces', workspaceOf(current));
    if (workspace?.kind === 'personal')
      fail(400, 'Personal workspaces are private. Create a shared workspace to add members.');
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

      user.lastWorkspaceId = workspaceOf(current);
      await addMembership(s, workspaceOf(current), user.id, input.role);
      return s.put('users', user);
    });
    return reply.code(201).send(u);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/users/:id/access', async (request) => {
    const actor = requireUser(request);
    if (request.tokenScope || actor.role !== 'admin')
      fail(403, 'Installation administrator access is required');
    const { disabled } = z.object({ disabled: z.boolean() }).strict().parse(request.body);
    return mutate(async (s, tx) => {
      const target = await workspaceUser(s, request.params.id, workspaceOf(actor));
      const installation = await s.get<Workspace>('workspaces', workspaceOf(actor));
      if (!target) fail(404, 'Account not found');
      if (disabled && (target.id === actor.id || target.id === installation?.ownerId))
        fail(400, 'You cannot disable yourself or the installation owner');
      const account = (await s.get<User>('users', target.id))!;
      if (disabled) account.disabledAt = now();
      else delete account.disabledAt;
      await s.put('users', account);
      if (disabled) {
        await tx.query('DELETE FROM tokens WHERE user_id=$1', [target.id]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [target.id]);
      }
      return { ok: true };
    });
  });
  app.get('/api/v1/tokens', async (request) => ({
    data: (
      await db.query(
        'SELECT id,name,scope,workspace_id AS "workspaceId",created_at AS "createdAt" FROM tokens WHERE user_id=$1',
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
      'INSERT INTO tokens(id,hash,user_id,name,scope,created_at,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [tokenId, hash(token), u.id, input.name, input.scope, createdAt, workspaceOf(u)],
    );
    return reply.code(201).send({
      id: tokenId,
      token,
      name: input.name,
      scope: input.scope,
      workspaceId: workspaceOf(u),
      createdAt,
    });
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
  registerProjectTransfer(app, ctx, mutate);
  registerCanvases(app, ctx, mutate);
  if (options.integrations !== false) {
    await registerIntegrations(app, ctx);
    await registerConfluence(app, ctx);
  }
  return app;
}
