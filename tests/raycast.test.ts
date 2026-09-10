import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app';
import {
  createClient,
  itemsPath,
  type Item,
  type ItemDetail,
  type Page,
  type Project,
} from '../extensions/raycast/src/client';

test('Raycast client works with real bearer auth, permissions, pagination, item detail and recurrence', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        seedDemo: false,
        name: 'Raycast tester',
        email: 'raycast@example.test',
        password: 'testing-raycast-password',
      },
    });
    assert.equal(setup.statusCode, 201);
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    async function token(scope: string) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/tokens',
        headers: { cookie },
        payload: { name: 'Raycast test', scope },
      });
      assert.equal(response.statusCode, 201);
      return response.json().token as string;
    }
    const transport = (async (url: URL, options: RequestInit) => {
      const response = await app.inject({
        method: options.method as 'GET' | 'POST' | 'PATCH',
        url: url.pathname + url.search,
        headers: options.headers as Record<string, string>,
        ...(options.body ? { payload: options.body as string } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const write = createClient(
      { serverUrl: 'http://localhost:4317', token: await token('write') },
      transport,
    );
    const read = createClient(
      { serverUrl: 'http://localhost:4317', token: await token('read') },
      transport,
    );
    const auth = await read<{ user: { id: string } }>('auth/status');
    const project = await write<Project>('projects', {
      method: 'POST',
      body: { name: 'Raycast integration', key: 'RAY', visibility: 'private' },
    });
    const first = await write<Item>('items', {
      method: 'POST',
      body: {
        title: 'First capture',
        projectId: project.id,
        assigneeId: auth.user.id,
        dueDate: '2026-09-10',
        recurrence: 'weekly',
        visibility: 'private',
      },
    });
    await write<Item>('items', {
      method: 'POST',
      body: { title: 'Second capture', projectId: project.id, assigneeId: auth.user.id },
    });
    const page = await read<Page<Item>>('items?limit=1');
    assert.equal(page.data.length, 1);
    assert.equal(page.nextCursor, '1');
    const next = await read<Page<Item>>(
      itemsPath('', { assigneeId: auth.user.id }, page.nextCursor),
    );
    assert.equal(next.data.length, 1);
    assert.notEqual(next.data[0].id, page.data[0].id);
    const detail = await read<ItemDetail>(`items/${first.id}`);
    assert.equal(detail.item.title, 'First capture');
    assert.ok(Array.isArray(detail.activity));
    await assert.rejects(
      read(`items/${first.id}`, { method: 'PATCH', body: { status: 'done' } }),
      /write-scoped/,
    );
    await write(`items/${first.id}`, { method: 'PATCH', body: { status: 'done' } });
    const recurrence = await read<Page<Item>>(itemsPath('First capture', { status: 'todo' }));
    assert.equal(recurrence.data.length, 1);
    assert.equal(recurrence.data[0].dueDate, '2026-09-17');
    const cleared = await write<Item>(`items/${first.id}`, {
      method: 'PATCH',
      body: { assigneeId: null, dueDate: null, followUpDate: null, priority: 'high' },
    });
    assert.equal(cleared.assigneeId, null);
    assert.equal(cleared.dueDate, null);
    assert.equal(cleared.priority, 'high');
  } finally {
    await app.close();
  }
});
