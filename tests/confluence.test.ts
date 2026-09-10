import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  confluenceCql,
  confluencePlainText,
  queryConfluence,
  registerConfluence,
  validateConfluenceBase,
} from '../server/confluence.ts';
import { makeStore, openDatabase } from '../server/db.ts';
import type { AppContext } from '../server/context.ts';
import type { User } from '../shared/types.ts';

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

test('Confluence requires an explicit trusted HTTPS origin and canonicalizes supported context paths', () => {
  assert.equal(
    validateConfluenceBase('cloud', 'https://company.atlassian.net', [
      'https://company.atlassian.net',
    ]),
    'https://company.atlassian.net/wiki',
  );
  assert.equal(
    validateConfluenceBase('cloud', 'https://company.atlassian.net/wiki/', [
      'https://company.atlassian.net',
    ]),
    'https://company.atlassian.net/wiki',
  );
  assert.equal(
    validateConfluenceBase('datacenter', 'https://docs.internal/confluence/rest/api', [
      'https://docs.internal',
    ]),
    'https://docs.internal/confluence',
  );
  assert.throws(
    () => validateConfluenceBase('datacenter', 'https://docs.internal', []),
    /not permitted/,
  );
  assert.throws(
    () =>
      validateConfluenceBase('datacenter', 'http://169.254.169.254', ['http://169.254.169.254']),
    /requires an HTTPS/,
  );
  assert.throws(
    () => validateConfluenceBase('datacenter', 'http://docs.internal', ['http://docs.internal']),
    /requires an HTTPS/,
  );
  assert.throws(
    () =>
      validateConfluenceBase('cloud', 'https://token@company.atlassian.net', [
        'https://company.atlassian.net',
      ]),
    /without credentials/,
  );
  assert.throws(
    () =>
      validateConfluenceBase('cloud', 'https://company.atlassian.net.attacker.test', [
        'https://company.atlassian.net',
      ]),
    /not permitted/,
  );
  assert.throws(
    () =>
      validateConfluenceBase('cloud', 'https://company.atlassian.net/wiki/api/v2', [
        'https://company.atlassian.net',
      ]),
    /site URL/,
  );
});

test('Confluence snippets become bounded plain text and CQL input stays within one string literal', () => {
  assert.equal(
    confluencePlainText(
      '<style>hidden</style><script>window.stolen=true</script><p>@@@hl@@@Runbook@@@endhl@@@ &amp; alerts</p>',
    ),
    'Runbook & alerts',
  );
  assert.equal(
    confluencePlainText('&lt;img src=x onerror=alert(1)&gt; &#x1f680; &#0;'),
    'img src=x onerror=alert(1) 🚀',
  );
  assert.ok(
    !confluencePlainText('<img src=x onerror=alert(1)>Safe<!--secret-->').includes('onerror'),
  );
  assert.equal(confluencePlainText('abcdef', 3), 'abc');
  assert.equal(confluencePlainText('<'.repeat(100_000)), '');
  assert.equal(
    confluenceCql('cluster'),
    'type = page AND text ~ "cluster" ORDER BY lastmodified DESC',
  );
  assert.equal(
    confluenceCql('a" OR type=user OR text~"\\'),
    'type = page AND text ~ "a\\" OR type=user OR text~\\"\\\\" ORDER BY lastmodified DESC',
  );
});

test('Cloud search and v2 page preview use user Basic auth, trusted URLs, and sanitized text', async () => {
  const requests: URL[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    assert.equal(url.origin, 'https://company.atlassian.net');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      `Basic ${Buffer.from('engineer@example.test:cloud-token').toString('base64')}`,
    );
    const body = url.pathname.endsWith('/search')
      ? {
          results: [
            {
              content: { id: '123', type: 'page', title: '<b>Runbooks</b>' },
              url: 'https://attacker.test',
              excerpt: '<b>Cloud</b> cluster @@@hl@@@upgrade@@@endhl@@@',
            },
          ],
          _links: { next: 'https://attacker.test/steal' },
        }
      : {
          id: '123',
          title: 'Runbooks',
          body: { storage: { value: '<p>Step 1: drain nodes.</p><script>steal()</script>' } },
          version: { createdAt: '2026-08-01T10:00:00Z' },
        };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
  const connection = {
    deployment: 'cloud' as const,
    baseUrl: 'https://company.atlassian.net/wiki',
    username: 'engineer@example.test',
  };
  const options = { allowedOrigins: ['https://company.atlassian.net'], fetch: fakeFetch };
  const result = await queryConfluence(
    connection,
    'cloud-token',
    { kind: 'search', query: 'cluster' },
    options,
  );
  assert.ok('data' in result);
  assert.equal(result.data[0]?.title, 'Runbooks');
  assert.equal(result.data[0]?.excerpt, 'Cloud cluster upgrade');
  assert.equal(
    result.data[0]?.url,
    'https://company.atlassian.net/wiki/pages/viewpage.action?pageId=123',
  );
  assert.equal(result.hasMore, true);
  assert.equal(requests[0]?.pathname, '/wiki/rest/api/search');
  assert.equal(requests[0]?.searchParams.get('limit'), '25');
  const page = await queryConfluence(
    connection,
    'cloud-token',
    { kind: 'page', id: '123' },
    options,
  );
  assert.ok('excerpt' in page);
  assert.equal(page.excerpt, 'Step 1: drain nodes.');
  assert.equal(page.updatedAt, '2026-08-01T10:00:00.000Z');
  assert.equal(requests[1]?.pathname, '/wiki/api/v2/pages/123');
  assert.equal(requests[1]?.searchParams.get('body-format'), 'storage');
});

test('Data Center uses bearer PAT and rejects redirects, oversized responses, access denial, and timeouts', async () => {
  let receivingRequests = 0;
  const receiver = createServer((_request, response) => {
    receivingRequests++;
    response.end('{}');
  });
  const otherOrigin = await listen(receiver);
  let mode = 'page';
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, 'Bearer private-pat');
    if (mode === 'redirect') {
      response.writeHead(302, { Location: otherOrigin });
      response.end();
    } else if (mode === 'denied') {
      response.writeHead(403);
      response.end('private-pat forbidden private page');
    } else if (mode === 'large') {
      response.writeHead(200, { 'Content-Length': '9999999' });
      response.end('{}');
    } else if (mode === 'timeout') {
      const timer = setTimeout(() => response.end('{}'), 1000);
      timer.unref();
    } else {
      const url = new URL(request.url!, 'http://local.test');
      assert.equal(url.pathname, '/confluence/rest/api/content/123');
      assert.equal(url.searchParams.get('expand'), 'body.storage,version');
      response.end(
        JSON.stringify({
          id: '123',
          type: 'page',
          title: 'Restricted runbook',
          body: { storage: { value: '<p>Internal instructions</p>' } },
          version: { when: '2026-08-01T10:00:00Z' },
        }),
      );
    }
  });
  const origin = await listen(server);
  const connection = {
    deployment: 'datacenter' as const,
    baseUrl: `${origin}/confluence`,
    username: null,
  };
  const options = { allowedOrigins: [origin], timeoutMs: 100 };
  try {
    const page = await queryConfluence(
      connection,
      'private-pat',
      { kind: 'page', id: '123' },
      options,
    );
    assert.ok('title' in page);
    assert.equal(page.excerpt, 'Internal instructions');
    mode = 'redirect';
    await assert.rejects(
      queryConfluence(connection, 'private-pat', { kind: 'page', id: '123' }, options),
      /Could not reach/,
    );
    assert.equal(receivingRequests, 0);
    mode = 'denied';
    await assert.rejects(
      queryConfluence(connection, 'private-pat', { kind: 'page', id: '123' }, options),
      (error) =>
        error instanceof Error &&
        error.message.includes('unavailable') &&
        !error.message.includes('private-pat'),
    );
    mode = 'large';
    await assert.rejects(
      queryConfluence(connection, 'private-pat', { kind: 'page', id: '123' }, options),
      /2 MB/,
    );
    mode = 'timeout';
    await assert.rejects(
      queryConfluence(connection, 'private-pat', { kind: 'page', id: '123' }, options),
      /timed out/,
    );
  } finally {
    server.closeAllConnections();
    await close(server);
    await close(receiver);
  }
});

test('Confluence credentials and remote content stay personal, encrypted, uncached, and session-managed', async () => {
  const users: User[] = [
    { id: 'alice', name: 'Alice', email: 'alice@example.test', role: 'member', color: '#ddd' },
    { id: 'bob', name: 'Bob', email: 'bob@example.test', role: 'admin', color: '#ddd' },
  ];
  const auth: string[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    auth.push(request.headers.authorization!);
    response.end(
      JSON.stringify({
        results: [
          {
            content: {
              id: '123',
              type: 'page',
              title:
                request.headers.authorization === 'Bearer alice-pat'
                  ? 'Alice private page'
                  : 'Bob page',
            },
            excerpt: '<p>Live access checked</p>',
          },
        ],
      }),
    );
  });
  const origin = await listen(server);
  const previousSecret = process.env.APP_SECRET,
    previousOrigins = process.env.CONFLUENCE_ALLOWED_ORIGINS;
  process.env.APP_SECRET = 'confluence-test-secret-at-least-32-characters';
  process.env.CONFLUENCE_ALLOWED_ORIGINS = origin;
  const db = await openDatabase({ dataDir: ':memory:' });
  const store = makeStore(db);
  const ctx: AppContext = {
    db,
    store,
    requireUser: (request) => {
      if (!request.user) throw Object.assign(new Error('Sign in'), { statusCode: 401 });
      return request.user;
    },
    canProject: async () => true,
    canItem: async () => true,
    id: randomUUID,
    now: () => new Date().toISOString(),
    fail: (status, message) => {
      throw Object.assign(new Error(message), { statusCode: status });
    },
  };
  const app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('tokenScope', null);
  app.addHook('onRequest', async (request) => {
    request.user = users.find((user) => user.id === request.headers['x-test-user']) ?? null;
    request.tokenScope =
      typeof request.headers['x-test-scope'] === 'string' ? request.headers['x-test-scope'] : null;
  });
  await registerConfluence(app, ctx);
  const alice = { 'x-test-user': 'alice' },
    bob = { 'x-test-user': 'bob' };
  const connectionUrl = '/api/v1/confluence/connection';
  try {
    assert.equal((await app.inject({ method: 'GET', url: connectionUrl })).statusCode, 401);
    assert.equal(
      (await app.inject({ method: 'GET', url: connectionUrl, headers: alice })).json(),
      null,
    );
    const created = await app.inject({
      method: 'POST',
      url: connectionUrl,
      headers: alice,
      payload: { deployment: 'datacenter', baseUrl: origin, token: 'alice-pat' },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.ok(!created.body.includes('alice-pat'));
    assert.ok(!created.body.includes('encryptedToken'));
    assert.equal(created.json().userId, 'alice');
    assert.equal(
      auth.length,
      0,
      'Saving configuration does not imply a successful remote authentication check',
    );
    const encrypted = await store.get<{ id: string; encryptedToken: string }>(
      'confluenceConnections',
      'alice',
    );
    assert.ok(encrypted?.encryptedToken && !encrypted.encryptedToken.includes('alice-pat'));
    assert.equal(
      (await app.inject({ method: 'GET', url: connectionUrl, headers: bob })).json(),
      null,
      'Even an admin sees only their own connection',
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/confluence/search?q=cluster',
          headers: bob,
        })
      ).statusCode,
      404,
    );
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/confluence/search?q=cluster',
      headers: alice,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data[0].title, 'Alice private page');
    assert.match(first.headers['cache-control']!, /private, no-store/);
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/confluence/search?q=cluster',
          headers: alice,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      auth.length,
      2,
      'Each request checks source permissions again; no shared content cache',
    );
    const aliceToken = { ...alice, 'x-test-scope': 'write' };
    assert.equal(
      (await app.inject({ method: 'DELETE', url: connectionUrl, headers: aliceToken })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: connectionUrl,
          headers: aliceToken,
          payload: { deployment: 'datacenter', baseUrl: origin, token: 'changed-token' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/confluence/search?q=cluster',
          headers: { ...alice, 'x-test-scope': 'read' },
        })
      ).statusCode,
      200,
    );
    const bobCreated = await app.inject({
      method: 'POST',
      url: connectionUrl,
      headers: bob,
      payload: { deployment: 'datacenter', baseUrl: origin, token: 'bob-pat' },
    });
    assert.equal(bobCreated.statusCode, 201, bobCreated.body);
    const bobResults = await app.inject({
      method: 'GET',
      url: '/api/v1/confluence/search?q=cluster',
      headers: bob,
    });
    assert.equal(bobResults.json().data[0].title, 'Bob page');
    assert.equal(auth.at(-1), 'Bearer bob-pat');
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/confluence/pages/..%2F123',
          headers: alice,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/confluence/search?q=', headers: alice }))
        .statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url: connectionUrl, headers: bob })).statusCode,
      204,
    );
    assert.ok(
      await store.get('confluenceConnections', 'alice'),
      'Deleting Bob connection leaves Alice connection intact',
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url: connectionUrl, headers: alice })).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/confluence/search?q=cluster',
          headers: alice,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await store.list('items')).length,
      0,
      'Search and previews do not copy documents into workspace data',
    );
  } finally {
    await app.close();
    await db.close();
    await close(server);
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
    if (previousOrigins === undefined) delete process.env.CONFLUENCE_ALLOWED_ORIGINS;
    else process.env.CONFLUENCE_ALLOWED_ORIGINS = previousOrigins;
  }
});
