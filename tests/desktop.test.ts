import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerDesktopGateway } from '../server/desktop-gateway.ts';

test('desktop gateway protects assets and APIs, rejects foreign hosts/origins, and consumes launch once', async (t) => {
  const token = randomBytes(32).toString('hex');
  const app = Fastify();
  await app.register(cookie);
  registerDesktopGateway(app, token);
  app.get('/', async () => 'Trestl');
  app.get('/api/data', async () => ({ private: true }));
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
  assert.equal(launch.cookies[0].httpOnly, true);
  assert.equal(launch.cookies[0].sameSite, 'Strict');
  const session = `${launch.cookies[0].name}=${launch.cookies[0].value}`;
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
