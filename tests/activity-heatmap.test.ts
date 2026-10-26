import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { activityHeatmap } from '../shared/activity-heatmap.ts';
import type { Activity, Project, ProjectUpdate, User, WorkItem } from '../shared/types.ts';
import type { AppContext } from '../server/context.ts';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';

const owner: User = {
  id: randomUUID(),
  name: 'Lead',
  email: 'lead@heatmap.test',
  color: '#123456',
  role: 'admin',
};
const project = (changes: Partial<Project> = {}): Project => ({
  id: randomUUID(),
  key: 'TEST',
  name: 'Project',
  description: '',
  color: '#123456',
  icon: 'folder',
  parentId: null,
  lifecycle: 'ongoing',
  status: 'active',
  startDate: null,
  dueDate: null,
  visibility: 'workspace',
  ownerId: owner.id,
  creationActorId: changes.ownerId ?? owner.id,
  createdAt: '2024-01-01T00:00:00Z',
  ...changes,
});
const item = (changes: Partial<WorkItem> = {}): WorkItem => ({
  id: randomUUID(),
  identifier: 'TEST-01',
  title: 'Work',
  description: '',
  projectId: null,
  parentId: null,
  type: 'task',
  status: 'todo',
  priority: 'none',
  assigneeId: null,
  dueDate: null,
  followUpDate: null,
  recurrence: null,
  labels: [],
  visibility: 'workspace',
  creatorId: owner.id,
  creationActorId: changes.creatorId ?? owner.id,
  createdAt: '2024-02-29T12:00:00Z',
  updatedAt: '2024-02-29T12:00:00Z',
  completedAt: null,
  position: 0,
  ...changes,
});
const activity = (itemId: string, changes: Partial<Activity> = {}): Activity => ({
  id: randomUUID(),
  itemId,
  userId: owner.id,
  kind: 'comment',
  body: 'Internal planning note',
  createdAt: '2024-02-29T13:00:00Z',
  ...changes,
});

test('activity heatmaps use UTC leap-year dates, verified local provenance and one count per action', () => {
  const work = item();
  const plan = project();
  const update: ProjectUpdate = {
    id: randomUUID(),
    projectId: plan.id,
    authorId: owner.id,
    health: 'on_track',
    body: 'Reviewed',
    createdAt: '2024-02-29T14:00:00Z',
  };
  const result = activityHeatmap(
    {
      projects: [plan],
      users: [owner],
      items: [work, item({ importedFrom: { authorName: 'Imported lead' } })],
      projectUpdates: [
        update,
        { ...update, id: randomUUID(), importedFrom: { authorName: 'Imported author' } },
      ],
      activity: [
        activity(work.id),
        activity(work.id, { kind: 'event', createdAt: '2023-12-31T23:30:00-02:00' }),
        activity(work.id, { createdAt: '2024-01-01T00:30:00+02:00' }),
        activity(work.id, { createdAt: '2024-03-02T00:00:00Z' }),
        activity(work.id, { createdAt: 'invalid timestamp' }),
        activity(work.id, { userId: randomUUID() }),
        activity(randomUUID()),
        activity(work.id, { source: { provider: 'github', author: 'external' } }),
        activity(work.id, { importedFrom: { authorName: 'Source author' } }),
      ],
    },
    2024,
    { now: new Date('2024-03-01T12:00:00Z') },
  );
  assert.equal(result.days.length, 366);
  assert.equal(result.days[0].date, '2024-01-01');
  assert.equal(result.days.at(-1)?.date, '2024-12-31');
  assert.equal(result.days.find((day) => day.date === '2024-01-01')?.count, 2);
  assert.equal(result.days.find((day) => day.date === '2024-02-29')?.count, 3);
  assert.equal(result.days.find((day) => day.date === '2024-03-02')?.count, 0);
  assert.equal(result.total, 5);
  assert.equal(
    result.total,
    result.days.reduce((sum, day) => sum + day.count, 0),
  );
  const empty = activityHeatmap(
    { projects: [], items: [], users: [owner], activity: [], projectUpdates: [] },
    2023,
    { now: new Date('2024-03-01T12:00:00Z') },
  );
  assert.equal(empty.days.length, 365);
  assert.equal(empty.total, 0);
  assert.throws(
    () =>
      activityHeatmap(
        { projects: [], items: [], users: [], activity: [], projectUpdates: [] },
        2025,
        { now: new Date('2024-03-01T12:00:00Z') },
      ),
    RangeError,
  );
});

test('heatmap API intersects project/user scope, includes linked work, and excludes private ancestors and other workspaces', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Lead',
        email: 'lead@heatmap.test',
        password: 'local-heatmap-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = cookieOf(setup);
    const lead = setup.json<User>();
    const memberLogin = await memberSession(app, cookie, {
      name: 'Member',
      email: 'member@heatmap.test',
      password: 'local-member-password',
    });
    const memberCookie = cookieOf(memberLogin);
    const member = memberLogin.json<User>();
    const ctx = (app as unknown as { context: AppContext }).context;
    const root = project({ key: 'ROOT', ownerId: lead.id, workspaceId: lead.workspaceId });
    const child = project({
      key: 'CHILD',
      parentId: root.id,
      ownerId: lead.id,
      workspaceId: lead.workspaceId,
      createdAt: '2024-01-02T00:00:00Z',
    });
    const outside = project({
      key: 'OUTSIDE',
      ownerId: member.id,
      workspaceId: lead.workspaceId,
      createdAt: '2023-12-01T00:00:00Z',
    });
    const hidden = project({
      key: 'HIDDEN',
      parentId: root.id,
      visibility: 'private',
      ownerId: member.id,
      workspaceId: lead.workspaceId,
    });
    const hiddenChild = project({
      key: 'HIDDENCHILD',
      parentId: hidden.id,
      ownerId: lead.id,
      workspaceId: lead.workspaceId,
    });
    const foreign = project({ key: 'FOREIGN', ownerId: lead.id, workspaceId: randomUUID() });
    for (const record of [root, child, outside, hidden, hiddenChild, foreign])
      await ctx.store.put('projects', record);
    const rootItem = item({
      projectId: root.id,
      creatorId: lead.id,
      workspaceId: lead.workspaceId,
    });
    const childItem = item({
      projectId: child.id,
      creatorId: lead.id,
      workspaceId: lead.workspaceId,
      createdAt: '2024-02-01T00:00:00Z',
    });
    const linkedItem = item({
      projectId: outside.id,
      creatorId: member.id,
      workspaceId: lead.workspaceId,
      createdAt: '2024-02-02T00:00:00Z',
    });
    const hiddenItem = item({
      projectId: root.id,
      creatorId: member.id,
      visibility: 'private',
      workspaceId: lead.workspaceId,
    });
    const hiddenAncestorItem = item({
      projectId: hiddenChild.id,
      creatorId: lead.id,
      workspaceId: lead.workspaceId,
    });
    const foreignItem = item({
      projectId: foreign.id,
      creatorId: lead.id,
      workspaceId: foreign.workspaceId,
    });
    const importedItem = item({
      projectId: root.id,
      creatorId: lead.id,
      workspaceId: lead.workspaceId,
      importedFrom: { authorName: 'Original author' },
    });
    for (const record of [
      rootItem,
      childItem,
      linkedItem,
      hiddenItem,
      hiddenAncestorItem,
      foreignItem,
      importedItem,
    ])
      await ctx.store.put('items', record);
    // Duplicate links must not count an item's actions more than once.
    for (let index = 0; index < 2; index++)
      await ctx.store.put('projectRelations', {
        id: randomUUID(),
        itemId: linkedItem.id,
        projectId: root.id,
      });
    for (const record of [
      activity(rootItem.id, { userId: lead.id, createdAt: '2024-03-01T12:00:00Z' }),
      activity(rootItem.id, {
        userId: member.id,
        kind: 'event',
        createdAt: '2024-03-01T13:00:00Z',
      }),
      activity(linkedItem.id, { userId: member.id, createdAt: '2024-04-05T00:00:00Z' }),
      activity(rootItem.id, { userId: lead.id, source: { provider: 'gitea', author: 'Source' } }),
      activity(rootItem.id, { userId: lead.id, importedFrom: { authorName: 'Imported' } }),
      activity(rootItem.id, { userId: randomUUID() }),
      activity(hiddenItem.id, { userId: lead.id }),
      activity(hiddenAncestorItem.id, { userId: lead.id }),
      activity(foreignItem.id, { userId: lead.id }),
      activity(rootItem.id, { userId: lead.id, createdAt: '2027-01-01T00:00:00Z' }),
    ])
      await ctx.store.put('activity', record);
    await ctx.store.put('projectUpdates', {
      id: randomUUID(),
      projectId: root.id,
      authorId: lead.id,
      health: 'on_track',
      body: 'Reviewed locally',
      createdAt: '2024-05-01T00:00:00Z',
    });
    await ctx.store.put('projectUpdates', {
      id: randomUUID(),
      projectId: root.id,
      authorId: lead.id,
      health: 'on_track',
      body: 'Imported update',
      importedFrom: { authorName: 'Source author' },
      createdAt: '2024-05-01T00:00:00Z',
    });
    const call = (query: string, session = cookie) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/activity/heatmap?year=2024${query}`,
        headers: { cookie: session },
      });
    const scoped = await call(`&projectId=${root.id}`);
    assert.equal(scoped.statusCode, 200, scoped.body);
    assert.equal(scoped.json().total, 9);
    assert.equal(scoped.json().days.length, 366);
    assert.equal(
      scoped.json().days.find((day: { date: string }) => day.date === '2024-03-01').count,
      2,
    );
    assert.equal((await call(`&projectId=${root.id}&userId=${member.id}`)).json().total, 3);
    assert.equal((await call(`&projectId=${root.id}&userId=${lead.id}`)).json().total, 6);
    assert.equal(
      (await call('')).json().total,
      6,
      'No filters defaults to current user; hidden ancestor creations stay excluded',
    );
    assert.equal((await call(`&projectId=${hidden.id}`)).statusCode, 404);
    assert.equal((await call(`&projectId=${hiddenChild.id}`)).statusCode, 404);
    assert.equal((await call(`&projectId=${foreign.id}`)).statusCode, 404);
    assert.equal((await call(`&userId=${randomUUID()}`)).statusCode, 404);
    assert.equal((await call(`&projectId=${randomUUID()}`)).statusCode, 404);
    // Revoking access removes its creation, item events, and explicit links.
    await ctx.store.put('projects', { ...outside, visibility: 'private' });
    assert.equal((await call(`&projectId=${root.id}`)).json().total, 7);
    assert.equal((await call(`&projectId=${root.id}&userId=${member.id}`)).json().total, 1);
    assert.equal((await call(`&projectId=${root.id}`, memberCookie)).statusCode, 200);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/activity/heatmap' })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/activity/heatmap?year=1969',
          headers: { cookie },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/activity/heatmap?year=2024.5',
          headers: { cookie },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/activity/heatmap?year=${new Date().getUTCFullYear() + 1}`,
          headers: { cookie },
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(Object.keys(scoped.json()).sort(), ['days', 'total', 'year']);
    assert.ok(
      !scoped.body.includes(rootItem.title),
      'The response contains counts, never work titles',
    );
  } finally {
    await app.close();
  }
});

test('fresh demo activity spans months and every item event follows its creation', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Demo',
        email: 'demo@heatmap.test',
        password: 'local-heatmap-password',
        seedDemo: true,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const ctx = (app as unknown as { context: AppContext }).context;
    const items = new Map(
      (await ctx.store.list<WorkItem>('items')).map((record) => [record.id, record]),
    );
    const events = await ctx.store.list<Activity>('activity');
    assert.ok(events.length >= 100);
    const now = Date.now();
    for (const event of events) {
      assert.ok(Date.parse(event.createdAt) >= Date.parse(items.get(event.itemId)!.createdAt));
      assert.ok(Date.parse(event.createdAt) <= now);
    }
    const yearCounts = new Map<number, number>();
    for (const event of events) {
      const year = new Date(event.createdAt).getUTCFullYear();
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
    const busiestYear = [...yearCounts].sort((a, b) => b[1] - a[1])[0][0];
    const heatmap = await app.inject({
      method: 'GET',
      url: `/api/v1/activity/heatmap?year=${busiestYear}`,
      headers: { cookie: cookieOf(setup) },
    });
    assert.equal(heatmap.statusCode, 200, heatmap.body);
    assert.ok(heatmap.json().days.filter((day: { count: number }) => day.count > 0).length > 30);
  } finally {
    await app.close();
  }
});

test('creation attribution is immutable, conservative for legacy data, and excludes automatic/imported history', () => {
  const other: User = {
    ...owner,
    id: randomUUID(),
    name: 'New owner',
    email: 'other@heatmap.test',
  };
  const sourceItem = item({
    source: {
      provider: 'github',
      integrationId: randomUUID(),
      repository: 'team/app',
      number: 1,
      url: 'https://github.com/team/app/issues/1',
      state: 'open',
      lastSyncedAt: null,
      connected: true,
    },
  });
  const data = {
    users: [owner, other],
    projects: [
      project({ ownerId: other.id, creationActorId: owner.id }),
      project({ ownerId: other.id, creationActorId: null }),
      project({ creationActorId: undefined }),
    ],
    items: [
      item({ creatorId: other.id, creationActorId: owner.id }),
      item({ creationActorId: null }),
      item({ creationActorId: undefined }),
      sourceItem,
    ],
    projectUpdates: [],
    activity: [
      activity(sourceItem.id, {
        kind: 'event',
        body: 'Imported from GitHub · team/app #1. Repository updates own the title and description; planning fields stay local.',
      }),
      activity(sourceItem.id, {
        kind: 'comment',
        body: 'Imported from GitHub · this is an actual local comment.',
      }),
      activity(sourceItem.id, { kind: 'event', body: 'priority: high' }),
      activity(sourceItem.id, { kind: 'comment' }),
    ],
  };
  const options = { now: new Date('2024-12-31T23:59:59Z') };
  assert.equal(activityHeatmap(data, 2024, options).total, 5);
  assert.equal(activityHeatmap(data, 2024, { ...options, userId: owner.id }).total, 5);
  assert.equal(
    activityHeatmap(data, 2024, { ...options, userId: other.id }).total,
    0,
    'Changed ownership must not transfer historical creation credit',
  );
});

test('a colleague completing recurring work gets activity credit without crediting its automatic successor to the original creator', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Alice',
        email: 'alice@heatmap.test',
        password: 'local-heatmap-password',
        seedDemo: false,
      },
    });
    const cookie = cookieOf(setup);
    const alice = setup.json<User>();
    const login = await memberSession(app, cookie, {
      name: 'Bob',
      email: 'bob@heatmap.test',
      password: 'local-member-password',
    });
    const bobCookie = cookieOf(login);
    const bob = login.json<User>();
    const call = (
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: unknown,
      session = cookie,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie: session },
        ...(payload ? { payload } : {}),
      });
    const created = await call('POST', '/items', {
      title: 'Recurring collaboration',
      recurrence: 'weekly',
    });
    assert.equal(created.statusCode, 201, created.body);
    const original = created.json<WorkItem>();
    assert.equal(original.creationActorId, alice.id);
    const aliceBefore = (await call('GET', `/activity/heatmap?userId=${alice.id}`)).json().total;
    assert.equal(aliceBefore, 1);
    const done = await call(
      'PATCH',
      `/items/${original.id}`,
      { status: 'done', expectedRevision: original.revision },
      bobCookie,
    );
    assert.equal(done.statusCode, 200, done.body);
    const data = (await call('GET', '/bootstrap')).json();
    const successor = data.items.find((record: WorkItem) => record.id !== original.id);
    assert.equal(successor.creatorId, alice.id, 'Historical ownership remains intact');
    assert.equal(
      successor.creationActorId,
      null,
      'Automatic creation is never credited as a local user action',
    );
    assert.equal(
      (await call('GET', `/activity/heatmap?userId=${alice.id}`)).json().total,
      aliceBefore,
    );
    assert.equal(
      (await call('GET', `/activity/heatmap?userId=${bob.id}`)).json().total,
      2,
      'Bob performed the completion and generated-follow-up recorded events',
    );
    const ctx = (app as unknown as { context: AppContext }).context;
    const { creationActorId: _actor, ...legacySuccessor } = successor;
    await ctx.store.put('items', legacySuccessor);
    assert.equal(
      (await call('GET', `/activity/heatmap?userId=${alice.id}`)).json().total,
      aliceBefore,
      'Legacy automatic creation without provenance is not reconstructed',
    );
    const forged = await call('PATCH', `/items/${original.id}`, { creationActorId: bob.id });
    assert.equal(forged.statusCode, 400, forged.body);
  } finally {
    await app.close();
  }
});
