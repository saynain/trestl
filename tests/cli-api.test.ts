import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { WorkItem } from '../shared/types.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('CLI API supports project keys, filtering, revisions and durable, scoped retry keys', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'CLI owner',
        email: 'cli@example.test',
        password: 'cli-test-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const tokenResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: 'CLI', scope: 'write' },
    });
    const authorization = `Bearer ${tokenResponse.json().token}`;
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: object,
      key?: string,
      auth = authorization,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { authorization: auth, ...(key ? { 'idempotency-key': key } : {}) },
        ...(payload ? { payload } : {}),
      });
    const project = (await api('POST', '/projects', { key: 'CLI', name: 'CLI project' })).json();
    assert.equal((await api('GET', '/projects/cli')).json().id, project.id);
    const payload = { title: 'Deploy upgrade', projectId: project.id, priority: 'high' };
    const created = await api('POST', '/items', payload, 'capture-1');
    assert.equal(created.statusCode, 201, created.body);
    const item = created.json();
    assert.equal(item.revision, 1);
    const replay = await api('POST', '/items', payload, 'capture-1');
    assert.deepEqual(replay.json(), item);
    const changedPayload = await api(
      'POST',
      '/items',
      { ...payload, title: 'Different' },
      'capture-1',
    );
    assert.equal(changedPayload.statusCode, 409);
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        api('POST', '/items', { title: 'Concurrent capture' }, 'capture-concurrent'),
      ),
    );
    assert.equal(new Set(concurrent.map((r) => r.json().id)).size, 1);
    assert.ok(concurrent.every((r) => r.statusCode === 201));
    await api('POST', '/items', {
      title: 'Deploy follow-up',
      projectId: project.id,
      priority: 'high',
    });
    const page = (await api('GET', '/items?q=Deploy&projectId=cli&priority=high&limit=1')).json();
    assert.equal(page.data.length, 1);
    assert.equal(page.nextCursor, '1');
    const next = (
      await api(
        'GET',
        `/items?q=Deploy&projectId=cli&priority=high&limit=1&cursor=${page.nextCursor}`,
      )
    ).json();
    assert.equal(next.data.length, 1);
    assert.notEqual(next.data[0].id, page.data[0].id);
    assert.equal((await api('GET', '/items?limit=0')).statusCode, 400);
    assert.equal((await api('GET', '/items?cursor=garbage')).statusCode, 400);
    const detail = (await api('GET', `/items/${item.identifier.toLowerCase()}`)).json();
    assert.equal(detail.item.id, item.id);
    const races = await Promise.all(
      ['in_progress', 'done'].map((status) =>
        api('PATCH', `/items/${item.identifier}`, { status, expectedRevision: 1 }),
      ),
    );
    assert.deepEqual(races.map((r) => r.statusCode).sort(), [200, 409]);
    const latest = (await api('GET', `/items/${item.id}`)).json().item;
    assert.equal(latest.revision, 2);
    const context = (app as unknown as { context: AppContext }).context;
    // A write through another client/integration also invalidates the revision.
    const integrationWrite = await context.store.put('items', {
      ...latest,
      description: 'Updated outside the CLI',
    });
    assert.equal(integrationWrite.revision, 3);
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { title: 'Stale overwrite', expectedRevision: 2 }))
        .statusCode,
      409,
    );
    await assert.rejects(
      context.store.put('items', { ...latest, title: 'Race at storage layer' }, 2),
      /Work item changed/,
    );
    const legacy = { ...integrationWrite };
    delete legacy.revision;
    await context.db.query(
      "UPDATE entities SET data=$1::jsonb WHERE collection='items' AND id=$2",
      [JSON.stringify(legacy), item.id],
    );
    const legacyUpdate = await api('PATCH', `/items/${item.id}`, {
      priority: 'low',
      expectedRevision: 0,
    });
    assert.equal(legacyUpdate.statusCode, 200, legacyUpdate.body);
    assert.equal(legacyUpdate.json().revision, 1);
    const comments = await Promise.all(
      Array.from({ length: 2 }, () =>
        api('POST', `/items/${item.identifier}/comments`, { body: 'Retry-safe note' }, 'note-1'),
      ),
    );
    assert.equal(comments[0].json().id, comments[1].json().id);
    assert.equal(
      (await api('POST', `/items/${item.id}/comments`, { body: 'Changed note' }, 'note-1'))
        .statusCode,
      409,
    );
    // Same key belongs to a different user/workspace and cannot reveal or replay this user's item.
    const profile = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/profiles',
      headers: { cookie },
      payload: {
        name: 'Other account',
        email: 'other-cli@example.test',
        password: 'another-cli-password',
      },
    });
    assert.equal(profile.statusCode, 201, profile.body);
    const otherCookie = profile.cookies.find((c) => c.name === 'trestl_session')!;
    const otherToken = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie: `${otherCookie.name}=${otherCookie.value}` },
      payload: { name: 'Other CLI', scope: 'write' },
    });
    const otherAuth = `Bearer ${otherToken.json().token}`;
    assert.equal(
      (await api('GET', `/items/${item.identifier}`, undefined, undefined, otherAuth)).statusCode,
      404,
    );
    const other = await api('POST', '/items', { title: 'Own task' }, 'capture-1', otherAuth);
    assert.equal(other.statusCode, 201, other.body);
    assert.notEqual(other.json().id, item.id);
    // Replays never recreate deleted items.
    assert.equal((await api('DELETE', `/items/${item.id}`)).statusCode, 204);
    assert.equal((await api('POST', '/items', payload, 'capture-1')).statusCode, 404);
    assert.equal(
      (await context.store.list<WorkItem>('items')).some((i) => i.id === item.id),
      false,
    );
  } finally {
    await app.close();
  }
});

test('retry records and item revisions survive a server restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-cli-restart-'));
  let app = await createApp({ dataDir, integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Restart test',
        email: 'restart@example.test',
        password: 'restart-test-password',
        seedDemo: false,
      },
    });
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const headers = { cookie, 'idempotency-key': 'persistent-create' };
    const payload = { title: 'Survives restart' };
    const created = await app.inject({ method: 'POST', url: '/api/v1/items', headers, payload });
    assert.equal(created.statusCode, 201, created.body);
    const item = created.json();
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/items/${item.id}`,
      headers: { cookie },
      payload: { status: 'in_progress', expectedRevision: 1 },
    });
    await app.close();
    app = await createApp({ dataDir, integrations: false });
    const replay = await app.inject({ method: 'POST', url: '/api/v1/items', headers, payload });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.deepEqual(replay.json(), item);
    const current = (
      await app.inject({ method: 'GET', url: `/api/v1/items/${item.id}`, headers: { cookie } })
    ).json().item;
    assert.equal(current.revision, 2);
    assert.equal(current.status, 'in_progress');
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/items', headers: { cookie } })).json().data
        .length,
      1,
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
