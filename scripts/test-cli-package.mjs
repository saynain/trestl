import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'trestl-package-'));
const outside = join(temporary, 'unrelated-repository');
await mkdir(outside);
const environment = {
  ...process.env,
  TRESTL_TOKEN: '',
  TRESTL_URL: '',
  TRESTL_PROFILE: '',
  TRESTL_CONFIG_DIR: join(temporary, 'credentials'),
};
const run = (executable, args, { cwd = outside, input, expected = 0, onStderr } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: environment, stdio: 'pipe' });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      onStderr?.(stderr);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        assert.equal(code, expected, `${executable} ${args.join(' ')}\n${stderr}`);
        resolve({ stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
let app;
try {
  await run(process.execPath, ['scripts/build-cli.mjs'], { cwd: root });
  const packed = await run(
    'npm',
    [
      'pack',
      './cli',
      '--json',
      '--pack-destination',
      temporary,
      '--cache',
      join(temporary, 'cache'),
      '--ignore-scripts',
    ],
    { cwd: root },
  );
  const artifact = join(temporary, JSON.parse(packed.stdout)[0].filename);
  const prefix = join(temporary, 'installation');
  await run('npm', [
    'install',
    '--global',
    '--prefix',
    prefix,
    artifact,
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--cache',
    join(temporary, 'cache'),
  ]);
  const installed =
    process.platform === 'win32'
      ? join(prefix, 'node_modules', '@trestl', 'cli', 'dist', 'index.js')
      : join(prefix, 'lib', 'node_modules', '@trestl', 'cli', 'dist', 'index.js');
  const cli = (args, options) => run(process.execPath, [installed, ...args], options);
  assert.match((await cli(['--help'])).stdout, /Usage: trestl/);
  assert.equal(JSON.parse((await cli(['--version', '--json'])).stdout).version, '0.1.0');
  app = await createApp({ dataDir: ':memory:', integrations: false });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.APP_ORIGIN = url;
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      name: 'Package test',
      email: 'package@example.test',
      password: 'package-test-password',
      seedDemo: false,
    },
  });
  const cookie = `${setup.cookies[0].name}=${setup.cookies[0].value}`;
  const token = (
    await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie },
      payload: { name: 'Package test', scope: 'write' },
    })
  ).json().token;
  await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie },
    payload: { name: 'Package project', key: 'PKG' },
  });
  await cli(['login', '--profile', 'test', '--url', url, '--token-stdin', '--json'], {
    input: token,
  });
  let approval;
  const browser = await cli(
    ['login', '--profile', 'browser', '--url', url, '--no-browser', '--scope', 'read', '--json'],
    {
      onStderr: (text) => {
        const code = text.match(/Confirm code ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/);
        if (code && !approval)
          approval = app.inject({
            method: 'POST',
            url: '/api/v1/auth/cli/approve',
            headers: { cookie },
            payload: { code: code[1] },
          });
      },
    },
  );
  assert.equal((await approval).statusCode, 200);
  assert.equal(browser.stdout.includes('ep_'), false);
  assert.equal(
    JSON.parse((await cli(['auth', 'status', '--profile', 'browser', '--json'])).stdout)
      .authenticated,
    true,
  );
  await cli(['create', 'Denied', '--profile', 'browser'], { expected: 3 });
  await cli(['logout', '--profile', 'browser']);
  await cli(['init', '--profile', 'test', '--project', 'PKG']);
  const discovery = JSON.parse((await cli(['profiles', 'list', '--json'])).stdout);
  assert.deepEqual(discovery, {
    selectedProfile: 'test',
    tokenOverride: false,
    profiles: [{ name: 'test', selected: true }],
  });
  const auth = JSON.parse((await cli(['auth', 'status', '--json'])).stdout);
  assert.equal(auth.source, 'saved');
  const args = ['create', 'Packaged CLI capture', '--idempotency-key', 'package-capture', '--json'];
  const created = JSON.parse((await cli(args)).stdout);
  assert.equal(created.identifier.startsWith('PKG-'), true);
  assert.deepEqual(JSON.parse((await cli(args)).stdout), created);
  const detail = JSON.parse((await cli(['get', created.identifier, '--json'])).stdout);
  assert.equal(detail.item.revision, 1);
  const page = JSON.parse(
    (await cli(['search', 'Packaged', '--page', '--limit', '1', '--json'])).stdout,
  );
  assert.equal(page.data.length, 1);
  await cli(['update', created.identifier, '--status', 'in_progress', '--expected-revision', '1']);
  const conflict = await cli(
    ['update', created.identifier, '--status', 'done', '--expected-revision', '1', '--json'],
    { expected: 5 },
  );
  assert.equal(JSON.parse(conflict.stderr).error.code, 'conflict');
  const noteArgs = [
    'comment',
    created.identifier,
    'Package test note',
    '--idempotency-key',
    'package-note',
    '--json',
  ];
  assert.equal(
    JSON.parse((await cli(noteArgs)).stdout).id,
    JSON.parse((await cli(noteArgs)).stdout).id,
  );
  await cli(['logout']);
  await cli(['list', '--json'], { expected: 3 });
  console.log(
    'Standalone package passed: offline installation, unrelated working directory, saved login, repository defaults, real API reads, guarded updates, retry-safe creates/comments and logout.',
  );
} finally {
  if (app) await app.close();
  await rm(temporary, { recursive: true, force: true });
}
