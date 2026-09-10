import { randomBytes, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { User } from '../shared/types.ts';
import { makeStore, type Store } from './db.ts';
import { installation } from './installation.ts';
import { addMembership, workspaceUser } from './workspaces.ts';
import { encryptToken, decryptToken } from './integration-provider.ts';
import type { ProxyAuthConfig } from './proxy-auth.ts';

export type AuthMode = 'local' | 'google' | 'oidc' | 'proxy';
export interface AuthSettings {
  id: 'authentication';
  revision: string;
  mode: AuthMode;
  origin: string;
  issuer: string;
  clientId: string;
  encryptedClientSecret?: string;
  allowedDomains: string[];
  linkExistingEmails: string[];
  encryptedProxySecret?: string;
}
export const authSettings = (s: Store) => s.get<AuthSettings>('system', 'authentication');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const key = () => {
  const value = process.env.APP_SECRET ?? '';
  if (value.length < 32)
    throw Object.assign(
      new Error(
        'Set a durable APP_SECRET of at least 32 characters on the server before storing authentication secrets.',
      ),
      { statusCode: 503 },
    );
  return value;
};
export function publicAuth(s: AuthSettings | null) {
  if (!s)
    return {
      mode: 'local',
      origin: process.env.APP_ORIGIN ?? '',
      issuer: '',
      clientId: '',
      allowedDomains: [],
      linkExistingEmails: [],
      clientSecretConfigured: false,
      proxySecretConfigured: false,
    };
  const { encryptedClientSecret, encryptedProxySecret, ...publicFields } = s;
  return {
    ...publicFields,
    clientSecretConfigured: !!encryptedClientSecret,
    proxySecretConfigured: !!encryptedProxySecret,
  };
}
export function validServerUrl(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    (u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
  )
    throw new Error('Use HTTPS, or HTTP on localhost for testing.');
  return u;
}
async function configuration(settings: AuthSettings) {
  const issuer = validServerUrl(
    settings.mode === 'google' ? 'https://accounts.google.com' : settings.issuer,
  );
  return oidc.discovery(
    issuer,
    settings.clientId,
    settings.encryptedClientSecret
      ? decryptToken(settings.encryptedClientSecret, key(), 'authentication-client')
      : undefined,
    undefined,
    {
      timeout: 10,
      execute: [
        oidc.enableNonRepudiationChecks,
        ...(issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : []),
      ],
    },
  );
}
export async function configuredProxy(s: Store, settings: AuthSettings): Promise<ProxyAuthConfig> {
  const site = (await installation(s))!;
  const owner = (await s.get<User>('users', site.ownerId))!;
  return {
    secret: decryptToken(settings.encryptedProxySecret!, key(), 'authentication-proxy'),
    provider: 'configured-proxy',
    installationId: site.workspaceId,
    installationName: 'Trestl',
    allowedDomains: settings.allowedDomains,
    adminEmails: [owner.email],
    linkExistingEmails: settings.linkExistingEmails,
    origin: settings.origin,
  };
}
export function registerAuthSettings(
  app: FastifyInstance,
  ctx: AppContext,
  session: (user: User, reply: FastifyReply, method?: string) => Promise<void>,
) {
  const admin = (request: Parameters<AppContext['requireUser']>[0]) => {
    const user = ctx.requireUser(request);
    if (request.tokenScope || user.role !== 'admin')
      ctx.fail(403, 'Administrator browser access is required');
    return user;
  };
  app.get('/api/v1/admin/authentication', async (request) => {
    admin(request);
    return publicAuth(await authSettings(ctx.store));
  });
  const schema = z
    .object({
      mode: z.enum(['local', 'google', 'oidc', 'proxy']),
      origin: z.string().max(2000),
      issuer: z.string().max(2000).default(''),
      clientId: z.string().max(1000).default(''),
      clientSecret: z.string().max(8192).optional(),
      proxySecret: z.string().min(32).max(512).optional(),
      allowedDomains: z
        .array(
          z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
        )
        .max(50)
        .default([]),
      linkExistingEmails: z.array(z.email().toLowerCase()).max(200).default([]),
    })
    .strict();
  app.put('/api/v1/admin/authentication', async (request) => {
    admin(request);
    const input = schema.parse(request.body);
    try {
      const origin = validServerUrl(input.origin);
      if (origin.origin !== input.origin) throw new Error('Use an origin without a path.');
    } catch (e) {
      ctx.fail(400, (e as Error).message);
    }
    const old = await authSettings(ctx.store);
    const { clientSecret, proxySecret, ...fields } = input;
    const next: AuthSettings = {
      ...old,
      ...fields,
      id: 'authentication',
      revision: ctx.id(),
      ...(clientSecret
        ? { encryptedClientSecret: encryptToken(clientSecret, key(), 'authentication-client') }
        : {}),
      ...(proxySecret
        ? { encryptedProxySecret: encryptToken(proxySecret, key(), 'authentication-proxy') }
        : {}),
    };
    if (input.mode !== 'local' && !input.allowedDomains.length)
      ctx.fail(400, 'Specify the allowed email domains.');
    if (['google', 'oidc'].includes(input.mode)) {
      if (
        old &&
        !clientSecret &&
        (old.mode !== input.mode || old.issuer !== input.issuer || old.clientId !== input.clientId)
      )
        ctx.fail(
          400,
          'Enter the client secret again when changing the identity provider or client ID.',
        );
      if (!next.clientId || !next.encryptedClientSecret)
        ctx.fail(400, 'Client ID and client secret are required.');
      try {
        await configuration(next);
      } catch {
        ctx.fail(
          400,
          'Could not discover this identity provider. Check the issuer URL and the server’s network access.',
        );
      }
    }
    if (input.mode === 'proxy' && !next.encryptedProxySecret)
      ctx.fail(400, 'A shared proxy secret is required.');
    await ctx.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      await makeStore(tx).put('system', next);
      // Keep the operator's current session for recovery; invalidate old external sessions.
      await tx.query("DELETE FROM sessions WHERE auth_method <> 'local' AND hash <> $1", [
        hash(request.cookies.trestl_session ?? ''),
      ]);
    });
    return publicAuth(next);
  });
  app.get('/api/v1/auth/provider/start', async (request, reply) => {
    const settings = await authSettings(ctx.store);
    if (!settings || !['google', 'oidc'].includes(settings.mode))
      ctx.fail(400, 'External sign-in is not configured');
    await ctx.db.query(
      "DELETE FROM entities WHERE collection='signInStates' AND (data->>'expiresAt')::bigint < $1",
      [Date.now()],
    );
    const config = await configuration(settings);
    const state = oidc.randomState(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce();
    await ctx.store.put('signInStates', {
      id: hash(state),
      revision: settings.revision,
      verifier,
      nonce,
      expiresAt: Date.now() + 600000,
      linkUserId: request.user?.id,
    });
    reply.setCookie('trestl_signin', state, {
      path: '/api/v1/auth/provider',
      httpOnly: true,
      sameSite: 'lax',
      secure: settings.origin.startsWith('https:'),
      maxAge: 600,
    });
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: settings.origin + '/api/v1/auth/provider/callback',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    return reply.redirect(url.href);
  });
  app.get('/api/v1/auth/provider/callback', async (request, reply) => {
    const settings = await authSettings(ctx.store);
    if (!settings || !['google', 'oidc'].includes(settings.mode))
      ctx.fail(400, 'External sign-in is not configured');
    const state = new URL(request.url, settings.origin).searchParams.get('state');
    if (!state || state !== request.cookies.trestl_signin)
      ctx.fail(400, 'Sign-in expired or belongs to another browser. Start again.');
    const stored = (
      await ctx.db.query<{
        data: {
          revision: string;
          verifier: string;
          nonce: string;
          expiresAt: number;
          linkUserId?: string;
        };
      }>("DELETE FROM entities WHERE collection='signInStates' AND id=$1 RETURNING data", [
        hash(state),
      ])
    ).rows[0]?.data;
    reply.clearCookie('trestl_signin', { path: '/api/v1/auth/provider' });
    if (!stored || stored.expiresAt < Date.now() || stored.revision !== settings.revision)
      ctx.fail(400, 'Sign-in expired. Start again.');
    let claims: Record<string, unknown>;
    try {
      const tokens = await oidc.authorizationCodeGrant(
        await configuration(settings),
        new URL(request.url, settings.origin),
        {
          pkceCodeVerifier: stored.verifier,
          expectedState: state,
          expectedNonce: stored.nonce,
          idTokenExpected: true,
        },
      );
      claims = tokens.claims()!;
    } catch {
      ctx.fail(401, 'The identity provider could not verify this sign-in.');
    }
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.iss !== 'string' ||
      claims.email_verified !== true ||
      !z.email().safeParse(claims.email).success
    )
      ctx.fail(403, 'A verified email address is required.');
    const email = (claims.email as string).toLowerCase();
    if (!settings.allowedDomains.includes(email.split('@')[1]))
      ctx.fail(403, 'This email domain is not allowed.');
    const user = await ctx.db.transaction(async (tx) => {
      await tx.query(
        "SELECT id FROM entities WHERE collection='system' AND id='mutation-lock' FOR UPDATE",
      );
      const s = makeStore(tx),
        site = (await installation(s))!;
      const identityId = hash(JSON.stringify([claims.iss, claims.sub]));
      const identity = await s.get<{ id: string; userId: string }>('oidcIdentities', identityId);
      let u = identity ? await s.get<User>('users', identity.userId) : null;
      const matching = (await s.list<User>('users')).find((u) => u.email.toLowerCase() === email);
      if (!identity && matching) {
        if (stored.linkUserId !== matching.id && !settings.linkExistingEmails.includes(email))
          ctx.fail(
            409,
            'Sign in to your existing account to link this identity, or ask your administrator to approve linking.',
          );
        if (
          (await s.list<{ id: string; userId: string }>('oidcIdentities')).some(
            (i) => i.userId === matching.id,
          )
        )
          ctx.fail(409, 'This account already has another external identity.');
        u = matching;
      }
      if (u?.disabledAt) ctx.fail(403, 'Your account is disabled.');
      if (identity && !u) ctx.fail(403, 'Account unavailable.');
      if (!u) {
        u = {
          id: ctx.id(),
          workspaceId: site.workspaceId,
          name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : email.split('@')[0],
          email,
          color: '#7c9b87',
          role: 'member',
        };
        await s.put('users', u);
        await addMembership(s, site.workspaceId, u.id, 'member');
      }
      if (!(await workspaceUser(s, u.id, site.workspaceId)))
        ctx.fail(403, 'Your account cannot access this installation.');
      if (!identity) await s.put('oidcIdentities', { id: identityId, userId: u.id });
      return (await workspaceUser(s, u.id, site.workspaceId))!;
    });
    await session(user, reply, 'oidc');
    return reply.redirect('/');
  });
}
