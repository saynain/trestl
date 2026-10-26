import { sharedWorkspace } from './shared-workspace-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { demoRoadmap } from '../server/roadmap-demo.ts';
import { randomUUID } from 'node:crypto';
import {
  filterRoadmapReferences,
  roadmapUpdate,
  validateRoadmapReferences,
} from '../server/roadmap.ts';
import { roadmapDelivery } from '../src/lib/roadmap-delivery.ts';
import type { Bootstrap, WorkItem } from '../shared/types.ts';

test('roadmap delivery references are optional, unique, access checked, and sanitized', () => {
  const roadmap = demoRoadmap('2026-10-05');
  const projectId = randomUUID(),
    milestoneId = randomUUID(),
    itemId = randomUUID();
  const feature = {
    ...roadmap.features[0],
    projectIds: [projectId],
    milestoneIds: [milestoneId],
    itemIds: [itemId],
  };
  const access = {
    projectIds: new Set([projectId]),
    milestoneIds: new Set([milestoneId]),
    itemIds: new Set([itemId]),
  };
  assert.equal(validateRoadmapReferences([feature], access), null);
  assert.notEqual(validateRoadmapReferences([feature], { ...access, itemIds: new Set() }), null);
  const filtered = filterRoadmapReferences(
    { ...roadmap, features: [feature] },
    { ...access, itemIds: new Set() },
  );
  assert.deepEqual(filtered.features[0].itemIds, []);
  assert.deepEqual(filtered.features[0].projectIds, [projectId]);
  assert.deepEqual(
    feature.itemIds,
    [itemId],
    'Sanitizing read responses must not mutate stored links',
  );
  assert(
    roadmapUpdate.safeParse({ ...roadmap, revision: undefined, expectedRevision: 0 }).success ===
      false,
  );
  const { revision, ...body } = roadmap;
  assert(roadmapUpdate.safeParse({ ...body, expectedRevision: revision }).success);
  assert(
    !roadmapUpdate.safeParse({
      ...body,
      expectedRevision: revision,
      features: [{ ...feature, itemIds: [itemId, itemId] }],
    }).success,
  );
});

test('linked roadmap progress deduplicates projects, milestones and items and reports visible delivery risks', () => {
  const projectId = randomUUID(),
    childId = randomUUID(),
    milestoneId = randomUUID();
  const user = {
    id: randomUUID(),
    name: 'Reviewer',
    email: 'r@test.local',
    color: '#445566',
    role: 'admin' as const,
  };
  const item = (id: string, changes: Partial<WorkItem> = {}): WorkItem => ({
    id,
    identifier: `TEST-${id}`,
    title: 'Work',
    description: '',
    projectId,
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
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:00Z',
    completedAt: null,
    position: 0,
    ...changes,
  });
  const done = item(randomUUID(), { status: 'done' });
  const overdue = item(randomUUID(), { projectId: childId, milestoneId, dueDate: '2026-10-02' });
  const future = item(randomUUID(), { dueDate: '2026-10-20' });
  const canceled = item(randomUUID(), { status: 'canceled', dueDate: '2026-10-01' });
  const blocker = item(randomUUID(), { projectId: null });
  const data: Bootstrap = {
    user,
    users: [user],
    views: [],
    links: [],
    projects: [projectId, childId].map((id) => ({
      id,
      name: id,
      key: 'TEST',
      description: '',
      color: '#445566',
      icon: '',
      parentId: id === childId ? projectId : null,
      lifecycle: 'fixed',
      status: 'active',
      startDate: null,
      dueDate: null,
      visibility: 'workspace',
      ownerId: user.id,
      createdAt: '2026-10-01T12:00:00Z',
    })),
    items: [done, overdue, future, canceled, blocker],
    milestones: [
      {
        id: milestoneId,
        projectId: childId,
        title: 'Launch',
        dueDate: '2026-10-03',
        completed: false,
      },
    ],
    relations: [
      { id: randomUUID(), itemId: blocker.id, targetId: overdue.id, kind: 'blocks' },
      { id: randomUUID(), itemId: randomUUID(), targetId: future.id, kind: 'blocks' },
    ],
  };
  const feature = {
    ...demoRoadmap('2026-10-05').features[0],
    projectIds: [projectId],
    itemIds: [overdue.id],
    milestoneIds: [milestoneId],
    targetDate: '2026-10-10',
  };
  const result = roadmapDelivery(feature, data, '2026-10-05');
  assert.equal(result.total, 3);
  assert.equal(result.done, 1);
  assert.equal(result.overdue, 1);
  assert.equal(result.blocked, 1, 'Unseen blockers must not affect derived risk');
  assert.equal(result.slippedMilestones, 1);
  assert.equal(result.targetAtRisk, true);
  assert.equal(feature.status, demoRoadmap('2026-10-05').features[0].status);
  const editorial = roadmapDelivery(
    { ...feature, projectIds: [], itemIds: [], milestoneIds: [] },
    data,
    '2026-10-05',
  );
  assert.equal(editorial.linked, false);
  assert.equal(editorial.total, 0);
});

test('roadmaps persist, reject stale/invalid changes, and inherit project privacy', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Lead',
        email: 'lead@example.test',
        password: 'test-roadmap-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const shared = await sharedWorkspace(app, setup);
    const cookie = `${shared.cookies[0].name}=${shared.cookies[0].value}`;
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
    const project = (
      await call('POST', '/projects', {
        key: 'ROAD',
        name: 'Roadmap project',
        visibility: 'private',
      })
    ).json();
    const { revision, ...data } = demoRoadmap('2026-09-05');
    const url = `/projects/${project.id}/roadmap`;
    const save = await call('PATCH', url, { ...data, expectedRevision: 0 });
    assert.equal(save.statusCode, 200, save.body);
    assert.equal(save.json().roadmap.revision, 1);
    assert.equal((await call('GET', '/bootstrap')).json().projects[0].roadmap.features.length, 8);
    assert.equal((await call('PATCH', url, { ...data, expectedRevision: 0 })).statusCode, 409);
    assert.equal(
      (await call('PATCH', url, { ...data, expectedRevision: 1, reviewedAt: '2026-02-30' }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await call('PATCH', url, {
          ...data,
          expectedRevision: 1,
          features: [data.features[0], data.features[0]],
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call('PATCH', url, {
          ...data,
          expectedRevision: 1,
          features: [{ ...data.features[0], horizon: 'tomorrow' }],
        })
      ).statusCode,
      400,
    );
    const changed = {
      ...data,
      features: [
        {
          ...data.features[0],
          horizon: 'deferred',
          rationale: 'Capacity moved elsewhere',
          targetDate: null,
        },
      ],
    };
    assert.equal((await call('PATCH', url, { ...changed, expectedRevision: 1 })).statusCode, 200);
    // An ordinary project edit must not discard its roadmap.
    assert.equal(
      (await call('PATCH', `/projects/${project.id}`, { name: 'Renamed' })).json().roadmap.revision,
      2,
    );
    assert.equal(
      (await call('GET', `/projects/${project.id}`)).json().roadmap.features[0].rationale,
      'Capacity moved elsewhere',
    );
    await call('POST', '/users', {
      name: 'Member',
      email: 'member@example.test',
      password: 'test-member-password',
    });
    const login = await call('POST', '/auth/login', {
      email: 'member@example.test',
      password: 'test-member-password',
    });
    assert.equal(login.statusCode, 200, login.body);
    const activeCookie = login.cookies.find((c) => c.name === 'trestl_session')!;
    const memberCookie = `${activeCookie.name}=${activeCookie.value}`;
    assert.equal(
      (await call('PATCH', url, { ...data, expectedRevision: 2 }, memberCookie)).statusCode,
      404,
    );
    assert.equal(
      (await call('GET', '/bootstrap', undefined, memberCookie)).json().projects.length,
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1${url}`,
          payload: { ...data, expectedRevision: 2 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await call('PATCH', url, { ...data, features: [], expectedRevision: 2 })).statusCode,
      200,
    );
    assert.equal((await call('GET', `/projects/${project.id}`)).json().roadmap.features.length, 0);
  } finally {
    await app.close();
  }
});

test('roadmap writes reject inaccessible delivery links and reads remove revoked references', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Lead',
        email: 'delivery@example.test',
        password: 'test-roadmap-password',
        seedDemo: false,
      },
    });
    const session = await sharedWorkspace(app, setup);
    const cookie = `${session.cookies[0].name}=${session.cookies[0].value}`;
    const call = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: unknown,
      sessionCookie = cookie,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie: sessionCookie },
        ...(payload ? { payload } : {}),
      });
    const root = (
      await call('POST', '/projects', { name: 'Delivery roadmap', key: 'DELIVERY' })
    ).json();
    const linked = (await call('POST', '/projects', { name: 'Delivery work', key: 'WORK' })).json();
    const item = (
      await call('POST', '/items', { projectId: linked.id, title: 'Implement' })
    ).json();
    const milestone = (
      await call('POST', '/milestones', { projectId: linked.id, title: 'Launch' })
    ).json();
    const { revision, ...roadmap } = demoRoadmap('2026-10-05');
    const features = [
      {
        ...roadmap.features[0],
        projectIds: [linked.id],
        milestoneIds: [milestone.id],
        itemIds: [item.id],
      },
    ];
    const url = `/projects/${root.id}/roadmap`;
    assert.equal(
      (
        await call('PATCH', url, {
          ...roadmap,
          expectedRevision: 0,
          features: [{ ...features[0], itemIds: [randomUUID()] }],
        })
      ).statusCode,
      400,
    );
    const save = await call('PATCH', url, { ...roadmap, expectedRevision: 0, features });
    assert.equal(save.statusCode, 200, save.body);
    const member = (
      await call('POST', '/users', {
        name: 'Colleague',
        email: 'roadmap-colleague@example.test',
        password: 'test-member-password',
      })
    ).json();
    const login = await call('POST', '/auth/login', {
      email: member.email,
      password: 'test-member-password',
    });
    assert.equal(login.statusCode, 200, login.body);
    const memberCookie = login.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const privacy = await call('PATCH', `/projects/${linked.id}`, { visibility: 'private' });
    assert.equal(privacy.statusCode, 200, privacy.body);
    const response = await call('GET', `/projects/${root.id}`, undefined, memberCookie);
    const feature = response.json().roadmap.features[0];
    assert.deepEqual(feature.projectIds, []);
    assert.deepEqual(feature.milestoneIds, []);
    assert.deepEqual(feature.itemIds, []);
    const bootstrap = (await call('GET', '/bootstrap', undefined, memberCookie)).json();
    assert.deepEqual(
      bootstrap.projects.find((project: { id: string }) => project.id === root.id).roadmap
        .features[0],
      feature,
    );
    assert.equal(
      (await call('PATCH', url, { ...roadmap, expectedRevision: 1, features }, memberCookie))
        .statusCode,
      400,
    );
    const projectEdit = await call(
      'PATCH',
      `/projects/${root.id}`,
      { description: 'Updated editorial description' },
      memberCookie,
    );
    assert.equal(projectEdit.statusCode, 200, projectEdit.body);
    assert.deepEqual(projectEdit.json().roadmap.features[0].projectIds, []);
    assert(!projectEdit.body.includes(linked.id));
    assert(!projectEdit.body.includes(item.id));
    assert(!projectEdit.body.includes(milestone.id));
    const visibleSave = await call(
      'PATCH',
      url,
      {
        ...roadmap,
        expectedRevision: 1,
        features: [{ ...feature, summary: 'Member editorial update' }],
      },
      memberCookie,
    );
    assert.equal(visibleSave.statusCode, 200, visibleSave.body);
    assert.deepEqual(visibleSave.json().roadmap.features[0].itemIds, []);
    const ownerRead = (await call('GET', `/projects/${root.id}`)).json().roadmap.features[0];
    assert.deepEqual(ownerRead.projectIds, features[0].projectIds);
    assert.deepEqual(ownerRead.milestoneIds, features[0].milestoneIds);
    assert.deepEqual(ownerRead.itemIds, features[0].itemIds);
    assert.equal(ownerRead.summary, 'Member editorial update');
  } finally {
    await app.close();
  }
});
