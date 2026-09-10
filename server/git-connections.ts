import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { WorkItem } from '../shared/types.ts';
import { makeStore } from './db.ts';
import {
  githubAppCredential,
  invalidateGitHubCredential,
  registerGitHubApp,
} from './github-app.ts';
import {
  decryptToken,
  encryptToken,
  fetchIssue,
  validateSource,
  ProviderRequestError,
  type Provider,
} from './integration-provider.ts';

export interface GitConnection {
  id: string;
  userId: string;
  provider: Provider;
  name: string;
  baseUrl: string;
  encryptedToken: string;
  githubApp?: {
    clientId: string;
    authorizationId: string;
    accountId: number;
    login: string;
    encryptedRefreshToken: string;
    expiresAt: string;
    refreshExpiresAt: string;
    reconnectRequired?: boolean;
  };
  /** Legacy envelopes remain bound to their original identity during migration. */
  credentialId?: string;
  createdAt: string;
  updatedAt: string;
}
export function publicGitConnection(connection: GitConnection) {
  return {
    id: connection.id,
    userId: connection.userId,
    provider: connection.provider,
    name: connection.name,
    baseUrl: connection.baseUrl,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    configured: true,
    authType: connection.githubApp ? 'github-app' : 'token',
    ...(connection.githubApp
      ? {
          githubAccount: connection.githubApp.login,
          reconnectRequired: !!connection.githubApp.reconnectRequired,
        }
      : {}),
  };
}
export function gitToken(connection: GitConnection, secret: string) {
  return decryptToken(connection.encryptedToken, secret, connection.credentialId ?? connection.id);
}
export async function resolveGitCredential(ctx: AppContext, connection: GitConnection) {
  if (connection.githubApp) return githubAppCredential(ctx, connection);
  return { connection, token: gitToken(connection, secretForGit()) };
}
const secretForGit = () => process.env.APP_SECRET ?? '';
export async function ownGitConnection(ctx: AppContext, userId: string, id: string) {
  const connection = await ctx.store.get<GitConnection>('gitConnections', id);
  if (!connection || connection.userId !== userId) ctx.fail(404, 'Git connection not found.');
  return connection;
}

/** Move credentials, without decrypting them or changing imported issue identities. */
export async function migrateGitConnections(ctx: AppContext) {
  await ctx.db.transaction(async (db) => {
    const store = makeStore(db);
    await db.query(
      "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
    );
    const imports = await store.list<{
      id: string;
      creatorId: string;
      provider: Provider;
      name: string;
      baseUrl: string;
      encryptedToken?: string;
      connectionId?: string;
      createdAt: string;
    }>('integrations');
    for (const entry of imports) {
      if (!entry.encryptedToken || entry.connectionId) continue;
      const connection: GitConnection = {
        id: ctx.id(),
        userId: entry.creatorId,
        provider: entry.provider,
        name: entry.name,
        baseUrl: entry.baseUrl,
        encryptedToken: entry.encryptedToken,
        credentialId: entry.id,
        createdAt: entry.createdAt,
        updatedAt: ctx.now(),
      };
      await store.put('gitConnections', connection);
      const { encryptedToken: _token, ...fields } = entry;
      await store.put('integrations', { ...fields, connectionId: connection.id });
    }
  });
}

export async function registerGitConnections(app: FastifyInstance, ctx: AppContext) {
  const allowedOrigins = (process.env.INTEGRATION_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const secret = () => process.env.APP_SECRET ?? '';
  const browserUser = (request: FastifyRequest) => {
    const user = ctx.requireUser(request);
    if (request.tokenScope)
      ctx.fail(403, 'Manage personal Git credentials from a signed-in browser session.');
    return user;
  };
  const input = z
    .object({
      provider: z.enum(['github', 'gitea']),
      name: z.string().trim().min(1).max(100),
      baseUrl: z.string().trim().max(2000).optional(),
      token: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .regex(/^[^\s\u0000-\u001f\u007f]+$/),
    })
    .strict();
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v1/git/'))
      reply.header('Cache-Control', 'private, no-store').header('Vary', 'Cookie, Authorization');
    return payload;
  });
  await registerGitHubApp(app, ctx);
  app.get('/api/v1/git/connections', async (request) => {
    const user = ctx.requireUser(request);
    return (await ctx.store.list<GitConnection>('gitConnections'))
      .filter((c) => c.userId === user.id)
      .map(publicGitConnection);
  });
  app.post('/api/v1/git/connections', async (request, reply) => {
    const user = browserUser(request);
    const parsed = input.safeParse(request.body);
    if (!parsed.success)
      ctx.fail(400, 'Provide a provider, connection name, base URL, and access token.');
    if (secret().length < 32)
      ctx.fail(503, 'APP_SECRET must contain at least 32 characters before Git can be configured.');
    let baseUrl: string;
    try {
      baseUrl = validateSource(
        {
          provider: parsed.data.provider,
          baseUrl:
            parsed.data.baseUrl ||
            (parsed.data.provider === 'github' ? 'https://api.github.com' : ''),
          repository: 'owner/repository',
        },
        allowedOrigins,
      ).baseUrl;
    } catch (error) {
      ctx.fail(400, error instanceof Error ? error.message : 'Invalid Git configuration.');
    }
    const id = ctx.id(),
      now = ctx.now();
    const connection: GitConnection = {
      id,
      userId: user.id,
      provider: parsed.data.provider,
      name: parsed.data.name,
      baseUrl,
      encryptedToken: encryptToken(parsed.data.token, secret(), id),
      createdAt: now,
      updatedAt: now,
    };
    await ctx.store.put('gitConnections', connection);
    return reply.code(201).send(publicGitConnection(connection));
  });
  app.put<{ Params: { id: string } }>('/api/v1/git/connections/:id', async (request) => {
    const user = browserUser(request);
    const connection = await ownGitConnection(ctx, user.id, request.params.id);
    if (connection.githubApp)
      ctx.fail(400, 'Use Reconnect GitHub to renew a GitHub App connection.');
    const parsed = input.pick({ name: true, token: true }).safeParse(request.body);
    if (!parsed.success) ctx.fail(400, 'Provide a connection name and replacement access token.');
    if (secret().length < 32)
      ctx.fail(503, 'APP_SECRET must contain at least 32 characters before Git can be configured.');
    const { credentialId: _aad, ...fields } = connection;
    const updated = {
      ...fields,
      name: parsed.data.name,
      encryptedToken: encryptToken(parsed.data.token, secret(), connection.id),
      updatedAt: ctx.now(),
    };
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const current = await store.get<GitConnection>('gitConnections', connection.id);
      if (!current || current.userId !== user.id) ctx.fail(404, 'Git connection not found.');
      if (current.encryptedToken !== connection.encryptedToken)
        ctx.fail(409, 'This connection changed. Reload before replacing its token.');
      await store.put('gitConnections', updated);
    });
    return publicGitConnection(updated);
  });
  app.delete<{ Params: { id: string } }>('/api/v1/git/connections/:id', async (request, reply) => {
    const user = browserUser(request);
    await ownGitConnection(ctx, user.id, request.params.id);
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const imports = await store.list<{ id: string; connectionId?: string }>('integrations');
      const dependent = new Set(
        imports.filter((i) => i.connectionId === request.params.id).map((i) => i.id),
      );
      for (const item of await store.list<WorkItem>('items')) {
        if (item.source && dependent.has(item.source.integrationId))
          await store.put('items', { ...item, source: { ...item.source, connected: false } });
      }
      for (const id of dependent) await store.remove('integrations', id);
      await db.query(
        "DELETE FROM entities WHERE collection='githubAuthorizationStates' AND data->>'userId'=$1 AND (data->>'connectionId' IS NULL OR data->>'connectionId'=$2)",
        [user.id, request.params.id],
      );
      await store.remove('gitConnections', request.params.id);
    });
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string }; Querystring: { repository?: string; number?: string } }>(
    '/api/v1/git/connections/:id/issue',
    async (request) => {
      let connection = await ownGitConnection(ctx, ctx.requireUser(request).id, request.params.id);
      const parsed = z
        .object({
          repository: z.string().trim().min(1).max(300),
          number: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .safeParse(request.query);
      if (!parsed.success)
        ctx.fail(400, 'Provide an owner/repository and a positive issue number.');
      try {
        validateSource({ ...connection, repository: parsed.data.repository }, allowedOrigins);
      } catch (error) {
        ctx.fail(400, error instanceof Error ? error.message : 'Invalid Git configuration.');
      }
      let token: string;
      try {
        const resolved = await resolveGitCredential(ctx, connection);
        connection = resolved.connection;
        token = resolved.token;
      } catch (error) {
        if (connection.githubApp) throw error;
        ctx.fail(
          503,
          'Git credentials could not be decrypted. Restore APP_SECRET or update your token.',
        );
      }
      try {
        return await fetchIssue(
          { ...connection, repository: parsed.data.repository },
          parsed.data.number,
          token,
          { allowedOrigins, ...(connection.githubApp ? { fetch: ctx.githubFetch } : {}) },
        );
      } catch (error) {
        if (
          error instanceof ProviderRequestError &&
          error.providerStatus === 401 &&
          connection.githubApp
        ) {
          await invalidateGitHubCredential(ctx, connection);
          ctx.fail(401, 'GitHub authorization was revoked. Reconnect GitHub in Settings.');
        }
        if (
          error instanceof Error &&
          /^(Provider |Repository |Could not reach )/.test(error.message)
        )
          ctx.fail(502, error.message);
        ctx.fail(
          400,
          'Invalid or no longer permitted Git configuration. Check the repository and allowed origins.',
        );
      }
    },
  );
}
