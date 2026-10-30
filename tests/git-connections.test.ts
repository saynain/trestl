import { addMembership } from '../server/workspaces.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { encryptToken, fetchIssue } from '../server/integration-provider.ts';
import { gitToken, migrateGitConnections, type GitConnection } from '../server/git-connections.ts';
import { registerIntegrations } from '../server/integrations.ts';
import { makeStore, openDatabase } from '../server/db.ts';
import type { AppContext } from '../server/context.ts';
import type { User } from '../shared/types.ts';

const secret = 'test-git-connection-secret-at-least-32-characters';

test('GitHub and Gitea issue lookup use scoped GET requests and construct trusted links', async () => {
  for (const provider of ['github', 'gitea'] as const) {
    const baseUrl =
      provider === 'github' ? 'https://api.github.com' : 'https://git.example.test/team';
    const result = await fetchIssue(
      { provider, baseUrl, repository: 'owner/repo' },
      42,
      'private-token',
      {
        allowedOrigins: ['https://git.example.test'],
        fetch: async (url, init) => {
          assert.equal(
            String(url),
            `${baseUrl}${provider === 'gitea' ? '/api/v1' : ''}/repos/owner/repo/issues/42`,
          );
          assert.equal(init?.method, 'GET');
          assert.equal(init?.redirect, 'error');
          assert.equal(
            (init?.headers as Record<string, string>).Authorization,
            `${provider === 'gitea' ? 'token' : 'Bearer'} private-token`,
          );
          return Response.json({
            id: 7,
            number: 42,
            title: 'Read this issue',
            body: 'Detail',
            state: 'closed',
            html_url: 'https://evil.test/token',
          });
        },
      },
    );
    assert.equal(
      result.externalUrl,
      `${provider === 'github' ? 'https://github.com' : baseUrl}/owner/repo/issues/42`,
    );
    assert.equal(result.closed, true);
  }
  await assert.rejects(
    fetchIssue(
      { provider: 'github', baseUrl: 'https://api.github.com', repository: '../repo' },
      1,
      'token',
    ),
    /owner\/repository/,
  );
  await assert.rejects(
    fetchIssue(
      { provider: 'github', baseUrl: 'https://api.github.com', repository: 'owner/repo' },
      1,
      'token',
      { fetch: async () => Response.json({ id: 1, number: 1, pull_request: {} }) },
    ),
    /Pull requests/,
  );
  await assert.rejects(
    fetchIssue(
      { provider: 'github', baseUrl: 'https://api.github.com', repository: 'owner/repo' },
      1,
      'token',
      { fetch: async () => new Response('secret-provider-body', { status: 403 }) },
    ),
    (error) =>
      error instanceof Error &&
      error.message.includes('403') &&
      !error.message.includes('secret-provider-body'),
  );
});

test('personal Git credentials work without projects, enforce ownership, and are reused by imports', async () => {
  const auth: string[] = [];
  let pendingRequest: { entered: () => void; release: Promise<void> } | null = null;
  const remote = createServer(async (request, response) => {
    if (pendingRequest) {
      const pending = pendingRequest;
      pendingRequest = null;
      pending.entered();
      await pending.release;
    }
    auth.push(request.headers.authorization ?? '');
    const url = new URL(request.url!, 'http://localhost');
    const body = /\/issues\/42$/.test(url.pathname)
      ? { id: 42, number: 42, title: 'Shared issue', body: 'Preview', state: 'open' }
      : url.pathname.endsWith('/comments') || url.searchParams.get('page') !== '1'
        ? []
        : [
            {
              // Provider issue IDs are unique per server; numbers repeat across repositories.
              id: url.pathname.includes('/owner/two/') ? 4200 : 42,
              number: 42,
              title: 'Shared issue',
              body: 'Preview',
              state: 'open',
            },
          ];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => remote.listen(0, '127.0.0.1', resolve));
  const address = remote.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const previousSecret = process.env.APP_SECRET,
    previousOrigins = process.env.INTEGRATION_ALLOWED_ORIGINS;
  process.env.APP_SECRET = secret;
  process.env.INTEGRATION_ALLOWED_ORIGINS = origin;
  const db = await openDatabase({ dataDir: ':memory:' }),
    store = makeStore(db);
  const alice: User = {
    id: 'alice',
    name: 'Alice',
    email: 'alice@example.test',
    role: 'member',
    color: '#336699',
  };
  const bob: User = { ...alice, id: 'bob', role: 'admin', workspaceId: 'elsewhere' };
  let currentUser = alice;
  const ctx: AppContext = {
    db,
    store,
    requireUser: () => currentUser,
    canProject: async (user, id, reader = store) =>
      user.id === alice.id && !!(await reader.get('projects', id)),
    canItem: async () => true,
    id: randomUUID,
    now: () => new Date().toISOString(),
    fail: (statusCode, message) => {
      throw Object.assign(new Error(message), { statusCode });
    },
  };
  await store.put('system', { id: 'mutation-lock' });
  await store.put('users', alice);
  await store.put('workspaces', { id: 'default', kind: 'personal', ownerId: alice.id });
  await addMembership(store, 'default', alice.id, alice.role);
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.tokenScope = (request.headers['x-scope'] as string) || null;
  });
  await registerIntegrations(app, ctx);
  const path = '/api/v1/git/connections';
  try {
    const created = await app.inject({
      method: 'POST',
      url: path,
      payload: { provider: 'gitea', name: 'Personal Git', baseUrl: origin, token: 'alice-token' },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(!created.body.includes('alice-token') && !created.body.includes('encryptedToken'));
    assert.equal(auth.length, 0);
    const id = created.json().id;
    const url = `${path}/${id}`;
    assert.equal((await app.inject({ method: 'GET', url: path })).json().length, 1);
    const first = await app.inject({
      method: 'GET',
      url: `${url}/issue?repository=owner/one&number=42`,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.match(first.headers['cache-control']!, /private, no-store/);
    assert.equal(first.json().title, 'Shared issue');
    assert.equal((await store.list('items')).length, 0, 'Lookup does not import work');
    assert.equal(
      (await app.inject({ method: 'GET', url: `${url}/issue?repository=owner/two&number=42` }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: path,
          headers: { 'x-scope': 'admin' },
          payload: { provider: 'github', name: 'No', token: 'token' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: path,
          payload: { provider: 'github', name: 'No', baseUrl: 'https://evil.test', token: 'token' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `${url}/issue?repository=../repo&number=42` }))
        .statusCode,
      400,
    );
    currentUser = bob;
    assert.deepEqual((await app.inject({ method: 'GET', url: path })).json(), []);
    for (const method of ['PUT', 'DELETE', 'GET'] as const) {
      const response = await app.inject({
        method,
        url: method === 'GET' ? `${url}/issue?repository=owner/one&number=42` : url,
        ...(method === 'PUT' ? { payload: { name: 'Stolen', token: 'bob-token' } } : {}),
      });
      assert.equal(response.statusCode, 404, response.body);
    }
    currentUser = { ...alice, role: 'admin' };
    await store.put('users', currentUser);
    await addMembership(store, 'default', currentUser.id, currentUser.role);
    for (const [projectId, repository] of [
      ['p1', 'owner/one'],
      ['p2', 'owner/two'],
    ]) {
      await store.put('projects', {
        id: projectId,
        key: projectId.toUpperCase(),
        visibility: 'workspace',
      });
      const imported = await app.inject({
        method: 'POST',
        url: '/api/v1/integrations',
        payload: { name: repository, repository, projectId, connectionId: id },
      });
      assert.equal(imported.statusCode, 201, imported.body);
      const synced = await app.inject({
        method: 'POST',
        url: `/api/v1/integrations/${imported.json().id}/sync`,
      });
      assert.equal(synced.statusCode, 200, synced.body);
    }
    assert.equal((await store.list('gitConnections')).length, 1, 'Imports reuse the token');
    const items = await store.list<{ id: string; projectId: string }>('items');
    assert.deepEqual(items.map((i) => i.projectId).sort(), ['p1', 'p2']);
    assert.ok(
      (await store.list<Record<string, unknown>>('integrations')).every(
        (i) => i.encryptedToken === undefined,
      ),
    );
    const updated = await app.inject({
      method: 'PUT',
      url,
      payload: { name: 'New token', token: 'rotated-token' },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    await app.inject({ method: 'GET', url: `${url}/issue?repository=owner/one&number=42` });
    assert.equal(auth.at(-1), 'token rotated-token');
    for (const imported of await store.list<{ id: string }>('integrations')) {
      assert.equal(
        (await app.inject({ method: 'POST', url: `/api/v1/integrations/${imported.id}/sync` }))
          .statusCode,
        200,
      );
      assert.equal(auth.at(-1), 'token rotated-token');
    }
    const activeImport = (await store.list<{ id: string; projectId: string }>('integrations')).find(
      (entry) => entry.projectId === 'p1',
    )!;
    let entered!: () => void, release!: () => void;
    const reachedProvider = new Promise<void>((resolve) => {
      entered = resolve;
    });
    pendingRequest = {
      entered,
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const runningSync = app
      .inject({ method: 'POST', url: `/api/v1/integrations/${activeImport.id}/sync` })
      .then((response) => response);
    await reachedProvider;
    // Personal token owners can disconnect even after losing admin/project access.
    currentUser = alice;
    await store.remove('projects', 'p2');
    try {
      assert.equal((await app.inject({ method: 'DELETE', url })).statusCode, 204);
    } finally {
      release();
    }
    assert.equal(
      (await runningSync).statusCode,
      502,
      'An in-flight sync cannot restore a disconnected import',
    );
    assert.equal((await store.list('integrations')).length, 0);
    assert.ok(
      (await store.list<{ source: { connected: boolean } }>('items')).every(
        (item) => !item.source.connected,
      ),
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: `${url}/issue?repository=owner/one&number=42` }))
        .statusCode,
      404,
    );
    assert.equal((await store.list('items')).length, 2, 'Disconnect retains imported work');
  } finally {
    await app.close();
    await db.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
    if (previousOrigins === undefined) delete process.env.INTEGRATION_ALLOWED_ORIGINS;
    else process.env.INTEGRATION_ALLOWED_ORIGINS = previousOrigins;
  }
});

test('legacy migration preserves credentials and import identity, is idempotent, and needs no secret', async () => {
  const db = await openDatabase({ dataDir: ':memory:' }),
    store = makeStore(db);
  const ctx = { db, store, id: randomUUID, now: () => new Date().toISOString() } as AppContext;
  try {
    await store.put('system', { id: 'mutation-lock' });
    const legacy = {
      id: 'legacy',
      creatorId: 'alice',
      provider: 'github',
      name: 'Existing import',
      baseUrl: 'https://api.github.com',
      projectId: 'project',
      repository: 'owner/repo',
      encryptedToken: encryptToken('legacy-token', secret, 'legacy'),
      createdAt: '2026-01-01',
      lastSyncedAt: '2026-02-01',
    };
    await store.put('integrations', legacy);
    await store.put('importedIssues', { id: 'mapping', integrationId: 'legacy', itemId: 'item' });
    await migrateGitConnections(ctx);
    await migrateGitConnections(ctx);
    const connections = await store.list<GitConnection>('gitConnections');
    assert.equal(connections.length, 1);
    assert.equal(connections[0].userId, 'alice');
    assert.equal(gitToken(connections[0], secret), 'legacy-token');
    const migrated = await store.get<Record<string, unknown>>('integrations', 'legacy');
    const { encryptedToken: _token, ...fields } = legacy;
    assert.deepEqual(migrated, { ...fields, connectionId: connections[0].id });
    assert.deepEqual(await store.get('importedIssues', 'mapping'), {
      id: 'mapping',
      integrationId: 'legacy',
      itemId: 'item',
    });
  } finally {
    await db.close();
  }
});
