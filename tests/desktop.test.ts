import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { once } from 'node:events';
import { registerDesktopGateway } from '../server/desktop-gateway.ts';

test('desktop gateway protects assets and APIs, rejects foreign hosts/origins, and consumes launch once', async (t) => {
  const token = randomBytes(32).toString('hex');
  const app = Fastify();
  await app.register(cookie);
  await app.register(websocket);
  registerDesktopGateway(app, token);
  app.get('/', async () => 'Trestl');
  app.get('/api/data', async () => ({ private: true }));
  app.get('/api/live', { websocket: true }, (socket) => {
    socket.on('message', (data) => socket.send(data));
  });
  app.put('/api/v1/admin/authentication', async () => ({ changed: true }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const host = new URL(origin).host;
  const request = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ url, headers: { host, ...headers } });
  assert.equal((await request('/')).statusCode, 403);
  assert.equal((await request('/api/data')).statusCode, 403);
  assert.equal((await request('/__desktop/launch?token=wrong')).statusCode, 403);
  assert.equal(
    (await request(`/__desktop/launch?token=${token}`, { origin: 'https://evil.test' })).statusCode,
    403,
  );
  const launch = await request(`/__desktop/launch?token=${token}`);
  assert.equal(launch.statusCode, 302);
  assert.equal(launch.headers.location, '/');
  assert.equal(launch.headers['referrer-policy'], 'no-referrer');
  assert.ok(
    launch.headers['content-security-policy']?.includes(`connect-src 'self' ws://${host};`),
  );
  assert.equal(launch.cookies[0].httpOnly, true);
  assert.equal(launch.cookies[0].sameSite, 'Strict');
  const session = `${launch.cookies[0].name}=${launch.cookies[0].value}`;
  await assert.rejects(app.injectWS('/api/live', { headers: { host, origin } }), /403/);
  await assert.rejects(
    app.injectWS('/api/live', { headers: { host, origin: 'https://evil.test', cookie: session } }),
    /403/,
  );
  const socket = await app.injectWS('/api/live', { headers: { host, origin, cookie: session } });
  try {
    const received = once(socket, 'message');
    socket.send('desktop canvas connection');
    assert.equal(String((await received)[0]), 'desktop canvas connection');
  } finally {
    socket.terminate();
  }
  assert.equal((await request(`/__desktop/launch?token=${token}`)).statusCode, 403);
  assert.equal((await request('/api/data', { cookie: session })).statusCode, 200);
  assert.equal(
    (await request('/api/data', { cookie: session, host: 'evil.test' })).statusCode,
    403,
  );
  assert.equal(
    (await request('/api/data', { cookie: session, origin: 'http://127.0.0.1:1' })).statusCode,
    403,
  );
  assert.equal(
    (await request('/api/data', { cookie: session, 'sec-fetch-site': 'cross-site' })).statusCode,
    403,
  );
  assert.equal((await request('/api/data', { cookie: 'trestl_desktop=stale' })).statusCode, 403);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/v1/admin/authentication',
        headers: { host, cookie: session },
      })
    ).statusCode,
    400,
  );
});
