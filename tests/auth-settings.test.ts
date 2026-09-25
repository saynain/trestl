import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';

test('OIDC validates signed identities, PKCE, browser state and domain; recovery and revocation remain available', async () => {
  const previous = process.env.APP_SECRET;
  process.env.APP_SECRET = 'oidc-test-encryption-key-at-least-32-characters';
  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test', use: 'sig', alg: 'RS256' };
  let issuer = '';
  const grants = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      email: string;
      verified: boolean;
      sub: string;
      badNonce?: boolean;
    }
  >();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration')
      return res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: issuer + '/authorize',
          token_endpoint: issuer + '/token',
          jwks_uri: issuer + '/jwks',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url === '/token') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const grant = grants.get(form.get('code')!);
      if (
        !grant ||
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url') !== grant.challenge ||
        form.get('client_secret') !== 'test-client-secret'
      ) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      grants.delete(form.get('code')!);
      const token = await new SignJWT({
        email: grant.email,
        email_verified: grant.verified,
        name: 'OIDC member',
        nonce: grant.badNonce ? 'incorrect' : grant.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(issuer)
        .setAudience('test-client')
        .setSubject(grant.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return res.end(
        JSON.stringify({
          access_token: 'provider-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: token,
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        name: 'Admin',
        email: 'admin@example.test',
        password: 'local-test-password',
        installationName: 'Example',
      },
    });
    const adminCookie = cookieOf(setup);
    const localMember = await memberSession(app, adminCookie, {
      name: 'Local',
      email: 'local@example.test',
      password: 'local-test-password',
    });
    const settings = {
      mode: 'oidc',
      origin: 'http://localhost',
      issuer,
      clientId: 'test-client',
      clientSecret: 'test-client-secret',
      allowedDomains: ['example.test'],
    };
    const save = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/authentication',
      headers: { cookie: adminCookie },
      payload: settings,
    });
    assert.equal(save.statusCode, 200, save.body);
    assert.equal(save.json().clientSecretConfigured, true);
    assert.ok(!save.body.includes('test-client-secret'));
    assert.ok(!save.body.includes('encrypted'));
    assert.equal(
      (await app.inject({ url: '/api/v1/bootstrap', headers: { cookie: cookieOf(localMember) } }))
        .statusCode,
      401,
    );
    const start = async (
      email = 'member@example.test',
      verified = true,
      sub = email,
      badNonce = false,
      cliCode = '',
    ) => {
      const response = await app.inject({
        url:
          '/api/v1/auth/provider/start' +
          (cliCode ? `?cli_code=${encodeURIComponent(cliCode)}` : ''),
      });
      assert.equal(response.statusCode, 302, response.body);
      const url = new URL(response.headers.location!);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const code = String(grants.size) + Math.random();
      grants.set(code, {
        nonce: url.searchParams.get('nonce')!,
        challenge: url.searchParams.get('code_challenge')!,
        email,
        verified,
        sub,
        badNonce,
      });
      const callback =
        '/api/v1/auth/provider/callback?code=' + code + '&state=' + url.searchParams.get('state');
      return { callback, cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
    };
    assert.equal(
      (await app.inject({ url: '/api/v1/auth/provider/start?cli_code=https://evil.example' }))
        .statusCode,
      400,
    );
    const first = await start(undefined, true, undefined, false, 'ABCD-EFGH');
    assert.equal((await app.inject({ url: first.callback })).statusCode, 400);
    const signed = await app.inject({ url: first.callback, headers: { cookie: first.cookie } });
    assert.equal(signed.statusCode, 302, signed.body);
    assert.equal(signed.headers.location, '/cli-login?code=ABCD-EFGH');
    const memberCookie = cookieOf(signed);
    const boot = (
      await app.inject({ url: '/api/v1/bootstrap', headers: { cookie: memberCookie } })
    ).json();
    assert.equal(boot.user.role, 'member');
    assert.equal(boot.workspace.id, 'default');
    assert.equal(boot.workspaces.length, 1);
    assert.equal(
      (await app.inject({ url: first.callback, headers: { cookie: first.cookie } })).statusCode,
      400,
    );
    for (const [email, verified, badNonce, expected] of [
      ['outsider@outside.test', true, false, 403],
      ['unverified@example.test', false, false, 403],
      ['nonce@example.test', true, true, 401],
      ['admin@example.test', true, false, 409],
    ] as const) {
      const flow = await start(email, verified, email, badNonce);
      assert.equal(
        (await app.inject({ url: flow.callback, headers: { cookie: flow.cookie } })).statusCode,
        expected,
        email,
      );
    }
    assert.equal(
      (await app.inject({ url: '/api/v1/admin/authentication', headers: { cookie: memberCookie } }))
        .statusCode,
      403,
    );
    const recovery = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'admin@example.test', password: 'local-test-password' },
    });
    assert.equal(recovery.statusCode, 200, recovery.body);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'local@example.test', password: 'local-test-password' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/users/${boot.user.id}/access`,
          headers: { cookie: adminCookie },
          payload: { disabled: true },
        })
      ).statusCode,
      200,
    );
    const disabled = await start();
    assert.equal(
      (await app.inject({ url: disabled.callback, headers: { cookie: disabled.cookie } }))
        .statusCode,
      403,
    );
    const pending = await start('pending@example.test');
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/authentication',
          headers: { cookie: adminCookie },
          payload: { mode: 'local', origin: 'http://localhost' },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: pending.callback, headers: { cookie: pending.cookie } })).statusCode,
      400,
    );
    const stored = await app
      .getDecorator<AppContext>('context')
      .store.get<any>('system', 'authentication');
    assert.ok(stored.encryptedClientSecret);
    assert.notEqual(stored.encryptedClientSecret, 'test-client-secret');
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previous;
  }
});
