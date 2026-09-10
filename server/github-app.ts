import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import { makeStore } from './db.ts';
import type { GitConnection } from './git-connections.ts';
import { decryptToken, encryptToken } from './integration-provider.ts';

const root = '/api/v1/git/github-app';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => process.env.APP_SECRET ?? '';
interface AppConfig {
  clientId: string;
  clientSecret: string;
  slug: string;
  origin: string;
  callbackUrl: string;
  installUrl: string;
}
export function githubAppConfig(): AppConfig | null {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  const slug = process.env.GITHUB_APP_SLUG?.trim();
  if (!clientId || !clientSecret || !slug || !/^[\w-]+$/.test(slug) || secret().length < 32)
    return null;
  try {
    const url = new URL(process.env.APP_ORIGIN ?? '');
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      return null;
    return {
      clientId,
      clientSecret,
      slug,
      origin: url.origin,
      callbackUrl: `${url.origin}${root}/callback`,
      installUrl: `https://github.com/apps/${slug}/installations/new`,
    };
  } catch {
    return null;
  }
}
class GitHubError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly reconnect = false,
  ) {
    super(message);
  }
}
const unavailable = () =>
  new GitHubError(
    'GitHub App is not configured. Ask your administrator to complete the GitHub App setup.',
    503,
  );
const reauthorize = () =>
  new GitHubError(
    'GitHub authorization expired or was revoked. Reconnect GitHub in Settings.',
    401,
    true,
  );

/** No redirects, arbitrary hosts, provider error bodies, or credentials in URLs/logs. */
async function requestJson(
  ctx: AppContext,
  url: string,
  options: { token?: string; form?: Record<string, string> } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  timer.unref();
  try {
    const response = await (ctx.githubFetch ?? fetch)(url, {
      method: options.form ? 'POST' : 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Trestl',
        ...(options.token
          ? { Authorization: `Bearer ${options.token}`, 'X-GitHub-Api-Version': '2026-03-10' }
          : {}),
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(options.form ? { body: new URLSearchParams(options.form).toString() } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw reauthorize();
      throw new GitHubError(
        `GitHub request failed (HTTP ${response.status}). Check app permissions or try again later.`,
      );
    }
    const limit = 1024 * 1024;
    if (!response.body) throw new GitHubError('GitHub returned an empty response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > limit) {
          await reader.cancel();
          throw new GitHubError('GitHub response exceeded the size limit.');
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!json || typeof json !== 'object' || Array.isArray(json))
      throw new GitHubError('GitHub returned an unexpected response.');
    const data = json as Record<string, unknown>;
    if (data.error) {
      if (data.error === 'bad_refresh_token' || data.error === 'invalid_grant') throw reauthorize();
      throw new GitHubError(
        'GitHub authorization failed. Check the app configuration and reconnect.',
      );
    }
    return data;
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    throw new GitHubError(
      controller.signal.aborted
        ? 'GitHub request timed out. Please try again.'
        : 'GitHub could not be reached or returned an invalid response. Please try again.',
    );
  } finally {
    clearTimeout(timer);
  }
}
const tokenResponse = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86400),
  refresh_token_expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 86400),
  token_type: z.literal('bearer'),
  scope: z.literal('').optional(),
});
function tokens(data: Record<string, unknown>, id: string, now: string) {
  const parsed = tokenResponse.safeParse(data);
  if (!parsed.success)
    throw new GitHubError(
      'GitHub App must use expiring user access tokens. Enable token expiration in the app settings, then reconnect.',
      503,
    );
  const value = parsed.data;
  return {
    encryptedToken: encryptToken(value.access_token, secret(), id),
    encryptedRefreshToken: encryptToken(value.refresh_token, secret(), `${id}:refresh`),
    expiresAt: new Date(Date.parse(now) + value.expires_in * 1000).toISOString(),
    refreshExpiresAt: new Date(
      Date.parse(now) + value.refresh_token_expires_in * 1000,
    ).toISOString(),
  };
}

/** Lock one connection across instances while consuming a single-use refresh token. */
export async function githubAppCredential(
  ctx: AppContext,
  original: GitConnection,
): Promise<{ connection: GitConnection; token: string }> {
  const config = githubAppConfig();
  if (!config) throw unavailable();
  const result = await ctx.db.transaction(async (db) => {
    const store = makeStore(db);
    const locked = await db.query<{ data: GitConnection }>(
      'SELECT data FROM entities WHERE collection=$1 AND id=$2 FOR UPDATE',
      ['gitConnections', original.id],
    );
    const connection = locked.rows[0]?.data;
    if (!connection || connection.userId !== original.userId)
      return {
        error: new GitHubError('GitHub connection was removed. Connect again in Settings.', 404),
      };
    const app = connection.githubApp;
    if (!app || app.clientId !== config.clientId || app.reconnectRequired)
      return { error: reauthorize() };
    if (Date.parse(app.expiresAt) > Date.parse(ctx.now()) + 60_000) {
      try {
        return {
          connection,
          token: decryptToken(connection.encryptedToken, secret(), connection.id),
        };
      } catch {
        return {
          error: new GitHubError(
            'GitHub credentials could not be decrypted. Restore APP_SECRET or reconnect.',
            503,
          ),
        };
      }
    }
    try {
      if (Date.parse(app.refreshExpiresAt) <= Date.parse(ctx.now())) throw reauthorize();
      let refresh: string;
      try {
        refresh = decryptToken(app.encryptedRefreshToken, secret(), `${connection.id}:refresh`);
      } catch {
        throw new GitHubError(
          'GitHub credentials could not be decrypted. Restore APP_SECRET or reconnect.',
          503,
        );
      }
      const renewed = tokens(
        await requestJson(ctx, 'https://github.com/login/oauth/access_token', {
          form: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: refresh,
          },
        }),
        connection.id,
        ctx.now(),
      );
      const { encryptedToken, ...metadata } = renewed;
      const updated: GitConnection = {
        ...connection,
        encryptedToken,
        githubApp: { ...app, ...metadata, reconnectRequired: false },
        updatedAt: ctx.now(),
      };
      await store.put('gitConnections', updated);
      return { connection: updated, token: decryptToken(encryptedToken, secret(), updated.id) };
    } catch (error) {
      if (error instanceof GitHubError && error.reconnect)
        await store.put('gitConnections', {
          ...connection,
          githubApp: { ...app, reconnectRequired: true },
        });
      return {
        error:
          error instanceof GitHubError
            ? error
            : new GitHubError('GitHub token renewal failed. Reconnect in Settings.'),
      };
    }
  });
  if (result.error) throw result.error;
  return { connection: result.connection!, token: result.token! };
}

export async function invalidateGitHubCredential(ctx: AppContext, connection: GitConnection) {
  if (!connection.githubApp) return;
  await ctx.db.query(
    "UPDATE entities SET data=jsonb_set(data, '{githubApp,reconnectRequired}', 'true') WHERE collection='gitConnections' AND id=$1 AND data->>'encryptedToken'=$2",
    [connection.id, connection.encryptedToken],
  );
}

interface AuthorizationState {
  id: string;
  userId: string;
  sessionHash: string;
  clientId: string;
  expiresAt: number;
  verifier: string;
  phase: 'pending' | 'exchanging';
  connectionId?: string;
  expectedAuthorizationId?: string;
}
async function installations(ctx: AppContext, token: string, page = 1) {
  const body = await requestJson(
    ctx,
    `https://api.github.com/user/installations?per_page=100&page=${page}`,
    { token },
  );
  const parsed = z
    .object({
      total_count: z.number().int().nonnegative(),
      installations: z.array(
        z.object({
          id: z.number().int().positive(),
          account: z.object({ login: z.string(), type: z.string() }),
          repository_selection: z.string(),
          permissions: z.object({ issues: z.string().optional() }),
          suspended_at: z.string().nullable().optional(),
        }),
      ),
    })
    .safeParse(body);
  if (!parsed.success)
    throw new GitHubError('GitHub returned an unexpected installation response.');
  return {
    data: parsed.data.installations.map((i) => ({
      id: i.id,
      account: i.account.login,
      repositorySelection: i.repository_selection,
      suspended: !!i.suspended_at,
      issuesReadable: ['read', 'write'].includes(i.permissions.issues ?? ''),
      settingsUrl:
        i.account.type === 'Organization'
          ? `https://github.com/organizations/${encodeURIComponent(i.account.login)}/settings/installations/${i.id}`
          : `https://github.com/settings/installations/${i.id}`,
    })),
    hasMore: parsed.data.total_count > page * 100,
  };
}
export async function registerGitHubApp(app: FastifyInstance, ctx: AppContext) {
  const browserUser = (request: FastifyRequest) => {
    const user = ctx.requireUser(request);
    if (request.tokenScope || !request.cookies?.trestl_session)
      ctx.fail(403, 'Connect GitHub from a signed-in browser session.');
    return user;
  };
  app.get(`${root}/status`, async (request) => {
    ctx.requireUser(request);
    const config = githubAppConfig();
    return { enabled: !!config, ...(config ? { installUrl: config.installUrl } : {}) };
  });
  app.post(`${root}/authorize`, async (request) => {
    const user = browserUser(request);
    const config = githubAppConfig();
    if (!config) throw unavailable();
    const parsed = z
      .object({ connectionId: z.string().min(1).max(200).optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!parsed.success) ctx.fail(400, 'Invalid GitHub connection.');
    const state = randomBytes(32).toString('base64url'),
      id = hash(state),
      verifier = randomBytes(32).toString('base64url');
    await ctx.db.transaction(async (db) => {
      const store = makeStore(db);
      await db.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      let previous: GitConnection | null = null;
      if (parsed.data.connectionId) {
        previous = await store.get<GitConnection>('gitConnections', parsed.data.connectionId);
        if (!previous || previous.userId !== user.id || !previous.githubApp)
          ctx.fail(404, 'GitHub App connection not found.');
      }
      await db.query(
        "DELETE FROM entities WHERE collection='githubAuthorizationStates' AND (data->>'expiresAt')::bigint <= $1",
        [Date.parse(ctx.now())],
      );
      // A single pending flow per browser session avoids replay and stale tabs.
      await db.query(
        "DELETE FROM entities WHERE collection='githubAuthorizationStates' AND data->>'sessionHash'=$1",
        [hash(request.cookies.trestl_session!)],
      );
      await store.put<AuthorizationState>('githubAuthorizationStates', {
        id,
        userId: user.id,
        sessionHash: hash(request.cookies.trestl_session!),
        clientId: config.clientId,
        expiresAt: Date.parse(ctx.now()) + 10 * 60_000,
        verifier: encryptToken(verifier, secret(), id),
        phase: 'pending',
        ...(previous
          ? {
              connectionId: previous.id,
              expectedAuthorizationId: previous.githubApp!.authorizationId,
            }
          : {}),
      });
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    for (const [key, value] of Object.entries({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }))
      url.searchParams.set(key, value);
    return { authorizationUrl: url.toString() };
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    `${root}/callback`,
    async (request, reply) => {
      const user = browserUser(request);
      const config = githubAppConfig();
      if (!config) throw unavailable();
      const destination = (result: string) =>
        `${config.origin}/#/settings?tab=integrations&github=${result}`;
      reply.header('Referrer-Policy', 'no-referrer');
      const parsed = z
        .string()
        .regex(/^[\w-]{43}$/)
        .safeParse(request.query.state);
      if (!parsed.success) return reply.redirect(destination('invalid_state'), 303);
      const stateId = hash(parsed.data);
      const claimed = await ctx.db.query<{ data: AuthorizationState }>(
        "UPDATE entities SET data=jsonb_set(data, '{phase}', '\"exchanging\"') WHERE collection='githubAuthorizationStates' AND id=$1 AND data->>'phase'='pending' AND data->>'userId'=$2 AND data->>'sessionHash'=$3 AND data->>'clientId'=$4 AND (data->>'expiresAt')::bigint > $5 RETURNING data",
        [
          stateId,
          user.id,
          hash(request.cookies.trestl_session!),
          config.clientId,
          Date.parse(ctx.now()),
        ],
      );
      const state = claimed.rows[0]?.data;
      if (!state) return reply.redirect(destination('invalid_state'), 303);
      try {
        if (request.query.error) return reply.redirect(destination('denied'), 303);
        const code = z.string().min(1).max(1000).safeParse(request.query.code);
        if (!code.success) return reply.redirect(destination('failed'), 303);
        const verifier = decryptToken(state.verifier, secret(), state.id);
        const response = await requestJson(ctx, 'https://github.com/login/oauth/access_token', {
          form: {
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: code.data,
            redirect_uri: config.callbackUrl,
            code_verifier: verifier,
          },
        });
        const temporaryId = ctx.id();
        const credential = tokens(response, temporaryId, ctx.now());
        const accessToken = decryptToken(credential.encryptedToken, secret(), temporaryId);
        const profile = z
          .object({ id: z.number().int().positive(), login: z.string().min(1).max(100) })
          .safeParse(await requestJson(ctx, 'https://api.github.com/user', { token: accessToken }));
        if (!profile.success) throw new GitHubError('GitHub returned an invalid user profile.');
        const access = await installations(ctx, accessToken);
        await ctx.db.transaction(async (db) => {
          const store = makeStore(db);
          await db.query(
            "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
          );
          const activeState = await store.get<AuthorizationState>(
            'githubAuthorizationStates',
            stateId,
          );
          const session = await db.query(
            'SELECT user_id FROM sessions WHERE hash=$1 AND user_id=$2 AND expires_at>NOW()',
            [state.sessionHash, user.id],
          );
          if (
            !activeState ||
            activeState.expiresAt <= Date.parse(ctx.now()) ||
            !session.rows.length
          )
            throw new GitHubError('GitHub authorization was canceled.');
          const id =
            state.connectionId ??
            `github-app:${hash(`${user.id}:${config.clientId}:${profile.data.id}`)}`;
          const previous = await store.get<GitConnection>('gitConnections', id);
          if (
            state.connectionId &&
            (!previous ||
              previous.userId !== user.id ||
              previous.githubApp?.authorizationId !== state.expectedAuthorizationId ||
              previous.githubApp?.accountId !== profile.data.id)
          )
            throw new GitHubError('GitHub account or connection changed.');
          const secured = tokens(response, id, ctx.now());
          const { encryptedToken, ...metadata } = secured;
          await store.put<GitConnection>('gitConnections', {
            id,
            userId: user.id,
            provider: 'github',
            baseUrl: 'https://api.github.com',
            name: previous?.name ?? `GitHub · ${profile.data.login}`,
            encryptedToken,
            githubApp: {
              clientId: config.clientId,
              authorizationId: ctx.id(),
              accountId: profile.data.id,
              login: profile.data.login,
              ...metadata,
              reconnectRequired: false,
            },
            createdAt: previous?.createdAt ?? ctx.now(),
            updatedAt: ctx.now(),
          });
          await store.remove('githubAuthorizationStates', stateId);
        });
        return reply.redirect(
          access.data.length ? destination('connected') : config.installUrl,
          303,
        );
      } catch {
        // Provider details, codes and tokens must never appear in errors, logs or redirects.
        return reply.redirect(destination('failed'), 303);
      } finally {
        await ctx.store.remove('githubAuthorizationStates', stateId);
      }
    },
  );
  // Installation IDs from redirects are untrusted. This endpoint never changes permissions or records.
  app.get(`${root}/setup`, async (request, reply) => {
    browserUser(request);
    const config = githubAppConfig();
    if (!config) throw unavailable();
    return reply.redirect(`${config.origin}/#/settings?tab=integrations&github=installed`, 303);
  });
  app.get<{ Params: { id: string }; Querystring: { page?: string } }>(
    '/api/v1/git/connections/:id/github-installations',
    async (request) => {
      const user = ctx.requireUser(request);
      const connection = await ctx.store.get<GitConnection>('gitConnections', request.params.id);
      if (!connection || connection.userId !== user.id || !connection.githubApp)
        ctx.fail(404, 'GitHub App connection not found.');
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .safeParse(request.query.page ?? 1);
      if (!page.success) ctx.fail(400, 'Invalid installations page.');
      const resolved = await githubAppCredential(ctx, connection);
      try {
        return await installations(ctx, resolved.token, page.data);
      } catch (error) {
        if (error instanceof GitHubError && error.reconnect)
          await invalidateGitHubCredential(ctx, resolved.connection);
        throw error;
      }
    },
  );
}
