import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { proxyAuthConfig, type ProxyAuthConfig } from '../server/proxy-auth.ts';

const config: ProxyAuthConfig = {
  secret: 'test-proxy-secret-with-more-than-32-characters',
  provider: 'google-test',
  installationId: 'default',
  installationName: 'Example Team',
  allowedDomains: ['example.test'],
  adminEmails: ['admin@example.test'],
  linkExistingEmails: ['admin@example.test'],
  origin: 'https://projects.example.test',
};
const identity = (subject = 'admin-subject', email = 'admin@example.test') => ({
  'x-trestl-proxy-secret': config.secret,
  'x-auth-request-user': subject,
  'x-auth-request-email': email,
  'x-auth-request-preferred-username':
    subject === 'admin-subject' ? 'Example Admin' : 'Example Member',
  origin: config.origin,
});
const create = async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false, proxyAuth: config });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      name: 'Admin',
      installationName: config.installationName,
      email: 'admin@example.test',
      password: 'local-test-password',
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return app;
};

test('proxy mode fails closed on incomplete configuration', () => {
  assert.equal(proxyAuthConfig({}), null);
  assert.throws(() => proxyAuthConfig({ AUTH_MODE: 'typo' }), /AUTH_MODE/);
  assert.throws(() => proxyAuthConfig({ AUTH_MODE: 'proxy' }), /SECRET/);
  assert.throws(
    () => proxyAuthConfig({ AUTH_MODE: 'proxy', PROXY_AUTH_SECRET: config.secret }),
    /DOMAINS/,
  );
});

test('proxy sign-in provisions one installation and binds identities to stable subjects', async () => {
  const app = await create();
  try {
    const first = await app.inject({ url: '/api/v1/bootstrap', headers: identity() });
    assert.equal(first.statusCode, 200, first.body);
    const a = first.json();
    assert.equal(a.authMode, 'proxy');
    assert.equal(a.workspace.name, config.installationName);
    assert.equal(a.user.role, 'admin');
    assert.equal(a.user.personalWorkspaceId, undefined);
    assert.equal(a.workspaces.length, 1);
    const [r1, r2] = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          url: '/api/v1/bootstrap',
          headers: identity('member-subject', 'member@example.test'),
        }),
      ),
    );
    assert.equal(r1.statusCode, 200, r1.body);
    assert.equal(r1.json().user.id, r2.json().user.id);
    assert.equal(r1.json().user.role, 'member');
    const renamed = await app.inject({
      url: '/api/v1/bootstrap',
      headers: identity('member-subject', 'renamed@example.test'),
    });
    assert.equal(renamed.json().user.id, r1.json().user.id);
    assert.equal(renamed.json().user.email, 'renamed@example.test');
    assert.equal(renamed.json().users.length, 2);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bootstrap',
          headers: identity('outsider', 'person@outside.test'),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bootstrap',
          headers: identity('impostor', 'admin@example.test'),
        })
      ).statusCode,
      409,
    );
    const member = r1.json().user;
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/users/${member.id}/access`,
          headers: identity(),
          payload: { disabled: true },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bootstrap',
          headers: identity('member-subject', 'renamed@example.test'),
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test('proxy authentication rejects forged headers, stale cookies, credential fallback, and CSRF', async () => {
  const app = await create();
  try {
    const signedIn = await app.inject({ url: '/api/v1/bootstrap', headers: identity() });
    const cookie = signedIn.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    for (const headers of [
      {},
      { ...identity(), 'x-trestl-proxy-secret': 'incorrect' },
      { 'x-auth-request-user': 'admin-subject', 'x-auth-request-email': 'admin@example.test' },
      { cookie },
      { ...identity(), authorization: 'Bearer invalid', cookie },
      { ...identity(), authorization: 'Basic invalid', cookie },
      { ...identity(), 'x-trestl-api-only': 'true', cookie },
    ])
      assert.equal((await app.inject({ url: '/api/v1/bootstrap', headers })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/auth/status' })).json().authMode, 'proxy');
    const recovery = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: config.origin },
      payload: { email: 'admin@example.test', password: 'local-test-password' },
    });
    assert.equal(recovery.statusCode, 200, recovery.body);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bootstrap',
          headers: { cookie: recovery.cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
        })
      ).statusCode,
      200,
    );
    for (const origin of ['', 'https://evil.example.test']) {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/tokens',
            headers: { ...identity(), origin },
            payload: { name: 'bad' },
          })
        ).statusCode,
        403,
      );
    }
    const signOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...identity(), cookie },
      payload: {},
    });
    assert.equal(signOut.json().redirectUrl, '/oauth2/sign_out');
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: { cookie } })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('personal API tokens work without proxy sessions, retain permissions, and revoke on account disabling', async () => {
  const app = await create();
  try {
    const admin = (await app.inject({ url: '/api/v1/bootstrap', headers: identity() })).json().user;
    const memberHeaders = identity('member', 'member@example.test');
    const member = (await app.inject({ url: '/api/v1/bootstrap', headers: memberHeaders })).json()
      .user;
    const project = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: identity(),
        payload: { name: 'Private project', key: 'PRIV', visibility: 'private' },
      })
    ).json();
    const shared = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: identity(),
      payload: { name: 'Shared project', key: 'SHARED' },
    });
    assert.equal(shared.statusCode, 201, shared.body);
    const token = async (scope: string) => {
      const result = await app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        headers: memberHeaders,
        payload: { name: 'CLI', scope },
      });
      assert.equal(result.statusCode, 201, result.body);
      return result.json().token as string;
    };
    const read = await token('read'),
      write = await token('write');
    const headers = (value: string) => ({
      authorization: `Bearer ${value}`,
      'x-trestl-api-only': 'true',
    });
    const boot = await app.inject({ url: '/api/v1/bootstrap', headers: headers(read) });
    assert.equal(boot.statusCode, 200, boot.body);
    assert.equal(boot.json().user.id, member.id);
    assert.equal(boot.json().projects.length, 1);
    assert.equal(
      (await app.inject({ url: `/api/v1/projects/${project.id}`, headers: headers(write) }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/items',
          headers: headers(read),
          payload: { title: 'Read-only denied' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/items',
          headers: headers(write),
          payload: { title: 'CLI task' },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/tokens',
          headers: headers(write),
          payload: { name: 'Escalation' },
        })
      ).statusCode,
      403,
    );
    const access = (who: ReturnType<typeof identity>, id: string, disabled: boolean) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/users/${id}/access`,
        headers: who,
        payload: { disabled },
      });
    assert.equal((await access(memberHeaders, admin.id, true)).statusCode, 403);
    assert.equal((await access(identity(), admin.id, true)).statusCode, 400);
    assert.equal((await access(identity(), member.id, true)).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: headers(write) })).statusCode,
      401,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: memberHeaders })).statusCode,
      403,
    );
    assert.equal((await access(identity(), member.id, false)).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: memberHeaders })).json().user.id,
      member.id,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: headers(write) })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('local mode ignores proxy identities and still requires its own login', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false, proxyAuth: null });
  try {
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: identity() })).statusCode,
      401,
    );
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Local',
        email: 'local@example.test',
        password: 'local-test-password',
        seedDemo: false,
      },
    });
    assert.equal(result.statusCode, 201, result.body);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bootstrap',
          headers: { cookie: result.cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('migration links existing accounts only with explicit consent and preserves project ownership', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-proxy-migration-'));
  let app = await createApp({ dataDir, integrations: false, proxyAuth: null });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Existing owner',
        email: 'admin@example.test',
        password: 'local-test-password',
        seedDemo: false,
      },
    });
    const original = setup.json();
    const initialCookie = setup.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const cookie = initialCookie;
    const installationId = original.workspaceId;
    const privateProject = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: { cookie },
        payload: { name: 'Existing private project', key: 'EXIST', visibility: 'private' },
      })
    ).json();
    const oldPersonalToken = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        headers: { cookie: initialCookie },
        payload: { name: 'Old personal' },
      })
    ).json().token;
    await app.close();
    app = await createApp({
      dataDir,
      integrations: false,
      proxyAuth: { ...config, installationId, linkExistingEmails: [] },
    });
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: identity() })).statusCode,
      409,
    );
    await app.close();
    app = await createApp({
      dataDir,
      integrations: false,
      proxyAuth: { ...config, installationId, linkExistingEmails: ['admin@example.test'] },
    });
    const migrated = await app.inject({ url: '/api/v1/bootstrap', headers: identity() });
    assert.equal(migrated.statusCode, 200, migrated.body);
    assert.equal(migrated.json().user.id, original.id);
    assert.equal(migrated.json().projects[0].id, privateProject.id);
    assert.equal(migrated.json().workspaces.length, 1);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/bootstrap',
          headers: { authorization: `Bearer ${oldPersonalToken}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: identity('another-subject') }))
        .statusCode,
      409,
    );
    await app.close();
    app = await createApp({
      dataDir,
      integrations: false,
      proxyAuth: { ...config, installationId, linkExistingEmails: [] },
    });
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: identity() })).json().user.id,
      original.id,
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
