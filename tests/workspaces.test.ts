import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { User, Workspace } from '../shared/types.ts';
import { openDatabase, makeStore } from '../server/db.ts';

test('legacy installation migration preserves memberships, data and token scope and runs once', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-workspace-migration-'));
  try {
    const db = await openDatabase({ dataDir }),
      s = makeStore(db);
    await s.put<User>('users', {
      id: 'legacy-owner',
      name: 'Owner',
      email: 'owner@test',
      color: '#123456',
      role: 'admin',
    });
    await s.put<User>('users', {
      id: 'legacy-member',
      name: 'Member',
      email: 'member@test',
      color: '#123456',
      role: 'member',
    });
    await s.put('projects', {
      id: 'legacy-project',
      key: 'LEG',
      name: 'Legacy',
      ownerId: 'legacy-owner',
      visibility: 'workspace',
    });
    await db.query(
      'INSERT INTO tokens(id,hash,user_id,name,scope,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        'legacy-token',
        createHash('sha256').update('legacy-secret').digest('hex'),
        'legacy-owner',
        'Legacy',
        'write',
        new Date().toISOString(),
      ],
    );
    await db.close();
    let app = await createApp({ dataDir, integrations: false });
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/bootstrap',
      headers: { authorization: 'Bearer legacy-secret' },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().workspace.kind, 'shared');
    assert.equal(first.json().users.length, 2);
    assert.equal(first.json().projects[0].id, 'legacy-project');
    const ctx = app.getDecorator<AppContext>('context');
    assert.equal(
      (await ctx.store.list<Workspace>('workspaces')).filter((w) => w.kind === 'personal').length,
      0,
    );
    await app.close();
    app = await createApp({ dataDir, integrations: false });
    try {
      assert.equal(
        (await app.getDecorator<AppContext>('context').store.list('workspaces')).length,
        1,
      );
    } finally {
      await app.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('ambiguous legacy installations require explicit selection and never merge private data', async () => {
  const { migrateInstallation, installation } = await import('../server/installation.ts');
  const db = await openDatabase({ dataDir: ':memory:' });
  const s = makeStore(db);
  const previous = process.env.INSTALLATION_ID;
  delete process.env.INSTALLATION_ID;
  try {
    for (const id of ['one', 'two']) {
      await s.put('workspaces', {
        id,
        name: id,
        kind: 'shared',
        ownerId: id,
        createdAt: new Date().toISOString(),
      });
      await s.put('projects', {
        id,
        workspaceId: id,
        name: id,
        visibility: 'private',
        ownerId: id,
      });
    }
    await assert.rejects(migrateInstallation(db), /INSTALLATION_ID/);
    assert.equal(await installation(s), null);
    process.env.INSTALLATION_ID = 'two';
    await migrateInstallation(db);
    assert.equal((await installation(s))?.workspaceId, 'two');
    process.env.INSTALLATION_ID = 'one';
    await migrateInstallation(db);
    assert.equal((await installation(s))?.workspaceId, 'two');
    assert.equal((await s.list('projects')).length, 2);
    assert.equal((await s.get<any>('projects', 'one')).visibility, 'private');
  } finally {
    await db.close();
    if (previous === undefined) delete process.env.INSTALLATION_ID;
    else process.env.INSTALLATION_ID = previous;
  }
});

test('first-run initialization has one winner and no default or duplicate administrators', async () => {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    assert.equal((await app.inject({ url: '/api/v1/auth/status' })).json().needsSetup, true);
    const result = await Promise.all(
      ['one', 'two'].map((name) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/setup',
          payload: {
            name,
            email: `${name}@example.test`,
            password: 'test-password-123',
            installationName: name,
          },
        }),
      ),
    );
    assert.deepEqual(result.map((r) => r.statusCode).sort(), [201, 409]);
    const store = app.getDecorator<AppContext>('context').store;
    assert.equal((await store.list('users')).length, 1);
    assert.equal((await store.list('workspaces')).length, 1);
    assert.equal((await app.inject({ url: '/api/v1/auth/status' })).json().needsSetup, false);
  } finally {
    await app.close();
  }
});

test('empty Compose installation selectors preserve the existing installation boundary', async () => {
  const { migrateInstallation, installation } = await import('../server/installation.ts');
  const db = await openDatabase({ dataDir: ':memory:' });
  const s = makeStore(db);
  const saved = [process.env.INSTALLATION_ID, process.env.PROXY_AUTH_INSTALLATION_ID];
  process.env.INSTALLATION_ID = '';
  process.env.PROXY_AUTH_INSTALLATION_ID = '';
  try {
    await s.put('workspaces', {
      id: 'existing',
      name: 'Existing team',
      kind: 'shared',
      ownerId: 'owner',
    });
    await migrateInstallation(db);
    assert.equal((await installation(s))?.workspaceId, 'existing');
  } finally {
    await db.close();
    for (const [i, name] of ['INSTALLATION_ID', 'PROXY_AUTH_INSTALLATION_ID'].entries()) {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    }
  }
});
