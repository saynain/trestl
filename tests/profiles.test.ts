import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
test('one installation shares projects while keeping private work and API access per user', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        installationName: 'Example Team',
        name: 'Admin',
        email: 'admin@example.test',
        password: 'test-password-123',
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = cookieOf(setup);
    const call = (method: any, path: string, payload?: unknown, auth = cookie) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie: auth },
        ...(payload ? { payload } : {}),
      });
    const login = await memberSession(app, cookie, {
      name: 'Member',
      email: 'member@example.test',
      password: 'test-password-123',
    });
    const member = cookieOf(login);
    const privateItem = (
      await call('POST', '/items', { title: 'Private follow-up', visibility: 'private' })
    ).json();
    const project = (
      await call('POST', '/projects', { key: 'TEAM', name: 'Ongoing platform' })
    ).json();
    assert.equal((await call('GET', `/projects/${project.id}`, undefined, member)).statusCode, 200);
    assert.equal(
      (await call('GET', `/items/${privateItem.id}`, undefined, member)).statusCode,
      404,
    );
    const boot = (await call('GET', '/bootstrap', undefined, member)).json();
    assert.equal(boot.workspace.name, 'Example Team');
    assert.equal(boot.workspaces.length, 1);
    assert.equal(boot.user.role, 'member');
    assert.equal(boot.user.personalWorkspaceId, undefined);
    assert.equal((await call('POST', '/workspaces', { name: 'Another' })).statusCode, 410);
    assert.equal((await call('POST', '/auth/profiles', {})).statusCode, 410);
    assert.equal(
      (await call('POST', '/auth/switch', { userId: setup.json().id }, member)).statusCode,
      410,
    );
    assert.equal((await call('POST', '/auth/register', {})).statusCode, 403);
    const token = (await call('POST', '/tokens', { name: 'CLI', scope: 'write' }, member)).json()
      .token;
    const viaToken = () =>
      app.inject({ url: '/api/v1/bootstrap', headers: { authorization: `Bearer ${token}` } });
    assert.equal((await viaToken()).json().user.id, boot.user.id);
    assert.equal((await call('GET', '/admin/authentication', undefined, member)).statusCode, 403);
    assert.equal(
      (await call('PATCH', `/users/${boot.user.id}/access`, { disabled: true })).statusCode,
      200,
    );
    assert.equal((await viaToken()).statusCode, 401);
    assert.equal((await call('GET', '/bootstrap', undefined, member)).statusCode, 401);
    assert.equal(
      (await call('PATCH', `/users/${setup.json().id}/access`, { disabled: true })).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
