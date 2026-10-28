import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import {
  extractMentions,
  mentionMarkdown,
  mentionQuery,
  remapMentionIds,
} from '../shared/mentions.ts';

test('milestone references parse and remap stable links while preserving code and external links', () => {
  const target = { kind: 'milestone' as const, id: randomUUID() };
  const nextId = randomUUID();
  const link = mentionMarkdown(target, 'Launch [phase]');
  assert.deepEqual(extractMentions(link), [target]);
  assert.equal(mentionQuery('Ready for %Lau', 14)?.kind, 'milestone');
  assert.equal(mentionQuery('100%', 4), null);
  assert.equal(mentionQuery('`%Launch`', 8), null);
  const external = `[External](https://example.test/${target.id})`;
  const markdown = `${link}\n\n\`${link}\`\n\n${external}`;
  assert.equal(
    remapMentionIds(markdown, { milestone: new Map([[target.id, nextId]]) }),
    `${mentionMarkdown({ ...target, id: nextId }, 'Launch [phase]')}\n\n\`${link}\`\n\n${external}`,
  );
  assert.equal(remapMentionIds(link, {}), link);
});

test('inline milestones persist without assignment or relationships and enforce target access', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Owner',
        email: 'owner@milestone-mentions.test',
        password: 'long-test-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = setup.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: object,
      as = cookie,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie: as },
        ...(payload ? { payload } : {}),
      });
    const project = (await api('POST', '/projects', { name: 'Main', key: 'MAIN' })).json();
    const other = (await api('POST', '/projects', { name: 'Other', key: 'OTHER' })).json();
    const assigned = (
      await api('POST', '/milestones', { projectId: project.id, title: 'Assigned' })
    ).json();
    const referenced = (
      await api('POST', '/milestones', { projectId: other.id, title: 'Launch' })
    ).json();
    const reference = mentionMarkdown({ kind: 'milestone', id: referenced.id }, referenced.title);
    const created = await api('POST', '/items', {
      projectId: project.id,
      title: 'Reference only',
      description: reference,
      milestoneId: assigned.id,
    });
    assert.equal(created.statusCode, 201, created.body);
    const item = created.json();
    const detail = async () => (await api('GET', `/items/${item.id}`)).json();
    const comment = await api('POST', `/items/${item.id}/comments`, {
      body: `Discuss ${reference}`,
    });
    assert.equal(comment.statusCode, 201, comment.body);
    let saved = await detail();
    assert.equal(saved.item.description, reference);
    assert.equal(saved.item.milestoneId, assigned.id);
    assert(saved.activity.some((a: { body: string }) => a.body === `Discuss ${reference}`));
    assert.deepEqual(saved.relations, []);
    assert.deepEqual(saved.projectRelations, []);
    assert.deepEqual((await api('GET', `/milestones/${referenced.id}`)).json().progress, {
      total: 0,
      done: 0,
      canceled: 0,
    });
    assert.deepEqual((await api('GET', `/milestones/${assigned.id}`)).json().progress, {
      total: 1,
      done: 0,
      canceled: 0,
    });
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { description: `Edited ${reference}` })).statusCode,
      200,
    );
    assert.equal((await detail()).item.description, `Edited ${reference}`);
    const unassigned = await api('POST', '/items', {
      projectId: project.id,
      title: 'Unassigned',
      description: reference,
    });
    assert.equal(unassigned.json().milestoneId, null);
    const invalid = mentionMarkdown({ kind: 'milestone', id: randomUUID() }, 'Missing');
    saved = await detail();
    assert.equal(
      (await api('POST', `/items/${item.id}/comments`, { body: invalid })).statusCode,
      404,
    );
    assert.equal((await detail()).activity.length, saved.activity.length);
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { description: invalid })).statusCode,
      404,
    );
    assert.equal((await detail()).item.description, saved.item.description);
    const privateProject = (
      await api('POST', '/projects', { name: 'Private', key: 'PRIVATE', visibility: 'private' })
    ).json();
    const hidden = (
      await api('POST', '/milestones', { projectId: privateProject.id, title: 'Secret' })
    ).json();
    const hiddenReference = mentionMarkdown({ kind: 'milestone', id: hidden.id }, 'Secret');
    await api('POST', '/users', {
      name: 'Member',
      email: 'member@milestone-mentions.test',
      password: 'long-test-password',
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'member@milestone-mentions.test', password: 'long-test-password' },
    });
    const memberCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.equal(
      (await api('POST', `/items/${item.id}/comments`, { body: hiddenReference }, memberCookie))
        .statusCode,
      404,
    );
    const bootstrap = (await api('GET', '/bootstrap', undefined, memberCookie)).json();
    assert(!bootstrap.milestones.some((m: { id: string }) => m.id === hidden.id));
    // Existing references remain editable after their target is deleted.
    assert.equal((await api('DELETE', `/milestones/${referenced.id}`)).statusCode, 204);
    assert.equal(
      (await api('PATCH', `/items/${item.id}`, { description: `Still ${reference}` })).statusCode,
      200,
    );
    assert.equal((await detail()).item.milestoneId, assigned.id);
  } finally {
    await app.close();
  }
});
