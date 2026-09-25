import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { compareVersions, createVersionChecker, serverBuild } from '../server/version.ts';
import { createApp } from '../server/app.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import type { ServerBuild } from '../shared/server-version.ts';

const running: ServerBuild = {
  version: '0.4.0',
  commit: 'abc123',
  buildId: 'test',
  builtAt: null,
  release: true,
};
const release = (tag = 'v0.5.0') =>
  Response.json({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: 'https://untrusted.example',
    published_at: '2026-09-25T12:00:00Z',
  });

test('semantic version ordering handles multi-digit, prerelease, and build versions', () => {
  for (const [a, b, result] of [
    ['0.9.0', '0.10.0', -1],
    ['v0.4.0', '0.4.0+build.2', 0],
    ['0.5.0-rc.10', '0.5.0-rc.2', 1],
    ['0.5.0-rc.1', '0.5.0', -1],
    ['0.5.0-alpha', '0.5.0-alpha.1', -1],
    ['0.5.0-1', '0.5.0-alpha', -1],
    ['0.5.0-beta', '0.5.0-alpha', 1],
    ['1.0.0', '0.99.99', 1],
    ['custom', '0.4.0', null],
    ['0.04.0', '0.4.0', null],
    ['0.5.0-01', '0.5.0', null],
  ] as const)
    assert.equal(compareVersions(a, b), result, `${a} vs ${b}`);
});

test('server metadata uses the installed package and deployment provenance', () => {
  const keys = [
    'TRESTL_BUILD_COMMIT',
    'TRESTL_BUILD_REF',
    'TRESTL_BUILD_ID',
    'TRESTL_BUILD_DATE',
  ] as const;
  const original = keys.map((key) => process.env[key]);
  const version = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;
  try {
    process.env.TRESTL_BUILD_COMMIT = 'a'.repeat(40);
    process.env.TRESTL_BUILD_REF = `v${version}`;
    process.env.TRESTL_BUILD_ID = '123-1';
    process.env.TRESTL_BUILD_DATE = '2026-09-25T12:00:00Z';
    assert.deepEqual(serverBuild(), {
      version,
      commit: 'a'.repeat(40),
      buildId: '123-1',
      builtAt: '2026-09-25T12:00:00Z',
      release: true,
    });
    process.env.TRESTL_BUILD_REF = 'main';
    assert.equal(serverBuild().release, false);
  } finally {
    keys.forEach((key, i) => {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    });
  }
});

test('release checks coalesce and bound refresh, expose trusted links, and expire', async () => {
  let now = 0,
    calls = 0;
  const check = createVersionChecker(
    running,
    async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.github.com/repos/saynain/trestl/releases/latest');
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      assert.equal(new Headers(options?.headers).has('Authorization'), false);
      return release();
    },
    () => now,
  );
  const [first, second] = await Promise.all([check(), check(true)]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.status, 'update-available');
  assert.equal(first.latest?.url, 'https://github.com/saynain/trestl/releases/tag/v0.5.0');
  assert.equal(first.running, running);
  assert.equal(first.checkedAt, new Date(0).toISOString());
  await check(true);
  assert.equal(calls, 1);
  now = 60_001;
  await check();
  assert.equal(calls, 1);
  await check(true);
  assert.equal(calls, 2);
  now += 15 * 60_000;
  await check();
  assert.equal(calls, 3);
});

test('current, newer and unidentified builds get distinct update statuses', async () => {
  assert.equal(
    (await createVersionChecker(running, async () => release('v0.4.0'))()).status,
    'up-to-date',
  );
  assert.equal(
    (await createVersionChecker(running, async () => release('v0.3.0'))()).status,
    'unreleased',
  );
  assert.equal(
    (await createVersionChecker({ ...running, release: false }, async () => release('v0.4.0'))())
      .status,
    'unreleased',
  );
  assert.equal(
    (await createVersionChecker({ ...running, version: 'custom' }, async () => release())()).status,
    'unknown',
  );
});

test('network, private repository, rate limit and invalid release failures preserve running metadata', async () => {
  for (const fetchRelease of [
    async () => {
      throw new Error('private upstream information');
    },
    async () => {
      throw new DOMException('timeout details', 'TimeoutError');
    },
    async () => new Response('secret provider error', { status: 404 }),
    async () => new Response('secret rate limit info', { status: 403 }),
    async () => new Response('invalid json'),
    async () => release('nightly'),
    async () => Response.json({ tag_name: 'v0.5.0-rc.1', prerelease: true }),
    async () => new Response('x'.repeat(256 * 1024 + 1)),
  ]) {
    let calls = 0;
    const check = createVersionChecker(running, async () => {
      calls++;
      return fetchRelease();
    });
    const value = await check();
    assert.equal(value.status, 'unknown');
    assert.equal(value.latest, null);
    assert.equal(value.running, running);
    assert.match(value.message!, /unavailable/);
    assert.doesNotMatch(JSON.stringify(value), /secret|private upstream|timeout details/);
    await check();
    assert.equal(calls, 1, 'failure must be cached too');
  }
});

test('version endpoint requires an administrator browser session', async () => {
  let calls = 0;
  const app = await createApp({
    dataDir: ':memory:',
    integrations: false,
    githubFetch: async () => {
      calls++;
      return release();
    },
  });
  try {
    assert.equal((await app.inject('/api/v1/admin/version')).statusCode, 401);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { name: 'Admin', email: 'admin@example.test', password: 'admin-test-password' },
    });
    assert.equal(setup.statusCode, 201, setup.body);
    const cookie = cookieOf(setup);
    const member = await memberSession(app, cookie, {
      name: 'Member',
      email: 'member@example.test',
      password: 'member-test-password',
    });
    const denied = await app.inject({
      url: '/api/v1/admin/version',
      headers: { cookie: cookieOf(member) },
    });
    assert.equal(denied.statusCode, 403);
    const token = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: 'admin token', scope: 'write' },
    });
    assert.equal(token.statusCode, 201, token.body);
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/admin/version',
          headers: { authorization: `Bearer ${token.json().token}` },
        })
      ).statusCode,
      403,
    );
    assert.equal(calls, 0, 'unauthorized requests must not contact GitHub');
    const response = await app.inject({ url: '/api/v1/admin/version', headers: { cookie } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().latest.version, '0.5.0');
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test('packaged desktop server reads embedded provenance without source files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-version-bundle-'));
  try {
    const output = join(directory, 'version.cjs');
    const result = await build({
      entryPoints: [new URL('../server/version.ts', import.meta.url).pathname],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      define: {
        __TRESTL_BUNDLED_BUILD__: JSON.stringify(running),
        'import.meta.url': '__trestlBundleUrl',
      },
      banner: {
        js: "const __trestlBundleUrl = require('node:url').pathToFileURL(__filename).href;",
      },
    });
    assert.equal(result.warnings.length, 0);
    const bundled = createRequire(import.meta.url)(output);
    assert.deepEqual(bundled.serverBuild(), running);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
