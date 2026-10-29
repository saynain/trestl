import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import {
  appOrigin,
  cookieSecurity,
  databaseConnectionError,
  flag,
  storedAppSecret,
  readSettings,
  SettingsError,
} from '../server/settings.ts';

test('APP_ORIGIN is normalized, and malformed values explain the expected form', () => {
  assert.equal(appOrigin(undefined), undefined);
  assert.equal(appOrigin('  '), undefined);
  assert.equal(appOrigin('https://Projects.Example.com/'), 'https://projects.example.com');
  assert.equal(appOrigin('http://localhost:4317'), 'http://localhost:4317');
  assert.throws(() => appOrigin('projects.example.com'), /"projects\.example\.com" is not a URL/);
  assert.throws(() => appOrigin('"https://projects.example.com"'), /is not a URL/);
  assert.throws(() => appOrigin('ftp://projects.example.com'), /must start with https:\/\//);
  assert.throws(() => appOrigin('https://example.com/trestl'), /without a path/);
  assert.throws(
    () => appOrigin('https://admin:hunter2@example.com'),
    (error: Error) => error instanceof SettingsError && !error.message.includes('hunter2'),
  );
});

test('on/off settings accept common spellings and reject guesses', () => {
  assert.equal(flag({}, 'SECURE_COOKIES'), undefined);
  assert.equal(flag({ SECURE_COOKIES: '' }, 'SECURE_COOKIES'), undefined);
  for (const value of ['true', 'TRUE', '1', 'yes', 'on'])
    assert.equal(flag({ SECURE_COOKIES: value }, 'SECURE_COOKIES'), true);
  for (const value of ['false', '0', 'No', 'off'])
    assert.equal(flag({ SECURE_COOKIES: value }, 'SECURE_COOKIES'), false);
  assert.throws(() => flag({ SECURE_COOKIES: 'maybe' }, 'SECURE_COOKIES'), /true or false/);
});

test('secure cookies follow an HTTPS origin, then SECURE_COOKIES, then each request', () => {
  // Compose passes SECURE_COOKIES=false by default; an HTTPS origin must still be Secure.
  assert.equal(cookieSecurity({ SECURE_COOKIES: 'false', APP_ORIGIN: 'https://x.test' }), true);
  assert.equal(cookieSecurity({ SECURE_COOKIES: 'true' }), true);
  assert.equal(cookieSecurity({ SECURE_COOKIES: 'false' }), false);
  assert.equal(
    cookieSecurity({ SECURE_COOKIES: 'true', APP_ORIGIN: 'http://localhost:4317' }),
    true,
  );
  assert.equal(cookieSecurity({ APP_ORIGIN: 'https://x.test' }), true);
  assert.equal(cookieSecurity({ APP_ORIGIN: 'http://192.168.1.20:4317' }), false);
  // NODE_ENV no longer forces Secure cookies onto a plain-HTTP trial.
  assert.equal(cookieSecurity({ NODE_ENV: 'production' }), 'request');
});

test('startup settings reject unusable values and warn about weak ones', () => {
  assert.deepEqual(readSettings({}), {
    port: 4317,
    host: '127.0.0.1',
    origin: undefined,
    database: {
      kind: 'pglite',
      dataDir: join(process.cwd(), '.data'),
      description: join(process.cwd(), '.data'),
      // Beside the database folder, which upgrades and restores replace.
      secretFile: join(process.cwd(), '.data-app-secret'),
    },
    warnings: [],
  });
  assert.deepEqual(readSettings({ DATA_DIR: '/data/database/' }).database, {
    kind: 'pglite',
    dataDir: '/data/database',
    description: '/data/database',
    secretFile: '/data/database-app-secret',
  });
  assert.deepEqual(readSettings({ DATA_DIR: ':memory:' }).database, {
    kind: 'pglite',
    dataDir: ':memory:',
    description: 'memory',
  });
  for (const PORT of ['abc', '0', '70000', '43 17'])
    assert.throws(() => readSettings({ PORT }), /PORT must be a whole number from 1 to 65535/);
  assert.throws(() => readSettings({ SECURE_COOKIES: 'secure' }), SettingsError);
  assert.throws(
    () => readSettings({ SECURE_COOKIES: 'secure', APP_ORIGIN: 'https://x.test' }),
    /SECURE_COOKIES must be true or false/,
  );
  const postgres = readSettings({
    DATABASE_URL: 'postgresql://trestl:hunter2@db:5432/trestl',
    INTEGRATION_SYNC_INTERVAL_MS: '5000',
  });
  assert.deepEqual(postgres.database, {
    kind: 'postgres',
    url: 'postgresql://trestl:hunter2@db:5432/trestl',
    description: 'db:5432/trestl',
  });
  assert.match(postgres.warnings.join('\n'), /APP_SECRET is not set/);
  assert.match(postgres.warnings.join('\n'), /INTEGRATION_SYNC_INTERVAL_MS "5000" is below 60000/);
  assert.match(readSettings({ APP_SECRET: 'too-short' }).warnings[0], /has 9 characters/);
  assert.deepEqual(
    readSettings({ APP_SECRET: 'x'.repeat(32), INTEGRATION_SYNC_INTERVAL_MS: '0' }).warnings,
    [],
  );
  assert.match(
    readSettings({ SECURE_COOKIES: 'true', APP_ORIGIN: 'http://192.168.1.20:4317' }).warnings[0],
    /browsers will drop the sign-in cookie/,
  );
  assert.deepEqual(
    readSettings({ SECURE_COOKIES: 'true', APP_ORIGIN: 'http://localhost:4317' }).warnings,
    [],
  );
});

test('PGlite installations keep a generated key unless APP_SECRET is configured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trestl-secret-'));
  try {
    const file = join(dir, 'database-app-secret');
    const first = await storedAppSecret(file, undefined);
    assert.equal(first.created, true);
    assert.match(first.secret, /^[0-9a-f]{64}$/);
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    const again = await storedAppSecret(file, '');
    assert.deepEqual(again, { ...first, created: false });
    const configured = await storedAppSecret(file, 'c'.repeat(40));
    assert.equal(configured.secret, 'c'.repeat(40));
    assert.equal(configured.mismatch, true);
    assert.equal((await storedAppSecret(file, first.secret)).mismatch, false);
    await writeFile(first.path, 'short');
    await assert.rejects(storedAppSecret(file, undefined), /Restore it from a backup/);
    await assert.rejects(
      storedAppSecret(join(dir, 'missing', 'app-secret'), undefined),
      (error: Error) =>
        error instanceof SettingsError && /Make that folder writable/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PostgreSQL connection failures name the server without the password', () => {
  const database = readSettings({
    DATABASE_URL: 'postgresql://trestl:hunter2@db:5432/trestl',
  }).database;
  const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
  const message = databaseConnectionError(refused, database)!;
  assert.match(message, /cannot connect to PostgreSQL at db:5432\/trestl: ECONNREFUSED/);
  assert.doesNotMatch(message, /hunter2/);
  const password = Object.assign(new Error('password authentication failed'), { code: '28P01' });
  assert.match(databaseConnectionError(password, database)!, /password authentication failed/);
  assert.equal(databaseConnectionError(new Error('syntax error'), database), undefined);
  assert.equal(databaseConnectionError(refused, readSettings({}).database), undefined);
});

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>,
) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const assign = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  assign(values);
  try {
    return await run();
  } finally {
    assign(previous);
  }
}
const setup = {
  installationName: 'Settings test',
  name: 'Ada',
  email: 'ada@example.test',
  password: 'correct-horse-battery',
};

test('sessions stay usable over plain HTTP and become Secure behind an HTTPS origin', async () => {
  const environment = { NODE_ENV: 'production', SECURE_COOKIES: undefined, APP_ORIGIN: undefined };
  await withEnvironment(environment, async () => {
    const app = await createApp({ dataDir: ':memory:', integrations: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: setup,
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.cookies.find((c) => c.name === 'trestl_session')?.secure, undefined);
    } finally {
      await app.close();
    }
  });
  await withEnvironment(
    { ...environment, APP_ORIGIN: 'https://projects.example.test' },
    async () => {
      const app = await createApp({ dataDir: ':memory:', integrations: false });
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: setup,
        });
        assert.equal(response.cookies.find((c) => c.name === 'trestl_session')?.secure, true);
      } finally {
        await app.close();
      }
    },
  );
});

test('an origin mismatch names the address Trestl expects and the setting to change', async () => {
  await withEnvironment({ APP_ORIGIN: 'https://projects.example.test' }, async () => {
    const app = await createApp({ dataDir: ':memory:', integrations: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: { origin: 'http://localhost:4317' },
        payload: setup,
      });
      assert.equal(response.statusCode, 403);
      assert.equal(
        response.json().message,
        'This page was opened at http://localhost:4317, but Trestl only accepts changes from https://projects.example.test. Open Trestl at https://projects.example.test, or change APP_ORIGIN.',
      );
    } finally {
      await app.close();
    }
  });
  await withEnvironment({ APP_ORIGIN: undefined }, async () => {
    const app = await createApp({ dataDir: ':memory:', integrations: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        headers: { origin: 'https://projects.example.test', host: 'projects.example.test' },
        payload: setup,
      });
      assert.equal(response.statusCode, 403);
      assert.match(response.json().message, /Behind an HTTPS reverse proxy, set APP_ORIGIN/);
    } finally {
      await app.close();
    }
  });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      DATABASE_URL: '',
      APP_SECRET: '',
      APP_ORIGIN: '',
      SECURE_COOKIES: '',
      AUTH_MODE: 'local',
      INTEGRATION_SYNC_INTERVAL_MS: '0',
      HOST: '127.0.0.1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return { child, exited, output: () => output };
}

test('the server refuses a malformed APP_ORIGIN before opening any data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trestl-origin-'));
  try {
    const server = start({ APP_ORIGIN: 'projects.example.com', DATA_DIR: join(dir, 'data') });
    assert.equal(await server.exited, 1);
    assert.match(
      server.output(),
      /Trestl cannot start: APP_ORIGIN "projects\.example\.com" is not a URL/,
    );
    await assert.rejects(stat(join(dir, 'data')), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh PGlite server generates its key beside the database and reuses it', async () => {
  // The container layout: one volume holding the database folder and its key.
  const dir = await mkdtemp(join(tmpdir(), 'trestl-pglite-'));
  const port = await freePort();
  const run = async () => {
    const server = start({
      DATA_DIR: join(dir, 'database'),
      PORT: String(port),
      NODE_ENV: 'production',
    });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
        } catch {}
        if (attempt > 150) throw new Error(`Server did not start:\n${server.output()}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        key: await readFile(join(dir, 'database-app-secret'), 'utf8'),
        log: server.output(),
      };
    } finally {
      server.child.kill('SIGTERM');
      await server.exited;
    }
  };
  try {
    const first = await run();
    assert.match(first.key, /^[0-9a-f]{64}$/);
    assert.match(first.log, /Generated the key that encrypts Git and sign-in credentials/);
    assert.match(first.log, /create the administrator account/);
    await assert.rejects(stat(join(dir, 'database', 'app-secret')), { code: 'ENOENT' });
    const second = await run();
    assert.equal(second.key, first.key);
    assert.doesNotMatch(second.log, /Generated the key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
