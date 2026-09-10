import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { CanvasSummary } from '../shared/types.ts';
import { organizeCanvases } from '../src/lib/canvas-organization.ts';

test('collections persist, enforce project access, validate moves, and preserve canvases on removal', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-collections-'));
  let app = await createApp({ dataDir, integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@collections.test',
        password: 'collection-password',
        seedDemo: false,
      },
    });
    const cookie = setup.cookies.find((c) => c.name === 'trestl_session')!;
    const owner = `${cookie.name}=${cookie.value}`;
    const call = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: unknown,
      auth = owner,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie: auth },
        ...(payload ? { payload } : {}),
      });
    const project = (
      await call('POST', '/projects', {
        name: 'Private sketches',
        key: 'SKETCH',
        visibility: 'private',
      })
    ).json();
    const other = (await call('POST', '/projects', { name: 'Other', key: 'OTHER' })).json();
    const base = `/projects/${project.id}/canvas-collections`,
      canvases = `/projects/${project.id}/canvases`;
    const created = await call('POST', base, { name: 'Architecture' });
    assert.equal(created.statusCode, 201, created.body);
    const group = created.json(),
      path = `${base}/${group.id}`;
    assert.equal((await call('POST', base, { name: ' architecture ' })).statusCode, 409);
    assert.equal((await call('POST', base, { name: ' ' })).statusCode, 400);
    const otherGroup = (
      await call('POST', `/projects/${other.id}/canvas-collections`, { name: 'Other' })
    ).json();
    assert.equal(
      (await call('POST', canvases, { title: 'Invalid', collectionId: otherGroup.id })).statusCode,
      404,
    );
    const scene = {
      elements: [{ id: 'box', type: 'rectangle', x: 1, y: 2, width: 20, height: 30 }],
      appState: {},
      files: {},
    };
    const canvas = (
      await call('POST', canvases, { title: 'A drawing', scene, collectionId: group.id })
    ).json();
    const canvasPath = `${canvases}/${canvas.id}`;
    assert.equal(canvas.collectionId, group.id);
    assert.equal(
      (await call('PATCH', canvasPath, { collectionId: otherGroup.id, expectedRevision: 1 }))
        .statusCode,
      404,
    );
    assert.equal((await call('GET', canvasPath)).json().revision, 1);
    assert.equal(
      (await call('PATCH', canvasPath, { collectionId: null, expectedRevision: 1 })).statusCode,
      200,
    );
    assert.equal(
      (await call('PATCH', canvasPath, { collectionId: group.id, expectedRevision: 1 })).statusCode,
      409,
    );
    assert.equal(
      (await call('PATCH', canvasPath, { collectionId: group.id, expectedRevision: 2 })).statusCode,
      200,
    );
    const summary = (await call('GET', canvases)).json().data[0];
    assert.equal(summary.collectionId, group.id);
    assert.equal(summary.scene, undefined);
    await call('POST', '/users', {
      name: 'Member',
      email: 'member@collections.test',
      password: 'collection-password',
    });
    const login = await call('POST', '/auth/login', {
      email: 'member@collections.test',
      password: 'collection-password',
    });
    const memberCookie = login.cookies.find((c) => c.name === 'trestl_session')!;
    const member = `${memberCookie.name}=${memberCookie.value}`;
    for (const [method, url, body] of [
      ['GET', base, undefined],
      ['POST', base, { name: 'Hidden' }],
      ['PATCH', path, { name: 'Hidden', expectedRevision: 1 }],
      ['DELETE', path, { expectedRevision: 1 }],
    ] as const)
      assert.equal((await call(method, url, body, member)).statusCode, 404);
    assert.deepEqual(
      (await call('GET', '/export', undefined, member))
        .json()
        .canvasCollections.map((c: { id: string }) => c.id),
      [otherGroup.id],
    );
    assert.equal(
      (
        await call('PATCH', `/projects/${other.id}/canvas-collections/${group.id}`, {
          name: 'Wrong project',
          expectedRevision: 1,
        })
      ).statusCode,
      404,
    );
    const outsiderLogin = await call('POST', '/auth/profiles', {
      name: 'Other workspace',
      email: 'outside@collections.test',
      password: 'collection-password',
    });
    const outsideCookie = outsiderLogin.cookies.find((c) => c.name === 'trestl_session')!;
    const outsider = `${outsideCookie.name}=${outsideCookie.value}`;
    assert.equal((await call('GET', base, undefined, outsider)).statusCode, 404);
    assert.deepEqual(
      (await call('GET', '/export', undefined, outsider)).json().canvasCollections,
      [],
    );
    const readToken = (await call('POST', '/tokens', { name: 'Read only', scope: 'read' })).json()
      .token;
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1${base}`,
          headers: { authorization: `Bearer ${readToken}` },
          payload: { name: 'Denied' },
        })
      ).statusCode,
      403,
    );
    const duplicateRace = await Promise.all(
      ['Workflows', 'workflows'].map((name) => call('POST', base, { name })),
    );
    assert.deepEqual(duplicateRace.map((r) => r.statusCode).sort(), [201, 409]);
    const renamed = await call('PATCH', path, { name: 'System design', expectedRevision: 1 });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((await call('DELETE', path, { expectedRevision: 1 })).statusCode, 409);
    await app.close();
    app = await createApp({ dataDir, integrations: false });
    assert.equal(
      (await call('GET', base)).json().data.find((c: { id: string }) => c.id === group.id).name,
      'System design',
    );
    assert.equal((await call('GET', canvasPath)).json().collectionId, group.id);
    assert.equal(
      (await call('GET', '/export'))
        .json()
        .canvasCollections.some((c: { id: string }) => c.id === group.id),
      true,
    );
    assert.equal((await call('DELETE', path, { expectedRevision: 2 })).statusCode, 204);
    const preserved = (await call('GET', canvasPath)).json();
    assert.equal(preserved.collectionId, null);
    assert.equal(preserved.revision, 4);
    assert.deepEqual(preserved.scene, scene);
    assert.equal(
      (await call('PATCH', canvasPath, { title: 'Stale editor', expectedRevision: 3 })).statusCode,
      409,
    );
    assert.equal(
      (await call('POST', canvases, { title: 'Deleted group', collectionId: group.id })).statusCode,
      404,
    );
    assert.equal((await call('POST', base, { name: 'Architecture' })).statusCode, 201);
    await call('DELETE', `/projects/${project.id}`);
    const rows = await app
      .getDecorator<AppContext>('context')
      .db.query<{ data: { projectId: string } }>(
        "SELECT data FROM entities WHERE collection='canvasCollections'",
      );
    assert.equal(
      rows.rows.some((r) => r.data.projectId === project.id),
      false,
    );
    assert.equal(
      rows.rows.some((r) => r.data.projectId === other.id),
      true,
    );
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('overview combines collection and name filters, supports legacy Unsorted, and sorts without mutating input', () => {
  const canvases = [
    { id: 'a', title: 'Sketch 10', createdAt: '2026-01-01', updatedAt: '2026-03-01' },
    {
      id: 'b',
      title: 'Sketch 2',
      collectionId: 'design',
      createdAt: '2026-02-01',
      updatedAt: '2026-02-01',
    },
    {
      id: 'c',
      title: 'Architecture',
      collectionId: null,
      createdAt: '2026-03-01',
      updatedAt: '2026-01-01',
    },
  ] as CanvasSummary[];
  const ids = (list: CanvasSummary[]) => list.map((c) => c.id);
  assert.deepEqual(ids(organizeCanvases(canvases, 'all', '', 'updated')), ['a', 'b', 'c']);
  assert.deepEqual(ids(organizeCanvases(canvases, 'all', '', 'newest')), ['c', 'b', 'a']);
  assert.deepEqual(ids(organizeCanvases(canvases, 'all', '', 'alphabetical')), ['c', 'b', 'a']);
  assert.deepEqual(ids(organizeCanvases(canvases, 'unsorted', ' SKETCH ', 'updated')), ['a']);
  assert.deepEqual(ids(organizeCanvases(canvases, 'design', 'sketch', 'updated')), ['b']);
  assert.deepEqual(ids(organizeCanvases(canvases, 'design', 'architecture', 'updated')), []);
  assert.deepEqual(ids(canvases), ['a', 'b', 'c']);
});
