import test from 'node:test';
import assert from 'node:assert/strict';
import { workItemOptions } from '../src/lib/work-item-options.ts';

const projects = [
  { id: 'alpha', name: 'Alpha project', key: 'ALP' },
  { id: 'beta', name: 'Beta project', key: 'BET' },
];
const items = [
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `other-${index}`,
    identifier: `BET-${index + 1}`,
    title: `Matching task ${index}`,
    projectId: 'beta',
  })),
  { id: 'self', identifier: 'ALP-1', title: 'Matching source', projectId: 'alpha' },
  { id: 'local-1', identifier: 'ALP-2', title: 'Matching local one', projectId: 'alpha' },
  { id: 'local-2', identifier: 'ALP-3', title: 'Matching local two', projectId: 'alpha' },
  { id: 'inbox', identifier: 'INB-1', title: 'Inbox task', projectId: null },
];

test('current project leads the default and searched suggestions before limiting results', () => {
  const originalOrder = items.map((item) => item.id);
  for (const query of ['', 'MaTCHing']) {
    const options = workItemOptions(items, projects, {
      projectId: 'alpha',
      excludeItemId: 'self',
      query,
      limit: 8,
    });
    assert.deepEqual(
      options.map((option) => option.id),
      ['local-1', 'local-2', ...Array.from({ length: 6 }, (_, index) => `other-${index}`)],
    );
    assert.equal(options[0].detail, 'Matching local one · Alpha project (ALP)');
    assert.equal(options[2].detail, 'Matching task 0 · Beta project (BET)');
  }
  assert.deepEqual(
    items.map((item) => item.id),
    originalOrder,
    'Do not reorder bootstrap data',
  );
});

test('cross-project results remain searchable by title, identifier and project context', () => {
  for (const query of ['BET-12', 'matching task 11', 'Beta project']) {
    const options = workItemOptions(items, projects, { projectId: 'alpha', query });
    assert.ok(options.some((option) => option.id === 'other-11'));
    assert.ok(options.every((option) => option.projectId === 'beta'));
  }
  assert.deepEqual(workItemOptions(items, projects, { projectId: 'alpha', query: 'absent' }), []);
});

test('all eligible relationship choices remain available and keep stable order in each group', () => {
  const options = workItemOptions(items, projects, { projectId: 'alpha', excludeItemId: 'self' });
  assert.deepEqual(
    options.map((option) => option.id),
    ['local-1', 'local-2', ...Array.from({ length: 12 }, (_, index) => `other-${index}`), 'inbox'],
  );
  assert.equal(options.at(-1)?.detail, 'Inbox task · Personal inbox');
  assert.deepEqual(workItemOptions([], projects, { projectId: 'alpha' }), []);
});

test('no project context retains existing global order; changing project changes priority', () => {
  for (const projectId of [undefined, null]) {
    assert.deepEqual(
      workItemOptions(items, projects, { projectId }).map((option) => option.id),
      items.map((item) => item.id),
    );
  }
  assert.equal(workItemOptions(items, projects, { projectId: 'beta', limit: 1 })[0].id, 'other-0');
});
