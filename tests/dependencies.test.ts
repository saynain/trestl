import { sharedWorkspace } from './shared-workspace-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Relation, WorkItem } from '../shared/types.ts';
import {
  blockingRelations,
  createsDependencyCycle,
  dependencyState,
  scheduleConflicts,
} from '../shared/dependencies.ts';
import { createApp } from '../server/app.ts';
const item = (id: string, startDate: string | null, dueDate: string | null, status = 'todo') =>
  ({ id, identifier: id, startDate, dueDate, status }) as WorkItem;
const link = (a: string, b: string, kind: Relation['kind'] = 'blocks'): Relation => ({
  id: `${a}-${b}`,
  itemId: a,
  targetId: b,
  kind,
});

test('dependencies are directional finish-to-start constraints with inclusive dates', () => {
  const a = item('a', '2026-09-01', '2026-09-05');
  assert.equal(dependencyState(a, item('b', '2026-09-05', '2026-09-09')), 'conflict');
  assert.equal(dependencyState(a, item('b', '2026-09-06', '2026-09-09')), 'waiting');
  assert.equal(dependencyState(a, item('b', null, '2026-09-05')), 'conflict');
  assert.equal(dependencyState(a, item('b', null, null)), 'undated');
  assert.equal(
    dependencyState(item('a', '2026-09-01', null), item('b', '2026-09-06', null)),
    'undated',
  );
  for (const status of ['done', 'canceled'])
    assert.equal(
      dependencyState({ ...a, status } as WorkItem, item('b', '2026-09-01', null)),
      'resolved',
    );
});
test('date edits check incoming and outgoing blockers across the full graph, ignoring related links', () => {
  const items = [
    item('a', '2026-09-01', '2026-09-05'),
    item('b', '2026-09-06', '2026-09-09'),
    item('c', '2026-09-10', '2026-09-12'),
  ];
  const links = [link('a', 'b'), link('b', 'c'), link('c', 'a', 'related')];
  assert.equal(
    scheduleConflicts({ ...items[1], startDate: '2026-09-04' }, items, links)[0].blocker.id,
    'a',
  );
  assert.equal(
    scheduleConflicts({ ...items[1], dueDate: '2026-09-10' }, items, links)[0].dependent.id,
    'c',
  );
  assert.equal(scheduleConflicts(items[1], items, links).length, 0);
  assert.equal(blockingRelations(links, [items[0], items[1]]).length, 1);
});
test('cycles are rejected transitively without treating related links as blockers', () => {
  const relations = [link('a', 'b'), link('b', 'c')];
  assert.equal(createsDependencyCycle(relations, 'c', 'a'), true);
  assert.equal(createsDependencyCycle(relations, 'a', 'c'), false);
  assert.equal(createsDependencyCycle([link('a', 'b', 'related')], 'b', 'a'), false);
});

test('API loads visible dependencies, guards schedules atomically and rejects cycles', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Planner',
        email: 'planner@example.test',
        password: 'dependency-test-password',
        seedDemo: false,
      },
    });
    const shared = await sharedWorkspace(app, setup);
    const cookie = `${shared.cookies[0].name}=${shared.cookies[0].value}`;
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: object,
      session = cookie,
    ) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie: session },
        ...(payload ? { payload } : {}),
      });
    const a = (await api('POST', '/items', { title: 'Build', dueDate: '2026-09-05' })).json();
    const b = (
      await api('POST', '/items', { title: 'Test', startDate: '2026-09-06', dueDate: '2026-09-09' })
    ).json();
    const c = (
      await api('POST', '/items', {
        title: 'Release',
        startDate: '2026-09-10',
        dueDate: '2026-09-12',
      })
    ).json();
    for (const [from, to] of [
      [a, b],
      [b, c],
    ])
      assert.equal(
        (await api('POST', `/items/${from.id}/relations`, { targetId: to.id, kind: 'blocks' }))
          .statusCode,
        201,
      );
    assert.equal((await api('GET', '/bootstrap')).json().relations.length, 2);
    assert.equal(
      (await api('POST', `/items/${c.id}/relations`, { targetId: a.id, kind: 'blocks' }))
        .statusCode,
      409,
    );
    assert.equal(
      (await api('POST', `/items/${c.id}/relations`, { targetId: a.id, kind: 'related' }))
        .statusCode,
      201,
    );
    assert.equal(
      (
        await api('PATCH', `/items/${b.id}`, {
          startDate: '2026-09-05',
          expectedRevision: b.revision,
        })
      ).statusCode,
      409,
    );
    assert.equal((await api('PATCH', `/items/${b.id}`, { dueDate: '2026-09-10' })).statusCode, 409);
    const unchanged = (await api('GET', `/items/${b.id}`)).json().item;
    assert.equal(unchanged.revision, b.revision);
    assert.equal(unchanged.startDate, '2026-09-06');
    assert.equal(
      (await api('PATCH', `/items/${b.id}`, { startDate: '2026-09-07' })).statusCode,
      200,
    );
    // A late relationship is observed even when the task revision hasn't changed.
    const d = (
      await api('POST', '/items', { title: 'Late dependency', dueDate: '2026-09-08' })
    ).json();
    await api('POST', `/items/${d.id}/relations`, { targetId: b.id, kind: 'blocks' });
    assert.equal(
      (await api('PATCH', `/items/${b.id}`, { startDate: '2026-09-08' })).statusCode,
      409,
    );
    await api('PATCH', `/items/${d.id}`, { status: 'done' });
    assert.equal(
      (await api('PATCH', `/items/${b.id}`, { startDate: '2026-09-08' })).statusCode,
      200,
    );
    // Private endpoints never appear in bootstrap or schedule error details.
    await api('POST', '/users', {
      name: 'Member',
      email: 'member@example.test',
      password: 'dependency-member-password',
    });
    const login = await api('POST', '/auth/login', {
      email: 'member@example.test',
      password: 'dependency-member-password',
    });
    assert.equal(login.statusCode, 200, login.body);
    const sessionCookie = login.cookies.find((cookie) => cookie.name === 'trestl_session')!;
    const member = `${sessionCookie.name}=${sessionCookie.value}`;
    const secret = (
      await api('POST', '/items', {
        title: 'Secret blocker',
        visibility: 'private',
        dueDate: '2026-09-09',
      })
    ).json();
    await api('POST', `/items/${secret.id}/relations`, { targetId: b.id, kind: 'blocks' });
    const bootstrapResponse = await api('GET', '/bootstrap', undefined, member);
    assert.equal(bootstrapResponse.statusCode, 200, bootstrapResponse.body);
    const bootstrap = bootstrapResponse.json();
    assert.equal(
      bootstrap.relations.some((r: Relation) => r.itemId === secret.id),
      false,
    );
    const denied = await api('PATCH', `/items/${b.id}`, { startDate: '2026-09-09' }, member);
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.body.includes(secret.identifier), false);
    assert.equal(denied.body.includes('Secret blocker'), false);
  } finally {
    await app.close();
  }
});
