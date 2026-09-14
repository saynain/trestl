import { memberSession } from './installation-fixture.ts';
import { sharedWorkspace } from './shared-workspace-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../server/context.ts';
import type { Project } from '../shared/types.ts';
import { createApp } from '../server/app.ts';
import type { FastifyInstance } from 'fastify';

async function setup(app: FastifyInstance, seedDemo = false) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      name: 'Platform lead',
      email: 'lead@example.test',
      password: 'correct-horse-battery',
      seedDemo,
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  const shared = await sharedWorkspace(app, response);
  return {
    cookie: shared.cookies[0].name + '=' + shared.cookies[0].value,
    user: response.json(),
  };
}
function client(app: FastifyInstance, cookie: string) {
  return async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: unknown) =>
    app.inject({
      method,
      url: '/api/v1' + path,
      headers: { cookie },
      ...(payload !== undefined
        ? {
            payload: JSON.stringify(payload),
            headers: { cookie, 'content-type': 'application/json' },
          }
        : {}),
    });
}
test('private project membership grants collaboration and revokes access across project resources', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app);
    const owner = client(app, lead.cookie);
    const createMember = async (name: string) => {
      const email = `${name}@sharing.test`;
      const response = await owner('POST', '/users', { name, email, password: 'sharing-password' });
      assert.equal(response.statusCode, 201, response.body);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email, password: 'sharing-password' },
      });
      return {
        user: response.json(),
        api: client(app, `${login.cookies[0].name}=${login.cookies[0].value}`),
      };
    };
    const member = await createMember('Member');
    const outsider = await createMember('Outsider');
    const created = await owner('POST', '/projects', {
      key: 'SHARING',
      name: 'Selected people',
      visibility: 'private',
      memberIds: [member.user.id, member.user.id, lead.user.id],
    });
    assert.equal(created.statusCode, 201, created.body);
    const project = created.json();
    assert.deepEqual(
      project.memberIds,
      [member.user.id],
      'Deduplicate members and keep ownership implicit',
    );
    const projectPath = `/projects/${project.id}`;
    const child = (
      await owner('POST', '/projects', { key: 'CHILD', name: 'Child', parentId: project.id })
    ).json();
    const item = (
      await owner('POST', '/items', { title: 'Shared work', projectId: child.id })
    ).json();
    const privateItem = (
      await owner('POST', '/items', {
        title: 'Personal work',
        projectId: project.id,
        visibility: 'private',
      })
    ).json();
    const privateChild = (
      await owner('POST', '/projects', {
        key: 'SECRET',
        name: 'Private child',
        parentId: project.id,
        visibility: 'private',
      })
    ).json();
    const canvas = (
      await owner('POST', `${projectPath}/canvases`, { title: 'Shared canvas' })
    ).json();
    const link = (
      await owner('POST', '/links', {
        projectId: project.id,
        title: 'Reference',
        url: 'https://example.test',
        kind: 'link',
      })
    ).json();
    const milestone = (
      await owner('POST', '/milestones', { projectId: project.id, title: 'Delivery' })
    ).json();
    for (const path of [
      projectPath,
      `/projects/${project.key}`,
      `/projects/${child.id}`,
      `/items/${item.id}`,
      `${projectPath}/canvases/${canvas.id}`,
    ]) {
      assert.equal((await member.api('GET', path)).statusCode, 200, path);
      assert.equal((await outsider.api('GET', path)).statusCode, 404, path);
    }
    assert.equal((await member.api('GET', `/items/${privateItem.id}`)).statusCode, 404);
    assert.equal((await member.api('GET', `/projects/${privateChild.id}`)).statusCode, 404);
    assert.equal(
      (
        await member.api('PATCH', projectPath, {
          name: 'Collaborative edit',
          visibility: 'private',
          memberIds: [member.user.id],
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await member.api('PATCH', `/items/${item.id}`, { title: 'Updated work' })).statusCode,
      200,
    );
    assert.equal(
      (await member.api('POST', `/items/${item.id}/comments`, { body: 'Shared discussion' }))
        .statusCode,
      201,
    );
    for (const payload of [
      { memberIds: [] },
      { memberIds: [member.user.id, outsider.user.id] },
      { visibility: 'workspace' },
    ]) {
      assert.equal((await member.api('PATCH', projectPath, payload)).statusCode, 403);
    }
    assert.equal(
      (await outsider.api('PATCH', projectPath, { memberIds: [outsider.user.id] })).statusCode,
      404,
    );
    assert.equal(
      (await member.api('PATCH', `/projects/${child.id}`, { parentId: null })).statusCode,
      403,
      'Collaborators cannot bypass inherited access by moving a project',
    );
    for (const endpoint of ['/bootstrap', '/export']) {
      const visible = (await member.api('GET', endpoint)).json();
      assert.ok(visible.projects.some((p: { id: string }) => p.id === project.id));
      assert.ok(visible.items.some((i: { id: string }) => i.id === item.id));
      assert.ok(visible.links.some((l: { id: string }) => l.id === link.id));
      assert.ok(visible.milestones.some((m: { id: string }) => m.id === milestone.id));
      assert.ok(!visible.items.some((i: { id: string }) => i.id === privateItem.id));
    }
    assert.equal((await owner('PATCH', projectPath, { memberIds: [] })).statusCode, 200);
    assert.equal((await owner('GET', projectPath)).statusCode, 200, 'Owner retains access');
    for (const path of [
      projectPath,
      `/projects/${child.id}`,
      `/items/${item.id}`,
      `${projectPath}/canvases/${canvas.id}`,
    ]) {
      assert.equal((await member.api('GET', path)).statusCode, 404, path);
    }
    assert.equal(
      (await member.api('PATCH', `/items/${item.id}`, { title: 'Revoked' })).statusCode,
      404,
    );
    for (const endpoint of ['/bootstrap', '/export']) {
      const visible = (await member.api('GET', endpoint)).json();
      assert.equal(visible.projects.length, 0);
      assert.equal(visible.items.length, 0);
      assert.equal(visible.links.length, 0);
      assert.equal(visible.milestones.length, 0);
      if (endpoint === '/export') assert.equal(visible.activity.length, 0);
    }
    assert.equal((await member.api('GET', '/projects')).json().data.length, 0);
    assert.equal((await member.api('GET', '/items')).json().data.length, 0);
  } finally {
    await app.close();
  }
});

test('project membership validates workspace users and cannot bypass private ancestors', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app);
    const owner = client(app, lead.cookie);
    const memberUser = (
      await owner('POST', '/users', {
        name: 'Member',
        email: 'member@hierarchy.test',
        password: 'sharing-password',
      })
    ).json();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: memberUser.email, password: 'sharing-password' },
    });
    const member = client(app, `${login.cookies[0].name}=${login.cookies[0].value}`);
    const otherUser = { id: randomUUID() };
    await app
      .getDecorator<AppContext>('context')
      .store.put('users', { ...memberUser, id: otherUser.id, workspaceId: 'legacy-other' });
    const project = (
      await owner('POST', '/projects', { key: 'ROOT', name: 'Private root', visibility: 'private' })
    ).json();
    const child = (
      await owner('POST', '/projects', {
        key: 'NESTED',
        name: 'Selected child',
        visibility: 'private',
        parentId: project.id,
        memberIds: [memberUser.id],
      })
    ).json();
    assert.equal((await member('GET', `/projects/${child.id}`)).statusCode, 404);
    assert.equal((await member('GET', '/projects')).json().data.length, 0);
    for (const memberIds of [[otherUser.id], [randomUUID()], ['invalid-id']]) {
      assert.equal(
        (await owner('POST', '/projects', { key: 'INVALID', name: 'Invalid sharing', memberIds }))
          .statusCode,
        400,
      );
      assert.equal(
        (await owner('PATCH', `/projects/${project.id}`, { memberIds })).statusCode,
        400,
      );
    }
    const legacy = (app as unknown as { context: AppContext }).context;
    const oldProject = (await legacy.store.get<Project>('projects', project.id))!;
    delete oldProject.memberIds;
    await legacy.store.put('projects', oldProject);
    assert.equal(
      (await member('GET', `/projects/${project.id}`)).statusCode,
      404,
      'Legacy projects remain private',
    );
    assert.equal(
      (await owner('PATCH', `/projects/${project.id}`, { memberIds: [memberUser.id] })).statusCode,
      200,
    );
    assert.equal((await member('GET', `/projects/${child.id}`)).statusCode, 200);
    assert.equal((await app.inject({ url: `/api/v1/projects/${project.id}` })).statusCode, 401);
    assert.equal(
      (await owner('PATCH', `/projects/${project.id}`, { visibility: 'workspace' })).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('setup, hierarchy privacy, conversations, recurrence, API tokens, and export', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    assert.equal((await app.inject('/api/v1/bootstrap')).statusCode, 401);
    const lead = await setup(app),
      api = client(app, lead.cookie);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            name: 'No',
            email: 'no@example.test',
            password: 'another-password',
            seedDemo: false,
          },
        })
      ).statusCode,
      409,
    );
    const second = (
      await api('POST', '/users', {
        name: 'Engineer',
        email: 'engineer@example.test',
        password: 'engineer-password',
      })
    ).json();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'engineer@example.test', password: 'engineer-password' },
    });
    assert.equal(login.statusCode, 200);
    const member = client(app, `${login.cookies[0].name}=${login.cookies[0].value}`);
    const privateProject = (
      await api('POST', '/projects', { key: 'TEAM', name: 'Team lead', visibility: 'private' })
    ).json();
    const child = (
      await api('POST', '/projects', { key: 'PLAN', name: 'Planning', parentId: privateProject.id })
    ).json();
    const publicProject = (await api('POST', '/projects', { key: 'K8S', name: 'Platform' })).json();
    assert.equal(
      (await api('PATCH', `/projects/${privateProject.id}`, { parentId: child.id })).statusCode,
      400,
    );
    assert.equal((await member('GET', `/projects/${child.id}`)).statusCode, 404);
    const secret = (
      await api('POST', '/items', { title: 'Private leadership work', projectId: child.id })
    ).json();
    assert.equal((await member('GET', `/items/${secret.id}`)).statusCode, 404);
    const recurringResponse = await api('POST', '/items', {
      title: 'Monthly follow-up',
      projectId: publicProject.id,
      assigneeId: second.id,
      recurrence: 'monthly',
      dueDate: '2026-01-31',
    });
    assert.equal(recurringResponse.statusCode, 201, recurringResponse.body);
    const recurring = recurringResponse.json();
    assert.equal((await api('GET', `/items/${recurring.identifier}`)).statusCode, 200);
    assert.equal(
      (
        await api('POST', `/items/${recurring.id}/comments`, {
          body: 'Keep the conversation with the work.',
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (await api('PATCH', `/items/${recurring.id}`, { status: 'done' })).statusCode,
      200,
    );
    let work = (await api('GET', '/items')).json().data;
    assert.equal(work.length, 3);
    const next = work.find(
      (i: { id: string; title: string }) => i.title === recurring.title && i.id !== recurring.id,
    );
    assert.equal(next.dueDate, '2026-02-28');
    assert.equal(next.status, 'todo');
    await api('PATCH', `/items/${recurring.id}`, { status: 'todo' });
    await api('PATCH', `/items/${recurring.id}`, { status: 'done' });
    work = (await api('GET', '/items')).json().data;
    assert.equal(work.length, 3, 'Re-completing must not create duplicate recurrence');
    const detail = (await api('GET', `/items/${recurring.id}`)).json();
    assert.ok(detail.activity.some((a: { kind: string }) => a.kind === 'comment'));
    assert.ok(detail.activity.some((a: { kind: string }) => a.kind === 'event'));
    assert.equal(
      (await api('POST', '/items', { title: 'Bad date', dueDate: '2026-02-30' })).statusCode,
      400,
    );
    assert.equal(
      (
        await api('POST', '/links', {
          itemId: recurring.id,
          title: 'Bad link',
          kind: 'link',
          url: 'javascript:alert(1)',
        })
      ).statusCode,
      400,
    );
    const tokenResponse = await api('POST', '/tokens', { name: 'Read client', scope: 'read' });
    assert.equal(tokenResponse.statusCode, 201, tokenResponse.body);
    const token = tokenResponse.json();
    const auth = { authorization: `Bearer ${token.token}` };
    assert.equal((await app.inject({ url: '/api/v1/bootstrap', headers: auth })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/items',
          headers: auth,
          payload: { title: 'Forbidden' },
        })
      ).statusCode,
      403,
    );
    assert.ok(!(await api('GET', '/tokens')).body.includes(token.token));
    await api('DELETE', `/tokens/${token.id}`);
    assert.equal((await app.inject({ url: '/api/v1/bootstrap', headers: auth })).statusCode, 401);
    const memberExport = (await member('GET', '/export')).json();
    assert.ok(!memberExport.items.some((i: { id: string }) => i.id === secret.id));
    assert.ok(!memberExport.projects.some((p: { id: string }) => p.id === child.id));
    assert.equal(
      (
        await member('POST', '/users', {
          name: 'New',
          email: 'new@example.test',
          password: 'password-long',
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/items',
          headers: { cookie: lead.cookie, origin: 'https://attacker.example' },
          payload: { title: 'CSRF' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await api('PATCH', '/auth/account', { email: 'changed@example.test' })).statusCode,
      403,
    );
    assert.equal(
      (await api('PATCH', '/auth/account', { name: 'Updated lead' })).json().name,
      'Updated lead',
    );
    assert.equal(
      (
        await api('PATCH', '/auth/account', {
          email: 'changed@example.test',
          password: 'another-good-password',
          currentPassword: 'correct-horse-battery',
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'lead@example.test', password: 'correct-horse-battery' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'changed@example.test', password: 'another-good-password' },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test('persistent database survives restart with credentials and work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-persistence-'));
  let app = await createApp({ dataDir: directory, integrations: false });
  try {
    const lead = await setup(app);
    const api = client(app, lead.cookie);
    const item = (
      await api('POST', '/items', { title: 'Persist across restarts', visibility: 'private' })
    ).json();
    await app.close();
    app = await createApp({ dataDir: directory, integrations: false });
    const status = (await app.inject('/api/v1/auth/status')).json();
    assert.equal(status.needsSetup, false);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'lead@example.test', password: 'correct-horse-battery' },
    });
    assert.equal(response.statusCode, 200);
    const restored = client(app, `${response.cookies[0].name}=${response.cookies[0].value}`);
    assert.equal(
      (await restored('GET', `/items/${item.id}`)).json().item.title,
      'Persist across restarts',
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('demo data provides nested projects without exposing private leadership data', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app, true);
    const data = (await client(app, lead.cookie)('GET', '/bootstrap')).json();
    assert.equal(data.projects.length, 6);
    assert.equal(data.items.length, 18);
    assert.equal(new Set(data.items.map((i: { identifier: string }) => i.identifier)).size, 18);
    assert.ok(data.projects.some((p: { parentId: string | null }) => p.parentId));
    const created = (
      await client(app, lead.cookie)('POST', '/items', { title: 'Next item' })
    ).json();
    assert.equal(created.identifier, 'INBOX-01');
  } finally {
    await app.close();
  }
});

test('monthly recurrence retains its calendar anchor and cannot duplicate after edits', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app),
      api = client(app, lead.cookie);
    const first = (
      await api('POST', '/items', {
        title: 'Month-end review',
        dueDate: '2024-01-31',
        followUpDate: '2024-01-30',
        recurrence: 'monthly',
      })
    ).json();
    await api('PATCH', `/items/${first.id}`, { status: 'done' });
    const february = (await api('GET', '/items'))
      .json()
      .data.find((i: { id: string }) => i.id !== first.id);
    assert.equal(february.dueDate, '2024-02-29');
    assert.equal(february.followUpDate, '2024-02-29');
    await api('PATCH', `/items/${february.id}`, { status: 'done' });
    const march = (await api('GET', '/items'))
      .json()
      .data.find((i: { id: string }) => i.id !== first.id && i.id !== february.id);
    assert.equal(march.dueDate, '2024-03-31');
    assert.equal(march.followUpDate, '2024-03-30');
    await api('PATCH', `/items/${first.id}`, { status: 'todo', dueDate: '2024-02-01' });
    await api('PATCH', `/items/${first.id}`, { status: 'done' });
    assert.equal(
      (await api('GET', '/items')).json().data.length,
      3,
      'Editing a completed date does not create a second successor',
    );
    await api('PATCH', `/items/${march.id}`, { dueDate: '2024-03-15' });
    await api('PATCH', `/items/${march.id}`, { status: 'done' });
    assert.ok(
      (await api('GET', '/items'))
        .json()
        .data.some((i: { dueDate: string }) => i.dueDate === '2024-04-15'),
      'Explicitly rescheduling resets the monthly day',
    );
    const invalid = await api('POST', '/links', {
      itemId: first.id,
      title: 'Invalid',
      kind: 'link',
      url: 'not a URL',
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(
      (
        await api('POST', '/links', {
          itemId: first.id,
          title: 'Credential URL',
          kind: 'link',
          url: 'https://user:secret@example.test',
        })
      ).statusCode,
      400,
    );
    const labeled = (
      await api('POST', '/items', {
        title: 'Stable labels',
        labels: [' platform ', 'platform', 'Platform', 'Reliability'],
      })
    ).json();
    assert.deepEqual(labeled.labels, ['platform', 'Reliability']);
  } finally {
    await app.close();
  }
});

test('inherited privacy changes require ownership and immediately cover conversations, relations, and exports', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app),
      api = client(app, lead.cookie);
    await api('POST', '/users', {
      name: 'Member',
      email: 'member@example.test',
      password: 'member-password',
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.test', password: 'member-password' },
    });
    const member = client(app, `${login.cookies[0].name}=${login.cookies[0].value}`);
    const shared = (
      await api('POST', '/projects', { key: 'SHARED', name: 'Shared project' })
    ).json();
    const memberPrivate = (
      await member('POST', '/projects', {
        key: 'PERSONAL',
        name: 'Personal',
        visibility: 'private',
      })
    ).json();
    const parent = (
      await api('POST', '/items', { title: 'Shared parent', projectId: shared.id })
    ).json();
    const child = (
      await api('POST', '/items', { title: 'Child discussion', parentId: parent.id })
    ).json();
    const peer = (await api('POST', '/items', { title: 'Public peer' })).json();
    await api('POST', `/items/${child.id}/comments`, {
      body: 'Discussion follows parent privacy.',
    });
    await api('POST', `/items/${peer.id}/relations`, { targetId: child.id, kind: 'related' });
    assert.equal(
      (await member('PATCH', `/items/${parent.id}`, { projectId: memberPrivate.id })).statusCode,
      403,
      'A collaborator cannot make another creator’s work inaccessible',
    );
    assert.equal(
      (await member('PATCH', `/projects/${shared.id}`, { parentId: memberPrivate.id })).statusCode,
      403,
    );
    assert.equal(
      (
        await member('PATCH', `/items/${parent.id}`, {
          title: 'Collaborative update',
          visibility: 'workspace',
        })
      ).statusCode,
      200,
      'Sending unchanged visibility does not block normal editing',
    );
    assert.equal(
      (await api('PATCH', `/items/${parent.id}`, { parentId: child.id })).statusCode,
      400,
      'Item ancestor cycles are rejected',
    );
    assert.equal(
      (await api('PATCH', `/projects/${shared.id}`, { visibility: 'private' })).statusCode,
      200,
    );
    assert.equal((await member('GET', `/items/${child.id}`)).statusCode, 404);
    assert.equal(
      (await member('POST', `/items/${child.id}/comments`, { body: 'Must not post' })).statusCode,
      404,
    );
    assert.equal((await member('GET', `/items/${peer.id}`)).json().relations.length, 0);
    const exported = (await member('GET', '/export')).json();
    assert.ok(!exported.items.some((i: { id: string }) => i.id === child.id));
    assert.equal(exported.activity.length, 0);
    assert.equal(exported.relations.length, 0);
    await api('PATCH', `/projects/${shared.id}`, { visibility: 'workspace' });
    assert.equal((await member('GET', `/items/${child.id}`)).statusCode, 200);
    assert.equal(
      (await api('PATCH', `/items/${parent.id}`, { visibility: 'private' })).statusCode,
      200,
    );
    assert.equal(
      (await member('GET', `/items/${child.id}`)).statusCode,
      404,
      'Parent-item privacy is inherited even when the child has no project',
    );
  } finally {
    await app.close();
  }
});

test('bootstrap uses bounded database reads while resolving large nested and malformed hierarchies', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app),
      api = client(app, lead.cookie);
    await api('POST', '/users', {
      name: 'Member',
      email: 'member@example.test',
      password: 'member-password',
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@example.test', password: 'member-password' },
    });
    const member = client(app, `${login.cookies[0].name}=${login.cookies[0].value}`);
    const publicProject = (
      await api('POST', '/projects', { key: 'PUBLIC', name: 'Shared platform' })
    ).json();
    const privateProject = (
      await api('POST', '/projects', { key: 'PRIVATE', name: 'Leadership', visibility: 'private' })
    ).json();
    const publicParent = (
      await api('POST', '/items', { title: 'Public root', projectId: publicProject.id })
    ).json();
    const privateParent = (
      await api('POST', '/items', { title: 'Private root', projectId: privateProject.id })
    ).json();
    const ctx = (app as typeof app & { context: AppContext }).context;
    let previousPublic = publicParent.id;
    for (let i = 0; i < 100; i++) {
      const item = {
        ...publicParent,
        id: randomUUID(),
        identifier: `FIXTURE-${i}`,
        title: `Nested item ${i}`,
        projectId: null,
        parentId: i % 2 === 0 ? previousPublic : privateParent.id,
      };
      await ctx.store.put('items', item);
      if (i % 2 === 0) previousPublic = item.id;
    }
    // Corrupt imports or historical data must fail closed, even without API validation.
    const cycleProjectA = randomUUID(),
      cycleProjectB = randomUUID();
    await ctx.store.put('projects', {
      ...publicProject,
      id: cycleProjectA,
      parentId: cycleProjectB,
    });
    await ctx.store.put('projects', {
      ...publicProject,
      id: cycleProjectB,
      parentId: cycleProjectA,
    });
    const cycleItemA = randomUUID(),
      cycleItemB = randomUUID();
    await ctx.store.put('items', { ...publicParent, id: cycleItemA, parentId: cycleItemB });
    await ctx.store.put('items', { ...publicParent, id: cycleItemB, parentId: cycleItemA });
    await ctx.store.put('items', { ...publicParent, id: randomUUID(), parentId: randomUUID() });
    await ctx.store.put('items', { ...publicParent, id: randomUUID(), projectId: cycleProjectA });
    await ctx.store.put('items', { ...publicParent, id: randomUUID(), projectId: randomUUID() });
    const originalQuery = ctx.db.query.bind(ctx.db);
    let reads = 0;
    ctx.db.query = async <T>(sql: string, params?: unknown[]) => {
      reads++;
      return originalQuery<T>(sql, params);
    };
    const visible = (await member('GET', '/bootstrap')).json();
    assert.equal(visible.items.length, 51);
    assert.equal(visible.projects.length, 1);
    assert.ok(
      reads <= 14,
      `Bootstrap used ${reads} queries; expected at most five authentication/configuration reads, seven collection reads and two installation reads`,
    );
    reads = 0;
    const own = (await api('GET', '/bootstrap')).json();
    assert.equal(own.items.length, 102);
    assert.equal(own.projects.length, 2);
    assert.ok(reads <= 14);
  } finally {
    await app.close();
  }
});

test('linked issue content is source-owned while planning and recurring successors stay local', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app),
      api = client(app, lead.cookie);
    const item = (
      await api('POST', '/items', {
        title: 'Source title',
        description: 'Source description',
        recurrence: 'weekly',
        dueDate: '2026-09-10',
      })
    ).json();
    const source = {
      provider: 'gitea' as const,
      integrationId: 'connection',
      repository: 'team/platform',
      number: 8,
      url: 'https://git.example.test/team/platform/issues/8',
      state: 'closed' as const,
      lastSyncedAt: '2026-09-05T01:00:00Z',
      connected: true,
    };
    const ctx = (app as typeof app & { context: AppContext }).context;
    await ctx.store.put('items', { ...item, source, externalUrl: source.url });
    for (const payload of [
      { title: 'Local title' },
      { description: 'Local description' },
      { externalUrl: null },
    ]) {
      const response = await api('PATCH', `/items/${item.id}`, payload);
      assert.equal(response.statusCode, 409, response.body);
      assert.match(response.body, /source repository/);
    }
    const updated = await api('PATCH', `/items/${item.id}`, {
      status: 'in_progress',
      priority: 'high',
      title: item.title,
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().source.state, 'closed');
    const bootstrap = (await api('GET', '/bootstrap')).json();
    assert.deepEqual(bootstrap.items[0].source, source);
    const note = await api('POST', `/items/${item.id}/comments`, { body: 'Internal note' });
    assert.equal(note.statusCode, 201);
    assert.equal(note.json().source, undefined);
    assert.equal((await api('PATCH', `/items/${item.id}`, { status: 'done' })).statusCode, 200);
    const successor = (await api('GET', '/bootstrap'))
      .json()
      .items.find((row: { id: string }) => row.id !== item.id);
    assert.ok(successor);
    assert.equal(successor.source, undefined);
    assert.equal(successor.externalUrl, undefined);
    assert.equal(
      (await api('PATCH', `/items/${successor.id}`, { title: 'My native follow-up' })).statusCode,
      200,
    );
    await ctx.store.put('items', { ...updated.json(), source: { ...source, connected: false } });
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { title: 'Still source-owned' })).statusCode,
      409,
    );
  } finally {
    await app.close();
  }
});

test('API numbering follows projects, moves, recurrence and deletion', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app);
    const api = client(app, lead.cookie);
    const create = async (path: string, payload: unknown) => {
      const result = await api('POST', path, payload);
      assert.equal(result.statusCode, 201, result.body);
      return result.json();
    };
    const a = await create('/projects', { key: 'AA', name: 'Alpha' });
    const b = await create('/projects', { key: 'BB', name: 'Beta' });
    const first = await create('/items', {
      projectId: a.id,
      title: 'Recurring',
      recurrence: 'weekly',
    });
    assert.equal(first.identifier, 'AA-01');
    assert.equal(
      (await create('/items', { projectId: b.id, title: 'Beta first' })).identifier,
      'BB-01',
    );
    const moved = await api('PATCH', `/items/${first.id}`, { projectId: b.id });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(moved.json().identifier, 'BB-02');
    const completed = await api('PATCH', `/items/${first.id}`, { status: 'done' });
    assert.equal(completed.statusCode, 200, completed.body);
    const followup = (await api('GET', '/bootstrap'))
      .json()
      .items.find((i: any) => i.identifier === 'BB-03');
    assert.ok(followup);
    assert.equal((await api('DELETE', `/items/${followup.id}`)).statusCode, 204);
    assert.equal(
      (await create('/items', { projectId: b.id, title: 'After deletion' })).identifier,
      'BB-04',
    );
    assert.equal(
      (await create('/items', { projectId: a.id, title: 'After move' })).identifier,
      'AA-02',
    );
    assert.equal((await api('GET', '/items/BB-02')).json().item.id, first.id);
  } finally {
    await app.close();
  }
});

test('installation inbox numbering is shared while private items stay private', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app);
    const api = client(app, lead.cookie);
    const first = (
      await api('POST', '/items', { title: 'Original inbox', visibility: 'private' })
    ).json();
    const profile = await memberSession(app, lead.cookie, {
      name: 'Other',
      email: 'other@example.test',
      password: 'other-password-123',
    });
    assert.equal(profile.statusCode, 200, profile.body);
    const session = profile.cookies.find((cookie) => cookie.name === 'trestl_session')!;
    const other = client(app, `${session.name}=${session.value}`);
    const second = (await other('POST', '/items', { title: 'Other workspace' })).json();
    assert.equal(first.identifier, 'INBOX-01');
    assert.equal(second.identifier, 'INBOX-02');
    assert.equal((await other('GET', '/items/INBOX-01')).statusCode, 404);
    assert.equal((await other('GET', '/items/INBOX-02')).json().item.id, second.id);
    assert.equal((await api('GET', '/items/INBOX-01')).json().item.id, first.id);
  } finally {
    await app.close();
  }
});

test('workspace project membership identifies the team without restricting collaboration', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const lead = await setup(app);
    const owner = client(app, lead.cookie);
    const response = await owner('POST', '/users', {
      name: 'Teammate',
      email: 'team@public.test',
      password: 'sharing-password',
    });
    assert.equal(response.statusCode, 201);
    const user = response.json();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'sharing-password' },
    });
    const teammate = client(app, `${login.cookies[0].name}=${login.cookies[0].value}`);
    const created = await owner('POST', '/projects', {
      key: 'TEAM',
      name: 'Public team',
      visibility: 'workspace',
      memberIds: [user.id, user.id, lead.user.id],
    });
    assert.equal(created.statusCode, 201);
    const path = `/projects/${created.json().id}`;
    assert.deepEqual(created.json().memberIds, [user.id]);
    assert.equal((await teammate('PATCH', path, { memberIds: [] })).statusCode, 403);
    const removed = await owner('PATCH', path, { memberIds: [] });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(removed.json().memberIds, []);
    assert.equal((await teammate('GET', path)).statusCode, 200);
    assert.equal(
      (await teammate('PATCH', path, { description: 'Still collaborating' })).statusCode,
      200,
    );
    assert.equal((await teammate('PATCH', path, { memberIds: [user.id] })).statusCode, 403);
    assert.equal((await owner('PATCH', path, { memberIds: [user.id] })).statusCode, 200);
    for (const visibility of ['private', 'workspace']) {
      const changed = await owner('PATCH', path, { visibility });
      assert.equal(changed.statusCode, 200);
      assert.deepEqual(changed.json().memberIds, [user.id]);
      assert.equal((await teammate('GET', path)).statusCode, 200);
    }
    const parent = await owner('POST', '/projects', {
      key: 'HIDDEN',
      name: 'Private parent',
      visibility: 'private',
    });
    assert.equal((await owner('PATCH', path, { parentId: parent.json().id })).statusCode, 200);
    assert.equal((await teammate('GET', path)).statusCode, 404);
  } finally {
    await app.close();
  }
});
