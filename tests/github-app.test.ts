import { addMembership } from '../server/workspaces.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { makeStore, openDatabase } from '../server/db.ts';
import { registerIntegrations } from '../server/integrations.ts';
import { githubAppConfig } from '../server/github-app.ts';
import { decryptToken } from '../server/integration-provider.ts';
import type { GitConnection } from '../server/git-connections.ts';
import type { AppContext } from '../server/context.ts';
import type { User } from '../shared/types.ts';
import { createApp } from '../server/app.ts';

const root = '/api/v1/git/github-app';
const secret = 'github-app-test-secret-at-least-thirty-two-characters';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenReply = (suffix = 'one') => ({
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
  token_type: 'bearer',
  scope: '',
});
const installation = {
  id: 3,
  account: { login: 'octocat', type: 'User' },
  repository_selection: 'selected',
  permissions: { issues: 'read' },
  suspended_at: null,
};
async function fixture() {
  const vars = [
    'APP_SECRET',
    'APP_ORIGIN',
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_SLUG',
    'INTEGRATION_SYNC_INTERVAL_MS',
  ] as const;
  const previous = Object.fromEntries(vars.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    APP_SECRET: secret,
    APP_ORIGIN: 'https://trestl.example.test',
    GITHUB_APP_CLIENT_ID: 'Iv23.test',
    GITHUB_APP_CLIENT_SECRET: 'private-app-secret',
    GITHUB_APP_SLUG: 'trestl-test',
    INTEGRATION_SYNC_INTERVAL_MS: '0',
  });
  let time = Date.now();
  const db = await openDatabase({ dataDir: ':memory:' }),
    store = makeStore(db);
  const alice: User = {
    id: 'alice',
    name: 'Alice',
    email: 'alice@example.test',
    role: 'admin',
    color: '#336699',
  };
  const bob: User = { ...alice, id: 'bob', workspaceId: 'other' };
  await store.put('system', { id: 'mutation-lock' });
  for (const user of [alice, bob]) {
    await store.put('users', user);
    await store.put('workspaces', {
      id: user.workspaceId ?? 'default',
      kind: 'personal',
      ownerId: user.id,
    });
    await addMembership(store, user.workspaceId ?? 'default', user.id, user.role);
    for (const session of [user.id, `${user.id}-other-browser`])
      await db.query('INSERT INTO sessions(hash,user_id,expires_at) VALUES($1,$2,$3)', [
        digest(session),
        user.id,
        new Date(Date.now() + 86400000).toISOString(),
      ]);
  }
  const requests: { url: string; init?: RequestInit }[] = [];
  let handler: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/login/oauth/access_token') return Response.json(tokenReply());
    if (parsed.pathname === '/user') return Response.json({ id: 7, login: 'octocat' });
    if (parsed.pathname === '/user/installations')
      return Response.json({ total_count: 1, installations: [installation] });
    if (parsed.pathname.endsWith('/issues/42'))
      return Response.json({
        id: 42,
        number: 42,
        title: 'App issue',
        body: 'Preview',
        state: 'open',
      });
    if (parsed.pathname.endsWith('/comments') || parsed.searchParams.get('page') !== '1')
      return Response.json([]);
    return Response.json([
      { id: 42, number: 42, title: 'App issue', body: 'Preview', state: 'open' },
    ]);
  };
  const app = Fastify();
  await app.register(cookie);
  app.addHook('onRequest', async (request) => {
    const sessionId = request.cookies.trestl_session;
    request.user = sessionId?.startsWith('alice')
      ? alice
      : sessionId?.startsWith('bob')
        ? bob
        : null;
    request.tokenScope = request.headers.authorization ? 'admin' : null;
  });
  const ctx: AppContext = {
    db,
    store,
    id: randomUUID,
    now: () => new Date(time).toISOString(),
    requireUser: (request) => {
      if (!request.user) throw Object.assign(new Error('Sign in'), { statusCode: 401 });
      return request.user;
    },
    canProject: async (user, id, reader = store) =>
      user.id === 'alice' && !!(await reader.get('projects', id)),
    canItem: async () => true,
    fail: (statusCode, message) => {
      throw Object.assign(new Error(message), { statusCode });
    },
    githubFetch: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.ok(
        ['https://github.com', 'https://api.github.com'].includes(new URL(String(url)).origin),
      );
      assert.equal(init?.redirect, 'error');
      return handler(url, init);
    },
  };
  await registerIntegrations(app, ctx);
  const send = (
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    url: string,
    payload?: object,
    user = 'alice',
  ) =>
    app.inject({
      method,
      url,
      headers: { cookie: `trestl_session=${user}` },
      ...(payload ? { payload } : {}),
    });
  async function start(connectionId?: string) {
    const response = await send('POST', `${root}/authorize`, connectionId ? { connectionId } : {});
    assert.equal(response.statusCode, 200, response.body);
    return new URL(response.json().authorizationUrl);
  }
  const callback = (url: URL, user = 'alice') =>
    send(
      'GET',
      `${root}/callback?state=${url.searchParams.get('state')}&code=temporary-secret-code`,
      undefined,
      user,
    );
  return {
    app,
    ctx,
    store,
    db,
    requests,
    send,
    start,
    callback,
    setHandler(next: typeof fetch) {
      handler = next;
    },
    advance(ms: number) {
      time += ms;
    },
    async close() {
      await app.close();
      await db.close();
      for (const key of vars) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    },
  };
}

test('GitHub App flow binds state and PKCE to one browser session and stores only encrypted personal credentials', async () => {
  const f = await fixture();
  try {
    const url = await f.start();
    assert.equal(url.origin, 'https://github.com');
    assert.equal(url.pathname, '/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'Iv23.test');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://trestl.example.test/api/v1/git/github-app/callback',
    );
    assert.equal(url.searchParams.get('scope'), null);
    assert.ok(!url.toString().includes('private-app-secret'));
    const state = (
      await f.store.list<{ verifier: string; id: string }>('githubAuthorizationStates')
    )[0];
    const verifier = decryptToken(state.verifier, secret, state.id);
    assert.equal(
      createHash('sha256').update(verifier).digest('base64url'),
      url.searchParams.get('code_challenge'),
    );
    assert.match((await f.callback(url, 'bob')).headers.location!, /invalid_state/);
    assert.match((await f.callback(url, 'alice-other-browser')).headers.location!, /invalid_state/);
    assert.equal(f.requests.length, 0);
    const result = await f.callback(url);
    assert.equal(result.statusCode, 303);
    assert.match(result.headers.location!, /#\/settings\?tab=integrations&github=connected$/);
    assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.match(result.headers['cache-control']!, /no-store/);
    const exchange = f.requests[0];
    const form = new URLSearchParams(String(exchange.init?.body));
    assert.equal(form.get('code_verifier'), verifier);
    assert.equal(form.get('client_secret'), 'private-app-secret');
    assert.ok(!exchange.url.includes('temporary-secret-code'));
    const [connection] = await f.store.list<GitConnection>('gitConnections');
    assert.equal(connection.githubApp?.accountId, 7);
    assert.equal(connection.userId, 'alice');
    assert.equal(decryptToken(connection.encryptedToken, secret, connection.id), 'access-one');
    assert.equal(
      decryptToken(connection.githubApp!.encryptedRefreshToken, secret, `${connection.id}:refresh`),
      'refresh-one',
    );
    const listed = await f.send('GET', '/api/v1/git/connections');
    for (const value of [
      'access-one',
      'refresh-one',
      'encryptedRefreshToken',
      'encryptedToken',
      'private-app-secret',
    ])
      assert.ok(!listed.body.includes(value));
    assert.equal(listed.json()[0].authType, 'github-app');
    assert.deepEqual((await f.send('GET', '/api/v1/git/connections', undefined, 'bob')).json(), []);
    const count = f.requests.length;
    assert.match((await f.callback(url)).headers.location!, /invalid_state/);
    assert.equal(f.requests.length, count);
    assert.equal(
      (
        await f.send('PUT', `/api/v1/git/connections/${connection.id}`, {
          name: 'No',
          token: 'pat',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.send(
          'GET',
          `/api/v1/git/connections/${connection.id}/github-installations`,
          undefined,
          'bob',
        )
      ).statusCode,
      404,
    );
    const issue = await f.send(
      'GET',
      `/api/v1/git/connections/${connection.id}/issue?repository=owner/repo&number=42`,
    );
    assert.equal(issue.statusCode, 200, issue.body);
    assert.equal(issue.json().title, 'App issue');
  } finally {
    await f.close();
  }
});

test('canceled, stale, malformed and interrupted authorization never grants access', async () => {
  const f = await fixture();
  try {
    const old = await f.start();
    const active = await f.start();
    assert.match((await f.callback(old)).headers.location!, /invalid_state/);
    const denied = await f.send(
      'GET',
      `${root}/callback?state=${active.searchParams.get('state')}&error=access_denied&error_description=provider-secret`,
    );
    assert.match(denied.headers.location!, /github=denied/);
    assert.ok(!denied.body.includes('provider-secret'));
    const expired = await f.start();
    f.advance(11 * 60_000);
    assert.match((await f.callback(expired)).headers.location!, /invalid_state/);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.store.list('gitConnections')).length, 0);
    f.setHandler(async () =>
      Response.json({ error: 'bad_verification_code', error_description: 'provider-secret' }),
    );
    const badCode = await f.callback(await f.start());
    assert.match(badCode.headers.location!, /github=failed/);
    assert.ok(!badCode.headers.location!.includes('secret'));
    assert.equal((await f.store.list('gitConnections')).length, 0);
    const setup = await f.send('GET', `${root}/setup?installation_id=123456&setup_action=install`);
    assert.match(setup.headers.location!, /github=installed/);
    assert.equal((await f.store.list('gitConnections')).length, 0);
    const noSession = await f.app.inject({ method: 'POST', url: `${root}/authorize`, payload: {} });
    assert.equal(noSession.statusCode, 401);
    const bearer = await f.app.inject({
      method: 'POST',
      url: `${root}/authorize`,
      headers: { cookie: 'trestl_session=alice', authorization: 'Bearer test' },
      payload: {},
    });
    assert.equal(bearer.statusCode, 403);
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    assert.deepEqual((await f.send('GET', `${root}/status`)).json(), { enabled: false });
    assert.equal((await f.send('POST', `${root}/authorize`, {})).statusCode, 503);
  } finally {
    await f.close();
  }
});

test('first authorization routes to repository selection, reconnect preserves imports and refuses a different GitHub identity', async () => {
  const f = await fixture();
  try {
    let githubUser = 7;
    f.setHandler(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/login/oauth/access_token') return Response.json(tokenReply());
      if (path === '/user') return Response.json({ id: githubUser, login: 'octocat' });
      return Response.json({ total_count: 0, installations: [] });
    });
    const result = await f.callback(await f.start());
    assert.equal(result.headers.location, 'https://github.com/apps/trestl-test/installations/new');
    const [connection] = await f.store.list<GitConnection>('gitConnections');
    await f.store.put('projects', { id: 'p1', key: 'PR', visibility: 'workspace' });
    const imported = await f.send('POST', '/api/v1/integrations', {
      name: 'Import',
      repository: 'owner/repo',
      projectId: 'p1',
      connectionId: connection.id,
    });
    assert.equal(imported.statusCode, 201, imported.body);
    const pending = await f.start(connection.id);
    githubUser = 8;
    assert.match((await f.callback(pending)).headers.location!, /github=failed/);
    assert.equal(
      (await f.store.get<GitConnection>('gitConnections', connection.id))!.encryptedToken,
      connection.encryptedToken,
    );
    githubUser = 7;
    await f.callback(await f.start(connection.id));
    const updated = (await f.store.get<GitConnection>('gitConnections', connection.id))!;
    assert.notEqual(updated.encryptedToken, connection.encryptedToken);
    assert.equal(updated.id, connection.id);
    assert.equal(
      (await f.store.list<{ connectionId: string }>('integrations'))[0].connectionId,
      connection.id,
    );
    const canceled = await f.start(connection.id);
    await f.send('DELETE', `/api/v1/git/connections/${connection.id}`);
    assert.match((await f.callback(canceled)).headers.location!, /invalid_state/);
    assert.equal((await f.store.list('gitConnections')).length, 0);
  } finally {
    await f.close();
  }
});

test('expired app tokens renew once across concurrent requests, serve imports, and revoked access requires reconnect', async () => {
  const f = await fixture();
  try {
    await f.callback(await f.start());
    const [connection] = await f.store.list<GitConnection>('gitConnections');
    f.advance(8 * 3600_000);
    let refreshes = 0;
    let revoked = false;
    f.setHandler(async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === '/login/oauth/access_token') {
        refreshes++;
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('grant_type'), 'refresh_token');
        assert.equal(form.get('refresh_token'), 'refresh-one');
        return Response.json(tokenReply('two'));
      }
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer access-two');
      if (revoked) return new Response('private-provider-response', { status: 401 });
      if (parsed.pathname === '/user/installations')
        return Response.json({ total_count: 1, installations: [installation] });
      return Response.json([]);
    });
    const url = `/api/v1/git/connections/${connection.id}/github-installations`;
    const results = await Promise.all([f.send('GET', url), f.send('GET', url)]);
    assert.ok(
      results.every((r) => r.statusCode === 200),
      results.map((r) => r.body).join(),
    );
    assert.equal(refreshes, 1);
    const updated = (await f.store.get<GitConnection>('gitConnections', connection.id))!;
    assert.equal(
      decryptToken(updated.githubApp!.encryptedRefreshToken, secret, `${connection.id}:refresh`),
      'refresh-two',
    );
    await f.store.put('projects', { id: 'p1', key: 'PR', visibility: 'workspace' });
    const imported = await f.send('POST', '/api/v1/integrations', {
      name: 'Import',
      repository: 'owner/repo',
      projectId: 'p1',
      connectionId: connection.id,
    });
    const sync = await f.send('POST', `/api/v1/integrations/${imported.json().id}/sync`);
    assert.equal(sync.statusCode, 200, sync.body);
    revoked = true;
    const denied = await f.send('GET', url);
    assert.equal(denied.statusCode, 401, denied.body);
    assert.ok(!denied.body.includes('private-provider-response'));
    const count = f.requests.length;
    assert.equal((await f.send('GET', url)).statusCode, 401);
    assert.equal(f.requests.length, count, 'Do not repeatedly use revoked credentials');
    assert.equal(
      (await f.send('GET', '/api/v1/git/connections')).json()[0].reconnectRequired,
      true,
    );
  } finally {
    await f.close();
  }
});

test('disconnect or logout during code exchange cannot recreate credentials', async () => {
  const f = await fixture();
  try {
    await f.callback(await f.start());
    const [connection] = await f.store.list<GitConnection>('gitConnections');
    const url = await f.start(connection.id);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const wait = new Promise<void>((r) => {
      release = r;
    });
    f.setHandler(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/login/oauth/access_token') {
        entered();
        await wait;
        return Response.json(tokenReply('new'));
      }
      if (path === '/user') return Response.json({ id: 7, login: 'octocat' });
      return Response.json({ total_count: 1, installations: [installation] });
    });
    const callback = f.callback(url).then((result) => result);
    await started;
    try {
      await f.send('DELETE', `/api/v1/git/connections/${connection.id}`);
    } finally {
      release();
    }
    assert.match((await callback).headers.location!, /github=failed/);
    assert.equal((await f.store.list('gitConnections')).length, 0);
    const logout = await f.start();
    await f.db.query('DELETE FROM sessions WHERE hash=$1', [digest('alice')]);
    assert.match((await f.callback(logout)).headers.location!, /github=failed/);
    assert.equal((await f.store.list('gitConnections')).length, 0);
  } finally {
    await f.close();
  }
});

test('self-hosted GitHub App config accepts only an explicit HTTPS or loopback origin', async () => {
  const f = await fixture();
  try {
    assert.ok(githubAppConfig());
    for (const origin of [
      'http://public.example.test',
      'https://user:pass@example.test',
      'https://example.test/path',
      'https://example.test?query=1',
    ]) {
      process.env.APP_ORIGIN = origin;
      assert.equal(githubAppConfig(), null);
    }
    process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
    assert.equal(
      githubAppConfig()?.callbackUrl,
      'http://127.0.0.1:5173/api/v1/git/github-app/callback',
    );
  } finally {
    await f.close();
  }
});

test('real app authentication and CSRF checks protect GitHub authorization endpoints', async () => {
  const f = await fixture();
  const app = await createApp({ dataDir: ':memory:', githubFetch: f.ctx.githubFetch });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@example.test',
        password: 'test-password-long',
        seedDemo: false,
      },
    });
    const session = setup.cookies.find((c) => c.name === 'trestl_session')!.value;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${root}/authorize`,
          headers: { cookie: `trestl_session=${session}`, origin: 'https://evil.test' },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `${root}/callback?code=secret&state=anything` }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `${root}/authorize`,
          headers: { cookie: `trestl_session=${session}`, origin: 'https://trestl.example.test' },
          payload: {},
        })
      ).statusCode,
      200,
    );
    const authorized = await app.inject({
      method: 'POST',
      url: `${root}/authorize`,
      headers: { cookie: `trestl_session=${session}`, origin: 'https://trestl.example.test' },
      payload: {},
    });
    const url = new URL(authorized.json().authorizationUrl);
    const connected = await app.inject({
      method: 'GET',
      url: `${root}/callback?state=${url.searchParams.get('state')}&code=test-code`,
      headers: { cookie: `trestl_session=${session}` },
    });
    assert.equal(connected.statusCode, 303, connected.body);
    assert.match(connected.headers.location!, /github=connected/);
    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/export',
      headers: { cookie: `trestl_session=${session}` },
    });
    assert.equal(exported.statusCode, 200);
    for (const privateField of [
      'encryptedToken',
      'encryptedRefreshToken',
      'access-one',
      'refresh-one',
      'private-app-secret',
    ])
      assert.ok(!exported.body.includes(privateField));
  } finally {
    await app.close();
    await f.close();
  }
});

test('bad refresh tokens require reauthorization; transient failures preserve the saved credential', async () => {
  const f = await fixture();
  try {
    await f.callback(await f.start());
    const [connection] = await f.store.list<GitConnection>('gitConnections');
    f.advance(8 * 3600_000);
    const url = `/api/v1/git/connections/${connection.id}/github-installations`;
    f.setHandler(async () => new Response('private details', { status: 503 }));
    const transient = await f.send('GET', url);
    assert.equal(transient.statusCode, 502);
    assert.ok(!transient.body.includes('private details'));
    assert.equal(
      (await f.store.get<GitConnection>('gitConnections', connection.id))!.githubApp!
        .reconnectRequired,
      false,
    );
    f.setHandler(async () =>
      Response.json({ error: 'bad_refresh_token', error_description: 'private refresh token' }),
    );
    const failed = await f.send('GET', url);
    assert.equal(failed.statusCode, 401);
    assert.ok(!failed.body.includes('private refresh token'));
    assert.equal(
      (await f.send('GET', '/api/v1/git/connections')).json()[0].reconnectRequired,
      true,
    );
  } finally {
    await f.close();
  }
});

test('non-expiring tokens, malformed and oversized provider responses do not establish a connection', async () => {
  const f = await fixture();
  try {
    for (const body of [
      JSON.stringify({ access_token: 'long-lived-token', token_type: 'bearer' }),
      '{malformed secret',
      JSON.stringify({ secret: 'x'.repeat(1024 * 1024 + 1) }),
    ]) {
      f.setHandler(
        async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      );
      const result = await f.callback(await f.start());
      assert.match(result.headers.location!, /github=failed/);
      assert.equal((await f.store.list('gitConnections')).length, 0);
    }
  } finally {
    await f.close();
  }
});

test('routine token renewal during a reconnect flow does not invalidate user authorization', async () => {
  const f = await fixture();
  try {
    await f.callback(await f.start());
    const [connection] = await f.store.list<GitConnection>('gitConnections');
    f.advance(8 * 3600_000);
    const pending = await f.start(connection.id);
    const refreshed = await f.send(
      'GET',
      `/api/v1/git/connections/${connection.id}/github-installations`,
    );
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const renewed = (await f.store.get<GitConnection>('gitConnections', connection.id))!;
    assert.notEqual(renewed.encryptedToken, connection.encryptedToken);
    assert.equal(renewed.githubApp?.authorizationId, connection.githubApp?.authorizationId);
    assert.match((await f.callback(pending)).headers.location!, /github=connected/);
    assert.equal((await f.store.list('gitConnections')).length, 1);
  } finally {
    await f.close();
  }
});
