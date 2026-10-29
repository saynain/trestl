import { addMembership } from '../server/workspaces.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  decryptToken,
  encryptToken,
  fetchRepository,
  validateSource,
} from '../server/integration-provider.ts';
import { registerIntegrations, backfillIssueSources } from '../server/integrations.ts';
import { makeStore, openDatabase } from '../server/db.ts';
import type { AppContext } from '../server/context.ts';
import type { Activity, Project, User, WorkItem } from '../shared/types.ts';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test('credential encryption is randomized, authenticated, and bound to a connection', () => {
  const secret = 'a'.repeat(32);
  const encrypted = encryptToken('private-provider-token', secret, 'connection-a');
  assert.ok(!encrypted.includes('private-provider-token'));
  assert.equal(decryptToken(encrypted, secret, 'connection-a'), 'private-provider-token');
  assert.notEqual(encrypted, encryptToken('private-provider-token', secret, 'connection-a'));
  assert.throws(() => decryptToken(encrypted, secret, 'connection-b'));
  assert.throws(() => decryptToken(encrypted, 'b'.repeat(32), 'connection-a'));
  assert.throws(() => encryptToken('token', 'short', 'a'));
});

test('provider origins must be explicitly trusted, including internal Gitea', () => {
  assert.equal(
    validateSource({
      provider: 'github',
      baseUrl: 'https://api.github.com/',
      repository: 'owner/repo',
    }).baseUrl,
    'https://api.github.com',
  );
  assert.throws(
    () =>
      validateSource({
        provider: 'gitea',
        baseUrl: 'http://169.254.169.254',
        repository: 'owner/repo',
      }),
    /not permitted/,
  );
  assert.throws(
    () =>
      validateSource({
        provider: 'github',
        baseUrl: 'https://api.github.com.evil.test',
        repository: 'owner/repo',
      }),
    /not permitted/,
  );
  assert.throws(
    () =>
      validateSource({
        provider: 'github',
        baseUrl: 'https://token@api.github.com',
        repository: 'owner/repo',
      }),
    /without credentials/,
  );
  assert.throws(
    () =>
      validateSource({
        provider: 'github',
        baseUrl: 'https://api.github.com',
        repository: '../repo',
      }),
    /owner\/repository/,
  );
  assert.equal(
    validateSource(
      { provider: 'gitea', baseUrl: 'https://git.internal/company', repository: 'owner/repo' },
      ['https://git.internal'],
    ).baseUrl,
    'https://git.internal/company',
  );
  assert.equal(
    validateSource(
      {
        provider: 'gitea',
        baseUrl: 'https://git.internal/company/api/v1/',
        repository: 'owner/repo',
      },
      ['https://git.internal'],
    ).baseUrl,
    'https://git.internal/company',
  );
});

test('GitHub paginates issues and comments, excludes pull requests and ignores remote link destinations', async () => {
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    const page = url.searchParams.get('page');
    const comment = url.pathname.endsWith('/comments');
    const body = comment
      ? page === '1'
        ? [{ id: 4, user: { login: 'alice' }, body: 'First comment', created_at: '2026-01-01' }]
        : []
      : page === '1'
        ? [
            {
              id: 10,
              number: 1,
              title: 'Issue',
              body: 'Description',
              html_url: 'javascript:alert(1)',
              labels: [{ name: 'bug' }],
            },
            { id: 20, number: 2, pull_request: {} },
          ]
        : page === '2'
          ? [{ id: 30, number: 3, title: 'Closed issue', state: 'closed' }]
          : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: page === '1' ? { Link: '<https://evil.test/steal>; rel="next"' } : {},
    });
  };
  const issues = await fetchRepository(
    { provider: 'github', baseUrl: 'https://api.github.com', repository: 'owner/repo' },
    'secret',
    { fetch: fakeFetch },
  );
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.externalUrl, 'https://github.com/owner/repo/issues/1');
  assert.equal(issues[0]?.comments[0]?.author, 'alice');
  assert.equal(issues[1]?.closed, true);
  assert.ok(requests.some((url) => url.includes('page=3')));
  assert.ok(requests.every((url) => !url.includes('/issues/2/comments')));
});

test('Gitea paginates capped issue pages but reads each complete comment collection once', async () => {
  const requests: string[] = [];
  // Gitea's issue-specific comments endpoint ignores page/limit and returns all comments.
  const comments = Array.from({ length: 125 }, (_, index) => ({
    id: index + 1,
    body: `Comment ${index + 1}`,
    user: { login: 'engineer' },
    created_at: '2026-09-01T12:00:00Z',
  }));
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/comments')) {
      return Response.json(url.pathname.endsWith('/1/comments') ? comments : []);
    }
    // No Link header and the server clamps limit=100 to one issue per page.
    const page = Number(url.searchParams.get('page'));
    assert.equal(url.searchParams.get('limit'), '100');
    return Response.json(page <= 2 ? [{ id: page, number: page, title: `Issue ${page}` }] : []);
  };
  const issues = await fetchRepository(
    { provider: 'gitea', baseUrl: 'https://git.example.test', repository: 'team/platform' },
    'secret',
    { fetch: fakeFetch, allowedOrigins: ['https://git.example.test'], maxPages: 3 },
  );
  assert.equal(issues.length, 2);
  assert.equal(issues[0]?.comments.length, 125);
  assert.equal(issues[1]?.comments.length, 0);
  assert.deepEqual(
    requests.filter((path) => path.includes('/comments')),
    [
      '/api/v1/repos/team/platform/issues/1/comments',
      '/api/v1/repos/team/platform/issues/2/comments',
    ],
  );
  assert.equal(requests.length, 5);
});

test('provider failures redact responses, refuse redirects, bound responses and timeout', async () => {
  let receivingRequests = 0;
  const receiver = createServer((_request, response) => {
    receivingRequests++;
    response.end('[]');
  });
  const receiverOrigin = await listen(receiver);
  let mode = 'redirect';
  const server = createServer((_request, response) => {
    if (mode === 'redirect') {
      response.writeHead(302, { Location: receiverOrigin });
      response.end();
    } else if (mode === 'unauthorized') {
      response.writeHead(401);
      response.end('VERY_SECRET_TOKEN');
    } else if (mode === 'large') {
      response.writeHead(200, { 'Content-Length': '9999999' });
      response.end('[]');
    } else {
      const timer = setTimeout(() => response.end('[]'), 1000);
      timer.unref();
    }
  });
  const origin = await listen(server);
  const source = { provider: 'gitea' as const, baseUrl: origin, repository: 'team/platform' };
  const options = { allowedOrigins: [origin], timeoutMs: 2000 };
  try {
    await assert.rejects(fetchRepository(source, 'VERY_SECRET_TOKEN', options), /Could not reach/);
    assert.equal(receivingRequests, 0);
    mode = 'unauthorized';
    await assert.rejects(
      fetchRepository(source, 'VERY_SECRET_TOKEN', options),
      (error) =>
        error instanceof Error &&
        error.message.includes('HTTP 401') &&
        !error.message.includes('VERY_SECRET_TOKEN'),
    );
    mode = 'large';
    await assert.rejects(fetchRepository(source, 'VERY_SECRET_TOKEN', options), /5 MB/);
    mode = 'timeout';
    await assert.rejects(
      fetchRepository(source, 'VERY_SECRET_TOKEN', { ...options, timeoutMs: 100 }),
      /timed out/,
    );
  } finally {
    server.closeAllConnections();
    await close(server);
    await close(receiver);
  }
});

test('Gitea sync is idempotent, preserves local planning and reconciles source comments', async () => {
  const admin: User = {
    id: 'admin',
    name: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    color: '#ddd',
  };
  const member: User = { ...admin, id: 'member', role: 'member' };
  const project: Project = {
    id: 'platform',
    key: 'PLAT',
    name: 'Platform',
    description: '',
    color: '#ddd',
    icon: 'box',
    parentId: null,
    lifecycle: 'ongoing',
    status: 'active',
    startDate: null,
    dueDate: null,
    visibility: 'workspace',
    ownerId: admin.id,
    createdAt: new Date().toISOString(),
  };
  let issueTitle = 'Upgrade cluster';
  let sourceState = 'open';
  let sourceComments = [
    {
      id: 31,
      body: 'Ready for review',
      user: { login: 'engineer' },
      created_at: '2026-06-01T10:00:00Z',
    },
  ];
  let failComments = false;
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, 'token secret-access-token');
    const url = new URL(request.url!, 'http://local.test');
    if (['/api/v1/repos/team/platform', '/api/v1/repositories/77'].includes(url.pathname)) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 77, full_name: 'team/platform', private: true }));
      return;
    }
    const isComments = url.pathname.endsWith('/comments');
    assert.equal(url.searchParams.get('limit'), isComments ? null : '100');
    if (url.pathname.endsWith('/comments') && failComments) {
      response.writeHead(503);
      response.end('secret-access-token');
      return;
    }
    const body =
      isComments || url.searchParams.get('page') === '1'
        ? isComments
          ? sourceComments
          : [
              {
                id: 101,
                number: 8,
                title: issueTitle,
                body: 'Source description',
                state: sourceState,
                labels: [{ name: 'maintenance' }],
              },
            ]
        : [];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  const origin = await listen(server);
  const previousSecret = process.env.APP_SECRET;
  const previousOrigins = process.env.INTEGRATION_ALLOWED_ORIGINS;
  process.env.APP_SECRET = 'test-secret-key-32-characters-minimum';
  process.env.INTEGRATION_ALLOWED_ORIGINS = origin;
  const db = await openDatabase({ dataDir: ':memory:' });
  const store = makeStore(db);
  await store.put('users', admin);
  await store.put('workspaces', { id: 'default', kind: 'shared', ownerId: admin.id });
  await addMembership(store, 'default', admin.id, admin.role);
  await store.put('projects', project);
  let currentUser = admin;
  let accessible = true;
  let itemAccessible = true;
  const ctx: AppContext = {
    db,
    store,
    requireUser: () => currentUser,
    canProject: async (_user, id) => accessible && id === project.id,
    canItem: async () => itemAccessible,
    id: randomUUID,
    now: () => new Date().toISOString(),
    fail: (status, message) => {
      throw Object.assign(new Error(message), { statusCode: status });
    },
  };
  const app = Fastify();
  await registerIntegrations(app, ctx);
  try {
    currentUser = member;
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/integrations' })).statusCode,
      403,
    );
    currentUser = admin;
    const payload = {
      provider: 'gitea',
      name: 'Platform repo',
      baseUrl: origin,
      repository: 'team/platform',
      projectId: project.id,
      token: 'secret-access-token',
    };
    const created = await app.inject({ method: 'POST', url: '/api/v1/integrations', payload });
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(!created.body.includes('secret-access-token'));
    assert.ok(!created.body.includes('encryptedToken'));
    const connection = created.json<{ id: string }>();
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/v1/integrations', payload })).statusCode,
      409,
    );
    const stored = await store.get<{ id: string; connectionId: string; encryptedToken?: string }>(
      'integrations',
      connection.id,
    );
    assert.equal(stored?.encryptedToken, undefined);
    const credential = await store.get<{ id: string; encryptedToken: string }>(
      'gitConnections',
      stored!.connectionId,
    );
    assert.ok(
      credential?.encryptedToken && !credential.encryptedToken.includes('secret-access-token'),
    );
    const syncUrl = `/api/v1/integrations/${connection.id}/sync`;
    const first = await app.inject({ method: 'POST', url: syncUrl });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().imported, 1);
    assert.equal(first.json().comments, 1);
    const [item] = await store.list<WorkItem>('items');
    assert.ok(item);
    assert.equal(item.identifier, 'PLAT-01');
    assert.deepEqual(item.source, {
      provider: 'gitea',
      integrationId: connection.id,
      repository: 'team/platform',
      number: 8,
      url: `${origin}/team/platform/issues/8`,
      state: 'open',
      connected: true,
      lastSyncedAt: item.source?.lastSyncedAt,
    });
    assert.ok(item.source?.lastSyncedAt);
    assert.ok(!JSON.stringify(item).includes('secret-access-token'));
    const importEvent = (await store.list<Activity>('activity')).find(
      (row) => row.kind === 'event' && row.body.startsWith('Imported from'),
    );
    assert.ok(importEvent?.importedFrom, 'Repository import events require source provenance');
    const importedActivity = (await store.list<Activity>('activity')).find((row) => row.source);
    assert.equal(importedActivity?.body, 'Ready for review');
    assert.deepEqual(importedActivity?.source, { provider: 'gitea', author: 'engineer' });
    // Simulate existing data created before provenance fields were introduced.
    const { source: _source, ...legacyItem } = item;
    await store.put('items', legacyItem);
    assert.ok(importedActivity);
    const { source: _commentSource, ...legacyActivity } = importedActivity;
    await store.put('activity', {
      ...legacyActivity,
      body: '**engineer** · imported from Gitea\n\nReady for review',
    });
    const nativeEnvelope = {
      ...legacyActivity,
      id: 'native-envelope',
      body: '**engineer** · imported from Gitea\n\nThis is an internal note quoting source content',
    };
    await store.put('activity', nativeEnvelope);
    await backfillIssueSources(ctx);
    await backfillIssueSources(ctx);
    assert.deepEqual(await store.get<Activity>('activity', nativeEnvelope.id), nativeEnvelope);
    await store.remove('activity', nativeEnvelope.id);
    assert.deepEqual((await store.get<WorkItem>('items', item.id))?.source, {
      ...item.source,
      lastSyncedAt: first.json().integration.lastSyncedAt,
    });
    assert.deepEqual(await store.get<Activity>('activity', importedActivity.id), importedActivity);
    await store.put('items', {
      ...item,
      status: 'in_progress',
      priority: 'urgent',
      dueDate: '2026-09-30',
      labels: ['local-label'],
    });
    const localComment: Activity = {
      id: 'local-comment',
      itemId: item.id,
      userId: admin.id,
      kind: 'comment',
      body: 'Internal discussion',
      createdAt: new Date().toISOString(),
    };
    await store.put('activity', localComment);
    issueTitle = 'Updated cluster upgrade';
    sourceState = 'closed';
    sourceComments[0]!.body = 'Remote edit';
    const second = await app.inject({ method: 'POST', url: syncUrl });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().imported, 0);
    assert.equal(second.json().updated, 1);
    assert.equal((await store.list<WorkItem>('items')).length, 1);
    const updated = await store.get<WorkItem>('items', item.id);
    assert.equal(updated?.title, issueTitle);
    assert.equal(updated?.status, 'in_progress');
    assert.equal(updated?.source?.state, 'closed');
    assert.equal(updated?.priority, 'urgent');
    assert.deepEqual(updated?.labels, ['local-label']);
    assert.equal(updated?.dueDate, '2026-09-30');
    assert.equal(
      (await store.list<Activity>('activity')).filter((activity) => activity.kind === 'comment')
        .length,
      2,
    );
    assert.ok(
      (await store.list<Activity>('activity')).some(
        (activity) =>
          activity.source?.author === 'engineer' &&
          activity.source.provider === 'gitea' &&
          activity.body === 'Remote edit',
      ),
    );
    itemAccessible = false;
    issueTitle = 'Must not change a private moved item';
    const inaccessibleItemSync = await app.inject({ method: 'POST', url: syncUrl });
    assert.equal(inaccessibleItemSync.statusCode, 200, inaccessibleItemSync.body);
    assert.equal(inaccessibleItemSync.json().updated, 0);
    assert.equal((await store.get<WorkItem>('items', item.id))?.title, 'Updated cluster upgrade');
    itemAccessible = true;
    issueTitle = 'Must not apply partial sync';
    failComments = true;
    const failed = await app.inject({ method: 'POST', url: syncUrl });
    assert.equal(failed.statusCode, 502, failed.body);
    assert.ok(!failed.body.includes('secret-access-token'));
    assert.equal((await store.get<WorkItem>('items', item.id))?.title, 'Updated cluster upgrade');
    assert.ok(
      (
        await store.get<{ id: string; lastError: string }>('integrations', connection.id)
      )?.lastError.includes('503'),
    );
    failComments = false;
    sourceComments = [];
    assert.equal((await app.inject({ method: 'POST', url: syncUrl })).statusCode, 200);
    const remainingComments = (await store.list<Activity>('activity')).filter(
      (activity) => activity.kind === 'comment',
    );
    assert.deepEqual(
      remainingComments.map((activity) => activity.id),
      ['local-comment'],
    );
    accessible = false;
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/integrations' })).json(), []);
    assert.equal((await app.inject({ method: 'POST', url: syncUrl })).statusCode, 404);
    accessible = true;
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/v1/integrations/${connection.id}` }))
        .statusCode,
      204,
    );
    assert.equal(
      (await store.list<WorkItem>('items')).length,
      1,
      'Disconnect retains imported work',
    );
    assert.equal((await store.get<WorkItem>('items', item.id))?.source?.connected, false);
    assert.equal(
      (await store.get<WorkItem>('items', item.id))?.source?.repository,
      'team/platform',
    );
    const disconnected = (await store.get<WorkItem>('items', item.id))!;
    const { source: _disconnectedSource, ...legacyDisconnected } = disconnected;
    await store.put('items', legacyDisconnected);
    await backfillIssueSources(ctx);
    assert.equal((await store.get<WorkItem>('items', item.id))?.source?.connected, false);
    assert.equal(
      (await store.get<WorkItem>('items', item.id))?.source?.repository,
      'team/platform',
    );
  } finally {
    await app.close();
    await db.close();
    await close(server);
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
    if (previousOrigins === undefined) delete process.env.INTEGRATION_ALLOWED_ORIGINS;
    else process.env.INTEGRATION_ALLOWED_ORIGINS = previousOrigins;
  }
});
