import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';

test('saved profiles require valid browser sessions and switch private account data', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  const jar = new Map<string, string>();
  const request = async (method: 'GET' | 'POST', path: string, payload?: unknown) => {
    const result = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') },
      ...(payload ? { payload } : {}),
    });
    for (const cookie of result.cookies) {
      if (cookie.maxAge === 0 || !cookie.value) jar.delete(cookie.name);
      else jar.set(cookie.name, cookie.value);
    }
    return result;
  };
  try {
    const setup = await request('POST', '/auth/setup', {
      name: 'Work',
      email: 'work@example.test',
      password: 'work-password-123',
      seedDemo: false,
    });
    assert.equal(setup.statusCode, 201);
    const work = setup.json();
    assert.ok(setup.cookies.every((c) => c.httpOnly && c.sameSite === 'Lax'));
    const created = await request('POST', '/users', {
      name: 'Personal',
      email: 'personal@example.test',
      password: 'personal-password-123',
    });
    const personal = created.json();
    assert.equal(created.statusCode, 201);
    const item = (
      await request('POST', '/items', { title: 'Work secret', visibility: 'private' })
    ).json();
    assert.equal((await request('POST', '/auth/switch', { userId: personal.id })).statusCode, 401);
    const wrong = await request('POST', '/auth/login', {
      email: personal.email,
      password: 'incorrect',
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal((await request('GET', '/bootstrap')).json().user.id, work.id);
    // Existing installations only have the active session cookie.
    jar.delete(`trestl_profile_${work.id}`);
    assert.equal(
      (
        await request('POST', '/auth/login', {
          email: personal.email,
          password: 'personal-password-123',
        })
      ).statusCode,
      200,
    );
    const profiles = (await request('GET', '/auth/profiles')).json().data;
    assert.deepEqual(
      new Set(profiles.map((u: { id: string }) => u.id)),
      new Set([work.id, personal.id]),
    );
    assert.equal((await request('GET', `/items/${item.id}`)).statusCode, 404);
    const personalSecret = jar.get(`trestl_profile_${personal.id}`)!;
    const workSecret = jar.get(`trestl_profile_${work.id}`)!;
    jar.set(`trestl_profile_${work.id}`, personalSecret);
    assert.equal((await request('POST', '/auth/switch', { userId: work.id })).statusCode, 401);
    jar.set(`trestl_profile_${work.id}`, workSecret);
    assert.equal((await request('POST', '/auth/switch', { userId: work.id })).statusCode, 200);
    assert.equal((await request('GET', '/bootstrap')).json().user.id, work.id);
    assert.equal((await request('GET', `/items/${item.id}`)).statusCode, 200);
    assert.equal((await request('POST', '/auth/logout')).statusCode, 200);
    assert.equal(jar.has(`trestl_profile_${work.id}`), false);
    jar.set('trestl_session', personalSecret);
    jar.set(`trestl_profile_${work.id}`, workSecret);
    assert.equal((await request('POST', '/auth/switch', { userId: work.id })).statusCode, 401);
    assert.equal((await request('GET', '/auth/profiles')).json().data.length, 1);
    assert.equal(jar.has(`trestl_profile_${work.id}`), false);
  } finally {
    await app.close();
  }
});

test('new profiles own isolated workspaces while invited users share only their workspace', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  const jar = new Map<string, string>();
  const request = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
    token?: string,
  ) => {
    const result = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: token
        ? { authorization: `Bearer ${token}` }
        : {
            cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
          },
      ...(payload ? { payload } : {}),
    });
    for (const cookie of result.cookies) if (cookie.value) jar.set(cookie.name, cookie.value);
    return result;
  };
  try {
    const work = (
      await request('POST', '/auth/setup', {
        name: 'Work',
        email: 'work@example.test',
        password: 'work-password-123',
        seedDemo: true,
      })
    ).json();
    const before = (await request('GET', '/bootstrap')).json();
    assert.ok(before.projects.length > 0);
    const project = (
      await request('POST', '/projects', { name: 'Shared work', key: 'SAME' })
    ).json();
    const item = (
      await request('POST', '/items', { title: 'Shared work task', projectId: project.id })
    ).json();
    const inbox = (await request('POST', '/items', { title: 'Work inbox' })).json();
    const link = (
      await request('POST', '/links', {
        projectId: project.id,
        title: 'Work docs',
        url: 'https://example.test',
        kind: 'link',
      })
    ).json();
    const milestone = (
      await request('POST', '/milestones', { projectId: project.id, title: 'Work launch' })
    ).json();
    const personalResponse = await request('POST', '/auth/profiles', {
      name: 'Personal',
      email: 'personal@example.test',
      password: 'personal-password-123',
    });
    assert.equal(personalResponse.statusCode, 201, personalResponse.body);
    const personal = personalResponse.json();
    assert.equal(personal.role, 'admin');
    assert.ok(personal.workspaceId);
    assert.notEqual(personal.workspaceId, work.workspaceId);
    const fresh = (await request('GET', '/bootstrap')).json();
    for (const collection of ['projects', 'items', 'views', 'links', 'milestones'])
      assert.deepEqual(fresh[collection], [], collection);
    assert.deepEqual(
      fresh.users.map((u: { id: string }) => u.id),
      [personal.id],
    );
    assert.deepEqual(
      (await request('GET', '/users')).json().data.map((u: { id: string }) => u.id),
      [personal.id],
    );
    for (const path of [`/projects/${project.id}`, `/items/${item.id}`, `/items/${inbox.id}`]) {
      for (const method of ['GET', 'DELETE'] as const)
        assert.equal((await request(method, path)).statusCode, 404, `${method} ${path}`);
    }
    assert.equal(
      (await request('PATCH', `/projects/${project.id}`, { name: 'Stolen' })).statusCode,
      404,
    );
    assert.equal(
      (await request('POST', '/projects', { key: 'BAD', name: 'Bad parent', parentId: project.id }))
        .statusCode,
      404,
    );
    assert.equal(
      (await request('POST', '/items', { title: 'Bad project', projectId: project.id })).statusCode,
      404,
    );
    assert.equal(
      (await request('POST', '/items', { title: 'Bad parent', parentId: item.id })).statusCode,
      404,
    );
    assert.equal(
      (await request('POST', '/items', { title: 'Bad assignee', assigneeId: work.id })).statusCode,
      400,
    );
    assert.equal(
      (await request('POST', `/items/${item.id}/comments`, { body: 'Cross-workspace comment' }))
        .statusCode,
      404,
    );
    assert.equal((await request('DELETE', `/links/${link.id}`)).statusCode, 404);
    assert.equal((await request('DELETE', `/milestones/${milestone.id}`)).statusCode, 404);
    const ownProject = await request('POST', '/projects', {
      name: 'Personal project',
      key: 'SAME',
    });
    assert.equal(ownProject.statusCode, 201, ownProject.body);
    const ownItem = (
      await request('POST', '/items', {
        title: 'Personal recurring',
        projectId: ownProject.json().id,
        recurrence: 'daily',
        dueDate: '2026-09-05',
      })
    ).json();
    assert.equal(
      (await request('PATCH', `/items/${ownItem.id}`, { status: 'done' })).statusCode,
      200,
    );
    const ownItems = (await request('GET', '/items')).json().data;
    assert.equal(ownItems.length, 2);
    assert.ok(
      ownItems.every((i: { workspaceId: string }) => i.workspaceId === personal.workspaceId),
    );
    const invited = (
      await request('POST', '/users', {
        name: 'Personal collaborator',
        email: 'collaborator@example.test',
        password: 'collaborator-password',
      })
    ).json();
    assert.equal(invited.role, 'member');
    assert.equal(invited.workspaceId, personal.workspaceId);
    await request('POST', '/auth/login', {
      email: invited.email,
      password: 'collaborator-password',
    });
    assert.equal((await request('GET', `/projects/${ownProject.json().id}`)).statusCode, 200);
    assert.equal((await request('GET', `/projects/${project.id}`)).statusCode, 404);
    assert.equal(
      (
        await request('POST', '/users', {
          name: 'No',
          email: 'no@example.test',
          password: 'no-password-123',
        })
      ).statusCode,
      403,
    );
    // Members can create their own separate workspace without gaining admin rights in the original.
    assert.equal(
      (
        await request('POST', '/auth/profiles', {
          name: 'Another workspace',
          email: 'another@example.test',
          password: 'another-password',
        })
      ).statusCode,
      201,
    );
    await request('POST', '/auth/switch', { userId: work.id });
    assert.equal((await request('GET', `/projects/${ownProject.json().id}`)).statusCode, 404);
    assert.equal((await request('GET', `/items/${ownItem.id}`)).statusCode, 404);
    const after = (await request('GET', '/bootstrap')).json();
    assert.equal(after.projects.length, before.projects.length + 1);
    assert.deepEqual(after.users, before.users);
    assert.equal(after.user.role, 'admin');
    const exported = (await request('GET', '/export')).json();
    assert.equal(JSON.stringify(exported).includes('Personal recurring'), false);
    const token = (
      await request('POST', '/tokens', { name: 'Admin client', scope: 'admin' })
    ).json().token;
    assert.ok(token);
    assert.equal(
      (await request('GET', `/projects/${ownProject.json().id}`, undefined, token)).statusCode,
      404,
    );
    assert.equal(
      (
        await request(
          'POST',
          '/auth/profiles',
          { name: 'No browser', email: 'no-browser@example.test', password: 'no-browser-password' },
          token,
        )
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test('repository connections are isolated and the same repository can be connected in both workspaces', async () => {
  const previous = process.env.APP_SECRET;
  process.env.APP_SECRET = 'profile-isolation-test-secret-32-characters';
  const previousOrigins = process.env.CONFLUENCE_ALLOWED_ORIGINS;
  process.env.CONFLUENCE_ALLOWED_ORIGINS = 'https://example.atlassian.net';
  const app = await createApp({ dataDir: ':memory:' });
  const jar = new Map<string, string>();
  const request = async (method: 'GET' | 'POST' | 'DELETE', path: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') },
      ...(payload ? { payload } : {}),
    });
    for (const cookie of response.cookies) if (cookie.value) jar.set(cookie.name, cookie.value);
    return response;
  };
  const connection = {
    provider: 'github',
    name: 'Repository',
    repository: 'owner/repository',
    token: 'local-test-token',
  };
  try {
    const work = (
      await request('POST', '/auth/setup', {
        name: 'Work',
        email: 'work@connections.test',
        password: 'work-password-123',
        seedDemo: false,
      })
    ).json();
    const workProject = (await request('POST', '/projects', { key: 'WORK', name: 'Work' })).json();
    const workConnection = await request('POST', '/integrations', {
      ...connection,
      projectId: workProject.id,
    });
    assert.equal(workConnection.statusCode, 201, workConnection.body);
    assert.equal(
      (
        await request('POST', '/confluence/connection', {
          deployment: 'cloud',
          baseUrl: 'https://example.atlassian.net/wiki',
          username: 'work@connections.test',
          token: 'work-confluence-token',
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (await request('POST', '/tokens', { name: 'Work token', scope: 'read' })).statusCode,
      201,
    );

    await request('POST', '/auth/profiles', {
      name: 'Personal',
      email: 'personal@connections.test',
      password: 'personal-password-123',
    });
    assert.deepEqual((await request('GET', '/integrations')).json(), []);
    assert.equal((await request('GET', '/confluence/connection')).json(), null);
    assert.deepEqual((await request('GET', '/tokens')).json().data, []);
    assert.equal((await request('GET', '/confluence/search?q=work')).statusCode, 404);

    assert.equal(
      (await request('POST', '/integrations', { ...connection, projectId: workProject.id }))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await request(
          'POST',
          `/integrations/${encodeURIComponent(workConnection.json().id)}/sync`,
          {},
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await request('DELETE', `/integrations/${encodeURIComponent(workConnection.json().id)}`))
        .statusCode,
      404,
    );
    const personalProject = (
      await request('POST', '/projects', { key: 'HOME', name: 'Personal' })
    ).json();
    const personalConnection = await request('POST', '/integrations', {
      ...connection,
      projectId: personalProject.id,
    });
    assert.equal(personalConnection.statusCode, 201, personalConnection.body);
    assert.notEqual(personalConnection.json().id, workConnection.json().id);
    assert.equal((await request('GET', '/integrations')).json().length, 1);
    assert.equal(
      (await request('POST', '/integrations', { ...connection, projectId: personalProject.id }))
        .statusCode,
      409,
    );
    await request('POST', '/auth/switch', { userId: work.id });
    const visible = (await request('GET', '/integrations')).json();
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, workConnection.json().id);
    assert.equal((await request('GET', '/confluence/connection')).json().configured, true);
    assert.equal((await request('GET', '/tokens')).json().data.length, 1);

    assert.equal(
      (await request('DELETE', `/integrations/${encodeURIComponent(personalConnection.json().id)}`))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
    if (previousOrigins === undefined) delete process.env.CONFLUENCE_ALLOWED_ORIGINS;
    else process.env.CONFLUENCE_ALLOWED_ORIGINS = previousOrigins;
    if (previous === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previous;
  }
});
