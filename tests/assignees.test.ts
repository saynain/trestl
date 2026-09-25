import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { cookieOf } from './installation-fixture.ts';
import { assigneeOptions } from '../src/lib/assignees.ts';
import type { User } from '../shared/types.ts';

test('assignment options exclude disabled people, preserve current ownership, and distinguish names', () => {
  const users: User[] = [
    { id: 'active', name: 'Alex', email: 'alex@work.test', role: 'member', color: '#123456' },
    {
      id: 'disabled',
      name: 'Alex',
      email: 'alex@old.test',
      role: 'member',
      color: '#123456',
      disabledAt: '2026-09-12',
    },
  ];
  assert.deepEqual(assigneeOptions(users), [
    { id: 'active', label: 'Alex · alex@work.test', disabled: false },
  ]);
  assert.deepEqual(assigneeOptions(users, 'disabled')[1], {
    id: 'disabled',
    label: 'Alex · alex@old.test (disabled)',
    disabled: true,
  });
  assert.equal(assigneeOptions(users, 'active').length, 1);
  delete users[1].disabledAt;
  assert.equal(assigneeOptions(users).length, 2);
});

test('disabled accounts cannot receive new assignments while their existing work remains editable', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false, proxyAuth: null });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@assignment.test',
        password: 'assignment-test-password',
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const headers = { cookie: cookieOf(setup) };
    const api = (
      method: 'POST' | 'PATCH' | 'GET',
      path: string,
      payload?: Record<string, unknown>,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    const created = await api('POST', '/users', {
      name: 'Colleague',
      email: 'colleague@assignment.test',
      password: 'assignment-test-password',
    });
    assert.equal(created.statusCode, 201, created.body);
    const assigneeId = created.json().id;
    const assigned = await api('POST', '/items', {
      title: 'Existing work',
      assigneeId,
      recurrence: 'weekly',
    });
    assert.equal(assigned.statusCode, 201, assigned.body);
    const itemId = assigned.json().id;
    const unassigned = await api('POST', '/items', { title: 'Unassigned work' });
    assert.equal(unassigned.statusCode, 201, unassigned.body);
    const disabled = await api('PATCH', `/users/${assigneeId}/access`, { disabled: true });
    assert.equal(disabled.statusCode, 200, disabled.body);
    for (const result of [
      await api('POST', '/items', { title: 'New assignment', assigneeId }),
      await api('PATCH', `/items/${unassigned.json().id}`, { assigneeId }),
    ]) {
      assert.equal(result.statusCode, 400, result.body);
      assert.match(result.json().message, /disabled.*active assignee/i);
    }
    const unchanged = await api('GET', `/items/${unassigned.json().id}`);
    assert.equal(unchanged.json().item.assigneeId, null);
    const edit = await api('PATCH', `/items/${itemId}`, { title: 'Still editable', assigneeId });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().item.assigneeId, assigneeId);
    const completed = await api('PATCH', `/items/${itemId}`, { status: 'done' });
    assert.equal(completed.statusCode, 200, completed.body);
    const bootstrap = (await api('GET', '/bootstrap')).json();
    assert.ok(bootstrap.users.find((u: User) => u.id === assigneeId)?.disabledAt);
    const next = bootstrap.items.find(
      (item: { id: string; title: string }) =>
        item.title === 'Still editable' && item.id !== itemId,
    );
    assert.ok(next, 'Recurring follow-up created');
    assert.equal(next.assigneeId, null, 'New recurrence must not inherit a disabled assignee');
    const cleared = await api('PATCH', `/items/${itemId}`, { assigneeId: null });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().item.assigneeId, null);
    const reassigned = await api('PATCH', `/items/${itemId}`, { assigneeId: setup.json().id });
    assert.equal(reassigned.statusCode, 200, reassigned.body);
    assert.equal(reassigned.json().item.assigneeId, setup.json().id);
    assert.equal(
      (await api('PATCH', `/users/${assigneeId}/access`, { disabled: false })).statusCode,
      200,
    );
    assert.equal(
      (await api('POST', '/items', { title: 'Enabled again', assigneeId })).statusCode,
      201,
    );
    assert.equal((await api('PATCH', `/items/${itemId}`, { assigneeId })).statusCode, 200);
  } finally {
    await app.close();
  }
});
