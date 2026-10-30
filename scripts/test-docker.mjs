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
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
// TRESTL_SMOKE_PORT reserves two consecutive host ports; otherwise any free ones are used.
const basePort = Number(process.env.TRESTL_SMOKE_PORT) || 0;
const port = basePort || (await freePort());
const singlePort = basePort ? basePort + 1 : await freePort();
const origin = `http://127.0.0.1:${port}`;
const singleOrigin = `http://127.0.0.1:${singlePort}`;
// Publication can exercise the exact image that will be pushed, without rebuilding it.
const image = process.env.TRESTL_SMOKE_IMAGE || `${project}:test`;
const single = { container: `${project}-single`, volume: `${project}-data` };
const envFile = join(temporary, '.env');
await writeFile(envFile, '', { mode: 0o600 });
// Explicit test settings prevent a developer's shell or .env selecting real data.
const environment = {
  ...process.env,
  TRESTL_IMAGE: image,
  PORT: String(port),
  POSTGRES_USER: 'trestl',
  POSTGRES_DB: 'trestl',
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  APP_SECRET: randomBytes(32).toString('hex'),
  APP_ORIGIN: origin,
  SECURE_COOKIES: '',
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
async function docker(...args) {
  await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: root, env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`docker ${args[0]} exited ${code}`)),
    );
  });
}
const compose = (...args) => docker(...composeArgs, ...args);
// Cleanup may target resources that are already gone.
const quietly = (...args) =>
  new Promise((resolve) =>
    spawn('docker', args, { cwd: root, env: environment, stdio: 'ignore' }).once('close', resolve),
  );
async function ready(target) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${target}/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Application did not become ready');
}
function client(target) {
  let cookie;
  return async function api(path, body) {
    const response = await fetch(`${target}/api/v1${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: target,
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    const session = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('trestl_session='));
    if (session) {
      // The image runs with NODE_ENV=production; plain HTTP must still keep the session.
      assert.doesNotMatch(session, /;\s*Secure/i);
      cookie = session.split(';')[0];
    }
    return response;
  };
}
const setupInput = (installationName) => ({
  installationName,
  name: 'Container smoke test',
  email: 'smoke@example.test',
  password: randomBytes(24).toString('hex'),
  seedDemo: false,
});
let phase = 'build';
try {
  if (!process.env.TRESTL_SMOKE_IMAGE) await docker('build', '--tag', image, '.');

  phase = 'compose';
  await compose('up', '--detach', '--wait', '--wait-timeout', '120');
  await ready(origin);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
  const api = client(origin);
  assert.equal((await (await api('/auth/status')).json()).needsSetup, true);
  await api('/auth/setup', setupInput('Container test installation'));
  const bootstrap = await (await api('/bootstrap')).json();
  assert.equal(bootstrap.workspace.name, 'Container test installation');
  assert.equal(bootstrap.workspaces.length, 1);
  assert.equal(bootstrap.user.role, 'admin');
  assert.equal(bootstrap.user.personalWorkspaceId, undefined);
  const item = await (await api('/items', { title: 'Persist across container restart' })).json();
  const comment = await (
    await api(`/items/${item.id}/comments`, { body: 'Activity smoke test' })
  ).json();
  const year = new Date(item.createdAt).getUTCFullYear();
  const heatmap = await (
    await api(`/activity/heatmap?userId=${bootstrap.user.id}&year=${year}`)
  ).json();
  assert.equal(heatmap.year, year);
  assert.equal(heatmap.total, 1 + (new Date(comment.createdAt).getUTCFullYear() === year ? 1 : 0));
  assert.equal(
    heatmap.days.reduce((sum, day) => sum + day.count, 0),
    heatmap.total,
  );
  await compose('restart', 'app');
  await ready(origin);
  const restored = await (await api(`/items/${item.id}`)).json();
  assert.equal((restored.item ?? restored).title, item.title);
  await compose('stop', 'db');
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  assert.equal(
    (await fetch(`${origin}/ready`, { signal: AbortSignal.timeout(10000) })).status,
    503,
  );
  await compose('start', 'db');
  await ready(origin);
  await api(`/items/${item.id}`);
  await compose('down', '--volumes', '--remove-orphans');

  // The quick start's single container: embedded PGlite in a volume, no other settings.
  phase = 'single container';
  const run = () =>
    docker(
      'run',
      '--detach',
      '--name',
      single.container,
      '--publish',
      `127.0.0.1:${singlePort}:4317`,
      '--volume',
      `${single.volume}:/data`,
      image,
    );
  await run();
  await ready(singleOrigin);
  const local = client(singleOrigin);
  await local('/auth/setup', setupInput('Single container installation'));
  const first = await (await local('/projects', { name: 'Web app', key: 'WEB' })).json();
  // A generated key lets Git connections be saved without configuring APP_SECRET.
  await local('/git/connections', {
    provider: 'gitea',
    name: 'Gitea',
    baseUrl: 'https://gitea.example.test',
    token: 'smoke-test-token',
    shared: true,
  });
  // Recreate the container: everything that matters must live in the volume.
  await docker('rm', '--force', single.container);
  await run();
  await ready(singleOrigin);
  const projects = (await (await local('/bootstrap')).json()).projects;
  assert.deepEqual(
    projects.map((p) => p.key),
    [first.key],
  );
  const connections = await (await local('/git/connections')).json();
  assert.equal((connections.data ?? connections).length, 1);
  console.log(
    'Docker smoke passed: Compose (frontend, setup, activity heatmap, persistence, session, DB outage and recovery) and a single PGlite container (setup, first project, generated key, recreation).',
  );
} catch (error) {
  if (phase === 'compose')
    await compose('logs', '--no-color', '--tail', '80', 'app').catch(() => {});
  if (phase === 'single container')
    await docker('logs', '--tail', '80', single.container).catch(() => {});
  throw error;
} finally {
  try {
    await quietly(...composeArgs, 'down', '--volumes', '--remove-orphans');
    await quietly('rm', '--force', single.container);
    await quietly('volume', 'rm', '--force', single.volume);
    if (!process.env.TRESTL_SMOKE_IMAGE) await quietly('image', 'rm', image);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
