import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type { WorkItem } from '../shared/types.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';

async function fixture() {
  const app = await createApp({ dataDir: ':memory:', integrations: false });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      name: 'Lead',
      email: 'lead@batch.test',
      password: 'test-batch-password',
      seedDemo: false,
    },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  const cookie = cookieOf(setup);
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: unknown,
    session = cookie,
    etag?: string,
  ) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie: session, ...(etag ? { 'if-none-match': etag } : {}) },
      ...(payload ? { payload } : {}),
    });
  const item = async (title: string, extra = {}) => {
    const response = await call('POST', '/items', { title, ...extra });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<WorkItem>();
  };
  return { app, call, item, cookie, user: setup.json() };
}

test('atomic board writes reject stale or invalid batches without partial writes or cache invalidation', async () => {
  const { app, call, item } = await fixture();
  try {
    const first = await item('First'),
      second = await item('Second');
    const before = await call('GET', '/bootstrap');
    const etag = String(before.headers.etag);
    const invalid = await call('POST', '/items/batch', {
      updates: [
        { id: first.id, expectedRevision: first.revision, status: 'in_progress', position: 10 },
        { id: second.id, expectedRevision: second.revision, parentId: second.id },
      ],
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal((await call('GET', `/items/${first.id}`)).json().item.status, 'todo');
    assert.equal((await call('GET', '/bootstrap', undefined, undefined, etag)).statusCode, 304);
    const patch = await call('PATCH', `/items/${second.id}`, {
      priority: 'high',
      expectedRevision: second.revision,
    });
    assert.equal(patch.statusCode, 200, patch.body);
    const stale = await call('POST', '/items/batch', {
      updates: [
        { id: first.id, expectedRevision: first.revision, status: 'done' },
        { id: second.id, expectedRevision: second.revision, status: 'done' },
      ],
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal((await call('GET', `/items/${first.id}`)).json().item.status, 'todo');
    const duplicate = await call('POST', '/items/batch', {
      updates: [
        { id: first.id, expectedRevision: first.revision, position: 1 },
        { id: first.id, expectedRevision: first.revision, position: 2 },
      ],
    });
    assert.equal(duplicate.statusCode, 400, duplicate.body);
    const nextRevision = patch.json().item.revision;
    const success = await call('POST', '/items/batch', {
      updates: [
        { id: first.id, expectedRevision: first.revision, status: 'in_progress', position: 1 },
        { id: second.id, expectedRevision: nextRevision, parentId: first.id, position: 2 },
      ],
    });
    assert.equal(success.statusCode, 200, success.body);
    assert.equal(success.json().data.length, 2);
    assert.equal(success.json().data[0].revision, (first.revision ?? 0) + 1);
    assert.equal(success.json().data[1].parentId, first.id);
  } finally {
    await app.close();
  }
});

test('board completion preserves recurring follow-up semantics and emits activity once', async () => {
  const { app, call, item } = await fixture();
  try {
    const recurring = await item('Weekly check', { recurrence: 'weekly', dueDate: '2026-10-05' });
    const completed = await call('POST', '/items/batch', {
      updates: [
        { id: recurring.id, expectedRevision: recurring.revision, status: 'done', position: 10 },
      ],
    });
    assert.equal(completed.statusCode, 200, completed.body);
    const data = (await call('GET', '/bootstrap')).json();
    assert.equal(data.items.length, 2);
    assert.equal(data.items.find((i: WorkItem) => i.id !== recurring.id).dueDate, '2026-10-12');
    assert.equal(data.items.find((i: WorkItem) => i.id !== recurring.id).status, 'todo');
    const replay = await call('POST', '/items/batch', {
      updates: [{ id: recurring.id, expectedRevision: recurring.revision, status: 'done' }],
    });
    assert.equal(replay.statusCode, 409, replay.body);
    assert.equal((await call('GET', '/bootstrap')).json().items.length, 2);
    const detail = (await call('GET', `/items/${recurring.id}`)).json();
    assert.equal(
      detail.activity.filter((a: { body: string }) => a.body.startsWith('Created recurring'))
        .length,
      1,
    );
  } finally {
    await app.close();
  }
});

test('bootstrap conditional reads notice direct SQL writes, preserve workspace boundaries and require current access', async () => {
  const { app, call, item, cookie } = await fixture();
  try {
    const shared = await item('Visible');
    const privateItem = await item('Only lead', { visibility: 'private' });
    const member = await memberSession(app, cookie, {
      name: 'Member',
      email: 'member@batch.test',
      password: 'test-member-password',
    });
    const memberCookie = cookieOf(member);
    const before = await call('GET', '/bootstrap', undefined, memberCookie);
    assert.equal(before.statusCode, 200, before.body);
    assert.deepEqual(
      before.json().items.map((i: WorkItem) => i.id),
      [shared.id],
    );
    const etag = String(before.headers.etag);
    const ctx = (app as unknown as { context: AppContext }).context;
    const originalQuery = ctx.db.query.bind(ctx.db);
    const conditionalQueries: string[] = [];
    ctx.db.query = async <T>(sql: string, params?: unknown[]) => {
      conditionalQueries.push(sql);
      return originalQuery<T>(sql, params);
    };
    const unchanged = await call('GET', '/bootstrap', undefined, memberCookie, etag);
    ctx.db.query = originalQuery;
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.body, '');
    assert.equal(unchanged.headers['cache-control'], 'private, no-cache');
    assert.ok(
      conditionalQueries.length <= 8,
      'Unchanged bootstrap only authenticates and reads its revision',
    );
    assert.ok(
      conditionalQueries.every((sql) => !sql.includes('ORDER BY')),
      'Unchanged reads must not hydrate collection lists',
    );
    const forbiddenBatch = await call(
      'POST',
      '/items/batch',
      {
        updates: [
          { id: shared.id, expectedRevision: shared.revision, status: 'done' },
          { id: privateItem.id, expectedRevision: privateItem.revision, status: 'done' },
        ],
      },
      memberCookie,
    );
    assert.equal(forbiddenBatch.statusCode, 404, forbiddenBatch.body);
    assert.equal((await call('GET', '/bootstrap', undefined, memberCookie, etag)).statusCode, 304);
    await ctx.db.query(
      `UPDATE entities SET data=jsonb_set(data,'{title}',to_jsonb($1::text)) WHERE collection='items' AND id=$2`,
      ['Changed through integration SQL', shared.id],
    );
    const changed = await call('GET', '/bootstrap', undefined, memberCookie, etag);
    assert.equal(changed.statusCode, 200, changed.body);
    assert.notEqual(changed.headers.etag, etag);
    assert.equal(changed.json().items[0].title, 'Changed through integration SQL');
    const foreign = {
      ...shared,
      id: randomUUID(),
      workspaceId: randomUUID(),
      title: 'Other installation',
    };
    await ctx.store.put('items', foreign);
    const scoped = await call('GET', '/bootstrap', undefined, memberCookie);
    assert.equal(scoped.json().items.length, 1);
    const revoke = await call('PATCH', `/users/${member.json().id}/access`, { disabled: true });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.equal(
      (await call('GET', '/bootstrap', undefined, memberCookie, String(scoped.headers.etag)))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('undo recurring completion cancels an untouched successor and preserves independently edited successors', async () => {
  const { app, call, item } = await fixture();
  try {
    const recurring = await item('Weekly follow-up', {
      recurrence: 'weekly',
      dueDate: '2026-10-05',
    });
    const complete = await call('PATCH', `/items/${recurring.id}`, {
      status: 'done',
      expectedRevision: recurring.revision,
    });
    assert.equal(complete.statusCode, 200, complete.body);
    const successor = (await call('GET', '/bootstrap'))
      .json()
      .items.find((i: WorkItem) => i.id !== recurring.id);
    const undo = await call('PATCH', `/items/${recurring.id}`, {
      status: 'todo',
      undoCompletion: true,
      expectedRevision: complete.json().item.revision,
    });
    assert.equal(undo.statusCode, 200, undo.body);
    assert.equal((await call('GET', `/items/${successor.id}`)).statusCode, 404);
    assert.equal((await call('GET', '/bootstrap')).json().items.length, 1);
    const redo = await call('PATCH', `/items/${recurring.id}`, {
      status: 'done',
      expectedRevision: undo.json().item.revision,
    });
    assert.equal(redo.statusCode, 200, redo.body);
    const next = (await call('GET', '/bootstrap'))
      .json()
      .items.find((i: WorkItem) => i.id !== recurring.id);
    const edited = await call('PATCH', `/items/${next.id}`, {
      title: 'Colleague planned this follow-up',
      expectedRevision: next.revision,
    });
    assert.equal(edited.statusCode, 200, edited.body);
    const undoEdited = await call('PATCH', `/items/${recurring.id}`, {
      status: 'todo',
      undoCompletion: true,
      expectedRevision: redo.json().item.revision,
    });
    assert.equal(undoEdited.statusCode, 200, undoEdited.body);
    assert.equal(
      (await call('GET', `/items/${next.id}`)).json().item.title,
      'Colleague planned this follow-up',
    );
    assert.equal((await call('GET', '/bootstrap')).json().items.length, 2);
    const afterRedo = await call('PATCH', `/items/${recurring.id}`, {
      status: 'done',
      expectedRevision: undoEdited.json().item.revision,
    });
    assert.equal(afterRedo.statusCode, 200, afterRedo.body);
    assert.equal(
      (await call('GET', '/bootstrap')).json().items.length,
      2,
      'A preserved successor must not be duplicated',
    );
  } finally {
    await app.close();
  }
});

test('undo recurring completion preserves discussed or roadmap-linked successors without an item revision change', async () => {
  const { app, call, item } = await fixture();
  try {
    for (const kind of ['comment', 'roadmap'] as const) {
      const original = await item(`Protected ${kind} follow-up`, {
        recurrence: 'weekly',
        dueDate: '2026-10-05',
      });
      const completed = await call('PATCH', `/items/${original.id}`, {
        status: 'done',
        expectedRevision: original.revision,
      });
      const next = (await call('GET', '/bootstrap'))
        .json()
        .items.find((i: WorkItem) => i.id !== original.id && i.title === original.title);
      if (kind === 'comment') {
        const comment = await call('POST', `/items/${next.id}/comments`, {
          body: 'We already planned this occurrence.',
        });
        assert.equal(comment.statusCode, 201, comment.body);
      } else {
        const project = (
          await call('POST', '/projects', { name: 'Delivery', key: 'DELIVERY' })
        ).json();
        const linked = await call('PATCH', `/projects/${project.id}/roadmap`, {
          expectedRevision: 0,
          headline: '',
          reviewNote: '',
          reviewedAt: null,
          features: [
            {
              id: randomUUID(),
              title: 'Delivery',
              summary: '',
              area: '',
              horizon: 'current',
              status: '',
              scope: '',
              rationale: '',
              targetDate: null,
              itemIds: [next.id],
            },
          ],
        });
        assert.equal(linked.statusCode, 200, linked.body);
      }
      assert.equal((await call('GET', `/items/${next.id}`)).json().item.revision, 1);
      const undo = await call('PATCH', `/items/${original.id}`, {
        status: 'todo',
        undoCompletion: true,
        expectedRevision: completed.json().item.revision,
      });
      assert.equal(undo.statusCode, 200, undo.body);
      assert.equal((await call('GET', `/items/${next.id}`)).statusCode, 200);
    }
  } finally {
    await app.close();
  }
});

test('ordinary reopening preserves a recurring successor and only explicit revision-checked Undo can cancel it', async () => {
  const { app, call, item } = await fixture();
  try {
    const original = await item('Existing weekly occurrence', {
      recurrence: 'weekly',
      dueDate: '2026-09-01',
    });
    const completed = await call('PATCH', `/items/${original.id}`, {
      status: 'done',
      expectedRevision: original.revision,
    });
    assert.equal(completed.statusCode, 200, completed.body);
    const next = (await call('GET', '/bootstrap'))
      .json()
      .items.find((i: WorkItem) => i.id !== original.id);
    const unguardedUndo = await call('PATCH', `/items/${original.id}`, {
      status: 'todo',
      undoCompletion: true,
    });
    assert.equal(unguardedUndo.statusCode, 400, unguardedUndo.body);
    const staleUndo = await call('PATCH', `/items/${original.id}`, {
      status: 'todo',
      undoCompletion: true,
      expectedRevision: original.revision,
    });
    assert.equal(staleUndo.statusCode, 409, staleUndo.body);
    const reopened = await call('PATCH', `/items/${original.id}`, {
      status: 'todo',
      expectedRevision: completed.json().item.revision,
    });
    assert.equal(reopened.statusCode, 200, reopened.body);
    assert.equal(
      (await call('GET', `/items/${next.id}`)).statusCode,
      200,
      'Reopening existing work must retain its successor',
    );
    assert.equal(
      reopened.json().item.undoCompletion,
      undefined,
      'The Undo command must not become stored item data',
    );
    const redone = await call('PATCH', `/items/${original.id}`, {
      status: 'done',
      expectedRevision: reopened.json().item.revision,
    });
    assert.equal(redone.statusCode, 200, redone.body);
    const boardReopen = await call('POST', '/items/batch', {
      updates: [{ id: original.id, expectedRevision: redone.json().item.revision, status: 'todo' }],
    });
    assert.equal(boardReopen.statusCode, 200, boardReopen.body);
    assert.equal(
      (await call('GET', `/items/${next.id}`)).statusCode,
      200,
      'Board reopening also preserves the successor',
    );
    const detail = (await call('GET', `/items/${original.id}`)).json();
    assert.ok(
      detail.activity.every((entry: { body: string }) => !entry.body.includes('undoCompletion')),
    );
  } finally {
    await app.close();
  }
});
