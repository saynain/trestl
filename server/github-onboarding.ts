import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { makeStore } from './db.ts';
import { workspaceOf } from './workspaces.ts';
import { encryptToken, decryptToken } from './integration-provider.ts';
import { appJwt, githubApi } from './github-api.ts';
import { publicGitConnection, type GitConnection } from './git-connections.ts';
import { installationCredential } from './github-installation.ts';

const root = '/api/v1/admin/github-apps';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => process.env.APP_SECRET ?? '';
export interface ManagedGitHubApp {
  id: string;
  workspaceId: string;
  userId: string;
  appId: string;
  slug: string;
  name: string;
  owner: string;
  ownerType?: 'personal' | 'organization';
  origin: string;
  mode: 'webhook' | 'polling';
  issueWrite?: boolean;
  encryptedPrivateKey: string;
  encryptedWebhookSecret: string;
  createdAt: string;
  lastWebhookAt: string | null;
}
interface SetupState {
  id: string;
  userId: string;
  workspaceId: string;
  sessionHash: string;
  expiresAt: number;
  appId: string;
  owner: string;
  ownerType: 'personal' | 'organization';
  origin: string;
  mode: ManagedGitHubApp['mode'];
  issueWrite: boolean;
}
function originOf(request: FastifyRequest) {
  const url = new URL(process.env.APP_ORIGIN || `${request.protocol}://${request.host}`);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error(
      'Set APP_ORIGIN to the HTTPS address of this Trestl installation (HTTP is supported on localhost).',
    );
  return url.origin;
}
export function managedAppKey(app: ManagedGitHubApp) {
  return decryptToken(app.encryptedPrivateKey, secret(), `${app.id}:key`);
}
function sanitize(app: ManagedGitHubApp) {
  const { encryptedPrivateKey: _key, encryptedWebhookSecret: _hook, ...data } = app;
  return {
    ...data,
    settingsUrl:
      app.ownerType === 'organization'
        ? `https://github.com/organizations/${app.owner}/settings/apps/${app.slug}`
        : `https://github.com/settings/apps/${app.slug}`,
    installUrl: `https://github.com/apps/${app.slug}/installations/new`,
  };
}
export function registerGitHubOnboarding(app: FastifyInstance, ctx: AppContext) {
  function admin(request: FastifyRequest) {
    const user = ctx.requireUser(request);
    if (user.role !== 'admin' || request.tokenScope || !request.cookies.trestl_session)
      ctx.fail(403, 'Administrator browser access is required.');
    return user;
  }
  async function own(request: FastifyRequest, id: string) {
    const user = admin(request);
    const saved = await ctx.store.get<ManagedGitHubApp>('githubManagedApps', id);
    if (!saved || saved.workspaceId !== workspaceOf(user)) ctx.fail(404, 'GitHub App not found.');
    return saved;
  }
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith(root))
      reply.header('Cache-Control', 'private, no-store').header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.get(root, async (request) => {
    const user = admin(request);
    let origin = '';
    let problem: string | null = null;
    try {
      origin = originOf(request);
    } catch (error) {
      problem = (error as Error).message;
    }
    if (secret().length < 32)
      problem = 'Set a durable APP_SECRET of at least 32 characters before connecting GitHub.';
    return {
      origin,
      problem,
      apps: (await ctx.store.list<ManagedGitHubApp>('githubManagedApps'))
        .filter((a) => a.workspaceId === workspaceOf(user))
        .map(sanitize),
    };
  });
  app.post(`${root}/start`, async (request) => {
    const user = admin(request);
    if (secret().length < 32) ctx.fail(400, 'Set a durable APP_SECRET before connecting GitHub.');
    let origin: string;
    try {
      origin = originOf(request);
    } catch (error) {
      ctx.fail(400, (error as Error).message);
    }
    const input = z
      .object({
        name: z.string().trim().min(1).max(34),
        owner: z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/),
        ownerType: z.enum(['personal', 'organization']),
        mode: z.enum(['webhook', 'polling']),
        multipleOwners: z.boolean().default(false),
        issueWrite: z.boolean().default(false),
      })
      .strict()
      .parse(request.body);
    const id = ctx.id();
    const state = randomBytes(32).toString('base64url');
    await ctx.db.transaction(async (db) => {
      await db.query(
        "DELETE FROM entities WHERE collection='githubSetupStates' AND (data->>'sessionHash'=$1 OR (data->>'expiresAt')::bigint<$2)",
        [hash(request.cookies.trestl_session!), Date.parse(ctx.now())],
      );
      await makeStore(db).put<SetupState>('githubSetupStates', {
        id: hash(state),
        userId: user.id,
        workspaceId: workspaceOf(user),
        sessionHash: hash(request.cookies.trestl_session!),
        expiresAt: Date.parse(ctx.now()) + 3600_000,
        appId: id,
        owner: input.owner,
        ownerType: input.ownerType,
        origin,
        mode: input.mode,
        issueWrite: input.issueWrite,
      });
    });
    return {
      action:
        input.ownerType === 'organization'
          ? `https://github.com/organizations/${input.owner}/settings/apps/new?state=${state}`
          : `https://github.com/settings/apps/new?state=${state}`,
      manifest: {
        name: input.name,
        url: origin,
        description:
          'Connect repositories, pull requests, and issues to your self-hosted Trestl workspace.',
        redirect_url: `${origin}${root}/callback`,
        setup_url: `${origin}/#/settings?tab=integrations&github=installed`,
        setup_on_update: true,
        public: input.multipleOwners,
        hook_attributes: { url: `${origin}/hooks/github/${id}`, active: input.mode === 'webhook' },
        default_permissions: {
          metadata: 'read',
          issues: input.issueWrite ? 'write' : 'read',
          pull_requests: 'read',
          contents: 'read',
          checks: 'read',
        },
        default_events: [
          'pull_request',
          'pull_request_review',
          'push',
          'create',
          'delete',
          'issues',
          'issue_comment',
          'check_run',
          'check_suite',
        ],
      },
    };
  });
  app.get(`${root}/callback`, async (request, reply) => {
    const user = admin(request);
    const query = z
      .object({
        state: z.string().min(30).max(200),
        code: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .max(200),
      })
      .parse(request.query);
    // A single atomic claim prevents another session, stale state, or concurrent replay from consuming the code.
    const result = await ctx.db.query<{ data: SetupState }>(
      "DELETE FROM entities WHERE collection='githubSetupStates' AND id=$1 AND data->>'userId'=$2 AND data->>'sessionHash'=$3 AND data->>'workspaceId'=$4 AND (data->>'expiresAt')::bigint>$5 RETURNING data",
      [
        hash(query.state),
        user.id,
        hash(request.cookies.trestl_session!),
        workspaceOf(user),
        Date.parse(ctx.now()),
      ],
    );
    const pending = result.rows[0]?.data;
    if (!pending)
      ctx.fail(
        400,
        'This setup link expired or was already used. Start GitHub setup again in Administration.',
      );
    const config = z
      .object({
        id: z.number().int().positive(),
        slug: z.string().regex(/^[\w-]+$/),
        name: z.string(),
        pem: z.string().min(100).max(20000),
        webhook_secret: z.string().min(1).max(4096),
        owner: z.object({ login: z.string() }),
      })
      .parse(await githubApi(ctx, `/app-manifests/${query.code}/conversions`, undefined, 'POST'));
    createPrivateKey(config.pem);
    if (config.owner.login.toLowerCase() !== pending.owner.toLowerCase())
      ctx.fail(
        400,
        'The app was created under a different GitHub account. Connect it using the existing-app option.',
      );
    const saved: ManagedGitHubApp = {
      id: pending.appId,
      appId: String(config.id),
      slug: config.slug,
      name: config.name,
      owner: config.owner.login,
      workspaceId: pending.workspaceId,
      userId: user.id,
      origin: pending.origin,
      mode: pending.mode,
      ownerType: pending.ownerType,
      issueWrite: pending.issueWrite,
      encryptedPrivateKey: encryptToken(config.pem, secret(), `${pending.appId}:key`),
      encryptedWebhookSecret: encryptToken(
        config.webhook_secret,
        secret(),
        `${pending.appId}:webhook`,
      ),
      createdAt: ctx.now(),
      lastWebhookAt: null,
    };
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      const session = await db.query(
        'SELECT hash FROM sessions WHERE hash=$1 AND user_id=$2 AND expires_at>NOW()',
        [pending.sessionHash, user.id],
      );
      const current = await store.get<{ role: string; disabledAt?: string }>('users', user.id);
      if (!session.rows.length || !current || current.disabledAt || current.role !== 'admin')
        ctx.fail(
          403,
          'Your administrator session ended during setup. Connect the created app using the existing-app option.',
        );
      await store.put('githubManagedApps', saved);
    });
    return reply.redirect(`${pending.origin}/#/settings?tab=integrations&github=${saved.id}`);
  });
  app.get<{ Params: { id: string } }>(`${root}/:id/installations`, async (request) => {
    const saved = await own(request, request.params.id);
    const token = appJwt(saved.appId, managedAppKey(saved));
    const all: {
      id: number;
      account: { login: string; type: string };
      suspended_at: string | null;
    }[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = await githubApi<typeof all>(
        ctx,
        `/app/installations?per_page=100&page=${page}`,
        token,
      );
      if (!Array.isArray(rows)) ctx.fail(502, 'GitHub returned invalid installations.');
      all.push(...rows);
      if (rows.length < 100)
        return all.map((i) => ({
          id: String(i.id),
          account: i.account.login,
          suspended: !!i.suspended_at,
        }));
    }
    ctx.fail(
      502,
      'Too many installations. Connect the specific installation using the existing-app option.',
    );
  });
  app.post<{ Params: { id: string } }>(`${root}/:id/connect`, async (request) => {
    const user = admin(request);
    const saved = await own(request, request.params.id);
    const { installationId } = z
      .object({ installationId: z.string().regex(/^\d+$/) })
      .strict()
      .parse(request.body);
    const remote = await githubApi<{
      id: number;
      app_id: number;
      account: { login: string; type: string };
      suspended_at: string | null;
    }>(ctx, `/app/installations/${installationId}`, appJwt(saved.appId, managedAppKey(saved)));
    if (
      String(remote.app_id) !== saved.appId ||
      String(remote.id) !== installationId ||
      remote.suspended_at
    )
      ctx.fail(400, 'This installation is unavailable for this GitHub App.');
    const id = hash(`${saved.id}:${installationId}`);
    const connection: GitConnection = {
      id,
      userId: user.id,
      workspaceId: workspaceOf(user),
      shared: true,
      provider: 'github',
      name: `${saved.name} · ${remote.account.login}`,
      baseUrl: 'https://api.github.com',
      encryptedToken: '',
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      githubInstallation: {
        appId: saved.appId,
        installationId,
        encryptedPrivateKey: encryptToken(managedAppKey(saved), secret(), id),
        managedAppId: saved.id,
        account: remote.account.login,
        development: true,
        issueWrite: !!saved.issueWrite,
        settingsUrl:
          remote.account.type === 'Organization'
            ? `https://github.com/organizations/${encodeURIComponent(remote.account.login)}/settings/installations/${installationId}`
            : `https://github.com/settings/installations/${installationId}`,
      },
    };
    await installationCredential(ctx, connection);
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      if (!(await store.get('githubManagedApps', saved.id)))
        ctx.fail(409, 'The app was disconnected during setup.');
      const previous = await store.get<GitConnection>('gitConnections', id);
      await store.put('gitConnections', {
        ...connection,
        createdAt: previous?.createdAt ?? connection.createdAt,
      });
    });
    return publicGitConnection(connection);
  });
  app.delete<{ Params: { id: string } }>(`${root}/:id`, async (request, reply) => {
    await own(request, request.params.id);
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      if (
        (await store.list<GitConnection>('gitConnections')).some(
          (c) => c.githubInstallation?.managedAppId === request.params.id,
        )
      )
        ctx.fail(409, 'Disconnect this app’s Git connections before removing its credentials.');
      await store.remove('githubManagedApps', request.params.id);
    });
    return reply.code(204).send();
  });
}
