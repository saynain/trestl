import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../shared/types.ts';
import { parentCandidates, parentBoardItems, childProgress } from '../src/lib/hierarchy.ts';
import { filterWorkItems } from '../src/lib/model.ts';
import { buildWorkTree, flattenWorkTree } from '../src/lib/work-tree.ts';

const item = (id: string, parentId: string | null = null, status = 'todo', assigneeId = 'me') =>
  ({ id, parentId, status, assigneeId, labels: [] }) as unknown as WorkItem;
const ids = (items: WorkItem[]) => items.map((item) => item.id);

test('parent candidates exclude selected subtrees including multiple levels and tolerate cycles', () => {
  const all = [item('a'), item('b', 'a'), item('c', 'b'), item('d'), item('e', 'd'), item('f')];
  assert.deepEqual(ids(parentCandidates(all, ['a'])), ['d', 'e', 'f']);
  assert.deepEqual(ids(parentCandidates(all, ['b'])), ['a', 'd', 'e', 'f']);
  assert.deepEqual(ids(parentCandidates(all, ['a', 'd'])), ['f']);
  assert.deepEqual(ids(parentCandidates([item('a', 'b'), item('b', 'a'), item('c')], ['a'])), [
    'c',
  ]);
});

test('hierarchy filters distinguish top level, parents, and direct children before building context', () => {
  const all = [
    item('root'),
    item('child', 'root'),
    item('grandchild', 'child'),
    item('done', 'root', 'done'),
    item('other'),
  ];
  assert.deepEqual(ids(filterWorkItems(all, 'me', { hierarchy: 'top-level' })), ['root', 'other']);
  assert.deepEqual(ids(filterWorkItems(all, 'me', { hierarchy: 'has-subtasks' })), [
    'root',
    'child',
  ]);
  assert.deepEqual(ids(filterWorkItems(all, 'me', { hierarchy: 'subtasks', parentId: 'root' })), [
    'child',
  ]);
  assert.deepEqual(
    ids(filterWorkItems(all, 'me', { hierarchy: 'subtasks', parentId: 'root' }, true)),
    ['child', 'done'],
  );
  assert.deepEqual(
    ids(filterWorkItems(all, 'me', { hierarchy: 'subtasks', parentId: 'root', status: 'done' })),
    ['done'],
  );
  const matches = filterWorkItems(all, 'me', { hierarchy: 'subtasks', parentId: 'child' });
  const tree = buildWorkTree(all, matches, all, true);
  assert.deepEqual(
    flattenWorkTree(tree.roots, new Set(tree.nodes.keys())).map(({ node }) => [
      node.item.id,
      node.matches,
    ]),
    [
      ['root', false],
      ['child', false],
      ['grandchild', true],
    ],
  );
  const top = filterWorkItems(all, 'me', { hierarchy: 'top-level' });
  const topTree = buildWorkTree(all, top, all, true);
  assert.deepEqual(
    flattenWorkTree(topTree.roots, new Set(['root'])).map(({ node }) => node.item.id),
    ['root', 'other'],
  );
});

test('has-subtasks counts authorized children outside a page scope but never pulls unrelated parents into matches', () => {
  const parent = item('parent');
  const children = [item('child', 'parent', 'todo', 'other'), item('done', 'parent', 'done')];
  assert.deepEqual(
    ids(
      filterWorkItems([parent], 'me', { hierarchy: 'has-subtasks' }, false, [parent, ...children]),
    ),
    ['parent'],
  );
  assert.deepEqual(
    ids(
      filterWorkItems([children[0]], 'me', { hierarchy: 'has-subtasks' }, false, [
        parent,
        ...children,
      ]),
    ),
    [],
  );
});

test('board parent counts preserve filtered or scoped-out children and completion totals include done', () => {
  const parent = item('parent');
  const child = item('child', 'parent');
  const done = item('done', 'parent', 'done');
  const orphan = item('orphan', 'missing');
  assert.deepEqual(ids(parentBoardItems([parent, child, done, orphan])), ['parent', 'orphan']);
  assert.deepEqual(ids(parentBoardItems([child, orphan])), ['child', 'orphan']);
  assert.deepEqual(childProgress([parent, child, done, orphan]).get('parent'), {
    total: 2,
    done: 1,
  });
});
