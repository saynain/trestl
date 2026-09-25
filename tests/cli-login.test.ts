import { createTokenGateway } from '../server/token-gateway-app.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { validGatewayToken } from '../server/cli-login.ts';
import type { User } from '../shared/types.ts';

test('CLI pairing requires browser approval and proof, issues one scoped token, and revokes at both layers', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  const ctx = (app as unknown as { context: AppContext }).context;
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'CLI owner',
        email: 'cli@example.test',
        password: 'cli-test-password',
        seedDemo: false,
      },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
    const start = async (scope = 'read') => {
      const verifier = randomBytes(32).toString('base64url');
      const response = await app.inject({
        method: 'POST',
        url: '/cli-auth/device',
        payload: {
          name: 'My terminal',
          scope,
          challenge: createHash('sha256').update(verifier).digest('base64url'),
        },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      const data = response.json();
      assert.match(data.verificationUri, /\/cli-login\?code=/);
      return { ...data, verifier };
    };
    const poll = (d: { deviceCode: string; verifier: string }) =>
      app.inject({
        method: 'POST',
        url: '/cli-auth/token',
        payload: { deviceCode: d.deviceCode, verifier: d.verifier },
      });
    const approve = (code: string, headers = { cookie }) =>
      app.inject({ method: 'POST', url: '/api/v1/auth/cli/approve', headers, payload: { code } });
    const d = await start();
    assert.equal((await approve(d.userCode, { cookie: '' })).statusCode, 401);
    assert.equal(
      (await poll({ ...d, verifier: randomBytes(32).toString('base64url') })).json().error,
      'invalid_grant',
    );
    assert.equal((await poll(d)).json().error, 'authorization_pending');
    assert.equal((await poll(d)).statusCode, 429);
    assert.equal(
      (await app.inject({ url: `/api/v1/auth/cli/${d.userCode}`, headers: { cookie } })).json()
        .scope,
      'read',
    );
    assert.equal((await approve(d.userCode)).statusCode, 200);
    assert.equal((await approve(d.userCode)).statusCode, 404);
    await ctx.db.query('UPDATE cli_logins SET polled_at=NULL');
    const issued = await poll(d);
    assert.equal(issued.statusCode, 200, issued.body);
    const token = issued.json().token;
    assert.equal((await poll(d)).json().error, 'expired_token');
    const authorization = `Bearer ${token}`;
    const gateway = await createTokenGateway(ctx.db, 'https://projects.example.test');
    try {
      assert.equal(
        (await gateway.inject({ url: '/verify', headers: { authorization } })).statusCode,
        202,
      );
      assert.equal(
        (
          await gateway.inject({
            url: '/verify',
            headers: { cookie, 'x-auth-request-email': 'cli@example.test' },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (await gateway.inject({ url: '/api/v1/projects', headers: { authorization } })).statusCode,
        404,
      );
      assert.equal((await gateway.inject({ url: '/' })).statusCode, 404);
      const started = await gateway.inject({
        method: 'POST',
        url: '/cli-auth/device',
        payload: { challenge: d.verifier, name: 'Gateway request' },
      });
      assert.equal(started.statusCode, 200);
      assert.match(started.json().verificationUri, /^https:\/\/projects.example.test\/cli-login/);
      assert.equal((await gateway.inject({ url: '/ready' })).statusCode, 200);
    } finally {
      await gateway.close();
    }

    assert.equal(await validGatewayToken(ctx.db, authorization), true);
    assert.equal(await validGatewayToken(ctx.db), false);
    assert.equal(await validGatewayToken(ctx.db, 'Bearer forged'), false);
    const status = await app.inject({ url: '/api/v1/auth/status', headers: { authorization } });
    assert.equal(status.json().user.email, 'cli@example.test');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/projects',
          headers: { authorization },
          payload: { name: 'Forbidden', key: 'NO' },
        })
      ).statusCode,
      403,
    );
    const next = await start('write');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/cli/approve',
          headers: { authorization },
          payload: { code: next.userCode },
        })
      ).statusCode,
      403,
    );
    // A valid session cookie cannot turn a wrong bearer into a gateway pass.
    assert.equal(
      await validGatewayToken(ctx.db, `Bearer ${randomBytes(32).toString('base64url')}`),
      false,
    );
    const user = (await ctx.store.get<User>('users', status.json().user.id))!;
    await ctx.store.put('users', { ...user, disabledAt: new Date().toISOString() });
    assert.equal(await validGatewayToken(ctx.db, authorization), false);
    await ctx.store.put('users', user);
    const id = (
      await ctx.db.query<{ id: string }>('SELECT id FROM tokens WHERE hash=$1', [
        createHash('sha256').update(token).digest('hex'),
      ])
    ).rows[0].id;
    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/api/v1/tokens/${id}`, headers: { cookie } }))
        .statusCode,
      204,
    );
    assert.equal(await validGatewayToken(ctx.db, authorization), false);
    assert.equal(
      (await app.inject({ url: '/api/v1/projects', headers: { authorization } })).statusCode,
      401,
    );
    await approve(next.userCode);
    await ctx.store.put('users', { ...user, disabledAt: new Date().toISOString() });
    assert.equal((await poll(next)).json().error, 'access_denied');
    await ctx.store.put('users', user);
    const expired = await start();
    await ctx.db.query("UPDATE cli_logins SET expires_at=NOW()-INTERVAL '1 second'");
    assert.equal((await approve(expired.userCode)).statusCode, 404);
    assert.equal((await poll(expired)).json().error, 'expired_token');
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/cli-auth/device',
          payload: { name: 'Escalate', scope: 'admin', challenge: d.verifier },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
