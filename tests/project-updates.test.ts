import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { Project, ProjectUpdate } from '../shared/types.ts';
import {
  latestProjectUpdates,
  latestProjectUpdate,
  reviewProjects,
  updateIsStale,
} from '../src/lib/project-updates.ts';

test('updates persist with authenticated authors, validate content, respect project access and clean up', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Lead',
        email: 'lead@updates.test',
        password: 'test-project-updates',
        seedDemo: false,
      },
    });
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const client =
      (auth: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
        app.inject({
          method,
          url: '/api/v1' + path,
          headers: { cookie: auth },
          ...(payload ? { payload } : {}),
        });
    const api = client(cookie);
    const member = (
      await api('POST', '/users', {
        name: 'Member',
        email: 'member@updates.test',
        password: 'test-project-updates',
      })
    ).json();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: member.email, password: 'test-project-updates' },
    });
    const other = client(`${login.cookies[0].name}=${login.cookies[0].value}`);
    const project = (
      await api('POST', '/projects', { key: 'UPD', name: 'Updates', visibility: 'private' })
    ).json();
    const path = `/projects/${project.id}/updates`;
    for (const payload of [
      { health: 'bad', body: 'Hello' },
      { health: 'on_track', body: '  ' },
      { health: 'at_risk', body: 'a'.repeat(20001) },
    ])
      assert.equal((await api('POST', path, payload)).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1' + path })).statusCode, 401);
    const first = await api('POST', path, {
      health: 'at_risk',
      body: '  Waiting for review  ',
      authorId: member.id,
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().body, 'Waiting for review');
    assert.notEqual(first.json().authorId, member.id);
    assert.equal((await other('GET', path)).statusCode, 404);
    assert.equal(
      (await other('POST', path, { health: 'on_track', body: 'No access' })).statusCode,
      404,
    );
    assert.equal((await other('GET', '/bootstrap')).json().projectUpdates.length, 0);
    await api('PATCH', `/projects/${project.id}`, { memberIds: [member.id] });
    const second = await other('POST', path, { health: 'on_track', body: 'Review complete' });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().authorId, member.id);
    const updates = (await api('GET', path)).json().data;
    assert.equal(updates.length, 2);
    assert.equal(updates[0].body, 'Review complete');
    assert.equal((await api('GET', `/projects/${project.id}`)).json().status, 'active');
    await api('PATCH', `/projects/${project.id}`, { memberIds: [] });
    assert.equal((await other('GET', '/bootstrap')).json().projectUpdates.length, 0);
    assert.equal((await api('DELETE', `/projects/${project.id}`)).statusCode, 204);
    assert.equal(
      (await app.getDecorator<AppContext>('context').store.list('projectUpdates')).length,
      0,
    );
  } finally {
    await app.close();
  }
});

test('weekly review uses latest health, flags seven-day updates and excludes inactive projects', () => {
  const projects = ['risk', 'ok', 'missing', 'old', 'planned', 'completed', 'archived'].map(
    (id) =>
      ({
        id,
        name: id,
        status: ['planned', 'completed', 'archived'].includes(id) ? id : 'active',
      }) as Project,
  );
  const update = (
    id: string,
    health: ProjectUpdate['health'],
    createdAt: string,
  ): ProjectUpdate => ({ id, projectId: id, health, createdAt, authorId: 'lead', body: 'Update' });
  const updates = [
    update('risk', 'off_track', new Date().toISOString()),
    update('ok', 'on_track', new Date().toISOString()),
    update('old', 'on_track', '2020-01-01T00:00:00Z'),
  ];
  assert.deepEqual(
    reviewProjects(projects, updates).map((p) => p.id),
    ['risk', 'missing', 'old', 'ok'],
  );
  const stale = update('x', 'on_track', '2026-09-01T00:00:00Z');
  assert.equal(updateIsStale(stale, Date.parse('2026-09-08T00:00:00Z')), true);
  assert.equal(updateIsStale(stale, Date.parse('2026-09-07T23:59:59Z')), false);
  assert.equal(
    latestProjectUpdate(
      [stale, { ...stale, id: 'new', health: 'off_track', createdAt: '2026-09-02T00:00:00Z' }],
      'x',
    )?.health,
    'off_track',
  );
});

test('latest update index retains chronology and imported tie-break order without mutating history', () => {
  const old: ProjectUpdate = {
    id: 'old',
    projectId: 'one',
    authorId: 'author',
    health: 'off_track',
    body: 'Old',
    createdAt: '2026-09-01T10:00:00Z',
  };
  const current: ProjectUpdate = {
    ...old,
    id: 'new',
    health: 'on_track',
    createdAt: '2026-09-02T12:00:00+02:00',
  };
  const tied: ProjectUpdate = {
    ...current,
    id: 'aaa',
    sortKey: 'zzz',
    createdAt: '2026-09-02T10:00:00Z',
  };
  const other = { ...old, projectId: 'two' };
  const history = [current, old, tied, other];
  const before = structuredClone(history);
  const latest = latestProjectUpdates(history);
  assert.equal(latest.get('one'), tied);
  assert.equal(latest.get('two'), other);
  assert.equal(latest.get('missing'), undefined);
  assert.deepEqual(history, before);
  const projects = [
    { id: 'one', name: 'One', status: 'active' },
    { id: 'two', name: 'Two', status: 'active' },
  ] as Project[];
  assert.deepEqual(
    reviewProjects(projects, latest, Date.parse('2026-09-03T00:00:00Z')).map((p) => p.id),
    ['two', 'one'],
  );
});
