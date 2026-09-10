import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, makeStore } from '../server/db.ts';
import { nextItemIdentifier } from '../server/item-identifiers.ts';

test('project and workspace counters are atomic, persistent, and support more than two digits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-numbering-'));
  let db = await openDatabase({ dataDir: directory });
  try {
    await makeStore(db).put('projects', { id: 'a', key: 'ALPHA' });
    await makeStore(db).put('projects', { id: 'b', key: 'BETA' });
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-01');
    assert.equal(await nextItemIdentifier(db, 'b', 'default'), 'BETA-01');
    assert.equal(await nextItemIdentifier(db, null, 'default'), 'INBOX-01');
    assert.equal(await nextItemIdentifier(db, null, 'other'), 'INBOX-01');
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => nextItemIdentifier(db, 'a', 'default')),
    );
    assert.equal(new Set(ids).size, 20);
    assert.ok(ids.includes('ALPHA-21'));
    await assert.rejects(
      db.transaction(async (tx) => {
        await nextItemIdentifier(tx, 'a', 'default');
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-22');
    await db.query("UPDATE item_counters SET last_number=98 WHERE project_id='a'");
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-99');
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-100');
    await db.query("UPDATE item_counters SET last_number=999 WHERE project_id='a'");
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-1000');
    await db.close();
    db = await openDatabase({ dataDir: directory });
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-1001');
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy items renumber once per project and workspace, preserving references and retry results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trestl-migration-'));
  let db = await openDatabase({ dataDir: directory });
  try {
    const store = makeStore(db);
    await store.put('projects', { id: 'a', key: 'ALPHA' });
    await store.put('projects', { id: 'b', key: 'BETA' });
    const entries = [
      {
        id: 'a2',
        identifier: 'ALPHA-120',
        projectId: 'a',
        parentId: 'a1',
        source: { number: 987 },
      },
      { id: 'a1', identifier: 'ALPHA-9', projectId: 'a' },
      { id: 'b1', identifier: 'BETA-55', projectId: 'b' },
      { id: 'i1', identifier: 'INBOX-99', projectId: null },
      { id: 'i2', identifier: 'INBOX-190', projectId: null, workspaceId: 'other' },
    ];
    for (const item of entries) await store.put('items', item);
    await store.put('idempotency', { id: 'retry', itemId: 'a2', result: entries[0] });
    await store.put('activity', { id: 'note', itemId: 'a2', body: 'Keep this note' });
    await store.remove('system', 'project-item-numbering-v1');
    await db.close();
    db = await openDatabase({ dataDir: directory });
    const migrated = await makeStore(db).list<any>('items');
    assert.deepEqual(Object.fromEntries(migrated.map((i) => [i.id, i.identifier])), {
      a1: 'ALPHA-01',
      a2: 'ALPHA-02',
      b1: 'BETA-01',
      i1: 'INBOX-01',
      i2: 'INBOX-01',
    });
    const child = migrated.find((i) => i.id === 'a2');
    assert.equal(child.parentId, 'a1');
    assert.equal(child.source.number, 987);
    assert.equal(child.revision, 2);
    assert.equal(
      (await makeStore(db).get<any>('idempotency', 'retry')).result.identifier,
      'ALPHA-02',
    );
    assert.equal((await makeStore(db).get<any>('activity', 'note')).itemId, 'a2');
    assert.equal((await db.query('SELECT * FROM item_identifier_changes')).rows.length, 5);
    await makeStore(db).remove('items', 'a2');
    await db.close();
    db = await openDatabase({ dataDir: directory });
    assert.equal(await nextItemIdentifier(db, 'a', 'default'), 'ALPHA-03');
    assert.equal(await nextItemIdentifier(db, 'b', 'default'), 'BETA-02');
    assert.equal(await nextItemIdentifier(db, null, 'other'), 'INBOX-02');
    assert.equal((await makeStore(db).get<any>('items', 'a1')).revision, 2);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
