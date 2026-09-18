import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import { openapi } from '../server/openapi.ts';

test('item relations expose both directions and display metadata without disclosing private endpoints', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Relation owner',
        email: 'relations@example.test',
        password: 'relations-test-password',
        seedDemo: false,
      },
    });
    const cookie = cookieOf(setup);
    const member = cookieOf(
      await memberSession(app, cookie, {
        name: 'Relation reader',
        email: 'reader@example.test',
        password: 'relations-reader-password',
      }),
    );
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: object,
      session = cookie,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie: session },
        ...(payload ? { payload } : {}),
      });
    const makeItem = async (title: string, extra = {}) => {
      const response = await api('POST', '/items', { title, ...extra });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    };
    const a = await makeItem('Prepare');
    const b = await makeItem('Release');
    const c = await makeItem('Public context');
    const hidden = await makeItem('Secret plan', { visibility: 'private' });
    const makeRelation = async (from: string, to: string, kind: 'blocks' | 'related') => {
      const response = await api('POST', `/items/${from}/relations`, { targetId: to, kind });
      assert.equal(response.statusCode, 201, response.body);
      const relation = response.json();
      assert.match(relation.id, /^[0-9a-f-]{36}$/);
      assert.deepEqual(
        { itemId: relation.itemId, targetId: relation.targetId, kind: relation.kind },
        { itemId: from, targetId: to, kind },
      );
      return relation;
    };
    const incoming = await makeRelation(a.id, b.id, 'blocks');
    const outgoing = await makeRelation(b.id, c.id, 'related');
    await makeRelation(hidden.id, b.id, 'blocks');
    await makeRelation(b.id, hidden.id, 'related');
    assert.deepEqual(
      await makeRelation(a.id, b.id, 'blocks'),
      incoming,
      'Creating the same relation returns its stable id',
    );
    const visible = await api(
      'GET',
      `/items/${b.identifier.toLowerCase()}/relations`,
      undefined,
      member,
    );
    assert.equal(visible.statusCode, 200, visible.body);
    assert.deepEqual(
      visible.json().data.sort((x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id)),
      [
        {
          ...incoming,
          direction: 'incoming',
          relatedItem: { id: a.id, identifier: a.identifier, title: a.title },
        },
        {
          ...outgoing,
          direction: 'outgoing',
          relatedItem: { id: c.id, identifier: c.identifier, title: c.title },
        },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    assert.equal((await api('GET', `/items/${b.id}/relations`)).json().data.length, 4);
    assert.equal(
      (await api('GET', `/items/${hidden.id}/relations`, undefined, member)).statusCode,
      404,
    );
    assert.equal((await api('GET', '/items/missing/relations')).statusCode, 404);
    assert.equal((await app.inject(`/api/v1/items/${b.id}/relations`)).statusCode, 401);
    const isolated = await makeItem('No links');
    assert.deepEqual((await api('GET', `/items/${isolated.id}/relations`)).json(), { data: [] });
    const update = await api('PATCH', `/items/${b.identifier}`, {
      title: 'Ship it',
      expectedRevision: b.revision,
    });
    assert.equal(update.statusCode, 200, update.body);
    const updated = update.json().item;
    assert.equal(updated.title, 'Ship it');
    assert.equal(updated.revision, b.revision + 1);
    assert.deepEqual(updated, (await api('GET', `/items/${b.id}`)).json().item);
    const next = await api('PATCH', `/items/${b.id}`, {
      status: 'done',
      expectedRevision: updated.revision,
    });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().item.revision, updated.revision + 1);
    assert.equal(
      (await api('PATCH', `/items/${b.id}`, { title: 'Stale', expectedRevision: updated.revision }))
        .statusCode,
      409,
    );
    const refreshed = (await api('GET', `/items/${a.id}/relations`, undefined, member)).json()
      .data[0];
    assert.equal(refreshed.relatedItem.title, 'Ship it');
    assert.equal((await api('DELETE', `/items/${b.id}/relations/${incoming.id}`)).statusCode, 204);
    assert.deepEqual((await api('GET', `/items/${a.id}/relations`)).json(), { data: [] });
  } finally {
    await app.close();
  }
});

test('OpenAPI documents item mutation envelopes, relation reads and revision preconditions', () => {
  const paths = openapi.paths as Record<string, Record<string, any>>;
  const deletion = paths['/items/{id}'].delete;
  assert.equal(deletion.requestBody.required, false);
  assert.equal(
    deletion.requestBody.content['application/json'].schema.properties.expectedRevision.maximum,
    2147483646,
  );
  assert.deepEqual(deletion.requestBody.content['application/json'].schema.required, []);
  assert.match(deletion.description, /stale revision returns 409/);
  assert.doesNotMatch(deletion.description, /return the new revision/);
  assert.deepEqual(
    paths['/items/{id}'].patch.responses['200'].content['application/json'].schema.properties.item,
    { $ref: '#/components/schemas/WorkItem' },
  );
  assert.equal(
    paths['/items/{id}/relations'].get.responses['200'].content['application/json'].schema
      .properties.data.items.$ref,
    '#/components/schemas/RelationDetail',
  );
  assert.equal(
    paths['/items/{id}/relations'].post.responses['201'].content['application/json'].schema.$ref,
    '#/components/schemas/Relation',
  );
  for (const methods of Object.values(paths)) {
    for (const operation of Object.values(methods)) {
      if (operation.requestBody?.content['application/json'].schema.properties?.expectedRevision) {
        assert.match(operation.description, /expectedRevision/);
        assert.match(operation.description, /409/);
      }
    }
  }
});
