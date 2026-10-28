import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { PGlite } from '@electric-sql/pglite';

const data = await mkdtemp(join(tmpdir(), 'trestl-desktop-'));
const resources = resolve(process.env.TRESTL_DESKTOP_TEST_RESOURCES || 'src-tauri/resources');
const binary = process.env.TRESTL_DESKTOP_TEST_BINARY
  ? resolve(process.env.TRESTL_DESKTOP_TEST_BINARY)
  : resolve(
      'src-tauri/binaries',
      (await readdir('src-tauri/binaries')).find((name) => name.startsWith('trestl-node-')),
    );
let child;
async function start() {
  let errors = '';
  child = spawn(binary, [join(resources, 'server.cjs')], {
    cwd: tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Prove that inherited web deployment configuration cannot redirect desktop storage.
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://invalid/desktop-must-not-use',
      APP_SECRET: 'ignored',
      AUTH_MODE: 'proxy',
      INSTALLATION_ID: 'ignored',
    },
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const input = createInterface({ input: child.stdout });
  const ready = new Promise((accept, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Desktop startup timed out: ${errors}`)),
      60000,
    );
    input.once('line', (line) => {
      clearTimeout(timeout);
      accept(JSON.parse(line));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Desktop exited ${code}: ${errors}`));
    });
    child.once('error', reject);
  });
  child.stdin.write(JSON.stringify({ dataDir: data, resources }) + '\n');
  const { url } = await ready;
  const origin = new URL(url).origin;
  assert.equal((await fetch(origin + '/api/v1/auth/status')).status, 403);
  const launch = await fetch(url, { redirect: 'manual' });
  assert.equal(launch.status, 302);
  let cookie = launch.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 403);
  async function api(path, body, method = 'POST') {
    const response = await fetch(origin + '/api/v1' + path, {
      method: body === undefined ? 'GET' : method,
      headers: { cookie, origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const next of response.headers.getSetCookie()) cookie += '; ' + next.split(';')[0];
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  const page = await fetch(origin, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  return { api, origin, cookie: () => cookie };
}
async function stop(eof = false) {
  const exited = once(child, 'exit');
  if (eof) child.stdin.end();
  else child.stdin.write('shutdown\n');
  const timer = setTimeout(() => child.kill(), 15000);
  const [code] = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, 'Graceful shutdown must flush the local database');
}
try {
  const first = await start();
  assert.equal((await first.api('/auth/status')).needsSetup, true);
  await first.api('/auth/setup', {
    name: 'Desktop owner',
    email: 'desktop@example.test',
    password: 'desktop-test-password',
    installationName: 'Local workspace',
  });
  const project = await first.api('/projects', { key: 'LOCAL', name: 'Offline project' });
  await first.api('/items', { title: 'Survives a desktop restart', projectId: project.id });
  const duplicate = spawn(binary, [join(resources, 'server.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let duplicateError = '';
  duplicate.stderr.on('data', (chunk) => {
    duplicateError += chunk;
  });
  const duplicateExit = once(duplicate, 'exit');
  duplicate.stdin.end(JSON.stringify({ dataDir: data, resources }) + '\n');
  assert.equal((await duplicateExit)[0], 1);
  assert.match(duplicateError, /already in use/);
  const secret = await readFile(join(data, 'app-secret'), 'utf8');
  assert.equal(secret.length, 64);
  await stop();
  const second = await start();
  assert.equal(
    second.origin,
    first.origin,
    'Reuse the local origin to preserve webview preferences',
  );
  assert.equal((await second.api('/auth/status')).needsSetup, false);
  await second.api('/auth/login', {
    email: 'desktop@example.test',
    password: 'desktop-test-password',
  });
  assert.ok(JSON.stringify(await second.api('/projects')).includes('Offline project'));
  assert.ok(JSON.stringify(await second.api('/items')).includes('Survives a desktop restart'));
  assert.equal(await readFile(join(data, 'app-secret'), 'utf8'), secret);
  await stop(true); // Parent pipe closure must also flush and exit on every OS.
  assert.ok(!(await readdir(data)).includes('desktop.lock'));
  assert.ok(!(await readdir(join(data, 'database'))).includes('trestl.lock'));
  // An update backs up the database before migrating it; the launch line stays first.
  const database = new PGlite(join(data, 'database'));
  await database.query(
    `UPDATE entities SET data=jsonb_set(data,'{version}','"0.0.1"') WHERE collection='system' AND id='installation-version'`,
  );
  await database.close();
  const upgraded = await start();
  await upgraded.api('/auth/login', {
    email: 'desktop@example.test',
    password: 'desktop-test-password',
  });
  assert.ok(JSON.stringify(await upgraded.api('/items')).includes('Survives a desktop restart'));
  await stop();
  assert.match((await readdir(join(data, 'backups'))).join(), /-0\.0\.1-before-.+\.trestl-backup$/);
  // Never attach to an unrelated process when the remembered port is occupied.
  const occupied = createServer();
  occupied.listen(Number(new URL(second.origin).port), '127.0.0.1');
  await once(occupied, 'listening');
  try {
    const third = await start();
    assert.notEqual(third.origin, second.origin);
    assert.equal((await third.api('/auth/status')).needsSetup, false);
    await stop();
  } finally {
    await new Promise((accept) => occupied.close(accept));
  }
  // A host exiting during first initialization must not leave a writer or lock behind.
  child = spawn(binary, [join(resources, 'server.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const earlyExit = once(child, 'exit');
  child.stdin.end(JSON.stringify({ dataDir: data, resources }) + '\n');
  const timer = setTimeout(() => child.kill(), 15000);
  assert.equal((await earlyExit)[0], 0);
  clearTimeout(timer);
  assert.ok(!(await readdir(data)).includes('desktop.lock'));
  console.log(
    'Packaged desktop runtime: setup, isolation, persistence, pre-upgrade backup, stable secret, and shutdown passed.',
  );
} finally {
  if (child?.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
  await rm(data, { recursive: true, force: true });
}
