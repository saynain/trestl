import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';

test('item deletion validates observed revisions and preserves related data on conflict', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'delete@example.test',
        password: 'delete-test-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const api = (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: object) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    const item = (await api('POST', '/items', { title: 'Delete safely' })).json();
    const child = (await api('POST', '/items', { title: 'Child', parentId: item.id })).json();
    await api('POST', `/items/${item.id}/comments`, { body: 'Keep this on conflict' });
    const before = await api('GET', `/items/${item.id}`);
    for (const expectedRevision of [-1, 1.5, '1', 2147483647]) {
      const invalid = await api('DELETE', `/items/${item.id}`, { expectedRevision });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    const conflict = await api('DELETE', `/items/${item.id}`, {
      expectedRevision: item.revision + 1,
    });
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.deepEqual((await api('GET', `/items/${item.id}`)).json(), before.json());
    const hasChildren = await api('DELETE', `/items/${item.id}`, {
      expectedRevision: item.revision,
    });
    assert.equal(hasChildren.statusCode, 409, hasChildren.body);
    assert.match(hasChildren.json().message, /subtasks/);
    assert.equal(
      (await api('DELETE', `/items/${child.id}`, { expectedRevision: child.revision })).statusCode,
      204,
    );
    assert.equal(
      (await api('DELETE', `/items/${item.identifier}`, { expectedRevision: item.revision }))
        .statusCode,
      204,
    );
    assert.equal((await api('GET', `/items/${item.id}`)).statusCode, 404);
    const legacy = (await api('POST', '/items', { title: 'Legacy client' })).json();
    assert.equal((await api('DELETE', `/items/${legacy.id}`)).statusCode, 204);
  } finally {
    await app.close();
  }
});
