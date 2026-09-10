import test from 'node:test';
import assert from 'node:assert/strict';
import { dayNumber, dateAt, scheduleRange, shiftSchedule } from '../src/lib/gantt.ts';
import { createApp } from '../server/app.ts';

test('timeline uses calendar days across DST, month and year boundaries', () => {
  assert.equal(dateAt(dayNumber('2026-03-28') + 2), '2026-03-30');
  assert.deepEqual(shiftSchedule({ startDate: '2026-12-29', dueDate: '2027-01-02' }, 4, 'move'), {
    startDate: '2027-01-02',
    dueDate: '2027-01-06',
  });
  assert.deepEqual(shiftSchedule({ dueDate: '2026-09-09' }, -1, 'move'), {
    startDate: null,
    dueDate: '2026-09-08',
  });
  assert.equal(scheduleRange({ dueDate: null }), null);
});

test('resizing clamps crossed ends and can give a due-only task a start date', () => {
  assert.deepEqual(shiftSchedule({ startDate: '2026-09-09', dueDate: '2026-09-12' }, 20, 'start'), {
    startDate: '2026-09-12',
    dueDate: '2026-09-12',
  });
  assert.deepEqual(shiftSchedule({ startDate: '2026-09-09', dueDate: '2026-09-12' }, -20, 'end'), {
    startDate: '2026-09-09',
    dueDate: '2026-09-09',
  });
  assert.deepEqual(shiftSchedule({ dueDate: '2026-09-12' }, -3, 'start'), {
    startDate: '2026-09-09',
    dueDate: '2026-09-12',
  });
});

test('item schedules persist, validate partial updates, protect revisions and recur', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Planner',
        email: 'planner@example.test',
        password: 'timeline-test-password',
        seedDemo: false,
      },
    });
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const request = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    assert.equal(
      (
        await request('POST', '/items', {
          title: 'Invalid range',
          startDate: '2026-09-12',
          dueDate: '2026-09-09',
        })
      ).statusCode,
      400,
    );
    const created = await request('POST', '/items', {
      title: 'Scheduled',
      startDate: '2026-09-09',
      dueDate: '2026-09-12',
      recurrence: 'weekly',
    });
    assert.equal(created.statusCode, 201, created.body);
    const item = created.json();
    assert.equal(
      (await request('PATCH', `/items/${item.id}`, { dueDate: '2026-09-08' })).statusCode,
      400,
    );
    const moved = await request('PATCH', `/items/${item.id}`, {
      startDate: '2026-09-10',
      dueDate: '2026-09-13',
      expectedRevision: item.revision,
    });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await request('GET', `/items/${item.id}`)).json().item.startDate, '2026-09-10');
    assert.equal(
      (
        await request('PATCH', `/items/${item.id}`, {
          startDate: null,
          expectedRevision: item.revision,
        })
      ).statusCode,
      409,
    );
    assert.equal((await request('PATCH', `/items/${item.id}`, { status: 'done' })).statusCode, 200);
    const next = (await request('GET', '/bootstrap'))
      .json()
      .items.find((entry: { id: string }) => entry.id !== item.id);
    assert.equal(next.startDate, '2026-09-17');
    assert.equal(next.dueDate, '2026-09-20');
    const monthly = (
      await request('POST', '/items', {
        title: 'Month-end schedule',
        startDate: '2026-01-31',
        dueDate: '2026-01-31',
        recurrence: 'monthly',
      })
    ).json();
    await request('PATCH', `/items/${monthly.id}`, { status: 'done' });
    const february = (await request('GET', '/bootstrap'))
      .json()
      .items.find(
        (entry: { title: string; status: string }) =>
          entry.title === 'Month-end schedule' && entry.status === 'todo',
      );
    assert.equal(february.startDate, '2026-02-28');
    await request('PATCH', `/items/${february.id}`, { status: 'done' });
    const march = (await request('GET', '/bootstrap'))
      .json()
      .items.find(
        (entry: { title: string; status: string }) =>
          entry.title === 'Month-end schedule' && entry.status === 'todo',
      );
    assert.equal(march.startDate, '2026-03-31');
    assert.equal(march.dueDate, '2026-03-31');
    const cleared = await request('PATCH', `/items/${item.id}`, { startDate: null, dueDate: null });
    assert.equal(cleared.json().startDate, null);
    assert.equal(cleared.json().dueDate, null);
  } finally {
    await app.close();
  }
});
