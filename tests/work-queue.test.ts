import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { openapi } from '../server/openapi.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import {
  belongsToRepository,
  compareReady,
  pullRequestTitle,
  queueOwner,
  repositoryName,
} from '../shared/work-queue.ts';
import type { Activity, ResourceLink, WorkItem } from '../shared/types.ts';

type Method = 'GET' | 'POST' | 'PATCH';
async function queueApp() {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      name: 'Queue owner',
      email: 'owner@example.test',
      password: 'queue-owner-password',
      seedDemo: false,
    },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  const ownerCookie = cookieOf(setup);
  const member = await memberSession(app, ownerCookie, {
    name: 'Queue member',
    email: 'member@example.test',
    password: 'queue-member-password',
  });
  assert.equal(member.statusCode, 200, member.body);
  const token = async (cookie: string, scope: 'read' | 'write') => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: `Queue ${scope}`, scope },
    });
    assert.equal(response.statusCode, 201, response.body);
    return `Bearer ${response.json().token}`;
  };
  const auth = {
    owner: await token(ownerCookie, 'write'),
    reader: await token(ownerCookie, 'read'),
    member: await token(cookieOf(member), 'write'),
  };
  const api = (as: string, method: Method, path: string, payload?: object, key?: string) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { authorization: as, ...(key ? { 'idempotency-key': key } : {}) },
      ...(payload ? { payload } : {}),
    });
  let position = 0;
  const create = async (title: string, fields: Partial<WorkItem> = {}, as = auth.owner) => {
    const response = await api(as, 'POST', '/items', { title, position: ++position, ...fields });
    assert.equal(response.statusCode, 201, response.body);
    return response.json() as WorkItem;
  };
  const block = async (blocker: WorkItem, dependent: WorkItem, as = auth.owner) => {
    const response = await api(as, 'POST', `/items/${blocker.id}/relations`, {
      targetId: dependent.id,
      kind: 'blocks',
    });
    assert.equal(response.statusCode, 201, response.body);
  };
  const ready = async (query = '', as = auth.owner) => {
    const response = await api(as, 'GET', `/items/ready${query}`);
    assert.equal(response.statusCode, 200, response.body);
    return (response.json().data as WorkItem[]).map((item) => item.title);
  };
  const detail = async (item: WorkItem) =>
    (await api(auth.owner, 'GET', `/items/${item.id}`)).json() as {
      item: WorkItem;
      activity: Activity[];
      links: ResourceLink[];
    };
  return {
    app,
    auth,
    api,
    create,
    block,
    ready,
    detail,
    context: (app as unknown as { context: AppContext }).context,
    ownerId: setup.json().id as string,
    memberId: member.json().id as string,
  };
}

test('ready lists unblocked todo work by priority then due date, never blocked or claimed work', async () => {
  const { app, auth, api, create, block, ready, context, ownerId, memberId } = await queueApp();
  try {
    const created = await api(auth.owner, 'POST', '/projects', { key: 'QUE', name: 'Queue' });
    assert.equal(created.statusCode, 201, created.body);
    const project = created.json();
    const inProject = { projectId: project.id };
    const urgentLate = await create('Urgent late', {
      ...inProject,
      priority: 'urgent',
      dueDate: '2026-12-01',
      labels: ['Agent'],
    });
    const urgentSoon = await create('Urgent soon', {
      ...inProject,
      priority: 'urgent',
      dueDate: '2026-11-01',
    });
    await create('Urgent undated', { ...inProject, priority: 'urgent' });
    const high = await create('High', {
      ...inProject,
      priority: 'high',
      dueDate: '2026-10-30',
      labels: ['agent', 'backend'],
    });
    await create('Backlog', { ...inProject, priority: 'urgent', status: 'backlog' });
    await create('Started', { ...inProject, priority: 'urgent', status: 'in_progress' });
    await create('In review', { ...inProject, priority: 'urgent', status: 'in_review' });
    await create('Theirs', { ...inProject, priority: 'urgent', assigneeId: memberId });
    await create('Mine', { ...inProject, priority: 'low', assigneeId: ownerId });
    const blocked = await create('Blocked', { ...inProject, priority: 'urgent' });
    const blocker = await create('Blocker', inProject);
    await block(blocker, blocked);
    const unblocked = await create('Unblocked', { ...inProject, priority: 'high' });
    await block(await create('Finished', { ...inProject, status: 'done' }), unblocked);
    await block(await create('Dropped', { ...inProject, status: 'canceled' }), unblocked);
    const hiddenBlocked = await create('Hidden blocker', { ...inProject, priority: 'urgent' });
    const secret = await create('Private plan', { visibility: 'private' }, auth.member);
    await block(secret, hiddenBlocked, auth.member);
    const inbox = await create('Inbox capture');

    const expected = [
      'Urgent soon',
      'Urgent late',
      'Urgent undated',
      'High',
      'Unblocked',
      'Mine',
      'Blocker',
      'Inbox capture',
    ];
    assert.deepEqual(await ready(), expected);
    // A blocker the caller cannot see still blocks, but claiming does not reveal it.
    const hidden = await api(auth.owner, 'POST', `/items/${hiddenBlocked.id}/claim`);
    assert.equal(hidden.statusCode, 409);
    assert.match(hidden.json().message, /blocked by unfinished work: 1 item you cannot access/);
    assert.doesNotMatch(hidden.json().message, new RegExp(secret.identifier));
    const visibleBlocker = await api(auth.owner, 'POST', `/items/${blocked.identifier}/claim`);
    assert.equal(visibleBlocker.statusCode, 409);
    assert.match(visibleBlocker.json().message, new RegExp(`blocked by .*${blocker.identifier}`));
    // Each person sees work assigned to them, but never work assigned to someone else.
    const memberReady = await ready('', auth.member);
    assert.ok(memberReady.includes('Theirs') && memberReady.includes('Private plan'));
    assert.ok(!memberReady.includes('Mine') && !memberReady.includes('Hidden blocker'));
    // An unassigned inbox capture belongs to whoever captured it, as in the interface.
    assert.ok(!memberReady.includes('Inbox capture'));
    const captured = await api(auth.member, 'POST', `/items/${inbox.id}/claim`);
    assert.equal(captured.statusCode, 409);
    assert.match(captured.json().message, /is an inbox capture of Queue owner/);

    assert.deepEqual(await ready('?label=AGENT'), ['Urgent late', 'High']);
    assert.deepEqual(await ready('?projectId=null'), ['Inbox capture']);
    assert.deepEqual(await ready('?projectId=que'), expected.slice(0, -1));
    assert.equal((await api(auth.owner, 'GET', '/items/ready?projectId=missing')).statusCode, 404);

    // An item's own repository wins over its project's repository links.
    for (const link of [
      { itemId: urgentSoon.id, url: 'https://github.com/acme/api/issues/4' },
      { projectId: project.id, url: 'https://git.example.com/gitea/acme/web.git' },
    ])
      assert.equal(
        (await api(auth.owner, 'POST', '/links', { ...link, title: 'Repo', kind: 'repository' }))
          .statusCode,
        201,
      );
    await context.store.put('items', {
      ...high,
      source: {
        provider: 'github',
        integrationId: 'integration',
        repository: 'Acme/API',
        number: 7,
        url: 'https://github.com/Acme/API/issues/7',
        state: 'open',
        lastSyncedAt: null,
        connected: true,
      },
    });
    assert.deepEqual(await ready('?repository=acme/api'), ['Urgent soon', 'High']);
    const web = await ready('?repository=Acme/Web.git');
    assert.ok(web.includes('Urgent late') && web.includes('Blocker'));
    assert.ok(
      !web.includes('Urgent soon') && !web.includes('High') && !web.includes('Inbox capture'),
    );
    assert.deepEqual(await ready('?repository=acme/we'), []);
    assert.equal((await api(auth.owner, 'GET', '/items/ready?repository=api')).statusCode, 400);
    assert.equal((await api(auth.owner, 'GET', '/items/ready?status=todo')).statusCode, 400);

    const first = (await api(auth.owner, 'GET', '/items/ready?limit=2')).json();
    assert.deepEqual(
      first.data.map((item: WorkItem) => item.title),
      expected.slice(0, 2),
    );
    assert.equal(first.nextCursor, '2');
    const second = (await api(auth.owner, 'GET', '/items/ready?limit=2&cursor=2')).json();
    assert.deepEqual(
      second.data.map((item: WorkItem) => item.title),
      expected.slice(2, 4),
    );

    // Finishing the blocker makes the dependent ready.
    const finished = await api(auth.owner, 'PATCH', `/items/${blocker.id}`, { status: 'done' });
    assert.equal(finished.statusCode, 200, finished.body);
    assert.ok((await ready()).includes('Blocked'));
    assert.ok((await ready()).includes(urgentLate.title));
  } finally {
    await app.close();
  }
});

test('concurrent claims: exactly one succeeds, across people and within one token', async () => {
  const { app, auth, api, create, ready, detail, ownerId, memberId } = await queueApp();
  try {
    const project = (
      await api(auth.owner, 'POST', '/projects', { key: 'RACE', name: 'Race' })
    ).json();
    const contested = await create('Contested', { priority: 'high', projectId: project.id });
    const claims = await Promise.all([
      api(auth.owner, 'POST', `/items/${contested.id}/claim`),
      api(auth.member, 'POST', `/items/${contested.id}/claim`),
    ]);
    assert.deepEqual(claims.map((r) => r.statusCode).sort(), [200, 409]);
    const winner = claims.find((r) => r.statusCode === 200)!.json().item as WorkItem;
    const loser = claims.find((r) => r.statusCode === 409)!.json();
    assert.equal(loser.error, 'conflict');
    assert.match(loser.message, /already in progress \(claimed by Queue (owner|member)\)/);
    assert.equal(winner.status, 'in_progress');
    assert.ok([ownerId, memberId].includes(winner.assigneeId!));
    const current = await detail(contested);
    assert.equal(current.item.revision, contested.revision! + 1);
    assert.equal(current.item.assigneeId, winner.assigneeId);
    assert.equal(
      current.activity.filter((entry) => entry.body === 'claimed this work item').length,
      1,
    );
    assert.equal(current.activity[0].userId, winner.assigneeId);

    // Several agents sharing one person's token still cannot take the same item twice.
    const shared = await create('Shared token', { projectId: project.id });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api(auth.owner, 'POST', `/items/${shared.id}/claim`)),
    );
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409, 409, 409, 409]);
    assert.ok(results.some((r) => /claimed by you/.test(r.json().message ?? '')));
    assert.deepEqual(await ready(), []);
    assert.deepEqual(await ready('', auth.member), []);
  } finally {
    await app.close();
  }
});

test('read-only tokens can list ready work but cannot claim, release or hand off', async () => {
  const { app, auth, api, create, ready, detail } = await queueApp();
  try {
    const item = await create('Read only');
    assert.deepEqual(await ready('', auth.reader), ['Read only']);
    const denied = await api(auth.reader, 'POST', `/items/${item.id}/claim`);
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.json().error, 'forbidden');
    assert.equal((await detail(item)).item.revision, item.revision);
    assert.equal((await detail(item)).item.status, 'todo');
    assert.equal((await api(auth.owner, 'POST', `/items/${item.id}/claim`)).statusCode, 200);
    for (const action of ['release', 'handoff'])
      assert.equal((await api(auth.reader, 'POST', `/items/${item.id}/${action}`)).statusCode, 403);
    assert.equal((await detail(item)).item.status, 'in_progress');
  } finally {
    await app.close();
  }
});

test('claim, release and handoff check the claimant, revisions and retry keys', async () => {
  const { app, auth, api, create, ready, detail, memberId } = await queueApp();
  try {
    const item = await create('Implement queue');
    const stale = await api(auth.owner, 'POST', `/items/${item.id}/claim`, {
      expectedRevision: item.revision! + 5,
    });
    assert.equal(stale.statusCode, 409);
    assert.match(stale.json().message, /Read it again/);

    const claimed = await api(
      auth.owner,
      'POST',
      `/items/${item.identifier}/claim`,
      { expectedRevision: item.revision },
      'claim-1',
    );
    assert.equal(claimed.statusCode, 200, claimed.body);
    assert.equal(claimed.json().item.revision, item.revision! + 1);
    const retried = await api(
      auth.owner,
      'POST',
      `/items/${item.id}/claim`,
      { expectedRevision: item.revision },
      'claim-1',
    );
    assert.equal(retried.statusCode, 200, retried.body);
    assert.deepEqual(retried.json(), claimed.json());
    const reused = await api(auth.owner, 'POST', `/items/${item.id}/claim`, {}, 'claim-1');
    assert.equal(reused.statusCode, 409);
    assert.match(reused.json().message, /Idempotency key was already used/);
    assert.match(
      (await api(auth.owner, 'POST', `/items/${item.id}/claim`)).json().message,
      /already in progress \(claimed by you\)/,
    );

    for (const action of ['release', 'handoff']) {
      const other = await api(auth.member, 'POST', `/items/${item.id}/${action}`);
      assert.equal(other.statusCode, 409);
      assert.match(other.json().message, /claimed by Queue owner\. Only the claimant/);
    }
    const released = await api(auth.owner, 'POST', `/items/${item.id}/release`, {
      comment: 'Needs a database I cannot reach.',
    });
    assert.equal(released.statusCode, 200, released.body);
    assert.equal(released.json().item.status, 'todo');
    assert.equal(released.json().item.assigneeId, null);
    assert.equal(released.json().comment.body, 'Needs a database I cannot reach.');
    assert.deepEqual(await ready(), ['Implement queue']);
    const unclaimed = await api(auth.owner, 'POST', `/items/${item.id}/handoff`);
    assert.equal(unclaimed.statusCode, 409);
    assert.match(unclaimed.json().message, /not claimed by you \(status todo\)/);
    assert.equal(
      (await api(auth.owner, 'POST', `/items/${item.id}/release`, { comment: ' ' })).statusCode,
      400,
    );

    assert.equal((await api(auth.owner, 'POST', `/items/${item.id}/claim`)).statusCode, 200);
    const pullRequestUrl = 'https://github.com/acme/api/pull/12';
    const invalid = await api(auth.owner, 'POST', `/items/${item.id}/handoff`, {
      pullRequestUrl: 'javascript:alert(1)',
    });
    assert.equal(invalid.statusCode, 400);
    const handoff = { pullRequestUrl, comment: 'Ready for review. Tests pass.' };
    const handed = await api(auth.owner, 'POST', `/items/${item.id}/handoff`, handoff, 'hand-1');
    assert.equal(handed.statusCode, 200, handed.body);
    assert.equal(handed.json().item.status, 'in_review');
    assert.deepEqual(
      {
        kind: handed.json().link.kind,
        title: handed.json().link.title,
        url: handed.json().link.url,
        itemId: handed.json().link.itemId,
      },
      {
        kind: 'repository',
        title: 'Pull request acme/api#12',
        url: pullRequestUrl,
        itemId: item.id,
      },
    );
    assert.equal(handed.json().comment.body, handoff.comment);
    assert.deepEqual(
      (await api(auth.owner, 'POST', `/items/${item.id}/handoff`, handoff, 'hand-1')).json(),
      handed.json(),
    );
    assert.equal(
      (await api(auth.owner, 'POST', `/items/${item.id}/handoff`, handoff)).statusCode,
      409,
    );
    // After review feedback, a second handoff of the same pull request reuses its link.
    await api(auth.owner, 'PATCH', `/items/${item.id}`, { status: 'in_progress' });
    assert.equal(
      (await api(auth.owner, 'POST', `/items/${item.id}/handoff`, { pullRequestUrl })).statusCode,
      200,
    );
    const current = await detail(item);
    assert.equal(current.links.length, 1);
    assert.equal(current.activity.filter((entry) => entry.body === handoff.comment).length, 1);
    assert.deepEqual(
      current.activity
        .filter((entry) => entry.kind === 'event')
        .map((entry) => entry.body)
        .sort(),
      [
        'claimed this work item',
        'claimed this work item',
        'handed this work item off for review',
        'handed this work item off for review',
        'released this work item',
        'status: in_progress',
      ],
    );

    const backlog = await create('Later', { status: 'backlog' });
    assert.match(
      (await api(auth.owner, 'POST', `/items/${backlog.id}/claim`)).json().message,
      /has status backlog; only todo items can be claimed/,
    );
    const assigned = await create('Assigned', { assigneeId: memberId });
    assert.match(
      (await api(auth.owner, 'POST', `/items/${assigned.id}/claim`)).json().message,
      /assigned to Queue member/,
    );
    assert.equal((await api(auth.member, 'POST', `/items/${assigned.id}/claim`)).statusCode, 200);
    const secret = await create('Private', { visibility: 'private' }, auth.member);
    assert.equal((await api(auth.owner, 'POST', `/items/${secret.id}/claim`)).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('OpenAPI documents the work queue endpoints', () => {
  const paths = openapi.paths as Record<string, Record<string, any>>;
  const ready = paths['/items/ready'].get;
  assert.deepEqual(
    ready.parameters.map((parameter: { name: string }) => parameter.name),
    ['projectId', 'label', 'repository', 'cursor', 'limit'],
  );
  for (const action of ['claim', 'release', 'handoff']) {
    const operation = paths[`/items/{id}/${action}`].post;
    assert.equal(operation.requestBody.required, false);
    assert.ok(operation.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key'));
    assert.deepEqual(
      operation.responses['200'].content['application/json'].schema.properties.item,
      { $ref: '#/components/schemas/WorkItem' },
    );
  }
  assert.ok(
    paths['/items/{id}/handoff'].post.requestBody.content['application/json'].schema.properties
      .pullRequestUrl,
  );
});

test('ready ordering and repository matching', () => {
  const item = (fields: Partial<WorkItem>) =>
    ({ id: 'a', priority: 'none', dueDate: null, position: 0, ...fields }) as WorkItem;
  const sorted = [
    item({ id: 'none' }),
    item({ id: 'urgent-undated', priority: 'urgent' }),
    item({ id: 'urgent-later', priority: 'urgent', dueDate: '2026-12-01' }),
    item({ id: 'urgent-sooner', priority: 'urgent', dueDate: '2026-11-01', position: 2 }),
    item({ id: 'urgent-first', priority: 'urgent', dueDate: '2026-11-01', position: 1 }),
    item({ id: 'low', priority: 'low' }),
  ]
    .sort(compareReady)
    .map((entry) => entry.id);
  assert.deepEqual(sorted, [
    'urgent-first',
    'urgent-sooner',
    'urgent-later',
    'urgent-undated',
    'low',
    'none',
  ]);

  const owned = (fields: Partial<WorkItem>) =>
    queueOwner(item({ creatorId: 'creator', projectId: null, assigneeId: null, ...fields }));
  assert.equal(owned({}), 'creator');
  assert.equal(owned({ projectId: 'p' }), null);
  assert.equal(owned({ assigneeId: 'assignee' }), 'assignee');
  assert.equal(owned({ projectId: 'p', assigneeId: 'assignee' }), 'assignee');

  assert.equal(repositoryName(' Acme/API.git '), 'acme/api');
  assert.equal(repositoryName('/acme/api/'), 'acme/api');
  for (const invalid of ['acme', 'acme/api/issues', 'https://github.com/acme/api', ''])
    assert.equal(repositoryName(invalid), null);
  const link = (url: string, fields: Partial<ResourceLink> = {}) =>
    ({
      id: url,
      projectId: 'p',
      itemId: null,
      title: '',
      url,
      kind: 'repository',
      ...fields,
    }) as ResourceLink;
  const projectItem = item({ id: 'item', projectId: 'p' });
  for (const [url, expected] of [
    ['https://github.com/acme/api', true],
    ['https://github.com/acme/api.git', true],
    ['https://git.example.com/sub/acme/api/issues/3', true],
    ['https://github.com/acme/api-docs', false],
    ['https://github.com/xacme/api', false],
    ['not a url', false],
  ] as const)
    assert.equal(belongsToRepository(projectItem, [link(url)], 'acme/api'), expected, url);
  assert.equal(
    belongsToRepository(
      projectItem,
      [link('https://github.com/acme/api', { kind: 'link' })],
      'acme/api',
    ),
    false,
  );
  assert.equal(
    belongsToRepository(
      item({ id: 'inbox', projectId: null }),
      [link('https://github.com/acme/api', { projectId: null })],
      'acme/api',
    ),
    false,
  );

  assert.equal(pullRequestTitle('https://github.com/acme/api/pull/12'), 'Pull request acme/api#12');
  assert.equal(
    pullRequestTitle('https://git.example.com/acme/api/pulls/3'),
    'Pull request acme/api#3',
  );
  assert.equal(
    pullRequestTitle('https://gitlab.example.com/acme/api/-/merge_requests/9'),
    'Pull request acme/api#9',
  );
  assert.equal(pullRequestTitle('https://example.com/review/abc'), 'Pull request');
});
