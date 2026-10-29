import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.ts';
import { makeStore } from '../server/db.ts';
import type { AppContext } from '../server/context.ts';
import {
  remoteKey,
  repositoryIdentity,
  type RepositoryAttachment,
} from '../server/repository-attachments.ts';
import {
  OutboundFailure,
  type OutboundContext,
  type RepositorySync,
} from '../server/repository-sync.ts';
import { claimOutbox, outboxOperation, remoteChanged } from '../server/sync-journal.ts';
import type { Activity, WorkItem } from '../shared/types.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import { giteaServer } from './git-fixture.ts';

const secret = 'sync-journal-test-secret-at-least-32-chars';
type Gitea = Awaited<ReturnType<typeof giteaServer>>;

/** One installation, restartable on the same data directory. */
async function installation(gitea: Gitea) {
  const dataDir = await mkdtemp(join(tmpdir(), 'trestl-journal-'));
  let app: FastifyInstance = await createApp({ dataDir });
  const admin = cookieOf(
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { name: 'Admin', email: 'admin@example.test', password: 'local-test-password' },
    }),
  );
  const owner = cookieOf(
    await memberSession(app, admin, {
      name: 'Owner',
      email: 'owner@example.test',
      password: 'local-test-password',
    }),
  );
  const request = (method: string, path: string, payload?: unknown, cookie = owner) =>
    app.inject({
      method: method as 'GET',
      url: `/api/v1${path}`,
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });
  const call = async (method: string, path: string, payload?: unknown, cookie = owner) => {
    const response = await request(method, path, payload, cookie);
    assert.ok(response.statusCode < 300, `${method} ${path}: ${response.body}`);
    return response.statusCode === 204 ? null : response.json();
  };
  const connection = await call(
    'POST',
    '/git/connections',
    {
      shared: true,
      provider: 'gitea',
      name: 'Team Gitea',
      baseUrl: gitea.origin,
      token: 'service-account-token',
    },
    admin,
  );
  const project = await call('POST', '/projects', { key: 'PLAT', name: 'Platform' });
  const repositories = `/projects/${project.id}/repositories`;
  return {
    get app() {
      return app;
    },
    ctx: () => app.getDecorator<AppContext>('context'),
    journal: () => app.getDecorator<RepositorySync>('repositorySync'),
    call,
    request,
    project,
    repositories,
    connectionId: connection.id as string,
    async attach(repository = 'team/platform') {
      return call('POST', repositories, {
        connectionId: connection.id,
        repository,
        mode: 'inbound',
      });
    },
    async twoWay(id: string, publish = { comments: true, status: true, assignee: false }) {
      const preview = await call('POST', `${repositories}/${id}/two-way/preview`, { publish });
      return call('POST', `${repositories}/${id}/two-way`, {
        publish,
        confirmation: preview.confirmation,
      });
    },
    async restart() {
      await app.close();
      app = await createApp({ dataDir });
    },
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A provider that records created comments; responses can be lost on purpose. */
function remoteComments(gitea: Gitea, repositoryId = '501') {
  const created: string[] = [];
  let nextId = 9000;
  let loseResponse = false;
  const post = (body: string) => {
    const id = nextId++;
    (gitea.comments[repositoryId] ??= []).push({ id, body, user: { login: 'trestl-bot' } });
    created.push(body);
    return String(id);
  };
  return {
    created,
    post,
    loseNextResponse() {
      loseResponse = true;
    },
    handler: {
      async perform(context: OutboundContext) {
        const id = post(`${context.activity!.body}\n\n${context.marker}`);
        if (loseResponse) {
          loseResponse = false;
          throw new OutboundFailure('The provider did not answer in time.', 'unknown');
        }
        return { remoteId: id };
      },
      async reconcile(context: OutboundContext) {
        const found = (gitea.comments[repositoryId] ?? []).find((comment) =>
          comment.body.includes(context.marker),
        );
        return found ? { remoteId: String(found.id) } : null;
      },
    },
  };
}

async function reply(
  ctx: AppContext,
  journal: RepositorySync,
  input: { attachmentId: string; itemId: string; actorId: string; body: string },
) {
  return ctx.db.transaction(async (db) => {
    const activity: Activity = {
      id: randomUUID(),
      itemId: input.itemId,
      userId: input.actorId,
      kind: 'comment',
      body: input.body,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    };
    await makeStore(db).put('activity', activity);
    const operationId = await journal.enqueueOutbound(db, {
      attachmentId: input.attachmentId,
      itemId: input.itemId,
      kind: 'comment.create',
      actorId: input.actorId,
      activityId: activity.id,
    });
    return { activity, operationId };
  });
}

const withSecret = async (run: () => Promise<void>) => {
  const previous = process.env.APP_SECRET;
  process.env.APP_SECRET = secret;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previous;
  }
};

test('pending outbound work survives restarts, and uncertain creates reconcile instead of re-posting', () =>
  withSecret(async () => {
    const gitea = await giteaServer();
    const site = await installation(gitea);
    try {
      const mirror = await site.attach();
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      await site.twoWay(mirror.id);
      const remote = remoteComments(gitea);
      site.journal().registerHandler('comment.create', remote.handler);
      const ctx = site.ctx();
      const [item] = await ctx.store.list<WorkItem>('items');
      const ownerId = (await ctx.store.list<{ id: string; email: string }>('users')).find(
        (user) => user.email === 'owner@example.test',
      )!.id;
      const first = await reply(ctx, site.journal(), {
        attachmentId: mirror.id,
        itemId: item!.id,
        actorId: ownerId,
        body: 'Shipped in v2.',
      });
      assert.equal((await outboxOperation(ctx.db, first.operationId))?.status, 'pending');
      const listed = await site.call('GET', site.repositories);
      assert.equal(listed.data[0].pending.outbound, 1, 'Pending work is visible as health');

      // The process stops after the local commit, before any provider call.
      await site.restart();
      site.journal().registerHandler('comment.create', remote.handler);
      await site.journal().dispatchOutbox();
      assert.equal(remote.created.length, 1);
      assert.match(remote.created[0]!, new RegExp(`<!-- trestl:${first.operationId} -->`));
      const done = await outboxOperation(site.ctx().db, first.operationId);
      assert.equal(done?.status, 'done');
      assert.equal(done?.remoteId, '9000');

      // The provider applies a create but the answer is lost: reconcile by marker.
      const second = await reply(site.ctx(), site.journal(), {
        attachmentId: mirror.id,
        itemId: item!.id,
        actorId: ownerId,
        body: 'Follow-up details.',
      });
      remote.loseNextResponse();
      await site.journal().dispatchOutbox();
      assert.equal((await outboxOperation(site.ctx().db, second.operationId))?.status, 'done');
      assert.equal(remote.created.length, 2, 'The uncertain create was found, not posted again');

      // The process dies after the provider call, before recording it.
      const third = await reply(site.ctx(), site.journal(), {
        attachmentId: mirror.id,
        itemId: item!.id,
        actorId: ownerId,
        body: 'Deployed.',
      });
      await site
        .ctx()
        .db.query(`UPDATE sync_outbox SET status='in_flight' WHERE id=$1`, [third.operationId]);
      remote.post(`Deployed.\n\n<!-- trestl:${third.operationId} -->`);
      await site.restart();
      assert.equal(
        (await outboxOperation(site.ctx().db, third.operationId))?.status,
        'uncertain',
        'Interrupted operations are uncertain after a restart',
      );
      site.journal().registerHandler('comment.create', remote.handler);
      await site.journal().dispatchOutbox();
      assert.equal((await outboxOperation(site.ctx().db, third.operationId))?.status, 'done');
      assert.equal(remote.created.length, 3);

      // An uncertain create that never reached the provider is retried exactly once.
      const fourth = await reply(site.ctx(), site.journal(), {
        attachmentId: mirror.id,
        itemId: item!.id,
        actorId: ownerId,
        body: 'Closing soon.',
      });
      await site
        .ctx()
        .db.query(`UPDATE sync_outbox SET status='uncertain' WHERE id=$1`, [fourth.operationId]);
      await site.journal().dispatchOutbox();
      await site.journal().dispatchOutbox();
      assert.equal((await outboxOperation(site.ctx().db, fourth.operationId))?.status, 'done');
      assert.equal(remote.created.length, 4);

      // Inbound sync sees our own replies: they stay linked to the local comments.
      const before = (await site.ctx().store.list<Activity>('activity')).length;
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      const activity = await site.ctx().store.list<Activity>('activity');
      assert.equal(activity.length, before, 'Echoes are never imported as new comments');
      assert.equal(
        activity.find((row) => row.id === first.activity.id)?.body,
        'Shipped in v2.',
        'The local reply is not overwritten by its marked echo',
      );
      assert.equal((await site.call('GET', site.repositories)).data[0].pending.outbound, 0);
    } finally {
      await site.close();
      await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    }
  }));

test('echo suppression uses the operation marker, while other bot comments still import', () =>
  withSecret(async () => {
    const gitea = await giteaServer();
    const site = await installation(gitea);
    try {
      const mirror = await site.attach();
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      await site.twoWay(mirror.id);
      const remote = remoteComments(gitea);
      site.journal().registerHandler('comment.create', remote.handler);
      const ctx = site.ctx();
      const [item] = await ctx.store.list<WorkItem>('items');
      const ownerId = (await ctx.store.list<{ id: string; email: string }>('users')).find(
        (user) => user.email === 'owner@example.test',
      )!.id;
      const sent = await reply(ctx, site.journal(), {
        attachmentId: mirror.id,
        itemId: item!.id,
        actorId: ownerId,
        body: 'Reply from Trestl.',
      });
      // The create landed, but the operation is still uncertain when the webhook-driven sync runs.
      remote.post(`Reply from Trestl.\n\n<!-- trestl:${sent.operationId} -->`);
      await ctx.db.query(`UPDATE sync_outbox SET status='uncertain' WHERE id=$1`, [
        sent.operationId,
      ]);
      gitea.comments['501']!.push(
        { id: 7001, body: 'Automated build passed.', user: { login: 'trestl-bot' } },
        {
          id: 7002,
          body: `Quoted elsewhere <!-- trestl:${randomUUID()} -->`,
          user: { login: 'someone' },
        },
      );
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      const comments = (await ctx.store.list<Activity>('activity')).filter(
        (row) => row.kind === 'comment',
      );
      assert.equal(comments.length, 3, 'Bot comments import; only the marked echo is linked');
      assert.equal(comments.filter((row) => row.body.includes('Reply from Trestl.')).length, 1);
      assert.ok(comments.some((row) => row.body === 'Automated build passed.' && row.source));
      assert.ok(comments.some((row) => row.body.startsWith('Quoted elsewhere') && row.source));
      const operation = await outboxOperation(ctx.db, sent.operationId);
      assert.equal(operation?.status, 'done', 'The inbound echo settles the uncertain operation');
      await site.journal().dispatchOutbox();
      assert.equal(remote.created.length, 1, 'Nothing is posted again');

      // The remote reply is deleted: the mapping goes, the local reply stays.
      gitea.comments['501'] = gitea.comments['501']!.filter((row) => row.id === 7001);
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      assert.ok(await ctx.store.get('activity', sent.activity.id), 'Local replies are kept');
    } finally {
      await site.close();
      await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    }
  }));

test('duplicate deliveries and retries do not duplicate items or comments', () =>
  withSecret(async () => {
    const gitea = await giteaServer();
    const site = await installation(gitea);
    try {
      const mirror = await site.attach();
      const journal = site.journal();
      const ctx = site.ctx();
      gitea.comments['501'] = [{ id: 31, body: 'First!', user: { login: 'engineer' } }];
      const delivery = {
        attachmentId: mirror.id,
        deliveryId: 'delivery-1',
        event: 'issues',
        issueNumber: 1,
      };
      assert.deepEqual(await journal.enqueueInbox(delivery), { accepted: true });
      assert.deepEqual(await journal.enqueueInbox(delivery), { accepted: false });
      assert.equal((await site.call('GET', site.repositories)).data[0].pending.inbound, 1);
      const before = gitea.requests.length;
      await journal.processInbox();
      assert.ok(
        gitea.requests.slice(before).includes('/api/v1/repos/team/platform/issues/1'),
        'A hint re-reads only the named issue',
      );
      assert.equal((await ctx.store.list<WorkItem>('items')).length, 1);
      await journal.enqueueInbox({ ...delivery, deliveryId: 'delivery-2', event: 'issue_comment' });
      await journal.enqueueInbox({ ...delivery, deliveryId: 'delivery-3', issueNumber: null });
      await journal.processInbox();
      assert.equal((await ctx.store.list<WorkItem>('items')).length, 1);
      const comments = () =>
        ctx.store
          .list<Activity>('activity')
          .then((rows) => rows.filter((row) => row.kind === 'comment'));
      assert.equal((await comments()).length, 1);

      // A provider failure leaves the event queued with backoff, then it is retried.
      gitea.failures.remaining = 1;
      gitea.comments['501']!.push({ id: 32, body: 'Second', user: { login: 'engineer' } });
      await journal.enqueueInbox({ ...delivery, deliveryId: 'delivery-4' });
      await journal.processInbox();
      const [queued] = (
        await ctx.db.query<{ attempts: number; last_error: string | null }>(
          `SELECT attempts, last_error FROM sync_inbox WHERE delivery_id='delivery-4'`,
        )
      ).rows;
      assert.equal(queued?.attempts, 1);
      assert.match(queued?.last_error ?? '', /503/);
      assert.ok(!queued?.last_error?.includes('service-account-token'));
      await journal.processInbox();
      assert.equal(
        (await comments()).length,
        1,
        'Backoff delays the retry instead of hammering the provider',
      );
      await ctx.db.query(
        `UPDATE sync_inbox SET next_attempt_at=NOW() WHERE delivery_id='delivery-4'`,
      );
      await journal.processInbox();
      await journal.processInbox();
      assert.equal((await comments()).length, 2);
      assert.equal((await ctx.store.list<WorkItem>('items')).length, 1);
      assert.equal((await site.call('GET', site.repositories)).data[0].pending.inbound, 0);

      // Events for a detached repository are settled without importing anything.
      await site.call('DELETE', `${site.repositories}/${mirror.id}`);
      await journal.enqueueInbox({ ...delivery, deliveryId: 'delivery-5' });
      await journal.processInbox();
      const [settled] = (
        await ctx.db.query<{ processed: boolean }>(
          `SELECT processed_at IS NOT NULL AS processed FROM sync_inbox WHERE delivery_id='delivery-5'`,
        )
      ).rows;
      assert.equal(settled?.processed, true);
    } finally {
      await site.close();
      await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    }
  }));

test('a repository rename updates paths without a second identity, and legacy mappings are re-keyed', () =>
  withSecret(async () => {
    const gitea = await giteaServer();
    const site = await installation(gitea);
    try {
      const mirror = await site.attach();
      const ctx = site.ctx();
      // An issue imported by an older version, keyed by repository path.
      const legacyItem = (await site.call('POST', '/items', {
        title: 'Imported earlier',
        projectId: site.project.id,
      })) as WorkItem;
      await ctx.store.put('importedIssues', {
        id: repositoryIdentity(mirror, '5010'),
        integrationId: mirror.id,
        itemId: legacyItem.id,
        remoteId: '5010',
        sourceState: 'open',
      });
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      let items = await ctx.store.list<WorkItem>('items');
      assert.equal(items.length, 1, 'The legacy mapping is reused, not duplicated');
      assert.equal(items[0]?.source?.repository, 'team/platform');
      assert.equal(await ctx.store.get('importedIssues', repositoryIdentity(mirror, '5010')), null);
      assert.ok(
        await ctx.store.get('importedIssues', remoteKey('default', mirror, 'issue', '5010')),
      );
      assert.equal(
        (await ctx.store.get<RepositoryAttachment>('integrations', mirror.id))?.remoteId,
        '501',
      );

      gitea.rename('team/platform', 'platform-team/platform-next');
      const synced = await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      assert.equal(synced.imported, 0);
      items = await ctx.store.list<WorkItem>('items');
      assert.equal(items.length, 1, 'A rename never creates a second identity');
      assert.equal(items[0]?.source?.repository, 'platform-team/platform-next');
      assert.equal(items[0]?.source?.url, `${gitea.origin}/platform-team/platform-next/issues/1`);
      assert.equal(items[0]?.externalUrl, `${gitea.origin}/platform-team/platform-next/issues/1`);
      const [listed] = (await site.call('GET', site.repositories)).data;
      assert.equal(listed.repository, 'platform-team/platform-next');
      assert.equal(listed.webUrl, `${gitea.origin}/platform-team/platform-next`);

      // The new path is still one repository for the mirror-uniqueness rule.
      const other = await site.call('POST', '/projects', { key: 'OPS', name: 'Operations' });
      const duplicate = await site.request('POST', `/projects/${other.id}/repositories`, {
        connectionId: site.connectionId,
        repository: 'platform-team/platform-next',
        mode: 'inbound',
      });
      assert.equal(duplicate.statusCode, 409, duplicate.body);
    } finally {
      await site.close();
      await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    }
  }));

test('the field journal records last-common values, recognizes field echoes, and serializes each item', () =>
  withSecret(async () => {
    const gitea = await giteaServer();
    const site = await installation(gitea);
    try {
      const mirror = await site.attach();
      await site.call('POST', `${site.repositories}/${mirror.id}/sync`);
      await site.twoWay(mirror.id);
      const ctx = site.ctx();
      const [item] = await ctx.store.list<WorkItem>('items');
      assert.equal(await remoteChanged(ctx.db, item!.id, 'state', 'open'), false);
      assert.equal(await remoteChanged(ctx.db, item!.id, 'state', 'closed'), true);
      assert.equal(
        await remoteChanged(ctx.db, item!.id, 'title', 'First issue in team/platform'),
        false,
      );

      const performed: string[] = [];
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      site.journal().registerHandler('issue.state', {
        async perform(context) {
          performed.push(String(context.operation.payload.value));
          if (performed.length === 1) await blocked;
          return { remoteId: null };
        },
        async reconcile() {
          return null;
        },
      });
      const ownerId = (await ctx.store.list<{ id: string; email: string }>('users')).find(
        (user) => user.email === 'owner@example.test',
      )!.id;
      const enqueue = (value: string) =>
        ctx.db.transaction((db) =>
          site.journal().enqueueOutbound(db, {
            attachmentId: mirror.id,
            itemId: item!.id,
            kind: 'issue.state',
            actorId: ownerId,
            payload: { value },
          }),
        );
      const close = await enqueue('closed');
      const reopen = await enqueue('open');
      const running = site.journal().dispatchOutbox();
      while (!performed.length) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        await claimOutbox(ctx.db, new Date().toISOString()),
        null,
        'A second operation for the same item waits for the first',
      );
      release();
      await running;
      assert.deepEqual(performed, ['closed', 'open'], 'Operations for an item stay in order');
      assert.equal((await outboxOperation(ctx.db, close))?.status, 'done');
      assert.equal((await outboxOperation(ctx.db, reopen))?.status, 'done');
      assert.equal(
        await remoteChanged(ctx.db, item!.id, 'state', 'open'),
        false,
        'The published value is the last common one, so its echo is not a change',
      );

      // Withdrawn consent rejects queued work at send time.
      const queued = await enqueue('closed');
      await site.call('PATCH', `${site.repositories}/${mirror.id}`, { mode: 'inbound' });
      await site.journal().dispatchOutbox();
      assert.equal((await outboxOperation(ctx.db, queued))?.status, 'rejected');
      assert.equal(performed.length, 2);
    } finally {
      await site.close();
      await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    }
  }));
