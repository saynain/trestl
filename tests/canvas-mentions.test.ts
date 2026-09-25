import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import {
  extractMentions,
  mentionMarkdown,
  mentionQuery,
  parseMentionHref,
} from '../shared/mentions.ts';

test('canvas references are stable Markdown links and do not activate inside Markdown images or code', () => {
  const mention = { kind: 'canvas' as const, id: randomUUID() };
  const link = mentionMarkdown(mention, 'Architecture [draft]');
  assert.deepEqual(extractMentions(link), [mention]);
  assert.deepEqual(parseMentionHref(`#/mention/canvas/${mention.id}`), mention);
  assert.equal(mentionQuery('See !Arch', 9)?.kind, 'canvas');
  assert.equal(mentionQuery('See !Arch', 9)?.query, 'Arch');
  assert.equal(mentionQuery('`!Arch`', 6), null);
  assert.equal(mentionQuery('![image](file.png)', 5), null);
  assert.deepEqual(extractMentions('`' + link + '`\n\n!' + link), []);
});

test('canvas references persist in all editors, expose summaries only, and enforce project access atomically', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@canvas-mentions.test',
        password: 'test-password-long',
      },
    });
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: unknown,
      as = cookie,
    ) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: { cookie: as },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const project = (await api('POST', '/projects', { name: 'Design', key: 'DES' })).json();
    const canvas = (
      await api('POST', `/projects/${project.id}/canvases`, { title: 'Architecture' })
    ).json();
    const reference = mentionMarkdown({ kind: 'canvas', id: canvas.id }, canvas.title);
    const itemResponse = await api('POST', '/items', {
      title: 'Implement design',
      projectId: project.id,
      description: reference,
    });
    assert.equal(itemResponse.statusCode, 201, itemResponse.body);
    const item = itemResponse.json();
    const comment = await api('POST', `/items/${item.id}/comments`, { body: reference });
    assert.equal(comment.statusCode, 201, comment.body);
    const description = await api('PATCH', `/projects/${project.id}`, { description: reference });
    assert.equal(description.statusCode, 200, description.body);
    assert.equal(description.json().description, reference);
    const newProject = await api('POST', '/projects', {
      name: 'Another design',
      key: 'OTHER',
      description: reference,
    });
    assert.equal(newProject.statusCode, 201, newProject.body);
    const detail = (await api('GET', `/items/${item.id}`)).json();
    assert.equal(detail.item.description, reference);
    assert.equal(detail.relations.length, 0);
    assert.equal(detail.projectRelations.length, 0);
    assert.ok(detail.activity.some((a: { body: string }) => a.body === reference));
    await api('PATCH', `/projects/${project.id}/canvases/${canvas.id}`, {
      title: 'Renamed architecture',
      expectedRevision: canvas.revision,
    });
    const summaries = (await api('GET', '/bootstrap')).json().canvases;
    assert.equal(summaries[0].id, canvas.id);
    assert.equal(summaries[0].title, 'Renamed architecture');
    assert.equal(summaries[0].scene, undefined);
    assert.equal((await api('GET', `/items/${item.id}`)).json().item.description, reference);
    const privateProject = (
      await api('POST', '/projects', { name: 'Private', key: 'PRIV', visibility: 'private' })
    ).json();
    const secret = (
      await api('POST', `/projects/${privateProject.id}/canvases`, { title: 'Secret design' })
    ).json();
    const hidden = mentionMarkdown({ kind: 'canvas', id: secret.id }, secret.title);
    await api('POST', '/users', {
      name: 'Member',
      email: 'member@canvas-mentions.test',
      password: 'test-password-long',
    });
    const login = await api('POST', '/auth/login', {
      email: 'member@canvas-mentions.test',
      password: 'test-password-long',
    });
    const memberCookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
    const memberBootstrap = (await api('GET', '/bootstrap', undefined, memberCookie)).json();
    assert.deepEqual(
      memberBootstrap.canvases.map((c: { id: string }) => c.id),
      [canvas.id],
    );
    assert.equal(
      (await api('POST', `/items/${item.id}/comments`, { body: hidden }, memberCookie)).statusCode,
      404,
    );
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { description: hidden }, memberCookie)).statusCode,
      404,
    );
    assert.equal(
      (await api('PATCH', `/projects/${project.id}`, { description: hidden }, memberCookie))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await api(
          'POST',
          '/projects',
          { name: 'Invalid', key: 'BAD', description: hidden },
          memberCookie,
        )
      ).statusCode,
      404,
    );
    assert.equal((await api('GET', `/items/${item.id}`)).json().item.description, reference);
    assert.equal((await api('GET', `/projects/${project.id}`)).json().description, reference);
    const missing = mentionMarkdown({ kind: 'canvas', id: randomUUID() }, 'Missing');
    assert.equal(
      (await api('POST', `/items/${item.id}/comments`, { body: missing })).statusCode,
      404,
    );
    assert.equal(
      (await api('GET', `/items/${item.id}`)).json().activity.length,
      detail.activity.length,
    );
    assert.equal(
      (
        await api('DELETE', `/projects/${project.id}/canvases/${canvas.id}`, {
          expectedRevision: canvas.revision + 1,
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (await api('GET', '/bootstrap'))
        .json()
        .canvases.some((c: { id: string }) => c.id === canvas.id),
      false,
    );
    // Existing references remain editable after their target has been removed.
    assert.equal(
      (await api('PATCH', `/projects/${project.id}`, { description: reference + ' revised' }))
        .statusCode,
      200,
    );
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { description: reference + ' revised' })).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
