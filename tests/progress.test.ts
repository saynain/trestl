import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bootstrap, Status, WorkItem } from '../shared/types.ts';
import { workProgress } from '../shared/progress.ts';
import { progressLabel, projectItems, projectProgress } from '../src/lib/progress.ts';

const item = (id: string, status: Status, projectId: string | null = 'root') =>
  ({ id, status, projectId }) as WorkItem;

test('progress counts only done as completed and reports canceled work separately', () => {
  const progress = workProgress([
    item('done', 'done'),
    item('canceled', 'canceled'),
    item('todo', 'todo'),
    item('review', 'in_review'),
    item('backlog', 'backlog'),
  ]);
  assert.deepEqual(progress, { total: 4, done: 1, open: 3, canceled: 1 });
  assert.equal(progressLabel(progress), '1 of 4 done · 1 canceled');
  assert.equal(progressLabel(workProgress([item('done', 'done')])), '1 of 1 done');
  assert.deepEqual(workProgress([]), { total: 0, done: 0, open: 0, canceled: 0 });
  assert.deepEqual(workProgress([item('a', 'done'), item('a', 'done'), item('b', 'canceled')]), {
    total: 1,
    done: 1,
    open: 0,
    canceled: 1,
  });
});

test('project progress includes subprojects and related work once per item', () => {
  const data = {
    projects: [
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
      { id: 'grandchild', parentId: 'child' },
      { id: 'other', parentId: null },
    ],
    items: [
      item('root-done', 'done'),
      item('root-canceled', 'canceled'),
      item('child-open', 'in_progress', 'child'),
      item('grandchild-done', 'done', 'grandchild'),
      item('owned-and-related', 'todo', 'child'),
      item('related-twice', 'done', 'other'),
      item('related-canceled', 'canceled', 'other'),
      item('unrelated', 'done', 'other'),
      item('inbox', 'todo', null),
    ],
    projectRelations: [
      { id: 'r1', itemId: 'owned-and-related', projectId: 'root' },
      { id: 'r2', itemId: 'related-twice', projectId: 'child' },
      { id: 'r3', itemId: 'related-twice', projectId: 'grandchild' },
      { id: 'r4', itemId: 'related-canceled', projectId: 'grandchild' },
      { id: 'r5', itemId: 'unrelated', projectId: 'missing' },
    ],
  } as Bootstrap;
  assert.deepEqual(
    projectItems(data, 'root')
      .map((i) => i.id)
      .sort(),
    [
      'child-open',
      'grandchild-done',
      'owned-and-related',
      'related-canceled',
      'related-twice',
      'root-canceled',
      'root-done',
    ],
  );
  // Canceled work used to count as done in All projects but not in Overview.
  assert.deepEqual(projectProgress(data, 'root'), { total: 5, done: 3, open: 2, canceled: 2 });
  assert.deepEqual(projectProgress(data, 'child'), { total: 4, done: 2, open: 2, canceled: 1 });
  assert.deepEqual(projectProgress(data, 'grandchild'), {
    total: 2,
    done: 2,
    open: 0,
    canceled: 1,
  });
  assert.deepEqual(projectProgress(data, 'other'), { total: 2, done: 2, open: 0, canceled: 1 });
  assert.deepEqual(projectProgress({ ...data, items: [...data.items, ...data.items] }, 'root'), {
    total: 5,
    done: 3,
    open: 2,
    canceled: 2,
  });
});
