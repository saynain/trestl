import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { mentionMarkdown } from '../shared/mentions.ts';
import type { MentionNotification } from '../shared/types.ts';

test('mention notifications are private, durable, idempotent, and filtered by current access', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Author',
        email: 'author@notifications.test',
        password: 'notification-test-password',
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const authorCookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const api = (
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      payload?: unknown,
      cookie = authorCookie,
      key?: string,
    ) =>
      app.inject({
        method,
        url: '/api/v1' + path,
        headers: {
          cookie,
          ...(key ? { 'idempotency-key': key } : {}),
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const member = (
      await api('POST', '/users', {
        name: 'Recipient',
        email: 'recipient@notifications.test',
        password: 'notification-test-password',
      })
    ).json();
    const login = async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: member.email, password: 'notification-test-password' },
      });
      assert.equal(response.statusCode, 200, response.body);
      return `${response.cookies[0].name}=${response.cookies[0].value}`;
    };
    const recipientCookie = await login();
    const notifications = async (cookie = recipientCookie) =>
      (await api('GET', '/notifications', undefined, cookie)).json().data as MentionNotification[];
    const mention = mentionMarkdown({ kind: 'user', id: member.id }, member.name);
    const selfMention = mentionMarkdown({ kind: 'user', id: setup.json().id }, 'Author');
    const project = (
      await api('POST', '/projects', { name: 'Shared project', key: 'NOTIFY' })
    ).json();
    const createKey = randomUUID();
    const itemInput = {
      title: 'Review the proposal',
      projectId: project.id,
      description: `${mention} ${mention} ${selfMention}`,
    };
    const created = await api('POST', '/items', itemInput, authorCookie, createKey);
    assert.equal(created.statusCode, 201, created.body);
    const item = created.json();
    await api('POST', '/items', itemInput, authorCookie, createKey);
    assert.equal(
      (await notifications()).length,
      1,
      'Create retries and repeated mentions are deduplicated',
    );
    const descriptionNotice = (await notifications())[0];
    assert.equal(descriptionNotice.activityId, null);
    assert.equal(descriptionNotice.actorId, setup.json().id);
    assert.equal(descriptionNotice.readAt, null);
    assert.equal(
      (await notifications(authorCookie)).length,
      0,
      'Authors do not receive self-mentions',
    );
    const changed = await api('PATCH', `/items/${item.id}`, {
      description: `${mention} Updated text`,
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(
      (await notifications()).length,
      1,
      'Editing around the same mention does not notify again',
    );
    const commentKey = randomUUID();
    const comment = await api(
      'POST',
      `/items/${item.id}/comments`,
      { body: `${mention} Please review` },
      authorCookie,
      commentKey,
    );
    assert.equal(comment.statusCode, 201, comment.body);
    await api(
      'POST',
      `/items/${item.id}/comments`,
      { body: `${mention} Please review` },
      authorCookie,
      commentKey,
    );
    assert.equal((await notifications()).length, 2);
    assert.ok((await notifications()).some((n) => n.activityId === comment.json().id));
    const invalid = await api('POST', `/items/${item.id}/comments`, {
      body: mention + ' ' + mentionMarkdown({ kind: 'item', id: randomUUID() }, 'Missing'),
    });
    assert.equal(invalid.statusCode, 404);
    assert.equal((await notifications()).length, 2, 'Failed saves roll back notifications');
    assert.equal(
      (await api('PATCH', `/notifications/${descriptionNotice.id}`, { read: true })).statusCode,
      404,
      'Another user cannot change read state',
    );
    assert.equal(
      (
        await api(
          'PATCH',
          `/notifications/${descriptionNotice.id}`,
          { read: true },
          recipientCookie,
        )
      ).statusCode,
      200,
    );
    assert.ok(
      (await notifications(await login())).find((n) => n.id === descriptionNotice.id)?.readAt,
      'Read state survives login',
    );
    await api('PATCH', `/notifications/${descriptionNotice.id}`, { read: false }, recipientCookie);
    assert.equal((await notifications()).find((n) => n.id === descriptionNotice.id)?.readAt, null);
    const privateItem = await api('POST', '/items', {
      title: 'Private work',
      projectId: project.id,
      visibility: 'private',
      description: mention,
    });
    assert.equal(privateItem.statusCode, 201, privateItem.body);
    assert.equal(
      (await notifications()).length,
      2,
      'Mentioning a person never grants private-item access or sends an inaccessible notice',
    );
    await api('PATCH', `/projects/${project.id}`, { visibility: 'private' });
    assert.equal((await notifications()).length, 0);
    const hiddenBootstrap = (await api('GET', '/bootstrap', undefined, recipientCookie)).json();
    assert.equal(hiddenBootstrap.notifications.length, 0, 'Bootstrap hides revoked targets too');
    assert.equal(
      (
        await api(
          'PATCH',
          `/notifications/${descriptionNotice.id}`,
          { read: true },
          recipientCookie,
        )
      ).statusCode,
      404,
    );
    await api('POST', '/notifications/read-all', {}, recipientCookie);
    await api('PATCH', `/projects/${project.id}`, { visibility: 'workspace' });
    assert.ok(
      (await notifications()).every((n) => !n.readAt),
      'Mark all does not mutate inaccessible notifications',
    );
    assert.equal(
      (await api('POST', '/notifications/read-all', {}, recipientCookie)).statusCode,
      204,
    );
    assert.ok((await notifications()).every((n) => n.readAt));
    const bootstrap = (await api('GET', '/bootstrap', undefined, recipientCookie)).json();
    assert.equal(bootstrap.notifications.length, 2);
    await api('DELETE', `/items/${item.id}`);
    assert.equal((await notifications()).length, 0, 'Deleting the source removes notifications');
  } finally {
    await app.close();
  }
});
