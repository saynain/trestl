import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../shared/types.ts';
import { buildWorkTree, flattenWorkTree } from '../src/lib/work-tree.ts';

const item = (id: string, parentId: string | null = null, status = 'todo') =>
  ({ id, parentId, status }) as WorkItem;
const ids = (rows: ReturnType<typeof flattenWorkTree>) => rows.map(({ node }) => node.item.id);

test('parents collapse mixed-status children and expansion preserves sibling order without duplicates', () => {
  const child = item('child', 'parent', 'in_progress');
  const done = item('done', 'parent', 'done');
  const parent = item('parent');
  const standalone = item('standalone');
  const all = [child, done, parent, standalone];
  const tree = buildWorkTree(all, [child, parent, standalone], all);
  assert.deepEqual(ids(flattenWorkTree(tree.roots, new Set())), ['parent', 'standalone']);
  assert.deepEqual(ids(flattenWorkTree(tree.roots, new Set(['parent']))), [
    'parent',
    'child',
    'done',
    'standalone',
  ]);
  assert.equal(tree.nodes.get('parent')!.childCount, 2);
  assert.equal(tree.nodes.get('parent')!.completedChildren, 1);
});

test('multiple levels expand independently and retain the actual visible parent for keyboard navigation', () => {
  const all = [item('root'), item('child', 'root'), item('grandchild', 'child')];
  const tree = buildWorkTree(all, all, all);
  assert.deepEqual(ids(flattenWorkTree(tree.roots, new Set(['root']))), ['root', 'child']);
  const rows = flattenWorkTree(tree.roots, new Set(['root', 'child']));
  assert.deepEqual(
    rows.map(({ depth, parentId }) => [depth, parentId]),
    [
      [0, undefined],
      [1, 'root'],
      [2, 'child'],
    ],
  );
  assert.deepEqual(ids(flattenWorkTree(tree.roots, new Set(['child']))), ['root']);
});

test('search and filters retain ancestor context but exclude nonmatching sibling branches', () => {
  const all = [
    item('parent', null, 'done'),
    item('child', 'parent'),
    item('match', 'child'),
    item('sibling', 'parent'),
  ];
  const tree = buildWorkTree(all, [all[2]], all, true);
  assert.deepEqual(ids(flattenWorkTree(tree.roots, new Set(tree.nodes.keys()))), [
    'parent',
    'child',
    'match',
  ]);
  assert.equal(tree.nodes.get('parent')!.matches, false);
  assert.equal(tree.nodes.get('parent')!.childCount, 2);
  assert.equal(tree.nodes.get('parent')!.children.length, 1);
  assert.equal(tree.nodes.get('match')!.matches, true);
  assert.equal(buildWorkTree(all, [], all, true).roots.length, 0);
});

test('a scoped-out or unavailable parent never hides a matching child', () => {
  const parent = item('other-project');
  const child = item('child', parent.id);
  const missing = item('orphan', 'unavailable');
  const tree = buildWorkTree([child, missing], [child, missing], [parent, child, missing], true);
  assert.deepEqual(
    tree.roots.map(({ item }) => item.id),
    ['child', 'orphan'],
  );
  assert.equal(tree.nodes.has(parent.id), false);
});

test('expanding a parent includes accessible children outside the current scope, without unrelated work', () => {
  const parent = item('assigned-to-me');
  const child = item('assigned-to-colleague', parent.id);
  const all = [parent, child, item('unrelated')];
  const tree = buildWorkTree([parent], [parent], all);
  assert.deepEqual(ids(flattenWorkTree(tree.roots, new Set([parent.id]))), [parent.id, child.id]);
  const filtered = buildWorkTree([parent], [parent], all, true);
  assert.deepEqual(ids(flattenWorkTree(filtered.roots, new Set([parent.id]))), [parent.id]);
});

test('malformed cycles terminate and preserve each reachable item exactly once', () => {
  const all = [item('a', 'b'), item('b', 'a'), item('self', 'self')];
  const tree = buildWorkTree(all, all, all);
  const rows = flattenWorkTree(tree.roots, new Set(tree.nodes.keys()));
  assert.deepEqual(new Set(ids(rows)), new Set(['a', 'b', 'self']));
  assert.equal(rows.length, 3);
});
