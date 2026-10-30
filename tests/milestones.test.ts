import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';

test('milestone edits persist, increment revisions, reject stale drags and retain project access checks', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Planner',
        email: 'planner@example.test',
        password: 'milestone-test-password',
        seedDemo: false,
      },
    });
    const cookie = setup.cookies.find((c) => c.name === 'trestl_session')!;
    const api = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie: `${cookie.name}=${cookie.value}` },
        ...(payload ? { payload } : {}),
      });
    const project = (
      await api('POST', '/projects', { key: 'DEMO', name: 'Milestone demo' })
    ).json();
    const original = (
      await api('POST', '/milestones', {
        projectId: project.id,
        title: 'Launch',
        dueDate: '2026-09-30',
      })
    ).json();
    assert.equal(original.revision, 1);
    const moved = await api('PATCH', `/milestones/${original.id}`, {
      dueDate: '2026-10-02',
      expectedRevision: 1,
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().revision, 2);
    assert.equal(
      (
        await api('PATCH', `/milestones/${original.id}`, {
          dueDate: '2026-10-03',
          expectedRevision: 1,
        })
      ).statusCode,
      409,
    );
    const edited = await api('PATCH', `/milestones/${original.id}`, {
      title: 'Public launch',
      completed: true,
      dueDate: null,
      expectedRevision: 2,
    });
    assert.equal(edited.statusCode, 200);
    const persisted = (await api('GET', '/milestones')).json().data[0];
    assert.equal(persisted.title, 'Public launch');
    assert.equal(persisted.completed, true);
    assert.equal(persisted.dueDate, null);
    assert.equal(
      (
        await api('PATCH', `/milestones/${original.id}`, {
          dueDate: 'not-a-date',
          expectedRevision: 3,
        })
      ).statusCode,
      400,
    );
    // Old clients continue to work but still advance the revision for new clients.
    const compatible = await api('PATCH', `/milestones/${original.id}`, { completed: false });
    assert.equal(compatible.json().revision, 4);
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/milestones/${original.id}`,
      payload: { title: 'No access', expectedRevision: 4 },
    });
    assert.equal(denied.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('linked work drives visible milestone progress, validates scope, clears assignments, and retries safely', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Planner',
        email: 'links@example.test',
        password: 'milestone-test-password',
        seedDemo: false,
      },
    });
    const cookie = setup.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: object,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie, ...headers },
        ...(payload ? { payload } : {}),
      });
    const p = (await api('POST', '/projects', { key: 'LINK', name: 'Linked work' })).json();
    const other = (await api('POST', '/projects', { key: 'OTHER', name: 'Other project' })).json();
    const input = { projectId: p.id, title: 'Release' };
    const m = (
      await api('POST', '/milestones', input, { 'idempotency-key': 'release-once' })
    ).json();
    assert.equal(
      (await api('POST', '/milestones', input, { 'idempotency-key': 'release-once' })).json().id,
      m.id,
    );
    assert.equal(
      (
        await api(
          'POST',
          '/milestones',
          { ...input, title: 'Different' },
          { 'idempotency-key': 'release-once' },
        )
      ).statusCode,
      409,
    );
    const next = (await api('POST', '/milestones', { projectId: other.id, title: 'Next' })).json();
    for (const invalid of [
      { projectId: other.id, milestoneId: m.id },
      { milestoneId: m.id },
      { projectId: p.id, milestoneId: '00000000-0000-4000-8000-000000000000' },
    ]) {
      assert.equal((await api('POST', '/items', { title: 'Invalid', ...invalid })).statusCode, 400);
    }
    const active = (
      await api('POST', '/items', { title: 'Active', projectId: p.id, milestoneId: m.id })
    ).json();
    const done = (
      await api('POST', '/items', {
        title: 'Done',
        status: 'done',
        projectId: p.id,
        milestoneId: m.id,
      })
    ).json();
    const canceled = (
      await api('POST', '/items', {
        title: 'Canceled',
        status: 'canceled',
        projectId: p.id,
        milestoneId: m.id,
      })
    ).json();
    await api('POST', '/items', {
      title: 'Private',
      visibility: 'private',
      projectId: p.id,
      milestoneId: m.id,
    });
    let detail = (await api('GET', `/milestones/${m.id}`)).json();
    // Canceled work is reported separately, never as done or as remaining scope.
    assert.deepEqual(detail.progress, { total: 3, done: 1, canceled: 1 });
    assert.ok(detail.itemIds.includes(done.id));
    assert.equal(detail.completed, false);
    assert.equal((await api('GET', `/items?milestoneId=${m.id}`)).json().data.length, 4);
    assert.equal((await api('GET', `/items?milestoneId=null`)).json().data.length, 0);
    assert.equal(
      (await api('PATCH', `/milestones/${m.id}`, { projectId: other.id })).statusCode,
      409,
    );
    assert.equal(
      (await api('PATCH', `/items/${active.id}`, { milestoneId: next.id })).statusCode,
      400,
    );
    await api('PATCH', `/items/${active.id}`, { projectId: other.id });
    assert.equal((await api('GET', `/items/${active.id}`)).json().item.milestoneId, null);
    await api('PATCH', `/items/${active.id}`, { projectId: p.id, milestoneId: m.id });
    await api('PATCH', `/items/${active.id}`, { projectId: other.id, milestoneId: next.id });
    assert.deepEqual((await api('GET', `/milestones/${next.id}`)).json().progress, {
      total: 1,
      done: 0,
      canceled: 0,
    });
    await api('PATCH', `/items/${canceled.id}`, { milestoneId: null });
    detail = (await api('GET', `/milestones/${m.id}`)).json();
    assert.deepEqual(detail.progress, { total: 2, done: 1, canceled: 0 });
    // Progress and linked IDs must not leak private work to another project member.
    const { memberSession, cookieOf } = await import('./installation-fixture.ts');
    const member = await memberSession(app, cookie, {
      name: 'Member',
      email: 'member@milestone.test',
      password: 'milestone-test-password',
    });
    const visible = (
      await api('GET', `/milestones/${m.id}`, undefined, { cookie: cookieOf(member) })
    ).json();
    assert.deepEqual(visible.progress, { total: 1, done: 1, canceled: 0 });
    assert.deepEqual(visible.itemIds, [done.id]);
    const before = (await api('GET', `/items/${done.id}`)).json().item;
    assert.equal((await api('DELETE', `/milestones/${m.id}`)).statusCode, 204);
    const after = (await api('GET', `/items/${done.id}`)).json().item;
    assert.equal(after.milestoneId, null);
    assert.ok(after.revision > (before.revision ?? 0));
    assert.equal(
      (
        await api('PATCH', `/items/${done.id}`, {
          title: 'Stale edit',
          expectedRevision: before.revision,
        })
      ).statusCode,
      409,
    );
    assert.equal((await api('GET', `/milestones/${m.id}`)).statusCode, 404);
    assert.equal(
      (await api('POST', '/milestones', input, { 'idempotency-key': 'release-once' })).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test('milestones list by due date with undated last, then title, then id', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Planner',
        email: 'planner@example.test',
        password: 'milestone-test-password',
        seedDemo: false,
      },
    });
    const cookie = setup.cookies.find((c) => c.name === 'trestl_session')!;
    const api = (method: 'GET' | 'POST', path: string, payload?: object) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie: `${cookie.name}=${cookie.value}` },
        ...(payload ? { payload } : {}),
      });
    const project = (await api('POST', '/projects', { key: 'ORD', name: 'Ordering' })).json();
    // Created out of date order so the result cannot match insertion order.
    for (const [title, dueDate] of [
      ['Someday', undefined],
      ['GA', '2026-12-01'],
      ['Beta', '2026-10-15'],
      ['Alpha', '2026-10-15'],
      ['Kickoff', '2026-09-01'],
      ['Backlog', undefined],
    ] as const) {
      const created = await api('POST', '/milestones', {
        projectId: project.id,
        title,
        ...(dueDate ? { dueDate } : {}),
      });
      assert.equal(created.statusCode, 201, created.body);
    }
    const expected = ['Kickoff', 'Alpha', 'Beta', 'GA', 'Backlog', 'Someday'];
    const listed = (await api('GET', '/milestones')).json().data;
    assert.deepEqual(
      listed.map((m: { title: string }) => m.title),
      expected,
    );
    const bootstrap = (await api('GET', '/bootstrap')).json();
    assert.deepEqual(
      bootstrap.milestones.map((m: { title: string }) => m.title),
      expected,
    );
  } finally {
    await app.close();
  }
});
