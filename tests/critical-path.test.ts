import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem, Relation } from '../shared/types.ts';
import { criticalPath } from '../src/lib/critical-path.ts';
const item = (id: string, duration: number): WorkItem =>
  ({
    id,
    identifier: id,
    startDate: '2026-09-01',
    dueDate: `2026-09-${String(duration).padStart(2, '0')}`,
    status: 'todo',
  }) as WorkItem;
const edge = (a: string, b: string): Relation => ({
  id: `${a}-${b}`,
  itemId: a,
  targetId: b,
  kind: 'blocks',
});

test('CPM calculates float through branches and excludes non-driving shortcut edges', () => {
  const items = [item('a', 3), item('b', 5), item('c', 2), item('d', 2)];
  const result = criticalPath(items, items, [
    edge('a', 'b'),
    edge('a', 'c'),
    edge('b', 'd'),
    edge('c', 'd'),
    edge('a', 'd'),
  ]);
  assert.equal(result.duration, 10);
  assert.deepEqual([...result.criticalIds].sort(), ['a', 'b', 'd']);
  assert.equal(result.float.get('c'), 3);
  assert.deepEqual([...result.criticalRelations].sort(), ['a-b', 'b-d']);
  assert.equal(result.status, 'ready');
});
test('equal critical branches are all highlighted and disconnected work shares a project finish', () => {
  const items = [item('a', 3), item('b', 3), item('c', 1)];
  const tied = criticalPath(items, items, [edge('a', 'c'), edge('b', 'c')]);
  assert.equal(tied.criticalIds.size, 3);
  const bigger = [...items, item('d', 7)];
  const result = criticalPath(bigger, bigger, [edge('a', 'c'), edge('b', 'c')]);
  assert.deepEqual([...result.criticalIds], ['d']);
  assert.equal(result.float.get('a'), 3);
});
test('critical path includes visible upstream work, ignores completed work and related edges', () => {
  const items = [
    item('external', 4),
    item('project', 2),
    { ...item('done', 20), status: 'done' as const },
    item('unrelated', 25),
  ];
  const result = criticalPath([items[1]], items, [
    edge('external', 'project'),
    edge('done', 'external'),
    { ...edge('unrelated', 'project'), kind: 'related' },
  ]);
  assert.equal(result.duration, 6);
  assert.equal(result.externalCount, 1);
  assert.equal(result.criticalIds.has('external'), true);
  assert.equal(result.criticalIds.has('unrelated'), false);
});
test('missing durations are explicit and cycles stop the entire calculation', () => {
  const items = [item('a', 3), { ...item('b', 2), dueDate: null }];
  const partial = criticalPath(items, items, [edge('a', 'b')]);
  assert.equal(partial.status, 'partial');
  assert.equal(partial.excluded[0].id, 'b');
  assert.equal(partial.duration, 3);
  const cycle = criticalPath(items, items, [edge('a', 'b'), edge('b', 'a')]);
  assert.equal(cycle.status, 'cycle');
  assert.equal(cycle.criticalIds.size, 0);
  assert.equal(criticalPath([items[1]], items, []).status, 'empty');
});
test('single-date points last one calendar day and date boundaries use calendar arithmetic', () => {
  const a = { ...item('a', 2), startDate: '2026-12-30', dueDate: '2027-01-02' };
  const b = { ...item('b', 1), startDate: null, dueDate: '2027-01-04' };
  const result = criticalPath([a, b], [a, b], [edge('a', 'b')]);
  assert.equal(result.duration, 5);
  assert.equal(result.float.get('b'), 0);
});
