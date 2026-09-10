import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, dateOnly, itemsPath, mergePage, origin, webLink } from '../src/client';
const connection = { serverUrl: 'https://projects.example.test', token: 'test-secret' };
const mock = (run: (url: URL, options: RequestInit) => Response | Promise<Response>) =>
  ((url: URL, options: RequestInit) => Promise.resolve(run(url, options))) as typeof fetch;
test('validates origins and never sends tokens to unsafe URLs', async () => {
  for (const serverUrl of [
    'http://remote.test',
    'file:///tmp/test',
    'https://user:password@example.test',
    'https://example.test/api/v1',
    'https://example.test?token=x',
    'https://example.test/#hash',
    'bad',
  ]) {
    await assert.rejects(
      createClient(
        { ...connection, serverUrl },
        mock(() => {
          assert.fail('transport must not run');
        }),
      )('items'),
    );
  }
  for (const value of [
    'http://localhost:4317',
    'http://127.0.0.1:4317',
    'http://[::1]:4317',
    'https://example.test/',
  ])
    assert.ok(origin(value, 'Server URL'));
});
test('constructs authenticated requests, encodes queries and preserves abort signals', async () => {
  const controller = new AbortController();
  const api = createClient(
    connection,
    mock((url, options) => {
      assert.equal(url.origin, connection.serverUrl);
      assert.equal(url.pathname, '/api/v1/items');
      assert.equal(url.searchParams.get('q'), 'a&b #/?');
      assert.equal(url.searchParams.get('cursor'), '100');
      assert.equal(url.searchParams.get('assigneeId'), 'member');
      assert.equal(options.redirect, 'error');
      assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer test-secret');
      controller.abort();
      assert.equal(options.signal?.aborted, true);
      return Response.json({ data: [] });
    }),
  );
  await api(itemsPath('a&b #/?', { assigneeId: 'member' }, '100'), { signal: controller.signal });
});
test('serializes mutations without dropping null date and assignment clearing', async () => {
  const body = { title: 'Capture', assigneeId: null, dueDate: null };
  await createClient(
    connection,
    mock((url, options) => {
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(JSON.parse(options.body as string), body);
      assert.equal(url.pathname, '/api/v1/items/id');
      return Response.json({ id: 'id' });
    }),
  )('items/id', { method: 'PATCH', body });
});
test('actionable errors cover auth, permission, not found, rate limits, server and non-JSON responses', async () => {
  for (const [status, message] of [
    [401, /Authentication/],
    [403, /write-scoped/],
    [404, /not found/],
    [429, /Too many/],
    [502, /unavailable/],
  ] as const) {
    await assert.rejects(
      createClient(
        connection,
        mock(() => new Response('<html>proxy error</html>', { status })),
      )('items'),
      message,
    );
  }
  await assert.rejects(
    createClient(
      connection,
      mock(() => new Response('<html>wrong server</html>')),
    )('items'),
    /unexpected response/,
  );
  await assert.rejects(
    createClient(
      connection,
      mock(() => Response.json({ message: 'bad test-secret' }, { status: 400 })),
    )('items'),
    /bad \[redacted\]/,
  );
  await assert.rejects(
    createClient(
      connection,
      mock(() => {
        throw new Error('secret transport error');
      }),
    )('items'),
    /Cannot reach/,
  );
});
test('caller cancellation remains distinguishable from a connection failure', async () => {
  const controller = new AbortController();
  controller.abort();
  const error = new DOMException('Canceled', 'AbortError');
  await assert.rejects(
    createClient(
      connection,
      mock(() => {
        throw error;
      }),
    )('items', { signal: controller.signal }),
    (value) => value === error,
  );
});
test('web links default to server, allow separate local frontend, and encode identifiers', () => {
  assert.equal(webLink(connection, 'item', 'a/b'), 'https://projects.example.test/#/item/a%2Fb');
  assert.equal(
    webLink({ ...connection, webUrl: 'http://127.0.0.1:5173' }, 'project', 'id'),
    'http://127.0.0.1:5173/#/project/id',
  );
  assert.throws(() => webLink({ ...connection, webUrl: 'javascript:alert(1)' }, 'home'));
});
test('pagination merges duplicate rows and dates preserve the selected local calendar day', () => {
  assert.deepEqual(
    mergePage(
      [{ id: '1', title: 'old' }],
      [
        { id: '1', title: 'new' },
        { id: '2', title: 'second' },
      ],
    ),
    [
      { id: '1', title: 'new' },
      { id: '2', title: 'second' },
    ],
  );
  assert.equal(dateOnly(new Date(2026, 0, 2, 0, 30)), '2026-01-02');
  assert.equal(dateOnly(null), null);
});
