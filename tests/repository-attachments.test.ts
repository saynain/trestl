import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { makeStore, openDatabase } from '../server/db.ts';
import type { AppContext } from '../server/context.ts';
import {
  migrateRepositoryAttachments,
  type RepositoryAttachment,
} from '../server/repository-attachments.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import { giteaServer } from './git-fixture.ts';
import type { WorkItem } from '../shared/types.ts';

const secret = 'repository-attachment-test-secret-32-characters';

test('existing repository imports upgrade to inbound mirrors with one default per project', async () => {
  const db = await openDatabase({ dataDir: ':memory:' });
  const store = makeStore(db);
  const ctx = { db, store, id: randomUUID, now: () => new Date().toISOString() } as AppContext;
  try {
    await store.put('system', { id: 'mutation-lock' });
    const legacy = (id: string, projectId: string, createdAt: string) => ({
      id,
      provider: 'gitea',
      name: id,
      baseUrl: 'https://git.example.test',
      repository: `team/${id}`,
      projectId,
      creatorId: 'admin',
      connectionId: 'connection',
      createdAt,
      lastSyncedAt: '2026-10-01T10:00:00.000Z',
      lastError: null,
    });
    await store.put('integrations', legacy('newer', 'platform', '2026-03-01T00:00:00.000Z'));
    await store.put('integrations', legacy('older', 'platform', '2026-01-01T00:00:00.000Z'));
    await store.put('integrations', legacy('single', 'docs', '2026-02-01T00:00:00.000Z'));
    await migrateRepositoryAttachments(ctx);
    const first = await store.list<RepositoryAttachment>('integrations');
    await migrateRepositoryAttachments(ctx);
    assert.deepEqual(await store.list('integrations'), first, 'The migration is idempotent');
    const byId = new Map(first.map((row) => [row.id, row]));
    assert.deepEqual(
      first.map((row) => row.mode),
      ['inbound', 'inbound', 'inbound'],
    );
    assert.equal(byId.get('older')?.isDefault, true);
    assert.equal(byId.get('newer')?.isDefault, false);
    assert.equal(byId.get('single')?.isDefault, true);
    // Nothing else about an existing import changes, including its ID and sync history.
    const { mode: _mode, isDefault: _default, ...rest } = byId.get('newer')!;
    assert.deepEqual(rest, legacy('newer', 'platform', '2026-03-01T00:00:00.000Z'));
  } finally {
    await db.close();
  }
});

test('project owners attach several repositories without seeing credentials, and read-only access is explained', async () => {
  const previousSecret = process.env.APP_SECRET;
  process.env.APP_SECRET = secret;
  const gitea = await giteaServer();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const app = await createApp({
    dataDir: ':memory:',
    githubFetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/app/installations/123/access_tokens'))
        return Response.json(
          { token: 'installation-token', expires_at: new Date(Date.now() + 3e6).toISOString() },
          { status: 201 },
        );
      if (url === 'https://api.github.com/installation/repositories?per_page=100&page=1')
        return Response.json({
          total_count: 1,
          repositories: [{ full_name: 'example/app', private: true }],
        });
      if (url === 'https://api.github.com/repos/example/app')
        return Response.json({
          id: 9,
          full_name: 'example/app',
          private: true,
          permissions: { admin: true, push: true, pull: true },
        });
      if (url.startsWith('https://api.github.com/repos/example/app/issues?'))
        return Response.json([]);
      throw new Error(`Unexpected GitHub request ${url}`);
    },
  });
  try {
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { name: 'Admin', email: 'admin@example.test', password: 'local-test-password' },
    });
    const admin = cookieOf(setup);
    const owner = cookieOf(
      await memberSession(app, admin, {
        name: 'Owner',
        email: 'owner@example.test',
        password: 'local-test-password',
      }),
    );
    const member = cookieOf(
      await memberSession(app, admin, {
        name: 'Member',
        email: 'member@example.test',
        password: 'local-test-password',
      }),
    );
    const call = (cookie: string, method: string, path: string, payload?: unknown) =>
      app.inject({
        method: method as 'GET',
        url: `/api/v1${path}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    const gitea_ = await call(admin, 'POST', '/git/connections', {
      shared: true,
      provider: 'gitea',
      name: 'Team Gitea',
      baseUrl: gitea.origin,
      token: 'service-account-token',
    });
    assert.equal(gitea_.statusCode, 201, gitea_.body);
    const connectionId = gitea_.json().id;
    const github = await call(admin, 'POST', '/admin/github-installation', {
      name: 'Organization',
      appId: '456',
      installationId: '123',
      privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    assert.equal(github.statusCode, 201, github.body);
    const project = await call(owner, 'POST', '/projects', { key: 'PLAT', name: 'Platform' });
    assert.equal(project.statusCode, 201, project.body);
    const other = await call(owner, 'POST', '/projects', { key: 'DOCS', name: 'Docs' });
    const repositories = `/projects/${project.json().id}/repositories`;

    const listed = await call(owner, 'GET', `/git/connections/${connectionId}/repositories`);
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(
      listed.json().data.map((row: { repository: string }) => row.repository),
      ['team/platform', 'team/docs'],
    );
    const installation = await call(
      owner,
      'GET',
      `/git/connections/${github.json().id}/repositories`,
    );
    assert.deepEqual(installation.json().data, [{ repository: 'example/app', private: true }]);

    const target = { connectionId, repository: 'team/platform' };
    assert.equal((await call(member, 'POST', `${repositories}/verify`, target)).statusCode, 403);
    assert.equal(
      (await call(member, 'POST', repositories, { ...target, mode: 'inbound' })).statusCode,
      403,
      'Project members who do not own the project cannot attach repositories',
    );
    const missing = await call(owner, 'POST', `${repositories}/verify`, {
      connectionId,
      repository: 'team/secret',
    });
    assert.equal(missing.statusCode, 400, missing.body);
    assert.ok(!missing.body.includes('service-account-token'));
    const verified = await call(owner, 'POST', `${repositories}/verify`, target);
    assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(verified.json().remoteId, '501');
    assert.equal(verified.json().access.write, true);
    assert.deepEqual(verified.json().conflicts, { reference: null, inbound: null });
    const docs = await call(owner, 'POST', `${repositories}/verify`, {
      connectionId,
      repository: 'team/docs',
    });
    assert.equal(docs.json().access.write, false);
    assert.match(docs.json().access.reason, /read-only access to team\/docs/);
    const app_ = await call(owner, 'POST', `${repositories}/verify`, {
      connectionId: github.json().id,
      repository: 'example/app',
    });
    assert.equal(app_.statusCode, 200, app_.body);
    assert.equal(app_.json().access.write, false, 'Installation tokens are minted read-only');
    assert.match(app_.json().access.reason, /only requests read access/);

    const before = gitea.requests.length;
    const mirrored = await call(owner, 'POST', repositories, { ...target, mode: 'inbound' });
    assert.equal(mirrored.statusCode, 201, mirrored.body);
    assert.ok(gitea.requests.length > before, 'Access is verified again on the server');
    assert.equal(mirrored.json().isDefault, true, 'The first repository is the default');
    assert.equal(mirrored.json().mode, 'inbound');
    const reference = await call(owner, 'POST', repositories, {
      connectionId,
      repository: 'team/docs',
      mode: 'reference',
    });
    assert.equal(reference.statusCode, 201, reference.body);
    assert.equal(reference.json().isDefault, false);
    assert.equal(
      (await call(owner, 'POST', repositories, { ...target, mode: 'reference' })).statusCode,
      409,
      'A repository is attached to a project once',
    );

    const visible = await call(member, 'GET', repositories);
    assert.equal(visible.statusCode, 200, visible.body);
    assert.deepEqual(
      visible.json().data.map((row: { repository: string }) => row.repository),
      ['team/platform', 'team/docs'],
    );
    assert.equal(visible.json().data[0].connection.name, 'Team Gitea');
    for (const forbidden of ['service-account-token', 'encryptedToken', 'PRIVATE KEY'])
      assert.ok(!visible.body.includes(forbidden), `${forbidden} is never returned`);

    const synced = await call(owner, 'POST', `${repositories}/${mirrored.json().id}/sync`);
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().imported, 1);
    assert.ok(synced.json().repository.lastSyncedAt);
    assert.equal(
      (await call(owner, 'POST', `${repositories}/${reference.json().id}/sync`)).statusCode,
      400,
      'Reference repositories do not import issues',
    );
    const ctx = app.getDecorator<AppContext>('context');
    const [imported] = await ctx.store.list<WorkItem>('items');
    assert.equal(imported?.projectId, project.json().id);
    assert.equal(imported?.source?.integrationId, mirrored.json().id);

    // The same repository can only mirror into one project, but can be referenced anywhere.
    const elsewhere = `/projects/${other.json().id}/repositories`;
    const duplicate = await call(owner, 'POST', elsewhere, { ...target, mode: 'inbound' });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.match(duplicate.json().message, /already mirrors issues into another project/);
    assert.equal(
      (await call(owner, 'POST', `${elsewhere}/verify`, target)).json().conflicts.inbound,
      duplicate.json().message,
    );
    assert.equal(
      (await call(owner, 'POST', elsewhere, { ...target, mode: 'reference' })).statusCode,
      201,
    );

    const promoted = await call(owner, 'PATCH', `${repositories}/${reference.json().id}`, {
      isDefault: true,
    });
    assert.equal(promoted.statusCode, 200, promoted.body);
    const defaults = (await call(member, 'GET', repositories)).json().data;
    assert.deepEqual(
      defaults.map((row: { repository: string; isDefault: boolean }) => [
        row.repository,
        row.isDefault,
      ]),
      [
        ['team/docs', true],
        ['team/platform', false],
      ],
    );
    assert.equal(
      (await call(member, 'PATCH', `${repositories}/${mirrored.json().id}`, { isDefault: true }))
        .statusCode,
      403,
    );

    const toReference = await call(owner, 'PATCH', `${repositories}/${mirrored.json().id}`, {
      mode: 'reference',
    });
    assert.equal(toReference.statusCode, 200, toReference.body);
    assert.equal((await ctx.store.get<WorkItem>('items', imported!.id))?.source?.connected, false);
    const back = await call(owner, 'PATCH', `${repositories}/${mirrored.json().id}`, {
      mode: 'inbound',
    });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(
      (await call(owner, 'POST', `${repositories}/${mirrored.json().id}/sync`)).json().imported,
      0,
      'Reattaching the mirror reconnects existing items instead of duplicating them',
    );
    assert.equal((await ctx.store.get<WorkItem>('items', imported!.id))?.source?.connected, true);

    assert.equal(
      (await call(member, 'DELETE', `${repositories}/${reference.json().id}`)).statusCode,
      403,
    );
    assert.equal(
      (await call(owner, 'DELETE', `${repositories}/${reference.json().id}`)).statusCode,
      204,
    );
    const remaining = (await call(owner, 'GET', repositories)).json().data;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].isDefault, true, 'Detaching the default promotes another repository');
    assert.equal(
      (await call(owner, 'DELETE', `${repositories}/${mirrored.json().id}`)).statusCode,
      204,
    );
    assert.equal((await ctx.store.list<WorkItem>('items')).length, 1, 'Detaching keeps work');
    assert.equal((await ctx.store.get<WorkItem>('items', imported!.id))?.source?.connected, false);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => gitea.server.close(() => resolve()));
    if (previousSecret === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = previousSecret;
  }
});
