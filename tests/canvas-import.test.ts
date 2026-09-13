import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';

const document = {
  type: 'excalidraw',
  version: 2,
  source: 'https://excalidraw.com',
  elements: [{ id: 'box', type: 'rectangle', x: 10, y: 20, width: 100, height: 80 }],
  appState: {
    viewBackgroundColor: '#ffffff',
    gridSize: null,
    theme: 'dark',
    selectedElementIds: { box: true },
  },
  files: {},
};

test('native imports create exactly one canvas, preserve images, validate atomically and respect token/project permissions', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Canvas owner',
        email: 'canvas-import@example.test',
        password: 'test-password-123',
        seedDemo: false,
      },
    });
    const cookie = cookieOf(setup);
    const token = async (scope: 'read' | 'write', session = cookie) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/tokens',
          headers: { cookie: session },
          payload: { name: 'Canvas test', scope },
        })
      ).json().token;
    const write = await token('write'),
      read = await token('read');
    const call = (
      method: 'GET' | 'POST' | 'DELETE',
      path: string,
      payload?: object,
      credential = write,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { authorization: `Bearer ${credential}` },
        ...(payload === undefined ? {} : { payload }),
      });
    const project = (
      await call('POST', '/projects', {
        key: 'DRAW',
        name: 'Private diagrams',
        visibility: 'private',
      })
    ).json();
    const base = `/projects/${project.id}/canvases`;
    const group = (
      await call('POST', `/projects/${project.id}/canvas-collections`, { name: 'Architecture' })
    ).json();
    const imported = await call('POST', `${base}/import`, {
      title: 'Native drawing',
      document,
      collectionId: group.id,
    });
    assert.equal(imported.statusCode, 201, imported.body);
    const canvas = imported.json();
    assert.equal(canvas.collectionId, group.id);
    assert.deepEqual(canvas.scene, {
      elements: document.elements,
      appState: { viewBackgroundColor: '#ffffff', gridSize: null },
      files: {},
    });
    const list = (await call('GET', base, undefined, read)).json().data;
    assert.equal(list.length, 1);
    assert.equal(list[0].scene, undefined);
    const show = await call('GET', `${base}/${canvas.id}/show`, undefined, read);
    assert.equal(show.statusCode, 200, show.body);
    const link = new URL(show.json().url, 'https://trestl.example');
    assert.equal(link.origin, 'https://trestl.example');
    assert.equal(link.hash.split('?')[0], `#/project/${project.id}`);
    assert.equal(new URLSearchParams(link.hash.split('?')[1]).get('tab'), `canvases/${canvas.id}`);
    assert.equal(show.json().revision, 1);
    assert.equal(
      (await call('GET', `${base}/${canvas.id}`, undefined, read)).json().scene.elements[0].id,
      'box',
    );
    const dataURL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
    const image = { id: 'image', type: 'image', x: 0, y: 0, width: 1, height: 1, fileId: 'png' };
    const imageDocument = {
      ...document,
      elements: [image],
      files: { png: { id: 'png', mimeType: 'image/png', dataURL, created: 1 } },
    };
    const withImage = await call('POST', `${base}/import`, {
      title: 'With image',
      document: imageDocument,
    });
    assert.equal(withImage.statusCode, 201, withImage.body);
    assert.equal(withImage.json().scene.files.png.dataURL, dataURL);
    for (const invalid of [
      null,
      {},
      { ...document, type: 'other' },
      { ...document, elements: [null] },
      { ...document, elements: [document.elements[0], document.elements[0]] },
      { ...document, elements: [{ ...document.elements[0], link: 'javascript:alert(1)' }] },
      { ...document, elements: [{ ...document.elements[0], type: 'embeddable' }] },
      { ...document, elements: [image] },
    ]) {
      const result = await call('POST', `${base}/import`, { title: 'Invalid', document: invalid });
      assert.equal(result.statusCode, 400, result.body);
    }
    assert.equal(
      (
        await call('POST', `${base}/import`, {
          title: 'Too big',
          document: { ...document, source: 'x'.repeat(8 * 1024 * 1024) },
        })
      ).statusCode,
      413,
    );
    const other = (await call('POST', '/projects', { key: 'OTHER', name: 'Other' })).json();
    assert.equal(
      (
        await call('POST', `/projects/${other.id}/canvases/import`, {
          title: 'Wrong collection',
          document,
          collectionId: group.id,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (await call('GET', `/projects/${other.id}/canvases/${canvas.id}/show`)).statusCode,
      404,
    );
    const member = await memberSession(app, cookie, {
      name: 'Other',
      email: 'other-canvas@example.test',
      password: 'test-password-123',
    });
    const memberToken = await token('write', cookieOf(member));
    for (const [method, path, payload] of [
      ['GET', base, undefined],
      ['GET', `${base}/${canvas.id}/show`, undefined],
      ['POST', `${base}/import`, { title: 'Denied', document }],
      ['DELETE', `${base}/${canvas.id}`, { expectedRevision: 1 }],
    ] as const)
      assert.equal((await call(method, path, payload, memberToken)).statusCode, 404);
    for (const [method, path, payload] of [
      ['POST', base, { title: 'Denied' }],
      ['POST', `${base}/import`, { title: 'Denied', document }],
      ['DELETE', `${base}/${canvas.id}`, { expectedRevision: 1 }],
    ] as const)
      assert.equal((await call(method, path, payload, read)).statusCode, 403);
    assert.equal(
      (await call('GET', base)).json().data.length,
      2,
      'Invalid imports must not create orphan canvases',
    );
    assert.equal(
      (await call('DELETE', `${base}/${canvas.id}`, { expectedRevision: 0 })).statusCode,
      409,
    );
    assert.equal(
      (await call('DELETE', `${base}/${canvas.id}`, { expectedRevision: 1 })).statusCode,
      204,
    );
    assert.equal((await call('GET', `${base}/${canvas.id}/show`)).statusCode, 404);
  } finally {
    await app.close();
  }
});
