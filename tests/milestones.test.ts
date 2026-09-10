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
