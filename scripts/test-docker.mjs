import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'trestl-docker-'));
const project = `trestl-smoke-${randomBytes(6).toString('hex')}`;
const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const envFile = join(temporary, '.env');
await writeFile(envFile, '', { mode: 0o600 });
// Explicit test settings prevent a developer's shell or .env selecting real data.
const environment = {
  ...process.env,
  PORT: String(port),
  POSTGRES_USER: 'trestl',
  POSTGRES_DB: 'trestl',
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  APP_SECRET: randomBytes(32).toString('hex'),
  APP_ORIGIN: origin,
  SECURE_COOKIES: 'false',
  AUTH_MODE: 'local',
  INSTALLATION_ID: '',
  PROXY_AUTH_INSTALLATION_ID: '',
  PROXY_AUTH_SECRET: '',
  PROXY_AUTH_ALLOWED_DOMAINS: '',
  PROXY_AUTH_ADMIN_EMAILS: '',
  PROXY_AUTH_LINK_EXISTING_EMAILS: '',
  GITHUB_APP_CLIENT_ID: '',
  GITHUB_APP_CLIENT_SECRET: '',
  GITHUB_APP_SLUG: '',
  INTEGRATION_ALLOWED_ORIGINS: '',
  CONFLUENCE_ALLOWED_ORIGINS: '',
  INTEGRATION_SYNC_INTERVAL_MS: '0',
};
const composeArgs = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  envFile,
  '--file',
  join(root, 'compose.yaml'),
];
// Publication can exercise the exact image that will be pushed, without rebuilding it.
const smokeImage = process.env.TRESTL_SMOKE_IMAGE;
if (smokeImage) {
  const override = join(temporary, 'image.json');
  await writeFile(
    override,
    JSON.stringify({ services: { app: { image: smokeImage, pull_policy: 'never' } } }),
  );
  composeArgs.push('--file', override);
}
async function compose(...args) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [...composeArgs, ...args], {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Compose ${args[0]} exited ${code}`)),
    );
  });
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Application did not become ready');
}
let cookie;
async function api(path, body) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response;
}
try {
  await compose(
    'up',
    smokeImage ? '--no-build' : '--build',
    '--detach',
    '--wait',
    '--wait-timeout',
    '120',
  );
  await ready();
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  assert.equal((await (await api('/auth/status')).json()).needsSetup, true);
  const setup = await api('/auth/setup', {
    installationName: 'Container test installation',
    name: 'Container smoke test',
    email: 'smoke@example.test',
    password: randomBytes(24).toString('hex'),
    seedDemo: false,
  });
  cookie = setup.headers
    .getSetCookie()
    .find((value) => value.startsWith('trestl_session='))
    .split(';')[0];
  const bootstrap = await (await api('/bootstrap')).json();
  assert.equal(bootstrap.workspace.name, 'Container test installation');
  assert.equal(bootstrap.workspaces.length, 1);
  assert.equal(bootstrap.user.role, 'admin');
  assert.equal(bootstrap.user.personalWorkspaceId, undefined);
  const item = await (await api('/items', { title: 'Persist across container restart' })).json();
  await compose('restart', 'app');
  await ready();
  const restored = await (await api(`/items/${item.id}`)).json();
  assert.equal((restored.item ?? restored).title, item.title);
  await compose('stop', 'db');
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  assert.equal(
    (await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(10000) })).status,
    503,
  );
  await compose('start', 'db');
  await ready();
  await api(`/items/${item.id}`);
  console.log(
    'Docker smoke passed: frontend, setup, persistence, session, DB outage and recovery.',
  );
} catch (error) {
  await compose('logs', '--no-color', '--tail', '80', 'app').catch(() => {});
  throw error;
} finally {
  try {
    await compose('down', '--volumes', '--remove-orphans');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
