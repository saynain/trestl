import test from 'node:test';
import assert from 'node:assert/strict';
import type { Bootstrap, SavedView, WorkItem } from '../shared/types.ts';
import {
  filteredItems,
  filterWorkItems,
  groupWorkItemsByTag,
  sortWorkItems,
  today,
  type Route,
} from '../src/lib/model.ts';
const user = {
  id: 'me',
  name: 'Alex',
  email: 'alex@example.com',
  role: 'member' as const,
  color: '#34775a',
};
function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    identifier: `TASK-${id}`,
    title: id,
    description: '',
    projectId: null,
    parentId: null,
    type: 'task',
    status: 'todo',
    priority: 'none',
    assigneeId: user.id,
    dueDate: null,
    followUpDate: null,
    recurrence: null,
    labels: [],
    visibility: 'workspace',
    creatorId: user.id,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    position: 1,
    ...overrides,
  };
}
function workspace(items: WorkItem[], filters: Record<string, string> = {}): Bootstrap {
  const view: SavedView = {
    id: 'saved',
    name: 'Saved',
    icon: 'bookmark',
    filters,
    layout: 'list',
    userId: user.id,
  };
  return { user, users: [user], items, views: [view], projects: [], links: [], milestones: [] };
}
const viewRoute: Route = { page: 'view', id: 'saved', tab: 'list' };

test('saved editable filters can be changed and cleared without retaining an upstream filter', () => {
  const data = workspace([item('high', { priority: 'high' }), item('low', { priority: 'low' })], {
    priority: 'high',
  });
  const scoped = filteredItems(data, viewRoute);
  assert.deepEqual(
    filterWorkItems(scoped, user.id, { priority: 'low' }).map((i) => i.id),
    ['low'],
  );
  assert.equal(filterWorkItems(scoped, user.id, {}).length, 2);
});

test('My work and Inbox retain completed records for the display toggle and explicit status filter', () => {
  const data = workspace([
    item('active'),
    item('done', { status: 'done' }),
    item('someone-else', { assigneeId: 'other', creatorId: 'other' }),
  ]);
  for (const page of ['my-work', 'inbox']) {
    const scoped = filteredItems(data, { page, tab: 'list' });
    assert.deepEqual(
      filterWorkItems(scoped, user.id, {}).map((i) => i.id),
      ['active'],
    );
    assert.deepEqual(
      filterWorkItems(scoped, user.id, {}, true).map((i) => i.id),
      ['active', 'done'],
    );
    assert.deepEqual(
      filterWorkItems(scoped, user.id, { status: 'done' }).map((i) => i.id),
      ['done'],
    );
  }
});

test('saved personal scopes do not widen to other people or project work', () => {
  const items = [
    item('mine'),
    item('other', { creatorId: 'other', assigneeId: 'other' }),
    item('project', { projectId: 'project' }),
  ];
  assert.deepEqual(
    filteredItems(workspace(items, { scope: 'inbox' }), viewRoute).map((i) => i.id),
    ['mine'],
  );
  assert.deepEqual(
    filteredItems(workspace(items, { scope: 'my-work' }), viewRoute).map((i) => i.id),
    ['mine', 'project'],
  );
});

test('search matches labels and descriptions identically in live and saved views', () => {
  const items = [
    item('label', { labels: ['Security'] }),
    item('description', { description: 'Security review' }),
    item('unrelated'),
  ];
  assert.deepEqual(
    filterWorkItems(items, user.id, { search: '  SECURITY  ' }).map((i) => i.id),
    ['label', 'description'],
  );
});

test('tag filters match whole tags case-insensitively and combine with other filters', () => {
  const items = [
    item('tagged', { labels: ['Security', 'Platform'], priority: 'high' }),
    item('other-priority', { labels: ['security'], priority: 'low' }),
    item('partial-tag', { labels: ['Security review'] }),
    item('title-only', { title: 'Security' }),
    item('completed', { labels: ['Security'], status: 'done' }),
  ];
  assert.deepEqual(
    filterWorkItems(items, user.id, { tag: 'SECURITY' }).map((i) => i.id),
    ['tagged', 'other-priority'],
  );
  assert.deepEqual(
    filterWorkItems(items, user.id, { tag: 'security', priority: 'high' }).map((i) => i.id),
    ['tagged'],
  );
  assert.deepEqual(
    filterWorkItems(items, user.id, { tag: 'security', status: 'done' }).map((i) => i.id),
    ['completed'],
  );
  assert.deepEqual(
    filterWorkItems(items, user.id, { untagged: 'true' }).map((i) => i.id),
    ['title-only'],
  );
  assert.deepEqual(filterWorkItems(items, user.id, { tag: 'missing' }), []);
});

test('saved tag filters can be changed and cleared within their original scope', () => {
  const data = workspace(
    [
      item('security', { labels: ['Security'] }),
      item('platform', { labels: ['Platform'] }),
      item('untagged'),
      item('outside-scope', { labels: ['Platform'], projectId: 'other-project' }),
    ],
    { scope: 'inbox', tag: 'security', groupBy: 'tag' },
  );
  const scoped = filteredItems(data, viewRoute);
  assert.deepEqual(
    filterWorkItems(scoped, user.id, data.views[0].filters).map((i) => i.id),
    ['security'],
  );
  assert.deepEqual(
    filterWorkItems(scoped, user.id, { tag: 'platform' }).map((i) => i.id),
    ['platform'],
  );
  assert.deepEqual(
    filterWorkItems(scoped, user.id, { untagged: 'true' }).map((i) => i.id),
    ['untagged'],
  );
  assert.equal(filterWorkItems(scoped, user.id, {}).length, 3);
});

test('tag groups include every membership once, merge casing, and preserve item order', () => {
  const items = [
    item('shared', { labels: ['Security', 'Platform', 'SECURITY'] }),
    item('platform', { labels: ['platform'] }),
    item('plain'),
    item('named-no-tags', { labels: ['No tags'] }),
  ];
  const groups = groupWorkItemsByTag(items);
  assert.deepEqual(
    groups.map((group) => ({
      id: group.id,
      name: group.name,
      items: group.items.map((i) => i.id),
    })),
    [
      { id: 'tag:no tags', name: 'No tags', items: ['named-no-tags'] },
      { id: 'tag:platform', name: 'Platform', items: ['shared', 'platform'] },
      { id: 'tag:security', name: 'Security', items: ['shared'] },
      { id: 'untagged', name: 'No tags', items: ['plain'] },
    ],
  );
  assert.deepEqual(groupWorkItemsByTag([]), []);
  assert.deepEqual(items[0].labels, ['Security', 'Platform', 'SECURITY']);
});

test('upcoming deadlines exclude overdue and completed work and sort by deadline', () => {
  const data = workspace(
    [
      item('future', { dueDate: '9999-01-01', position: 1 }),
      item('today', { dueDate: today(), position: 9 }),
      item('overdue', { dueDate: '2000-01-01' }),
      item('done', { dueDate: today(), status: 'done' }),
    ],
    { due: 'upcoming' },
  );
  assert.deepEqual(
    sortWorkItems(filteredItems(data, viewRoute), { due: 'upcoming' }).map((i) => i.id),
    ['today', 'future'],
  );
});

test('follow-up order is independent of delivery deadlines and does not mutate source arrays', () => {
  const items = [
    item('later', { followUpDate: '2026-09-20', dueDate: '2026-09-01', position: 1 }),
    item('first', { followUpDate: '2026-09-10', dueDate: '2026-12-01', position: 8 }),
  ];
  assert.deepEqual(
    sortWorkItems(items, { followUp: 'true' }).map((i) => i.id),
    ['first', 'later'],
  );
  assert.equal(items[0].id, 'later');
});

test('a missing saved view does not silently become all workspace work', () => {
  assert.deepEqual(filteredItems(workspace([item('mine')]), { ...viewRoute, id: 'removed' }), []);
});

test('source filters distinguish native items, providers, and individual repository connections', () => {
  const source = {
    provider: 'gitea' as const,
    integrationId: 'gitea-one',
    repository: 'team/platform',
    number: 42,
    url: 'https://git.example.test/team/platform/issues/42',
    state: 'open' as const,
    lastSyncedAt: null,
    connected: true,
  };
  const items = [
    item('native'),
    item('manual-link', { externalUrl: 'https://example.test/reference' }),
    item('gitea-one', { source }),
    item('gitea-two', { source: { ...source, integrationId: 'gitea-two', connected: false } }),
    item('github', { source: { ...source, provider: 'github', integrationId: 'github' } }),
  ];
  const ids = (source: string) =>
    filterWorkItems(items, user.id, { source }).map((item) => item.id);
  assert.deepEqual(ids('native'), ['native', 'manual-link']);
  assert.deepEqual(ids('gitea'), ['gitea-one', 'gitea-two']);
  assert.deepEqual(ids('github'), ['github']);
  assert.deepEqual(ids('integration:gitea-two'), ['gitea-two']);
  assert.deepEqual(ids('integration:deleted'), []);
  const data = workspace(items, { source: 'native' });
  assert.deepEqual(
    filterWorkItems(filteredItems(data, viewRoute), user.id, { source: 'github' }).map(
      (item) => item.id,
    ),
    ['github'],
  );
});

test('search finds original issue references without treating arbitrary links as integrations', () => {
  const linked = item('linked', {
    source: {
      provider: 'gitea',
      integrationId: 'connection',
      repository: 'basis/kubernetes',
      number: 42,
      url: 'https://git.example.test/basis/kubernetes/issues/42',
      state: 'closed',
      lastSyncedAt: null,
      connected: true,
    },
  });
  for (const search of ['basis/kubernetes #42', 'GITEA', '#42']) {
    assert.deepEqual(
      filterWorkItems([item('native'), linked], user.id, { search }).map((item) => item.id),
      ['linked'],
    );
  }
});

test('personal inbox captures appear in Home, My work, and saved My work without assigning them', () => {
  const data = workspace(
    [
      item('unassigned-capture', { assigneeId: null }),
      item('assigned-project', { projectId: 'project', creatorId: 'other' }),
      item('delegated', { assigneeId: 'other' }),
      item('other-capture', { creatorId: 'other', assigneeId: null }),
      item('unassigned-project', { projectId: 'project', assigneeId: null }),
    ],
    { scope: 'my-work' },
  );
  for (const route of [
    { page: 'home', tab: 'list' },
    { page: 'my-work', tab: 'list' },
    viewRoute,
  ]) {
    assert.deepEqual(
      filteredItems(data, route).map((i) => i.id),
      ['unassigned-capture', 'assigned-project'],
    );
  }
});

test('milestone filters include legacy unassigned items and compose with existing filters', () => {
  const items = [
    item('legacy'),
    item('empty', { milestoneId: null }),
    item('linked', { milestoneId: 'm' }),
    item('done', { milestoneId: 'm', status: 'done' }),
  ];
  assert.deepEqual(
    filterWorkItems(items, user.id, { milestoneId: 'null' }).map((i) => i.id),
    ['legacy', 'empty'],
  );
  assert.deepEqual(
    filterWorkItems(items, user.id, { milestoneId: 'm' }).map((i) => i.id),
    ['linked'],
  );
  assert.deepEqual(
    filterWorkItems(items, user.id, { milestoneId: 'm', status: 'done' }).map((i) => i.id),
    ['done'],
  );
});
