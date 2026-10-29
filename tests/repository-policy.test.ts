import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { makeStore, openDatabase } from '../server/db.ts';
import type { AppContext } from '../server/context.ts';
import {
  migrateRepositoryAttachments,
  type RepositoryAttachment,
} from '../server/repository-attachments.ts';
import { authorizeOutbound, OutboundRejected } from '../server/repository-policy.ts';
import type { Activity, Project, WorkItem } from '../shared/types.ts';
import { readFile } from 'node:fs/promises';
import { fieldOwnership } from '../shared/repository-sync.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import { giteaServer } from './git-fixture.ts';

const rejected = (code: OutboundRejected['code']) => (error: unknown) =>
  error instanceof OutboundRejected && error.code === code;

test('the documented field-ownership table matches the enforced one', async () => {
  const docs = await readFile(new URL('../docs/repositories.md', import.meta.url), 'utf8');
  const rows = docs
    .split('\n')
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells.length === 4);
  for (const row of fieldOwnership)
    assert.ok(
      rows.some((cells) =>
        [row.field, row.reference, row.inbound, row.two_way].every((text, i) => cells[i] === text),
      ),
      `docs/repositories.md documents ${row.field}`,
    );
});

test('upgrades keep existing repository imports inbound-only and unpublishable', async () => {
  const db = await openDatabase({ dataDir: ':memory:' });
  const store = makeStore(db);
  const ctx = {
    db,
    store,
    id: randomUUID,
    now: () => new Date().toISOString(),
    canProject: async () => true,
    canItem: async () => true,
  } as unknown as AppContext;
  try {
    await store.put('system', { id: 'mutation-lock' });
    await store.put('integrations', {
      id: 'legacy',
      provider: 'gitea',
      name: 'Legacy import',
      baseUrl: 'https://git.example.test',
      repository: 'team/platform',
      projectId: 'platform',
      creatorId: 'admin',
      connectionId: 'connection',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSyncedAt: null,
      lastError: null,
    });
    await migrateRepositoryAttachments(ctx);
    const migrated = await store.get<RepositoryAttachment>('integrations', 'legacy');
    assert.equal(migrated?.mode, 'inbound');
    assert.equal(migrated?.publish, undefined);
    assert.equal(migrated?.twoWay, undefined);
    await assert.rejects(
      authorizeOutbound(ctx, store, {
        attachmentId: 'legacy',
        itemId: 'item',
        kind: 'comment.create',
        actorId: 'admin',
      }),
      rejected('mode'),
    );
  } finally {
    await db.close();
  }
});

test('two-way needs a confirmed preview, and outbound checks mode, opt-in, capability and the actor', async () => {
  const previousSecret = process.env.APP_SECRET;
  process.env.APP_SECRET = 'repository-policy-test-secret-32-characters';
  const gitea = await giteaServer();
  const app = await createApp({ dataDir: ':memory:' });
  try {
    const admin = cookieOf(
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { name: 'Admin', email: 'admin@example.test', password: 'local-test-password' },
      }),
    );
    const session = async (name: string) =>
      cookieOf(
        await memberSession(app, admin, {
          name,
          email: `${name.toLowerCase()}@example.test`,
          password: 'local-test-password',
        }),
      );
    const owner = await session('Owner');
    const teammate = await session('Teammate');
    const call = (cookie: string, method: string, path: string, payload?: unknown, token = '') =>
      app.inject({
        method: method as 'GET',
        url: `/api/v1${path}`,
        headers: token ? { authorization: `Bearer ${token}` } : { cookie },
        ...(payload ? { payload } : {}),
      });
    const connectionId = (
      await call(admin, 'POST', '/git/connections', {
        shared: true,
        provider: 'gitea',
        name: 'Team Gitea',
        baseUrl: gitea.origin,
        token: 'service-account-token',
      })
    ).json().id;
    const project = (
      await call(owner, 'POST', '/projects', { key: 'PLAT', name: 'Platform' })
    ).json();
    const base = `/projects/${project.id}/repositories`;
    const mirror = (
      await call(owner, 'POST', base, {
        connectionId,
        repository: 'team/platform',
        mode: 'inbound',
      })
    ).json();
    const readOnly = (
      await call(owner, 'POST', base, { connectionId, repository: 'team/docs', mode: 'reference' })
    ).json();
    assert.equal((await call(owner, 'POST', `${base}/${mirror.id}/sync`)).statusCode, 200);
    const ctx = app.getDecorator<AppContext>('context');
    const users = await ctx.store.list<{ id: string; email: string }>('users');
    const id = (email: string) => users.find((user) => user.email === email)!.id;
    const [item] = await ctx.store.list<WorkItem>('items');
    assert.ok(item);

    // The mode cannot be switched to two-way without the preview.
    assert.equal(
      (await call(owner, 'PATCH', `${base}/${mirror.id}`, { mode: 'two_way' })).statusCode,
      400,
    );
    const publish = { comments: true, status: false, assignee: false };
    assert.equal(
      (
        await call(owner, 'POST', `${base}/${mirror.id}/two-way/preview`, {
          publish: { comments: false, status: false, assignee: false },
        })
      ).statusCode,
      400,
      'Two-way needs at least one published field',
    );
    assert.equal(
      (await call(teammate, 'POST', `${base}/${mirror.id}/two-way/preview`, { publish }))
        .statusCode,
      403,
    );
    const docsPreview = await call(owner, 'POST', `${base}/${readOnly.id}/two-way/preview`, {
      publish,
    });
    assert.equal(docsPreview.statusCode, 400);
    assert.match(docsPreview.json().message, /read-only access to team\/docs/);
    const preview = await call(owner, 'POST', `${base}/${mirror.id}/two-way/preview`, { publish });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().destination.repository, 'team/platform');
    assert.equal(preview.json().destination.private, true);
    assert.match(preview.json().audience, /Everyone with access to team\/platform/);
    assert.match(preview.json().publisher, /shared “Team Gitea” connection/);
    assert.deepEqual(
      preview
        .json()
        .fields.filter((row: { published: boolean }) => row.published)
        .map((row: { field: string }) => row.field),
      ['Replies'],
    );
    assert.ok(preview.json().neverPublished.includes('Private items'));
    assert.ok(!preview.body.includes('service-account-token'));
    assert.equal(
      (await call(owner, 'POST', `${base}/${mirror.id}/two-way`, { publish })).statusCode,
      400,
      'Enabling two-way requires the preview confirmation',
    );
    assert.equal(
      (
        await call(owner, 'POST', `${base}/${mirror.id}/two-way`, {
          publish: { ...publish, status: true },
          confirmation: preview.json().confirmation,
        })
      ).statusCode,
      409,
      'A confirmation only covers the preview it came from',
    );
    const token = (
      await call(admin, 'POST', '/tokens', { name: 'automation', scope: 'admin' })
    ).json().token;
    assert.equal(
      (
        await call(
          '',
          'POST',
          `${base}/${mirror.id}/two-way`,
          {
            publish,
            confirmation: preview.json().confirmation,
          },
          token,
        )
      ).statusCode,
      403,
      'API tokens cannot give two-way consent',
    );
    // Before activation, nothing may be published.
    await assert.rejects(
      authorizeOutbound(ctx, ctx.store, {
        attachmentId: mirror.id,
        itemId: item.id,
        kind: 'comment.create',
        actorId: id('owner@example.test'),
      }),
      rejected('mode'),
    );
    const before: Activity = {
      id: randomUUID(),
      itemId: item.id,
      userId: id('owner@example.test'),
      kind: 'comment',
      body: 'Internal discussion from before',
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await ctx.store.put('activity', before);
    const enabled = await call(owner, 'POST', `${base}/${mirror.id}/two-way`, {
      publish,
      confirmation: preview.json().confirmation,
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    assert.equal(enabled.json().mode, 'two_way');
    assert.deepEqual(enabled.json().publish, publish);
    assert.equal(enabled.json().twoWay.activatedBy, id('owner@example.test'));
    assert.equal((await call(owner, 'POST', `${base}/${mirror.id}/sync`)).statusCode, 200);

    const reply = async (author: string) => {
      const activity: Activity = {
        id: randomUUID(),
        itemId: item.id,
        userId: id(author),
        kind: 'comment',
        body: 'Reply for the repository',
        createdAt: new Date(Date.now() + 1000).toISOString(),
      };
      await ctx.store.put('activity', activity);
      return activity.id;
    };
    const outbound = (actor: string, extra: Record<string, unknown> = {}) =>
      authorizeOutbound(ctx, ctx.store, {
        attachmentId: mirror.id,
        itemId: item.id,
        kind: 'comment.create',
        actorId: id(actor),
        ...extra,
      });
    const ownReply = await reply('owner@example.test');
    const allowed = await outbound('owner@example.test', { activityId: ownReply });
    assert.equal(allowed.attachment.id, mirror.id);
    await assert.rejects(
      outbound('owner@example.test', { activityId: before.id }),
      rejected('content'),
      'Notes from before activation are never published',
    );
    await assert.rejects(
      outbound('owner@example.test', { activityId: ownReply, tokenScope: 'read' }),
      rejected('permission'),
    );
    await assert.rejects(
      outbound('owner@example.test', { kind: 'issue.state' }),
      rejected('not_opted_in'),
    );
    // Shared credentials: being able to see a workspace project is not permission to publish.
    const teammateReply = await reply('teammate@example.test');
    await assert.rejects(
      outbound('teammate@example.test', { activityId: teammateReply }),
      rejected('permission'),
    );
    await assert.rejects(
      outbound('teammate@example.test', { activityId: ownReply }),
      rejected('permission'),
    );
    await ctx.store.put('projects', {
      ...(await ctx.store.get<Project>('projects', project.id))!,
      memberIds: [id('teammate@example.test')],
    });
    await outbound('teammate@example.test', { activityId: teammateReply });
    await assert.rejects(
      outbound('teammate@example.test', { activityId: ownReply }),
      rejected('content'),
      'Nobody publishes someone else’s comment',
    );
    // A personal credential publishes only for its owner.
    const stored = (await ctx.store.get<RepositoryAttachment>('integrations', mirror.id))!;
    const connection = (await ctx.store.get<{ id: string; shared?: boolean; userId: string }>(
      'gitConnections',
      connectionId,
    ))!;
    await ctx.store.put('gitConnections', {
      ...connection,
      shared: false,
      userId: id('owner@example.test'),
    });
    await assert.rejects(
      outbound('teammate@example.test', { activityId: teammateReply }),
      rejected('permission'),
    );
    await outbound('owner@example.test', { activityId: ownReply });
    await ctx.store.put('gitConnections', connection);
    // Capability is checked on every outbound attempt.
    await ctx.store.put('integrations', {
      ...stored,
      access: { ...stored.access!, write: false, reason: 'Read-only token.' },
    });
    await assert.rejects(
      outbound('owner@example.test', { activityId: ownReply }),
      rejected('capability'),
    );
    await ctx.store.put('integrations', stored);
    await ctx.store.put('items', {
      ...item,
      visibility: 'private',
      creatorId: id('owner@example.test'),
    });
    await assert.rejects(
      outbound('owner@example.test', { activityId: ownReply }),
      rejected('content'),
      'Private items are never published',
    );
    await ctx.store.put('items', {
      ...(await ctx.store.get<WorkItem>('items', item.id))!,
      visibility: 'workspace',
    });

    // Leaving two-way withdraws consent.
    const disabled = await call(owner, 'PATCH', `${base}/${mirror.id}`, { mode: 'inbound' });
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().twoWay, null);
    assert.equal(
      (await ctx.store.get<RepositoryAttachment>('integrations', mirror.id))?.publish,
      undefined,
    );
    await assert.rejects(
      outbound('owner@example.test', { activityId: ownReply }),
      rejected('mode'),
    );
    assert.ok(
      gitea.requests.every((path) => path.startsWith('/api/v1/')),
      'Every provider call was a GET (asserted by the fixture)',
    );
  } finally {
    await app.close();
    await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  }
});
