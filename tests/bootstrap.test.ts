import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBootstrapItems } from '../src/lib/bootstrap.ts';
import type { Bootstrap, WorkItem } from '../shared/types.ts';
const item = (id: string, revision: number, extra = {}): WorkItem =>
  ({
    id,
    revision,
    workspaceId: 'one',
    projectId: 'p',
    status: 'todo',
    milestoneId: 'm',
    ...extra,
  }) as WorkItem;
test('acknowledged writes preserve newer revisions, compute milestone progress and reject a prior workspace response', () => {
  const data = {
    user: { id: 'user', workspaceId: 'one' },
    items: [item('a', 3), item('b', 1)],
    milestones: [{ id: 'm', projectId: 'p' }],
  } as Bootstrap;
  const next = applyBootstrapItems(data, [
    item('a', 2, { status: 'done' }),
    item('b', 2, { status: 'done' }),
    item('c', 1),
    item('foreign', 1, { workspaceId: 'two' }),
  ]);
  assert.equal(next.items.find((i) => i.id === 'a')?.status, 'todo');
  assert.deepEqual(next.milestones[0].progress, { total: 3, done: 1, canceled: 0 });
  assert.equal(
    next.items.some((i) => i.id === 'foreign'),
    false,
  );
  assert.equal(data.items.length, 2);
  const removed = applyBootstrapItems(next, [], ['b']);
  assert.deepEqual(removed.milestones[0].progress, { total: 2, done: 0, canceled: 0 });
  const canceled = applyBootstrapItems(removed, [item('c', 2, { status: 'canceled' })]);
  assert.deepEqual(canceled.milestones[0].progress, { total: 1, done: 0, canceled: 1 });
});
