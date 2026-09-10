import { sharedWorkspace } from './shared-workspace-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { demoRoadmap } from '../server/roadmap-demo.ts';

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
