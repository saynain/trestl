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

test('mentions parse actual Markdown links, not code, images, or escaped examples', () => {
  const target = { kind: 'item' as const, id: randomUUID() };
  const link = mentionMarkdown(target, 'TEST-1 [example]');
  assert.deepEqual(extractMentions(`${link} ${link}`), [target]);
  assert.deepEqual(
    extractMentions('`' + link + '`\n\n```\n' + link + '\n```\n\n    ' + link + '\n\n!' + link),
    [],
  );
  assert.deepEqual(extractMentions('\\' + link), []);
  assert.equal(parseMentionHref('https://evil.test/#/mention/item/' + target.id), null);
  assert.equal(parseMentionHref('#/mention/item/not-an-id'), null);
  assert.equal(mentionQuery('mail@example.test', 17), null);
  assert.equal(mentionQuery('https://example.test', 20), null);
  assert.equal(mentionQuery('`/foo`', 5), null);
  assert.equal(mentionQuery('text /TES', 9)?.query, 'TES');
  assert.equal(mentionQuery('$Plan', 5)?.kind, 'project');
  assert.equal(mentionQuery('@Alex', 5)?.kind, 'user');
});

test('description and comment mentions create atomic, deduplicated, access-controlled relationships', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@mentions.test',
        password: 'test-password-long',
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
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
        headers: {
          cookie: as,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const project = (
      await api('POST', '/projects', { name: 'Mention target', key: 'MENTION' })
    ).json();
    const target = (await api('POST', '/items', { title: 'Target', projectId: project.id })).json();
    const itemMention = mentionMarkdown({ kind: 'item', id: target.id }, target.identifier);
    const projectMention = mentionMarkdown({ kind: 'project', id: project.id }, project.name);
    const personMention = mentionMarkdown({ kind: 'user', id: setup.json().id }, 'Owner');
    const created = await api('POST', '/items', {
      title: 'Source',
      projectId: project.id,
      description: `${personMention} ${itemMention} ${projectMention}`,
    });
    assert.equal(created.statusCode, 201, created.body);
    const source = created.json();
    const detail = async () => (await api('GET', `/items/${source.id}`)).json();
    assert.equal((await detail()).relations.length, 1);
    assert.equal((await detail()).projectRelations.length, 1);
    await api('POST', `/items/${source.id}/comments`, { body: `${itemMention} ${projectMention}` });
    await api('POST', `/items/${target.id}/comments`, {
      body: mentionMarkdown({ kind: 'item', id: source.id }, source.identifier),
    });
    assert.equal(
      (await detail()).relations.length,
      1,
      'Reverse mentions do not duplicate a related relationship',
    );
    assert.equal((await detail()).projectRelations.length, 1);
    await api('PATCH', `/items/${source.id}`, { description: 'Removed mentions' });
    assert.equal((await detail()).relations.length, 1, 'Removing text preserves relationships');
    const before = await detail();
    const invalid = mentionMarkdown({ kind: 'project', id: randomUUID() }, 'Missing');
    assert.equal(
      (await api('POST', `/items/${source.id}/comments`, { body: invalid })).statusCode,
      404,
    );
    assert.equal(
      (await detail()).activity.length,
      before.activity.length,
      'Invalid mention rolls back the comment',
    );
    assert.equal(
      (await api('PATCH', `/items/${source.id}`, { description: invalid })).statusCode,
      404,
    );
    assert.equal((await detail()).item.description, 'Removed mentions');
    const privateProject = (
      await api('POST', '/projects', { name: 'Private', key: 'PRIVATE', visibility: 'private' })
    ).json();
    const privateItem = (
      await api('POST', '/items', { title: 'Secret', projectId: privateProject.id })
    ).json();
    const hiddenMention = mentionMarkdown({ kind: 'item', id: privateItem.id }, 'Secret');
    await api('POST', `/items/${source.id}/comments`, {
      body:
        hiddenMention +
        ' ' +
        mentionMarkdown({ kind: 'project', id: privateProject.id }, 'Private'),
    });
    const member = await api('POST', '/users', {
      name: 'Member',
      email: 'member@mentions.test',
      password: 'test-password-long',
    });
    assert.equal(member.statusCode, 201, member.body);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@mentions.test', password: 'test-password-long' },
    });
    const memberCookie = `${login.cookies[0].name}=${login.cookies[0].value}`;
    assert.equal(
      (await api('POST', `/items/${source.id}/comments`, { body: hiddenMention }, memberCookie))
        .statusCode,
      404,
    );
    const visible = (await api('GET', `/items/${source.id}`, undefined, memberCookie)).json();
    assert.equal(visible.relations.length, 1);
    assert.equal(visible.projectRelations.length, 1);
    const bootstrap = (await api('GET', '/bootstrap', undefined, memberCookie)).json();
    assert.equal(bootstrap.projectRelations.length, 1);
    const r = (await detail()).projectRelations.find(
      (r: { projectId: string }) => r.projectId === project.id,
    );
    assert.equal(
      (await api('DELETE', `/items/${source.id}/project-relations/${r.id}`)).statusCode,
      204,
    );
    assert.equal((await detail()).projectRelations.length, 1);
    await api('DELETE', `/items/${privateItem.id}`);
    await api('DELETE', `/projects/${privateProject.id}`);
    assert.equal(
      (await detail()).projectRelations.length,
      0,
      'Project deletion cleans up relationships',
    );
  } finally {
    await app.close();
  }
});
