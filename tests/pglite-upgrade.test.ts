import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.ts';
import { readBackup, writeBackup } from '../server/backup.ts';
import { openDatabase } from '../server/db.ts';
import { pgliteMajor } from '../server/pglite-upgrade.ts';
import { testSecret, verifyRestored, withSecret } from './backup-fixture.ts';
import { releaseFolder } from './release-fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const major = async (dataDir: string) =>
  (await readFile(join(dataDir, 'PG_VERSION'), 'utf8')).trim();

/** The 0.6.0 installation's Gitea, answered without opening its port. */
function giteaAt(t: TestContext, origin: string) {
  const authorizations: string[] = [];
  const real = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(origin)) return real(input, init);
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json(
      url.endsWith('/issues/42')
        ? { id: 42, number: 42, title: 'Remote issue', body: 'Body', state: 'open' }
        : [],
    );
  });
  return { authorizations };
}

async function scratch(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-pglite-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a PGlite 0.3 folder from Trestl 0.6.0 moves to the current engine intact', async (t) => {
  const directory = await scratch(t);
  const dataDir = join(directory, 'data');
  const fixture = await releaseFolder(dataDir);
  assert.equal(await major(dataDir), '17');
  const gitea = giteaAt(t, 'http://127.0.0.1:4516');
  const notices: string[] = [];
  t.mock.method(console, 'error', (message: string) => notices.push(message));
  await withSecret(testSecret, async () => {
    const app = await createApp({ dataDir });
    try {
      await verifyRestored(app, fixture, gitea);
    } finally {
      await app.close();
    }
  });
  assert.equal(await major(dataDir), pgliteMajor);
  const kept = `${dataDir}-pglite-0.3`;
  assert.equal(await major(kept), '17', 'The original folder is kept');
  assert.equal(existsSync(`${dataDir}-pglite-upgrade`), false);
  const backups = await readdir(`${dataDir}-backups`);
  assert.equal(backups.length, 1, 'One backup for the whole upgrade');
  const backup = await readBackup(
    Readable.from([await readFile(join(`${dataDir}-backups`, backups[0]!))]),
  );
  assert.match(backup.header.database.server, /^PostgreSQL 17/);
  assert.match(notices.join('\n'), /The original folder is kept in .*data-pglite-0\.3/);

  // Later starts are ordinary; the kept folder still opens with its own engine.
  await withSecret(testSecret, async () => (await createApp({ dataDir })).close());
  assert.equal((await readdir(`${dataDir}-backups`)).length, 1);
  const original = await openDatabase({ dataDir: kept, initialize: false });
  try {
    const summary = await writeBackup(original, null, {
      engine: 'pglite',
      createdBy: { version: '0.6.0', commit: null },
    });
    assert.deepEqual(summary.digests, backup.digests);
  } finally {
    await original.close();
  }
});

test('the desktop app moves its database on the first start after an update', async (t) => {
  const appData = await scratch(t);
  const fixture = await releaseFolder(join(appData, 'database'));
  await writeFile(join(appData, 'app-secret'), testSecret, { mode: 0o600 });
  const resources = join(appData, '..', `${appData.split('/').at(-1)}-resources`);
  t.after(() => rm(resources, { recursive: true, force: true }));
  await mkdir(join(resources, 'web'), { recursive: true });
  await writeFile(join(resources, 'web', 'index.html'), '<div id="root"></div>');
  const child = spawn(process.execPath, ['--import', 'tsx', 'desktop/server.ts'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const exited = new Promise<number | null>((accept) => child.once('exit', accept));
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  child.stdin.write(JSON.stringify({ dataDir: appData, resources }) + '\n');
  const launch = await new Promise<string>((accept, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.url) accept(message.url);
    });
    child.once('exit', () => reject(new Error(`Desktop exited: ${errors}`)));
  });
  const origin = new URL(launch).origin;
  const start = await fetch(launch, { redirect: 'manual' });
  let cookie = start.headers.getSetCookie()[0]!.split(';')[0]!;
  const login = await fetch(`${origin}/api/v1/auth/login`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@backup.test', password: 'correct-horse-battery' }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  for (const next of login.headers.getSetCookie()) cookie += '; ' + next.split(';')[0];
  const item = await fetch(`${origin}/api/v1/items/${fixture.items.private}`, {
    headers: { cookie, origin },
  });
  assert.equal(item.status, 200);
  assert.equal((await item.json()).item.title, 'Personal follow-up');
  child.stdin.write('shutdown\n');
  assert.equal(await exited, 0, errors);
  assert.equal(await major(join(appData, 'database')), pgliteMajor);
  assert.equal(await major(join(appData, 'database-pglite-0.3')), '17');
  assert.match((await readdir(join(appData, 'backups'))).join(), /-before-.+\.trestl-backup$/);
});

test('a failed or interrupted move leaves a folder that opens', async (t) => {
  const directory = await scratch(t);
  const dataDir = join(directory, 'data');
  await releaseFolder(dataDir);
  t.mock.method(console, 'error', () => {});

  // No backup, no move: the original stays where it was.
  const blocked = join(directory, 'not-a-folder');
  await writeFile(blocked, '');
  await assert.rejects(
    createApp({ dataDir, backupDir: blocked, integrations: false }),
    /pre-upgrade backup .* failed.*data is unchanged/s,
  );
  assert.equal(await major(dataDir), '17');
  assert.deepEqual(
    (await readdir(directory)).sort(),
    ['data', 'not-a-folder'],
    'Nothing else was created',
  );

  // An earlier attempt that never swapped is discarded.
  await mkdir(`${dataDir}-pglite-upgrade`);
  await writeFile(join(`${dataDir}-pglite-upgrade`, 'PG_VERSION'), pgliteMajor);
  await (await createApp({ dataDir, integrations: false })).close();
  assert.equal(await major(dataDir), pgliteMajor);
  assert.equal(existsSync(`${dataDir}-pglite-upgrade`), false);

  // A crash between the two renames: the verified copy is put in place on the next start.
  await rename(dataDir, `${dataDir}-pglite-upgrade`);
  await writeFile(join(`${dataDir}-pglite-upgrade`, 'trestl-upgrade.json'), '{}');
  const reopened = await openDatabase({ dataDir });
  try {
    assert.ok((await reopened.query(`SELECT 1 FROM entities LIMIT 1`)).rows.length);
  } finally {
    await reopened.close();
  }
  assert.equal(existsSync(join(dataDir, 'trestl-upgrade.json')), false);
});

test('backups read older folders without moving them', async (t) => {
  const directory = await scratch(t);
  const dataDir = join(directory, 'data');
  await releaseFolder(dataDir);
  const legacy = await openDatabase({ dataDir, initialize: false, mustExist: true });
  try {
    const summary = await writeBackup(legacy, null, {
      engine: 'pglite',
      createdBy: { version: '0.6.0', commit: null },
    });
    assert.equal(summary.tables.item_images, 1);
  } finally {
    await legacy.close();
  }
  assert.equal(await major(dataDir), '17');
  assert.equal(existsSync(`${dataDir}-pglite-0.3`), false);
});

test('new folders use the bundled engine, and unknown engines are refused', async (t) => {
  const directory = await scratch(t);
  // A dependency update to another PostgreSQL major needs its own folder migration.
  await (await openDatabase({ dataDir: join(directory, 'new') })).close();
  assert.equal(await major(join(directory, 'new')), pgliteMajor);
  await mkdir(join(directory, 'future'));
  await writeFile(join(directory, 'future', 'PG_VERSION'), '99\n');
  await assert.rejects(openDatabase({ dataDir: join(directory, 'future') }), /PostgreSQL 99/);
});
