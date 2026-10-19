import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkItem } from '../shared/types.ts';
import {
  boardMoveUpdates,
  defaultBoardPreferences,
  moveColumn,
  parseBoardPreferences,
  readBoardPreferences,
  saveBoardPreferences,
} from '../src/lib/board.ts';

const item = (id: string, position: number, status = 'todo'): WorkItem =>
  ({ id, position, status, createdAt: '2026-01-01' }) as WorkItem;

test('board settings validate saved views and recover missing, duplicate, and unknown columns', () => {
  assert.deepEqual(parseBoardPreferences('{broken'), defaultBoardPreferences());
  const parsed = parseBoardPreferences(
    JSON.stringify({
      columns: [
        { id: 'todo', name: '  Ready  ', hidden: true },
        { id: 'todo', name: 'Duplicate' },
        { id: 'unknown' },
        { id: 'done', name: '' },
      ],
      compact: true,
      showLabels: false,
    }),
  );
  assert.equal(parsed.columns.length, 6);
  assert.deepEqual(parsed.columns[0], { id: 'todo', name: 'Ready', hidden: true });
  assert.equal(parsed.columns[1].name, 'Done');
  assert.equal(parsed.compact, true);
  assert.equal(parsed.showLabels, false);
  assert.equal(new Set(parsed.columns.map((entry) => entry.id)).size, 6);
});

test('board columns default to workflow order and keep saved orders', () => {
  const workflow = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];
  assert.deepEqual(
    defaultBoardPreferences().columns.map((column) => column.id),
    workflow,
  );
  assert.deepEqual(
    defaultBoardPreferences().columns.map((column) => column.name),
    ['Backlog', 'Todo', 'In progress', 'In review', 'Done', 'Canceled'],
  );
  assert.deepEqual(
    parseBoardPreferences(null).columns.map((column) => column.id),
    workflow,
  );
  const saved = parseBoardPreferences(
    JSON.stringify({
      columns: [
        { id: 'in_progress', name: 'In progress' },
        { id: 'todo', name: 'Todo' },
        { id: 'in_review', name: 'In review' },
        { id: 'backlog', name: 'Backlog' },
        { id: 'done', name: 'Done' },
        { id: 'canceled', name: 'Canceled' },
      ],
    }),
  );
  assert.deepEqual(
    saved.columns.map((column) => column.id),
    ['in_progress', 'todo', 'in_review', 'backlog', 'done', 'canceled'],
  );
  const partial = parseBoardPreferences(
    JSON.stringify({ columns: [{ id: 'done', name: 'Shipped' }, { id: 'todo' }] }),
  );
  assert.deepEqual(
    partial.columns.map((column) => column.id),
    ['done', 'todo', 'backlog', 'in_progress', 'in_review', 'canceled'],
  );
});

test('column ordering moves both directions without losing names or visibility', () => {
  const columns = defaultBoardPreferences().columns;
  columns[0].name = 'Working';
  columns[0].hidden = true;
  const moved = moveColumn(columns, 'backlog', 'in_review');
  assert.deepEqual(
    moved.map((column) => column.id),
    ['todo', 'in_progress', 'in_review', 'backlog', 'done', 'canceled'],
  );
  assert.deepEqual(moveColumn(moved, 'backlog', 'todo'), columns);
  assert.equal(moveColumn(columns, 'missing', 'todo'), columns);
});

test('board preferences persist per scope with saved view fallback and blocked storage recovery', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const settings = { ...defaultBoardPreferences(true), compact: true };
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    saveBoardPreferences('user-a:project-a', settings);
    assert.deepEqual(readBoardPreferences('user-a:project-a'), settings);
    assert.deepEqual(readBoardPreferences('user-a:project-b'), defaultBoardPreferences());
    assert.deepEqual(readBoardPreferences('user-b:project-a'), defaultBoardPreferences());
    assert.deepEqual(readBoardPreferences('saved-view', JSON.stringify(settings)), settings);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage blocked');
      },
    });
    assert.doesNotThrow(() => saveBoardPreferences('key', settings));
    assert.deepEqual(readBoardPreferences('key', JSON.stringify(settings)), settings);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('card moves persist a rank before, between, after, and across status columns', () => {
  const a = item('a', 100),
    b = item('b', 200),
    c = item('c', 300);
  assert.equal(boardMoveUpdates([a, b, c], c, 'todo', 'a')[0].position, -924);
  assert.equal(boardMoveUpdates([a, b, c], c, 'todo', 'b')[0].position, 150);
  assert.equal(boardMoveUpdates([a, b, c], a, 'todo', null)[0].position, 1324);
  assert.deepEqual(boardMoveUpdates([a, b, c], c, 'in_review', null), [
    { item: c, status: 'in_review', position: 0 },
  ]);
  assert.deepEqual(boardMoveUpdates([a, b, c], b, 'todo', 'c'), []);
  assert.deepEqual(boardMoveUpdates([a, b, c], c, 'todo', null), []);
  assert.deepEqual(boardMoveUpdates([a, b, c], c, 'todo', 'missing'), []);
});

test('tied or exhausted ranks rebalance in the requested order and preserve other columns', () => {
  for (const positions of [
    [1, 1],
    [1, 1 + Number.EPSILON],
  ]) {
    const a = item('a', positions[0]),
      b = item('b', positions[1]),
      c = item('c', 500),
      other = item('other', 20, 'in_progress');
    const updates = boardMoveUpdates([a, b, c, other], c, 'todo', 'b');
    assert.deepEqual(
      updates.map(({ item: entry, position }) => [entry.id, position]),
      [
        ['a', 0],
        ['c', 1024],
        ['b', 2048],
      ],
    );
  }
});

test('collapsed subtasks default off and round trip with saved board preferences', () => {
  assert.equal(defaultBoardPreferences().collapseSubtasks, false);
  const preferences = { ...defaultBoardPreferences(), collapseSubtasks: true };
  assert.deepEqual(parseBoardPreferences(JSON.stringify(preferences)), preferences);
  assert.equal(
    parseBoardPreferences(JSON.stringify({ ...preferences, collapseSubtasks: 'yes' }))
      .collapseSubtasks,
    false,
  );
});
