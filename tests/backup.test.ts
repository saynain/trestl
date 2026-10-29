import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { createApp } from '../server/app.ts';
import { readBackup, restoreBackup, writeBackup } from '../server/backup.ts';
import { lockTiming, openDatabase } from '../server/db.ts';
import { checkUpgrade } from '../server/upgrade.ts';
import { serverVersion } from '../server/version.ts';
import {
  contentsOf,
  fakeGitea,
  populate,
  testSecret,
  verifyRestored,
  type Fixture,
} from './backup-fixture.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = serverVersion();

/** Run the operator command with only the configuration a test passes. */
function backupCli(args: string[], env: Record<string, string>, stdin?: Buffer) {
  const clean = { ...process.env };
  for (const key of ['DATABASE_URL', 'DATA_DIR', 'BACKUP_DIR', 'APP_SECRET']) delete clean[key];
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/backup-cli.ts', ...args], {
    cwd: root,
    env: { ...clean, ...env },
  });
  const stdout: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.stdin.end(stdin);
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((accept) =>
    child.once('close', (code) => accept({ code, stdout: Buffer.concat(stdout), stderr })),
  );
}

async function withSecret<T>(secret: string | undefined, fn: () => Promise<T>) {
  const previous = process.env.APP_SECRET;
  if (secret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previous;
  }
}

/** A populated, closed PGlite installation and its backup. */
async function backedUpInstallation(directory: string, gitOrigin: string) {
  const source = join(directory, 'source');
  const fixture = await withSecret(testSecret, async () => {
    const app = await createApp({ dataDir: source });
    try {
      return await populate(app, gitOrigin);
    } finally {
      await app.close();
    }
  });
  const file = join(directory, 'installation.trestl-backup');
  const created = await backupCli(['create', '--output', file], {
    DATA_DIR: source,
    APP_SECRET: testSecret,
  });
  assert.equal(created.code, 0, created.stderr);
  return { source, file, fixture };
}

async function restoredApp(options: { dataDir?: string; databaseUrl?: string }) {
  return createApp({ ...options, backupDir: join(tmpdir(), 'unused') });
}

async function postgres(t: TestContext) {
  const admin = process.env.TRESTL_TEST_DATABASE_URL;
  if (!admin) {
    t.skip('Set TRESTL_TEST_DATABASE_URL to a disposable PostgreSQL server to run this test.');
    return null;
  }
  const name = `trestl_backup_${randomBytes(6).toString('hex')}`;
  const run = async (sql: string) => {
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await run(`CREATE DATABASE ${name}`);
  t.after(() => run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return url.toString();
}

test('a backup restores a complete installation into a new PGlite folder', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-backup-'));
  const gitea = await fakeGitea();
  t.after(async () => {
    await gitea.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { source, file, fixture } = await backedUpInstallation(directory, gitea.origin);
  const verified = await backupCli(['verify', file], { APP_SECRET: testSecret });
  assert.equal(verified.code, 0, verified.stderr);
  assert.match(verified.stdout.toString(), /APP_SECRET: +matches this APP_SECRET/);
  assert.match(verified.stdout.toString(), /item_images: 1/);

  // A clean machine: an absent folder, the backup file and APP_SECRET.
  const clean = join(directory, 'clean', 'data');
  const restored = await backupCli(['restore', file], {
    DATA_DIR: clean,
    APP_SECRET: testSecret,
  });
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(await contentsOf({ dataDir: clean }), await contentsOf({ dataDir: source }));
  await withSecret(testSecret, async () => {
    const app = await restoredApp({ dataDir: clean });
    try {
      await verifyRestored(app, fixture, gitea);
    } finally {
      await app.close();
    }
  });

  // Standard output and input carry the same backup, for example through docker exec.
  const streamed = await backupCli(['create', '--output', '-'], {
    DATA_DIR: source,
    APP_SECRET: testSecret,
  });
  assert.equal(streamed.code, 0, streamed.stderr);
  const piped = join(directory, 'piped');
  const fromStdin = await backupCli(
    ['restore', '-'],
    { DATA_DIR: piped, APP_SECRET: testSecret },
    streamed.stdout,
  );
  assert.equal(fromStdin.code, 0, fromStdin.stderr);
  assert.deepEqual(await contentsOf({ dataDir: piped }), await contentsOf({ dataDir: source }));

  // Without --output, backups go to BACKUP_DIR.
  const folder = join(directory, 'scheduled');
  const scheduled = await backupCli(['create'], {
    DATA_DIR: source,
    APP_SECRET: testSecret,
    BACKUP_DIR: folder,
  });
  assert.equal(scheduled.code, 0, scheduled.stderr);
  assert.match((await readdir(folder))[0]!, /^trestl-\d{8}-\d{6}Z-.+\.trestl-backup$/);
});

test('restore refuses unsafe targets and keeps them unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-backup-'));
  const gitea = await fakeGitea();
  t.after(async () => {
    await gitea.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { source, file, fixture } = await backedUpInstallation(directory, gitea.origin);

  const occupied = await backupCli(['restore', file], { DATA_DIR: source, APP_SECRET: testSecret });
  assert.equal(occupied.code, 1);
  assert.match(occupied.stderr, /is not empty/);

  const target = join(directory, 'target');
  for (const secret of [undefined, 'a-different-secret-that-is-long-enough-123']) {
    const refused = await backupCli(['restore', file], {
      DATA_DIR: target,
      ...(secret ? { APP_SECRET: secret } : {}),
    });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /APP_SECRET/);
    assert.equal(existsSync(target), false, 'A refused restore leaves nothing behind');
  }
  // An existing empty folder (such as a volume mount) stays, emptied again on failure.
  await mkdir(target);
  const damaged = join(directory, 'damaged.trestl-backup');
  await writeFile(damaged, (await readFile(file)).subarray(0, 2000));
  const failed = await backupCli(['restore', damaged], {
    DATA_DIR: target,
    APP_SECRET: testSecret,
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /incomplete or damaged/);
  assert.deepEqual(await readdir(target), []);

  // Lost the key: everything else comes back; credentials need reconnecting.
  const mismatch = await backupCli(['restore', file, '--allow-secret-mismatch'], {
    DATA_DIR: target,
    APP_SECRET: 'a-different-secret-that-is-long-enough-123',
  });
  assert.equal(mismatch.code, 0, mismatch.stderr);
  await withSecret('a-different-secret-that-is-long-enough-123', async () => {
    const app = await restoredApp({ dataDir: target });
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'owner@backup.test', password: 'correct-horse-battery' },
      });
      assert.equal(login.statusCode, 200);
      const issue = await app.inject({
        url: `/api/v1/git/connections/${fixture.connection}/issue?repository=owner/repo&number=42`,
        headers: { cookie: `trestl_session=${login.cookies[0]!.value}` },
      });
      assert.equal(issue.statusCode, 503);
      assert.match(issue.json().message, /could not be decrypted/);
    } finally {
      await app.close();
    }
  });

  const missing = await backupCli(['create'], { DATA_DIR: join(directory, 'absent') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No Trestl database was found/);
  assert.equal(existsSync(join(directory, 'absent')), false);
  // A database without Trestl's tables (such as a mistyped DATABASE_URL) is not backed up.
  const unrelated = join(directory, 'unrelated');
  await (await openDatabase({ dataDir: unrelated, initialize: false })).close();
  const empty = await backupCli(['create', '--output', join(directory, 'empty.trestl-backup')], {
    DATA_DIR: unrelated,
  });
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /it has no entities table/);
  assert.equal(existsSync(join(directory, 'empty.trestl-backup')), false);
});

test('backups detect damage, truncation and incompatible releases', async () => {
  const db = await openDatabase({ dataDir: ':memory:' });
  const chunks: Buffer[] = [];
  const output = new PassThrough();
  output.on('data', (chunk) => chunks.push(chunk));
  try {
    await db.query(
      `INSERT INTO item_images(id,creator_id,workspace_id,mime_type,data) VALUES ('i','u','w','image/png',$1)`,
      [Buffer.from([0, 1, 2, 255])],
    );
    await writeBackup(db, output, { engine: 'pglite', createdBy: { version, commit: null } });
    // A failing destination (such as a full disk) fails the backup instead of hanging.
    await db.query(
      `INSERT INTO item_images(id,creator_id,workspace_id,mime_type,data) VALUES ('large','u','w','image/png',$1)`,
      [randomBytes(4 * 1024 * 1024)],
    );
    let written = 0;
    const full = new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, callback) {
        written += chunk.length;
        setImmediate(() => callback(written > 64 * 1024 ? new Error('No space left') : null));
      },
    });
    await assert.rejects(
      writeBackup(db, full, { engine: 'pglite', createdBy: { version, commit: null } }),
      /No space left/,
    );
  } finally {
    await db.close();
  }
  const backup = Buffer.concat(chunks);
  const summary = await readBackup(Readable.from([backup]));
  assert.equal(summary.tables.item_images, 1);
  assert.equal(summary.header.secretCheck, null);
  const lines = gunzipSync(backup).toString().split('\n');
  const variant = (change: (lines: string[]) => string[]) =>
    Readable.from([gzipSync(change([...lines]).join('\n'))]);
  const replace = (index: number, change: (line: string) => string) => (l: string[]) =>
    l.map((line, i) => (i === index ? change(line) : line));
  const row = lines.findIndex((line) => line.startsWith('["i",'));
  await assert.rejects(
    readBackup(variant(replace(row, (line) => line.replace('AAEC/w==', 'AAEC/A==')))),
    /rows of item_images are incomplete or damaged/,
  );
  await assert.rejects(
    readBackup(variant((l) => l.slice(0, -2).concat(''))),
    /incomplete\. It may have been truncated/,
  );
  await assert.rejects(readBackup(Readable.from([backup.subarray(0, 100)])), /damaged/);
  await assert.rejects(
    readBackup(variant(() => ['{"format":"something-else"}', ''])),
    /not a Trestl backup/,
  );
  await assert.rejects(
    readBackup(
      variant(replace(0, (line) => line.replace('"formatVersion":1', '"formatVersion":2'))),
    ),
    /newer Trestl release/,
  );
  // Restoring runs definitions as SQL; a crafted file must not run anything else.
  const entities = lines.findIndex((line) => line.startsWith('{"table":{"name":"entities"'));
  const crafted = (change: (table: any) => void) =>
    variant(
      replace(entities, (line) => {
        const record = JSON.parse(line);
        change(record.table);
        return JSON.stringify(record);
      }),
    );
  for (const change of [
    (t: any) => (t.indexes[0].definition += `; COPY (SELECT 1) TO PROGRAM 'id'`),
    (t: any) => (t.indexes[0].definition = t.indexes[0].definition.replace('USING', '-- USING')),
    (t: any) =>
      t.constraints.push({ name: 'x', type: 'c', definition: "CHECK (pg_read_file('x') <> '')" }),
    (t: any) => (t.columns[0].type = 'text CHECK (length(concat(chr(47))) > 0)'),
    (t: any) => (t.columns[0].default = "pg_read_file('x')"),
    (t: any) => (t.columns[0].default = '"pg_read_file"(\'x\')'),
    (t: any) => (t.indexes[0].definition = t.indexes[0].definition.replace(' ON ', ' ON other.')),
  ])
    await assert.rejects(readBackup(crafted(change)), /table definition is not supported/);
  const newer = variant(
    replace(0, (line) => line.replace(/"version":(null|"[^"]*")}/, '"version":"999.0.0"}')),
  );
  const target = await openDatabase({ dataDir: ':memory:', initialize: false });
  try {
    await assert.rejects(
      restoreBackup(target, newer, { appVersion: version }),
      /comes from Trestl 999\.0\.0/,
    );
    assert.deepEqual(
      (await target.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows,
      [],
    );
  } finally {
    await target.close();
  }
});

test('backups keep foreign keys and refuse columns they cannot restore', async () => {
  const backup = async (db: Awaited<ReturnType<typeof openDatabase>>) => {
    const chunks: Buffer[] = [];
    const output = new PassThrough();
    output.on('data', (chunk) => chunks.push(chunk));
    await writeBackup(db, output, { engine: 'pglite', createdBy: { version, commit: null } });
    return Buffer.concat(chunks);
  };
  const source = await openDatabase({ dataDir: ':memory:' });
  const target = await openDatabase({ dataDir: ':memory:', initialize: false });
  try {
    // A reference to a plain unique index, from a table that sorts before it.
    await source.query(`CREATE TABLE zone (code text NOT NULL)`);
    await source.query(`CREATE UNIQUE INDEX zone_code ON zone (code)`);
    await source.query(`CREATE TABLE area (zone text REFERENCES zone(code))`);
    await source.query(`INSERT INTO zone VALUES ('north')`);
    await source.query(`INSERT INTO area VALUES ('north')`);
    await restoreBackup(target, Readable.from([await backup(source)]), { appVersion: version });
    await assert.rejects(
      target.query(`INSERT INTO area VALUES ('south')`),
      /violates foreign key constraint/,
    );
    await source.query(`CREATE TYPE mood AS ENUM ('calm')`);
    await source.query(`CREATE TABLE feelings (mood mood)`);
    await assert.rejects(backup(source), /do not support column feelings\.mood/);
  } finally {
    await source.close();
    await target.close();
  }
});

test('startup backs up before an upgrade and refuses a database from a newer release', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.BACKUP_DIR;
  delete process.env.BACKUP_DIR;
  t.after(() => {
    if (previous !== undefined) process.env.BACKUP_DIR = previous;
  });
  const dataDir = join(directory, 'data');
  const backups = join(directory, 'backups');
  const app = await createApp({ dataDir, backupDir: backups, integrations: false });
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { name: 'Owner', email: 'owner@upgrade.test', password: 'correct-horse-battery' },
  });
  await app.close();
  assert.equal(existsSync(backups), false, 'A new installation has nothing to back up');
  const marker = async (value: string | null) => {
    const db = await openDatabase({ dataDir, initialize: false });
    try {
      if (value === null)
        await db.query(
          `DELETE FROM entities WHERE collection='system' AND id='installation-version'`,
        );
      else
        await db.query(
          `UPDATE entities SET data=jsonb_set(data,'{version}',to_jsonb($1::text)) WHERE collection='system' AND id='installation-version'`,
          [value],
        );
      return (
        await db.query<{ version: string }>(
          `SELECT data->>'version' AS version FROM entities WHERE collection='system' AND id='installation-version'`,
        )
      ).rows[0]?.version;
    } finally {
      await db.close();
    }
  };
  const start = async (options: { backupDir?: string } = { backupDir: backups }) =>
    (await createApp({ dataDir, integrations: false, ...options })).close();
  // Desktop reads its launch line from stdout, so notices go to stderr.
  const notices: string[] = [];
  t.mock.method(console, 'error', (message: string) => notices.push(message));

  assert.equal(await marker('0.0.1'), '0.0.1');
  await start();
  const [first, ...others] = await readdir(backups);
  assert.equal(others.length, 0);
  assert.match(
    first!,
    new RegExp(`-0\\.0\\.1-before-${version.replaceAll('.', '\\.')}\\.trestl-backup$`),
  );
  const saved = await readBackup(Readable.from([await readFile(join(backups, first!))]));
  assert.equal(saved.header.database.version, '0.0.1');
  assert.match(notices.join('\n'), new RegExp(`Backed up \\d+ rows to .*${first}`));
  assert.equal(await marker(version), version, 'The upgrade is recorded');
  await start();
  assert.equal((await readdir(backups)).length, 1, 'A restart is not an upgrade');

  // Databases from before version tracking get the same protection, by default beside PGlite.
  await marker(null);
  await start({});
  assert.match((await readdir(`${dataDir}-backups`))[0]!, /-unknown-before-/);

  await marker('0.0.1');
  const blocked = join(directory, 'not-a-folder');
  await writeFile(blocked, '');
  await assert.rejects(
    start({ backupDir: blocked }),
    /pre-upgrade backup .* failed.*data is unchanged/s,
  );
  assert.equal(await marker('0.0.1'), '0.0.1', 'Nothing was migrated');

  // A start that fails after its backup keeps that backup; later starts add no partial copies,
  // and an older release refuses the partly migrated data.
  const installationId = process.env.INSTALLATION_ID;
  delete process.env.INSTALLATION_ID;
  t.after(() => {
    if (installationId !== undefined) process.env.INSTALLATION_ID = installationId;
  });
  const legacy = await openDatabase({ dataDir, initialize: false });
  await legacy.query(
    `INSERT INTO entities VALUES ('workspaces','second','{"id":"second","name":"Second","kind":"shared","ownerId":"x"}')`,
  );
  await legacy.query(`DELETE FROM entities WHERE collection='system' AND id='installation'`);
  await legacy.close();
  await marker('0.0.1');
  const before = (await readdir(backups)).length;
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(start(), /INSTALLATION_ID/);
  assert.equal((await readdir(backups)).length, before + 1);
  const pending = await openDatabase({ dataDir, initialize: false });
  try {
    await assert.rejects(
      checkUpgrade(pending, 'pglite', dataDir, { version: '0.0.1' }),
      new RegExp(`upgrade to Trestl ${version.replaceAll('.', '\\.')} started .* did not finish`),
    );
  } finally {
    await pending.close();
  }
  process.env.INSTALLATION_ID = 'default';
  await start();
  assert.equal(await marker(version), version);
  const finished = await openDatabase({ dataDir, initialize: false });
  const data = (
    await finished.query<{ data: object }>(
      `SELECT data FROM entities WHERE collection='system' AND id='installation-version'`,
    )
  ).rows[0]!.data;
  await finished.close();
  assert.equal('upgrade' in data, false, 'Finishing the upgrade clears it');

  await marker('999.0.0');
  await assert.rejects(start(), /last used by Trestl 999\.0\.0, which is newer/);
  assert.equal(await marker('999.0.0'), '999.0.0');
});

test('one process at a time owns a PGlite folder', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const timing = { ...lockTiming };
  Object.assign(lockTiming, { staleAfter: 600, wait: 200 });
  t.after(() => Object.assign(lockTiming, timing));
  const first = await openDatabase({ dataDir });
  await assert.rejects(openDatabase({ dataDir, initialize: false }), /in use by process/);
  await first.close();
  assert.equal(existsSync(join(dataDir, 'trestl.lock')), false);
  // A crashed process leaves its lock behind; it is recovered once that process is gone.
  const exited = spawn(process.execPath, ['-e', '']);
  await new Promise((accept) => exited.once('close', accept));
  // Our own PID is left over from an earlier run, as in a restarted container.
  const lock = join(dataDir, 'trestl.lock');
  for (const owner of [`${exited.pid} ${hostname()}`, `${process.pid} ${hostname()}`]) {
    await writeFile(lock, owner);
    const reopened = await openDatabase({ dataDir });
    await reopened.close();
  }
  // Another host's process (such as another container on the volume) cannot be checked
  // by PID: its lock holds while the owner keeps it fresh, and goes stale when it stops.
  await writeFile(lock, '1 elsewhere');
  const fresh = setInterval(() => utimes(lock, new Date(), new Date()).catch(() => {}), 50);
  try {
    await assert.rejects(openDatabase({ dataDir }), /in use by process 1 on elsewhere/);
  } finally {
    clearInterval(fresh);
  }
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await (await openDatabase({ dataDir })).close();
  // A stale lock that cannot be removed fails instead of spinning.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await writeFile(lock, `${exited.pid} ${hostname()}`);
    await chmod(dataDir, 0o555);
    try {
      await assert.rejects(openDatabase({ dataDir }), /EACCES|permission denied/i);
    } finally {
      await chmod(dataDir, 0o755);
    }
  }
});

async function crossEngine(t: TestContext, direction: 'into' | 'from') {
  const databaseUrl = await postgres(t);
  if (!databaseUrl) return;
  const directory = await mkdtemp(join(tmpdir(), 'trestl-backup-pg-'));
  const gitea = await fakeGitea();
  t.after(async () => {
    await gitea.close();
    await rm(directory, { recursive: true, force: true });
  });
  let fixture: Fixture;
  let file: string;
  let source: { dataDir?: string; databaseUrl?: string };
  let target: { dataDir?: string; databaseUrl?: string };
  if (direction === 'into') {
    const installed = await backedUpInstallation(directory, gitea.origin);
    ({ fixture, file } = installed);
    source = { dataDir: installed.source };
    target = { databaseUrl };
  } else {
    fixture = await withSecret(testSecret, async () => {
      const app = await createApp({ databaseUrl });
      try {
        return await populate(app, gitea.origin);
      } finally {
        await app.close();
      }
    });
    file = join(directory, 'postgres.trestl-backup');
    const created = await backupCli(['create', '--output', file], {
      DATABASE_URL: databaseUrl,
      APP_SECRET: testSecret,
    });
    assert.equal(created.code, 0, created.stderr);
    source = { databaseUrl };
    target = { dataDir: join(directory, 'restored') };
  }
  const restored = await backupCli(['restore', file], {
    ...(target.databaseUrl ? { DATABASE_URL: target.databaseUrl } : { DATA_DIR: target.dataDir! }),
    APP_SECRET: testSecret,
  });
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(await contentsOf(target), await contentsOf(source));
  await withSecret(testSecret, async () => {
    const app = await restoredApp(target);
    try {
      await verifyRestored(app, fixture, gitea);
    } finally {
      await app.close();
    }
  });
  if (target.databaseUrl) {
    // PostgreSQL: a second restore into the same database is refused and changes nothing.
    const before = await contentsOf(target);
    const again = await backupCli(['restore', file], {
      DATABASE_URL: target.databaseUrl,
      APP_SECRET: testSecret,
    });
    assert.equal(again.code, 1);
    assert.match(again.stderr, /target database is not empty/);
    assert.deepEqual(await contentsOf(target), before);
  }
}

test('PGlite backups restore into PostgreSQL', (t) => crossEngine(t, 'into'));
test('PostgreSQL backups restore into PGlite', (t) => crossEngine(t, 'from'));

test('PostgreSQL backups follow the schema Trestl uses', async (t) => {
  const source = await postgres(t);
  const target = await postgres(t);
  if (!source || !target) return;
  const client = new pg.Client({ connectionString: source });
  await client.connect();
  await client.query('CREATE SCHEMA work');
  await client.end();
  const scoped = new URL(source);
  scoped.searchParams.set('options', '-c search_path=work');
  await (await createApp({ databaseUrl: scoped.toString(), integrations: false })).close();
  const directory = await mkdtemp(join(tmpdir(), 'trestl-backup-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'scoped.trestl-backup');
  const created = await backupCli(['create', '--output', file], {
    DATABASE_URL: scoped.toString(),
  });
  assert.equal(created.code, 0, created.stderr);
  const restored = await backupCli(['restore', file], { DATABASE_URL: target });
  assert.equal(restored.code, 0, restored.stderr);
  assert.deepEqual(
    await contentsOf({ databaseUrl: target }),
    await contentsOf({ databaseUrl: scoped.toString() }),
  );
  assert.ok(Object.keys(await contentsOf({ databaseUrl: target })).includes('entities'));
});

test('PostgreSQL upgrades without BACKUP_DIR warn and continue', async (t) => {
  const databaseUrl = await postgres(t);
  if (!databaseUrl) return;
  const previous = process.env.BACKUP_DIR;
  delete process.env.BACKUP_DIR;
  t.after(() => {
    if (previous !== undefined) process.env.BACKUP_DIR = previous;
  });
  await (await createApp({ databaseUrl, integrations: false })).close();
  const db = await openDatabase({ databaseUrl, initialize: false });
  await db.query(
    `UPDATE entities SET data=jsonb_set(data,'{version}','"0.0.1"') WHERE collection='system' AND id='installation-version'`,
  );
  await db.close();
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  await (await createApp({ databaseUrl, integrations: false })).close();
  assert.match(warnings.join('\n'), /from Trestl 0\.0\.1 to .* without an automatic backup/);
});
