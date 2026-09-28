import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==',
  'base64',
);

test('uploaded images follow the referenced work item access', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { name: 'Owner', email: 'owner@images.test', password: 'correct-horse-battery' },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const owner = cookieOf(setup);
    const memberLogin = await memberSession(app, owner, {
      name: 'Member',
      email: 'member@images.test',
      password: 'correct-horse-battery',
    });
    const member = cookieOf(memberLogin);
    const memberId = memberLogin.json().id;
    const upload = await app.inject({
      method: 'POST',
      url: '/api/v1/images',
      headers: { cookie: owner, 'content-type': 'image/png' },
      payload: png,
    });
    assert.equal(upload.statusCode, 201, upload.body);
    const url = upload.json().url as string;
    assert.match(url, /^\/api\/v1\/images\/[0-9a-f-]{36}$/);
    const getImage = (cookie: string) => app.inject({ method: 'GET', url, headers: { cookie } });
    assert.equal((await getImage(owner)).statusCode, 200);
    assert.equal((await getImage(member)).statusCode, 404, 'Unattached images stay private');

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie: owner },
      payload: { key: 'SCREEN', name: 'Screenshots', visibility: 'private', memberIds: [memberId] },
    });
    assert.equal(projectResponse.statusCode, 201, projectResponse.body);
    const project = projectResponse.json();
    const itemResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: { cookie: owner },
      payload: {
        title: 'Review screenshot',
        projectId: project.id,
        description: `![Screenshot](${url})`,
      },
    });
    assert.equal(itemResponse.statusCode, 201, itemResponse.body);
    const image = await getImage(member);
    assert.equal(image.statusCode, 200, image.body);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(image.rawPayload, png);

    const revoke = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: { cookie: owner },
      payload: { memberIds: [] },
    });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.equal((await getImage(member)).statusCode, 404);
    assert.equal((await getImage(owner)).statusCode, 200);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/items/${itemResponse.json().id}`,
      headers: { cookie: owner },
    });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal((await getImage(owner)).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('comment images bind to their work item and invalid files are rejected', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@comment-images.test',
        password: 'correct-horse-battery',
      },
    });
    const cookie = cookieOf(setup);
    const upload = (payload: Buffer) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/images',
        headers: { cookie, 'content-type': 'image/png' },
        payload,
      });
    assert.equal((await upload(Buffer.from('not an image'))).statusCode, 400);
    const { url } = (await upload(png)).json();
    const item = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/items',
        headers: { cookie },
        payload: { title: 'Comment image' },
      })
    ).json();
    const comment = await app.inject({
      method: 'POST',
      url: `/api/v1/items/${item.id}/comments`,
      headers: { cookie },
      payload: { body: `See ![capture](${url})` },
    });
    assert.equal(comment.statusCode, 201, comment.body);
    assert.equal((await app.inject({ method: 'GET', url, headers: { cookie } })).statusCode, 200);
  } finally {
    await app.close();
  }
});
