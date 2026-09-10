import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import type { AppContext } from '../server/context.ts';

test('installation Git credentials are encrypted, shared for reads, and administrator-managed', async () => {
  const previous = process.env.APP_SECRET;
  process.env.APP_SECRET = 'shared-git-test-key-more-than-32-characters';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let grants = 0;
  const app = await createApp({
    dataDir: ':memory:',
    githubFetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/app/installations/123/access_tokens')) {
        const jwt = (init!.headers as Record<string, string>).Authorization.slice(7);
        const [header, payload, signature] = jwt.split('.');
        assert.ok(
          verify(
            'RSA-SHA256',
            Buffer.from(header + '.' + payload),
            keys.publicKey,
            Buffer.from(signature, 'base64url'),
          ),
        );
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss, '456');
        assert.deepEqual(JSON.parse(init!.body as string), {
          permissions: { issues: 'read', metadata: 'read' },
        });
        grants++;
        return new Response(
          JSON.stringify({
            token: 'installation-token',
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            repository_selection: 'all',
          }),
          { status: 201 },
        );
      }
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer installation-token');
      if (url.includes('/issues/7'))
        return Response.json({
          id: 7,
          number: 7,
          title: 'Shared repository issue',
          body: 'Details',
          state: 'open',
          html_url: 'https://github.com/example/repo/issues/7',
          user: { login: 'author' },
          labels: [],
          assignees: [],
          milestone: null,
        });
      throw new Error('Unexpected URL ' + url);
    },
  });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { name: 'Admin', email: 'admin@example.test', password: 'local-test-password' },
    });
    const cookie = cookieOf(setup);
    const member = cookieOf(
      await memberSession(app, cookie, {
        name: 'Member',
        email: 'member@example.test',
        password: 'local-test-password',
      }),
    );
    const call = (method: any, path: string, payload?: unknown, auth = cookie) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie: auth },
        ...(payload ? { payload } : {}),
      });
    const input = { name: 'Organization', appId: '456', installationId: '123', privateKey: pem };
    assert.equal((await call('POST', '/admin/github-installation', input, member)).statusCode, 403);
    const saved = await call('POST', '/admin/github-installation', input);
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.json().shared, true);
    assert.ok(!saved.body.includes('PRIVATE KEY'));
    assert.ok(!saved.body.includes('installation-token'));
    const id = saved.json().id;
    const stored = await app
      .getDecorator<AppContext>('context')
      .store.get<any>('gitConnections', id);
    assert.ok(!JSON.stringify(stored).includes('PRIVATE KEY'));
    assert.equal((await call('GET', '/git/connections', undefined, member)).json()[0].id, id);
    const issue = await call(
      'GET',
      `/git/connections/${id}/issue?repository=example/repo&number=7`,
      undefined,
      member,
    );
    assert.equal(issue.statusCode, 200, issue.body);
    assert.equal(issue.json().title, 'Shared repository issue');
    assert.equal(grants, 2);
    assert.equal(
      (await call('DELETE', `/git/connections/${id}`, undefined, member)).statusCode,
      403,
    );
    assert.equal(
      (await call('PUT', `/git/connections/${id}`, { name: 'Stolen', token: 'fake' }, member))
        .statusCode,
      403,
    );
    const gitea = {
      name: 'Internal Git',
      provider: 'gitea',
      baseUrl: 'https://git.example.test',
      token: 'service-account-token',
      shared: true,
    };
    assert.equal((await call('POST', '/git/connections', gitea, member)).statusCode, 403);
    const git = await call('POST', '/git/connections', gitea);
    assert.equal(git.statusCode, 201, git.body);
    assert.ok(
      !(await call('GET', '/git/connections', undefined, member)).body.includes(
        'service-account-token',
      ),
    );
    const personal = await call('POST', '/git/connections', {
      name: 'Legacy private',
      provider: 'github',
      token: 'private-token',
    });
    assert.equal(personal.statusCode, 201, personal.body);
    assert.equal((await call('GET', '/git/connections', undefined, member)).json().length, 2);
    assert.equal((await call('DELETE', `/git/connections/${id}`)).statusCode, 204);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previous;
  }
});
