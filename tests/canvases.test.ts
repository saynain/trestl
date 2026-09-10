import { sharedWorkspace } from './shared-workspace-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../server/context.ts';
import { createApp } from '../server/app.ts';

test('project canvases persist, isolate access, reject stale writes, export, and clean up on deletion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-canvas-test-'));
  let app = await createApp({ dataDir, integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@canvas.test',
        password: 'canvas-test-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const shared = await sharedWorkspace(app, setup);
    const cookieOf = (response: typeof setup) => {
      const cookie = response.cookies.find((c) => c.name === 'trestl_session')!;
      return `${cookie.name}=${cookie.value}`;
    };
    const owner = cookieOf(shared);
    const call = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: unknown,
      cookie = owner,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    const parent = (
      await call('POST', '/projects', {
        key: 'SECRET',
        name: 'Private parent',
        visibility: 'private',
      })
    ).json();
    const project = (
      await call('POST', '/projects', { key: 'CANVAS', name: 'Architecture', parentId: parent.id })
    ).json();
    const base = `/projects/${project.id}/canvases`;
    const created = await call('POST', base, { title: 'System architecture' });
    assert.equal(created.statusCode, 201, created.body);
    const canvas = created.json(),
      path = `${base}/${canvas.id}`;
    const scene = {
      elements: [
        { id: 'box', type: 'rectangle', x: 20, y: 30, width: 200, height: 100, version: 1 },
      ],
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    };
    const writes = await Promise.all(
      ['First', 'Second'].map((title) =>
        call('PATCH', path, { title, scene, expectedRevision: 1 }),
      ),
    );
    assert.deepEqual(writes.map((r) => r.statusCode).sort(), [200, 409]);
    const saved = (await call('GET', path)).json();
    assert.equal(saved.revision, 2);
    assert.deepEqual(saved.scene, scene);
    assert.equal((await call('PATCH', path, { scene })).statusCode, 400);
    assert.equal(
      (
        await call('PATCH', path, {
          expectedRevision: 2,
          scene: {
            ...scene,
            elements: [{ id: 'bad', type: 'iframe', x: 0, y: 0, width: 1, height: 1 }],
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call('PATCH', path, {
          expectedRevision: 2,
          scene: {
            ...scene,
            elements: [{ ...scene.elements[0], type: 'image', fileId: 'missing' }],
          },
        })
      ).statusCode,
      400,
    );
    assert.equal((await call('POST', base, { title: '  ' })).statusCode, 400);
    const listed = (await call('GET', base)).json().data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].scene, undefined);
    assert.equal((await call('GET', '/bootstrap')).json().canvases, undefined);
    assert.deepEqual((await call('GET', '/export')).json().canvases[0].scene, scene);
    await call('POST', '/users', {
      name: 'Member',
      email: 'member@canvas.test',
      password: 'canvas-member-password',
    });
    const member = cookieOf(
      await call('POST', '/auth/login', {
        email: 'member@canvas.test',
        password: 'canvas-member-password',
      }),
    );
    for (const [method, url, payload] of [
      ['GET', base, undefined],
      ['GET', path, undefined],
      ['POST', base, { title: 'Hidden' }],
      ['PATCH', path, { title: 'Hidden', expectedRevision: 2 }],
      ['DELETE', path, { expectedRevision: 2 }],
    ] as const)
      assert.equal((await call(method, url, payload, member)).statusCode, 404);
    assert.deepEqual((await call('GET', '/export', undefined, member)).json().canvases, []);
    await call('PATCH', `/projects/${parent.id}`, { visibility: 'workspace' });
    assert.equal((await call('GET', path, undefined, member)).statusCode, 200);
    // Installation access requires authentication, even for shared projects.
    assert.equal((await app.inject({ url: `/api/v1${path}` })).statusCode, 401);
    const readToken = (await call('POST', '/tokens', { name: 'Read only', scope: 'read' })).json()
      .token;
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1${path}`,
          headers: { authorization: `Bearer ${readToken}` },
          payload: { title: 'Denied', expectedRevision: 2 },
        })
      ).statusCode,
      403,
    );
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1${path}` })).statusCode, 401);
    assert.equal((await call('DELETE', path, { expectedRevision: 1 })).statusCode, 409);
    // Real disk-backed restart, including embedded image bytes.
    const dataURL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
    const imageScene = {
      ...scene,
      elements: [
        ...scene.elements,
        { id: 'image', type: 'image', x: 250, y: 30, width: 100, height: 100, fileId: 'png' },
      ],
      files: { png: { id: 'png', mimeType: 'image/png', dataURL, created: 1 } },
    };
    assert.equal(
      (await call('PATCH', path, { scene: imageScene, expectedRevision: 2 })).statusCode,
      200,
    );
    await app.close();
    app = await createApp({ dataDir, integrations: false });
    assert.deepEqual((await call('GET', path)).json().scene, imageScene);
    const otherProject = (await call('POST', '/projects', { key: 'OTHER', name: 'Other' })).json();
    assert.equal(
      (await call('GET', `/projects/${otherProject.id}/canvases/${canvas.id}`)).statusCode,
      404,
    );
    const disposable = (await call('POST', base, { title: 'Temporary' })).json();
    assert.equal(
      (await call('DELETE', `${base}/${disposable.id}`, { expectedRevision: 1 })).statusCode,
      204,
    );
    assert.equal((await call('GET', `${base}/${disposable.id}`)).statusCode, 404);
    assert.equal((await call('DELETE', `/projects/${project.id}`)).statusCode, 204);
    assert.deepEqual((await call('GET', '/export')).json().canvases, []);
    const rows = await app
      .getDecorator<AppContext>('context')
      .db.query("SELECT id FROM entities WHERE collection='canvases'");
    assert.equal(rows.rows.length, 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
