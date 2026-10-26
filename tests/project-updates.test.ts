import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { Bootstrap, Project, ProjectUpdate, WorkItem } from '../shared/types.ts';
import {
  latestProjectUpdates,
  latestProjectUpdate,
  reviewProjects,
  updateIsStale,
  projectReviewEvidence,
  projectEvidenceDraft,
  projectDraftEvidence,
} from '../src/lib/project-updates.ts';

test('updates persist with authenticated authors, validate content, respect project access and clean up', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Lead',
        email: 'lead@updates.test',
        password: 'test-project-updates',
        seedDemo: false,
      },
    });
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const client =
      (auth: string) =>
      (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
        app.inject({
          method,
          url: '/api/v1' + path,
          headers: { cookie: auth },
          ...(payload ? { payload } : {}),
        });
    const api = client(cookie);
    const member = (
      await api('POST', '/users', {
        name: 'Member',
        email: 'member@updates.test',
        password: 'test-project-updates',
      })
    ).json();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: member.email, password: 'test-project-updates' },
    });
    const other = client(`${login.cookies[0].name}=${login.cookies[0].value}`);
    const project = (
      await api('POST', '/projects', { key: 'UPD', name: 'Updates', visibility: 'private' })
    ).json();
    const path = `/projects/${project.id}/updates`;
    for (const payload of [
      { health: 'bad', body: 'Hello' },
      { health: 'on_track', body: '  ' },
      { health: 'at_risk', body: 'a'.repeat(20001) },
    ])
      assert.equal((await api('POST', path, payload)).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1' + path })).statusCode, 401);
    const first = await api('POST', path, {
      health: 'at_risk',
      body: '  Waiting for review  ',
      authorId: member.id,
    });
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().body, 'Waiting for review');
    assert.notEqual(first.json().authorId, member.id);
    assert.equal((await other('GET', path)).statusCode, 404);
    assert.equal(
      (await other('POST', path, { health: 'on_track', body: 'No access' })).statusCode,
      404,
    );
    assert.equal((await other('GET', '/bootstrap')).json().projectUpdates.length, 0);
    await api('PATCH', `/projects/${project.id}`, { memberIds: [member.id] });
    const second = await other('POST', path, { health: 'on_track', body: 'Review complete' });
    assert.equal(second.statusCode, 201, second.body);
    assert.equal(second.json().authorId, member.id);
    const updates = (await api('GET', path)).json().data;
    assert.equal(updates.length, 2);
    assert.equal(updates[0].body, 'Review complete');
    assert.equal((await api('GET', `/projects/${project.id}`)).json().status, 'active');
    await api('PATCH', `/projects/${project.id}`, { memberIds: [] });
    assert.equal((await other('GET', '/bootstrap')).json().projectUpdates.length, 0);
    assert.equal((await api('DELETE', `/projects/${project.id}`)).statusCode, 204);
    assert.equal(
      (await app.getDecorator<AppContext>('context').store.list('projectUpdates')).length,
      0,
    );
  } finally {
    await app.close();
  }
});

test('review evidence uses completion dates, live dependencies and calendar deadlines across visible subprojects', () => {
  const now = new Date(2026, 9, 5, 12).getTime();
  const item = (id: string, changes: Partial<WorkItem> = {}): WorkItem => ({
    id,
    identifier: `REV-${id}`,
    title: id,
    description: '',
    projectId: 'root',
    parentId: null,
    type: 'task',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    followUpDate: null,
    recurrence: null,
    labels: [],
    visibility: 'workspace',
    creatorId: 'lead',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
    completedAt: null,
    position: 0,
    ...changes,
  });
  const data = {
    projects: [
      { id: 'root', parentId: null },
      { id: 'child', parentId: 'root' },
      { id: 'other', parentId: null },
    ],
    projectUpdates: [
      { id: 'update', projectId: 'root', createdAt: new Date(2026, 9, 1, 12).toISOString() },
    ],
    items: [
      item('completed', {
        status: 'done',
        completedAt: new Date(2026, 9, 2, 12).toISOString(),
        projectId: 'child',
      }),
      item('old', { status: 'done', completedAt: new Date(2026, 8, 30, 12).toISOString() }),
      item('reopened', { status: 'todo', completedAt: new Date(2026, 9, 3, 12).toISOString() }),
      item('canceled', { status: 'canceled', dueDate: '2026-10-01' }),
      item('late', { dueDate: '2026-10-04' }),
      item('today', { dueDate: '2026-10-05' }),
      item('week', { dueDate: '2026-10-12' }),
      item('later', { dueDate: '2026-10-13' }),
      item('external', { projectId: 'other', dueDate: '2026-10-02' }),
      item('linked', { projectId: 'other', dueDate: '2026-10-03' }),
      item('resolved', { status: 'done' }),
    ],
    projectRelations: [{ itemId: 'linked', projectId: 'root' }],
    relations: [
      { id: 'blocking', itemId: 'external', targetId: 'today', kind: 'blocks' },
      { id: 'done', itemId: 'resolved', targetId: 'week', kind: 'blocks' },
      { id: 'related', itemId: 'late', targetId: 'week', kind: 'related' },
      { id: 'hidden', itemId: 'invisible', targetId: 'today', kind: 'blocks' },
      { id: 'other', itemId: 'late', targetId: 'external', kind: 'blocks' },
    ],
    milestones: [
      { id: 'slip', title: 'Launch', projectId: 'child', dueDate: '2026-10-04', completed: false },
      { id: 'done', projectId: 'root', dueDate: '2026-10-04', completed: true },
      { id: 'today', projectId: 'root', dueDate: '2026-10-05', completed: false },
      { id: 'external', projectId: 'other', dueDate: '2026-10-04', completed: false },
    ],
  } as Bootstrap;
  const evidence = projectReviewEvidence(data, 'root', now);
  assert.equal(evidence.includesSubprojects, true);
  assert.deepEqual(
    evidence.completed.map((i) => i.id),
    ['completed'],
  );
  assert.deepEqual(
    evidence.overdue.map((i) => i.id),
    ['linked', 'late'],
  );
  assert.deepEqual(
    evidence.upcoming.map((i) => i.id),
    ['today', 'week'],
  );
  assert.deepEqual(
    evidence.blockers.map((r) => r.relation.id),
    ['blocking'],
  );
  assert.deepEqual(
    evidence.slippedMilestones.map((m) => m.id),
    ['slip'],
  );
  const draft = projectEvidenceDraft(evidence, data, 'root');
  assert.match(draft, /REV-completed/);
  assert.match(draft, /REV-today waits on REV-external/);
  assert.match(draft, /choose the project health/);
  assert.doesNotMatch(draft, /REV-old/);
  const noUpdate = projectReviewEvidence({ ...data, projectUpdates: [] }, 'root', now);
  assert.equal(Date.parse(noUpdate.since), now - 7 * 86400000);
  assert.deepEqual(
    noUpdate.completed.map((i) => i.id),
    ['completed', 'old'],
  );
});

test('evidence draft remains editable within update size limits for large projects', () => {
  const evidence = {
    since: '2026-10-01T00:00:00Z',
    includesSubprojects: false,
    completed: Array.from(
      { length: 1000 },
      (_, i) => ({ identifier: `REV-${i}`, title: 'a'.repeat(1000) }) as WorkItem,
    ),
    overdue: [] as WorkItem[],
    upcoming: [] as WorkItem[],
    blockers: [],
    slippedMilestones: [],
  };
  const draft = projectEvidenceDraft(
    evidence,
    { projects: [{ id: 'root', parentId: null }], items: evidence.completed } as Bootstrap,
    'root',
  );
  assert.ok(draft.length < 20000);
  assert.match(draft, /985 more/);
});

test('shared evidence drafts omit private work, narrower child projects and restricted dependency endpoints', () => {
  const projects = [
    { id: 'root', parentId: null, visibility: 'workspace', ownerId: 'a' },
    { id: 'wide-child', parentId: 'root', visibility: 'workspace', ownerId: 'a' },
    { id: 'narrow-child', parentId: 'root', visibility: 'private', ownerId: 'a' },
    { id: 'other-public', parentId: null, visibility: 'workspace', ownerId: 'a' },
    { id: 'other-private', parentId: null, visibility: 'private', ownerId: 'a', memberIds: ['b'] },
  ] as Project[];
  const item = (id: string, changes: Partial<WorkItem> = {}) =>
    ({
      id,
      identifier: id,
      title: id,
      visibility: 'workspace',
      projectId: 'root',
      parentId: null,
      creatorId: 'a',
      ...changes,
    }) as WorkItem;
  const items = [
    item('public-work'),
    item('private-note', { visibility: 'private' }),
    item('child-work', { projectId: 'wide-child' }),
    item('secret-child', { projectId: 'narrow-child' }),
    item('secret-linked', { projectId: 'other-private' }),
    item('public-linked', { projectId: 'other-public' }),
    item('secret-parent', { visibility: 'private' }),
    item('inherited-secret', { parentId: 'secret-parent' }),
    item('missing-parent', { parentId: 'hidden' }),
  ];
  const data = { projects, items, users: [{ id: 'a' }, { id: 'b' }] } as Bootstrap;
  const evidence = {
    since: '2026-10-01T00:00:00Z',
    includesSubprojects: true,
    completed: items,
    overdue: items,
    upcoming: items,
    blockers: [
      { relation: { id: 'secret-edge' }, blocker: items[1], dependent: items[0], state: 'waiting' },
      { relation: { id: 'public-edge' }, blocker: items[2], dependent: items[0], state: 'waiting' },
    ],
    slippedMilestones: [
      {
        id: 'public-milestone',
        title: 'Public milestone',
        projectId: 'wide-child',
        dueDate: '2026-10-01',
      },
      {
        id: 'secret-milestone',
        title: 'Secret milestone',
        projectId: 'narrow-child',
        dueDate: '2026-10-01',
      },
    ],
  } as Parameters<typeof projectDraftEvidence>[0];
  const shareable = projectDraftEvidence(evidence, data, 'root');
  assert.deepEqual(
    shareable.completed.map((entry) => entry.id),
    ['public-work', 'child-work', 'public-linked'],
  );
  assert.equal(shareable.omittedRestricted, true);
  assert.deepEqual(
    shareable.blockers.map((entry) => entry.relation.id),
    ['public-edge'],
  );
  assert.deepEqual(
    shareable.slippedMilestones.map((entry) => entry.id),
    ['public-milestone'],
  );
  const body = projectEvidenceDraft(evidence, data, 'root');
  assert.doesNotMatch(body, /private-note|secret|missing-parent|Restricted|omitted/);
  assert.match(body, /public-work/);
  assert.equal(projectDraftEvidence(evidence, data, 'missing-project').completed.length, 0);

  // A private project can safely reuse work available to all its own members.
  const privateData = {
    ...data,
    projects: projects.map((project) =>
      project.id === 'root'
        ? { ...project, visibility: 'private' as const, memberIds: ['b'] }
        : project,
    ),
  };
  assert.deepEqual(
    projectDraftEvidence(evidence, privateData, 'root').completed.map((entry) => entry.id),
    ['public-work', 'child-work', 'secret-linked', 'public-linked'],
  );
  const ownerOnly = {
    ...privateData,
    projects: privateData.projects.map((project) =>
      project.id === 'root' ? { ...project, memberIds: [] } : project,
    ),
  };
  assert.ok(
    projectDraftEvidence(evidence, ownerOnly, 'root').completed.some(
      (entry) => entry.id === 'private-note',
    ),
  );
});

test('draft audience checks intersect project ancestors and fail closed on item cycles', () => {
  const projects = [
    { id: 'root', visibility: 'private', ownerId: 'a', memberIds: ['b'], parentId: null },
    { id: 'restricted-parent', visibility: 'private', ownerId: 'a', parentId: null },
    {
      id: 'broad-child',
      visibility: 'private',
      ownerId: 'a',
      memberIds: ['b'],
      parentId: 'restricted-parent',
    },
  ] as Project[];
  const items = [
    {
      id: 'ancestor-restricted',
      title: 'Ancestor restricted',
      identifier: 'secret',
      projectId: 'broad-child',
      visibility: 'workspace',
      parentId: null,
    },
    {
      id: 'cycle',
      title: 'Cycle',
      identifier: 'cycle',
      projectId: 'root',
      visibility: 'workspace',
      parentId: 'cycle',
    },
  ] as WorkItem[];
  const evidence = {
    since: '2026-10-01T00:00:00Z',
    includesSubprojects: false,
    completed: items,
    overdue: [],
    upcoming: [],
    blockers: [],
    slippedMilestones: [],
  };
  assert.deepEqual(
    projectDraftEvidence(evidence, { projects, items } as Bootstrap, 'root').completed,
    [],
  );
});

test('weekly review uses latest health, flags seven-day updates and excludes inactive projects', () => {
  const projects = ['risk', 'ok', 'missing', 'old', 'planned', 'completed', 'archived'].map(
    (id) =>
      ({
        id,
        name: id,
        status: ['planned', 'completed', 'archived'].includes(id) ? id : 'active',
      }) as Project,
  );
  const update = (
    id: string,
    health: ProjectUpdate['health'],
    createdAt: string,
  ): ProjectUpdate => ({ id, projectId: id, health, createdAt, authorId: 'lead', body: 'Update' });
  const updates = [
    update('risk', 'off_track', new Date().toISOString()),
    update('ok', 'on_track', new Date().toISOString()),
    update('old', 'on_track', '2020-01-01T00:00:00Z'),
  ];
  assert.deepEqual(
    reviewProjects(projects, updates).map((p) => p.id),
    ['risk', 'missing', 'old', 'ok'],
  );
  const stale = update('x', 'on_track', '2026-09-01T00:00:00Z');
  assert.equal(updateIsStale(stale, Date.parse('2026-09-08T00:00:00Z')), true);
  assert.equal(updateIsStale(stale, Date.parse('2026-09-07T23:59:59Z')), false);
  assert.equal(
    latestProjectUpdate(
      [stale, { ...stale, id: 'new', health: 'off_track', createdAt: '2026-09-02T00:00:00Z' }],
      'x',
    )?.health,
    'off_track',
  );
});

test('latest update index retains chronology and imported tie-break order without mutating history', () => {
  const old: ProjectUpdate = {
    id: 'old',
    projectId: 'one',
    authorId: 'author',
    health: 'off_track',
    body: 'Old',
    createdAt: '2026-09-01T10:00:00Z',
  };
  const current: ProjectUpdate = {
    ...old,
    id: 'new',
    health: 'on_track',
    createdAt: '2026-09-02T12:00:00+02:00',
  };
  const tied: ProjectUpdate = {
    ...current,
    id: 'aaa',
    sortKey: 'zzz',
    createdAt: '2026-09-02T10:00:00Z',
  };
  const other = { ...old, projectId: 'two' };
  const history = [current, old, tied, other];
  const before = structuredClone(history);
  const latest = latestProjectUpdates(history);
  assert.equal(latest.get('one'), tied);
  assert.equal(latest.get('two'), other);
  assert.equal(latest.get('missing'), undefined);
  assert.deepEqual(history, before);
  const projects = [
    { id: 'one', name: 'One', status: 'active' },
    { id: 'two', name: 'Two', status: 'active' },
  ] as Project[];
  assert.deepEqual(
    reviewProjects(projects, latest, Date.parse('2026-09-03T00:00:00Z')).map((p) => p.id),
    ['two', 'one'],
  );
});
