import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';
import { branchMatches, githubBranchName, githubReferences } from '../server/github-development.ts';
import { mergeIssueFields } from '../server/github-issue-sync.ts';
import { defaultGitHubRules } from '../shared/github.ts';
import type { WorkItem } from '../shared/types.ts';

test('GitHub linking recognizes exact task IDs, closing and related magic words, and branch patterns', () => {
  const refs = githubReferences(
    'Fix APP-01 and APP-012',
    'feature/app-03-login',
    'Fixes APP-04, APP-05\nPart of APP-06\nReferences APP-07\nCloses APP-08; relates to APP-09\nUnrelated APP-10',
  );
  assert.deepEqual(
    [...refs],
    [
      ['APP-01', true],
      ['APP-012', true],
      ['APP-03', true],
      ['APP-04', true],
      ['APP-05', true],
      ['APP-06', false],
      ['APP-07', false],
      ['APP-08', true],
      ['APP-09', false],
    ],
  );
  assert.equal(githubReferences('xxAPP-01other', '', '').size, 0);
  assert.equal(branchMatches('main, release/*', 'release/1.0'), true);
  assert.equal(branchMatches('main, release/*', 'develop'), false);
  assert.equal(branchMatches('release/1.0', 'release/1x0'), false);
  assert.equal(
    githubBranchName({ identifier: 'APP-01', title: 'Fix café / login?!' }),
    'app-01-fix-cafe-login',
  );
});

async function fixture() {
  const env = { APP_SECRET: process.env.APP_SECRET, APP_ORIGIN: process.env.APP_ORIGIN };
  process.env.APP_SECRET = 'github-development-fixture-key-at-least-32-characters';
  process.env.APP_ORIGIN = 'https://trestl.example.test';
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const pulls: any[] = [];
  const reviews: any[] = [];
  const commits: any[] = [];
  const issues: any[] = [];
  const comments: any[] = [];
  const calls: string[] = [];
  let failure = false;
  let beforeManifest: (() => Promise<void>) | undefined;
  let loseIssueResponse = false;
  const app = await createApp({
    dataDir: ':memory:',
    githubFetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (failure) return new Response('never expose this provider body', { status: 403 });
      if (url.pathname.startsWith('/app-manifests/')) {
        await beforeManifest?.();
        return Response.json({
          id: 456,
          name: 'Trestl Test',
          slug: 'trestl-test',
          pem,
          webhook_secret: 'webhook-fixture-secret',
          owner: { login: 'example' },
        });
      }
      if (url.pathname === '/app/installations')
        return Response.json([
          { id: 123, account: { login: 'example', type: 'Organization' }, suspended_at: null },
        ]);
      if (url.pathname === '/app/installations/123')
        return Response.json({
          id: 123,
          app_id: 456,
          account: { login: 'example', type: 'Organization' },
          suspended_at: null,
        });
      if (url.pathname.endsWith('/access_tokens'))
        return Response.json({
          token: 'secret-installation-token',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      if (url.pathname === '/installation/repositories')
        return Response.json({
          repositories: [
            { id: 1, full_name: 'example/repo', default_branch: 'main', private: true },
          ],
        });
      if (url.pathname === '/repos/example/repo/pulls') return Response.json(pulls);
      if (/\/pulls\/\d+$/.test(url.pathname))
        return Response.json(
          pulls.find((p) => p.number === Number(url.pathname.split('/').at(-1))),
        );
      if (url.pathname.endsWith('/reviews')) return Response.json(reviews);
      if (url.pathname.endsWith('/check-runs'))
        return Response.json({
          check_runs: [{ status: 'completed', conclusion: 'success' }],
          total_count: 1,
        });
      if (url.pathname.endsWith('/branches')) return Response.json([]);
      if (url.pathname.endsWith('/commits')) return Response.json(commits);
      if (
        (url.pathname === '/repos/example/repo/issues' ||
          /\/issues\/\d+\/comments$/.test(url.pathname)) &&
        Number(url.searchParams.get('page') ?? 1) > 1
      )
        return Response.json([]);
      if (url.pathname === '/repos/example/repo/issues') {
        if (init?.method === 'POST') {
          const input = JSON.parse(String(init.body));
          const issue = {
            id: 1000 + issues.length,
            number: 100 + issues.length,
            title: input.title,
            body: input.body,
            state: 'open',
            user: { login: 'trestl[bot]' },
            labels: (input.labels ?? []).map((name: string) => ({ name })),
            html_url: `https://github.com/example/repo/issues/${100 + issues.length}`,
          };
          issues.push(issue);
          if (loseIssueResponse) throw new Error('Connection lost after GitHub created the issue');
          return Response.json(issue, { status: 201 });
        }
        return Response.json(issues);
      }
      if (/\/issues\/\d+$/.test(url.pathname)) {
        const issue = issues.find((i) => i.number === Number(url.pathname.split('/').at(-1)));
        if (init?.method === 'PATCH') {
          const input = JSON.parse(String(init.body));
          Object.assign(issue, input);
          if (input.labels) issue.labels = input.labels.map((name: string) => ({ name }));
        }
        return Response.json(issue);
      }
      if (/\/issues\/\d+\/comments$/.test(url.pathname)) {
        if (init?.method === 'POST') {
          const created = {
            id: comments.length + 1,
            ...JSON.parse(String(init.body)),
            created_at: new Date().toISOString(),
            user: { login: 'trestl[bot]' },
          };
          comments.push(created);
          return Response.json(created);
        }
        return Response.json(comments);
      }

      throw new Error(`Unexpected provider request: ${url.pathname}`);
    },
  });
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { name: 'Admin', email: 'admin@example.test', password: 'local-test-password' },
  });
  const cookie = cookieOf(setup);
  const ctx = app.getDecorator<AppContext>('context');
  const call = (method: any, path: string, payload?: unknown, auth = cookie) =>
    app.inject({
      method,
      url: '/api/v1' + path,
      headers: { cookie: auth },
      ...(payload ? { payload } : {}),
    });
  const start = async (issueWrite = false) => {
    const response = await call('POST', '/admin/github-apps/start', {
      name: 'Trestl Test',
      owner: 'example',
      ownerType: 'organization',
      mode: 'webhook',
      issueWrite,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const create = async (issueWrite = false) => {
    const result = await start(issueWrite);
    const state = new URL(result.action).searchParams.get('state');
    const callback = await call(
      'GET',
      `/admin/github-apps/callback?state=${state}&code=manifest-code`,
    );
    assert.equal(callback.statusCode, 302, callback.body);
    const id = new URL(callback.headers.location!).hash.split('github=')[1];
    const connection = await call('POST', `/admin/github-apps/${id}/connect`, {
      installationId: '123',
    });
    assert.equal(connection.statusCode, 200, connection.body);
    const project = await call('POST', '/projects', { key: 'APP', name: 'Application' });
    const repo = await call('POST', '/github/repositories', {
      connectionId: connection.json().id,
      repository: 'example/repo',
      projectId: project.json().id,
    });
    assert.equal(repo.statusCode, 201, repo.body);
    return {
      appId: id,
      connectionId: connection.json().id,
      projectId: project.json().id,
      repo: repo.json(),
    };
  };
  return {
    app,
    ctx,
    call,
    start,
    create,
    cookie,
    pulls,
    reviews,
    commits,
    issues,
    comments,
    calls,
    setFailure(value: boolean) {
      failure = value;
    },
    beforeManifest(callback: () => Promise<void>) {
      beforeManifest = callback;
    },
    loseIssueResponse(value: boolean) {
      loseIssueResponse = value;
    },
    async close() {
      await app.close();
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('manifest setup binds a one-use state to an administrator session and keeps credentials private', async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    assert.equal(started.manifest.public, false);
    assert.equal(started.manifest.default_permissions.contents, 'read');
    assert.equal(started.manifest.hook_attributes.active, true);
    assert.match(
      started.manifest.hook_attributes.url,
      /^https:\/\/trestl.example.test\/hooks\/github\//,
    );
    const state = new URL(started.action).searchParams.get('state');
    const second = cookieOf(
      await f.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'admin@example.test', password: 'local-test-password' },
      }),
    );
    const wrong = await f.call(
      'GET',
      `/admin/github-apps/callback?state=${state}&code=code`,
      undefined,
      second,
    );
    assert.equal(wrong.statusCode, 400);
    assert.equal(f.calls.length, 0);
    const callback = await f.call('GET', `/admin/github-apps/callback?state=${state}&code=code`);
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(
      (await f.call('GET', `/admin/github-apps/callback?state=${state}&code=code`)).statusCode,
      400,
    );
    const apps = await f.call('GET', '/admin/github-apps');
    assert.equal(apps.json().apps.length, 1);
    assert.ok(!apps.body.includes('PRIVATE KEY'));
    assert.ok(!apps.body.includes('webhook-fixture-secret'));
    assert.ok(!JSON.stringify(await f.ctx.store.list('githubManagedApps')).includes('PRIVATE KEY'));
    const member = cookieOf(
      await memberSession(f.app, f.cookie, {
        name: 'Member',
        email: 'member@example.test',
        password: 'local-test-password',
      }),
    );
    assert.equal((await f.call('GET', '/admin/github-apps', undefined, member)).statusCode, 403);
    assert.equal((await f.call('POST', '/admin/github-apps/start', {}, member)).statusCode, 403);
    const next = await f.start();
    const stateId = (await f.ctx.store.list<any>('githubSetupStates'))[0];
    await f.ctx.store.put('githubSetupStates', { ...stateId, expiresAt: 0 });
    assert.equal(
      (
        await f.call(
          'GET',
          `/admin/github-apps/callback?state=${new URL(next.action).searchParams.get('state')}&code=expired`,
        )
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test('setup does not save credentials when the initiating session ends during the manifest exchange', async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    const state = new URL(started.action).searchParams.get('state');
    f.beforeManifest(async () => {
      assert.equal((await f.call('POST', '/auth/logout')).statusCode, 200);
    });
    const result = await f.call('GET', `/admin/github-apps/callback?state=${state}&code=code`);
    assert.equal(result.statusCode, 403, result.body);
    assert.equal((await f.ctx.store.list('githubManagedApps')).length, 0);
    assert.equal((await f.ctx.store.list('githubSetupStates')).length, 0);
  } finally {
    await f.close();
  }
});

test('PR sync links tasks, preserves unrelated work, waits for multiple PRs, and records idempotent automation', async () => {
  const f = await fixture();
  try {
    const connected = await f.create();
    const task = (
      await f.call('POST', '/items', { title: 'Login', projectId: connected.projectId })
    ).json();
    const unrelated = (
      await f.call('POST', '/items', { title: 'Related work', projectId: connected.projectId })
    ).json();
    const pull = (number: number, options = {}) => ({
      number,
      title: `${task.identifier} Login`,
      body: `Related to ${unrelated.identifier}`,
      state: 'open',
      draft: false,
      merged_at: null,
      updated_at: `2026-09-13T10:0${number}:00Z`,
      head: { ref: `feature/login-${number}`, sha: 'abc123' },
      base: { ref: 'main' },
      user: { login: 'developer' },
      ...options,
    });
    f.pulls.push(pull(1), pull(2));
    const sync = async () => {
      const response = await f.call('POST', `/github/repositories/${connected.repo.id}/sync`, {});
      assert.equal(response.statusCode, 200, response.body);
    };
    await sync();
    assert.equal((await f.ctx.store.get<WorkItem>('items', task.id))!.status, 'in_review');
    assert.equal(
      (await f.ctx.store.get<WorkItem>('items', unrelated.id))!.status,
      unrelated.status,
    );
    const detail = (await f.call('GET', `/github/items/${task.id}`)).json();
    assert.equal(detail.links.length, 2);
    assert.equal(detail.links[0].checks, 'Checks passed');
    const activityCount = (await f.ctx.store.list('activity')).length;
    await sync();
    assert.equal((await f.ctx.store.list('activity')).length, activityCount);
    f.pulls[0] = pull(1, {
      state: 'closed',
      merged_at: '2026-09-13T11:00:00Z',
      updated_at: '2026-09-13T11:00:00Z',
    });
    await sync();
    assert.equal((await f.ctx.store.get<WorkItem>('items', task.id))!.status, 'in_review');
    f.pulls[1] = pull(2, {
      state: 'closed',
      merged_at: '2026-09-13T12:00:00Z',
      updated_at: '2026-09-13T12:00:00Z',
    });
    await sync();
    assert.equal((await f.ctx.store.get<WorkItem>('items', task.id))!.status, 'done');
    // Older replay cannot reopen a merged task or regress the stored PR.
    f.pulls[0] = pull(1);
    await sync();
    assert.equal((await f.ctx.store.get<WorkItem>('items', task.id))!.status, 'done');
    assert.equal(
      (await f.call('GET', `/github/items/${task.id}`))
        .json()
        .links.find((l: any) => l.number === 1).state,
      'merged',
    );
    const link = detail.links.find((l: any) => l.number === 1);
    assert.equal(
      (await f.call('DELETE', `/github/items/${task.id}/links/${encodeURIComponent(link.id)}`))
        .statusCode,
      204,
    );
    await sync();
    assert.equal(
      (await f.call('GET', `/github/items/${task.id}`)).json().links.length,
      1,
      'Explicitly unlinked PRs must stay unlinked during automatic synchronization',
    );
    assert.equal(
      (
        await f.call('POST', `/github/items/${task.id}/pull-request`, {
          repositoryId: connected.repo.id,
          number: 1,
          closing: false,
        })
      ).statusCode,
      200,
    );
    await sync();
    const restored = (await f.call('GET', `/github/items/${task.id}`))
      .json()
      .links.find((l: any) => l.number === 1);
    assert.equal(restored.manual, true);
    assert.equal(restored.closing, false);
    const config = await f.call('PATCH', `/github/repositories/${connected.repo.id}`, {
      enabled: true,
      branches: 'release/*',
      rules: defaultGitHubRules,
    });
    assert.equal(config.statusCode, 200);
    assert.equal(
      (
        await f.call('POST', `/github/items/${task.id}/pull-request`, {
          repositoryId: connected.repo.id,
          number: 1,
          closing: true,
        })
      ).statusCode,
      400,
    );
    f.setFailure(true);
    const failed = await f.call('POST', `/github/repositories/${connected.repo.id}/sync`, {});
    assert.equal(failed.statusCode, 502);
    assert.ok(!failed.body.includes('never expose'));
    assert.ok(!failed.body.includes('secret-installation-token'));
    f.setFailure(false);
    assert.equal(
      (await f.call('DELETE', `/git/connections/${connected.connectionId}`)).statusCode,
      204,
    );
    assert.equal((await f.call('GET', '/github/repositories')).json().length, 0);
    assert.equal((await f.ctx.store.get<WorkItem>('items', task.id))!.status, 'done');
  } finally {
    await f.close();
  }
});

test('webhooks authenticate raw bytes, deduplicate deliveries, and enqueue only the matching installation', async () => {
  const f = await fixture();
  try {
    const connected = await f.create();
    const payload = JSON.stringify({
      installation: { id: 123 },
      repository: { full_name: 'example/repo' },
    });
    const signature = `sha256=${createHmac('sha256', 'webhook-fixture-secret').update(payload).digest('hex')}`;
    const send = (body = payload, sig = signature, delivery = 'delivery-1') =>
      f.app.inject({
        method: 'POST',
        url: `/hooks/github/${connected.appId}`,
        payload: body,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
          'x-github-event': 'pull_request',
          'x-github-delivery': delivery,
        },
      });
    assert.equal((await send(payload + ' ')).statusCode, 401);
    assert.equal((await send(payload, 'sha256=' + '0'.repeat(64))).statusCode, 401);
    assert.equal((await f.ctx.store.list('githubJobs')).length, 0);
    const ok = await send();
    assert.equal(ok.statusCode, 202, ok.body);
    assert.equal((await f.ctx.store.list('githubJobs')).length, 1);
    assert.equal((await send()).statusCode, 202);
    assert.equal((await f.ctx.store.list('githubDeliveries')).length, 1);
    await f.ctx.store.remove('githubJobs', connected.repo.id);
    const wrong = JSON.stringify({
      installation: { id: 999 },
      repository: { full_name: 'example/repo' },
    });
    assert.equal(
      (
        await send(
          wrong,
          `sha256=${createHmac('sha256', 'webhook-fixture-secret').update(wrong).digest('hex')}`,
          'delivery-2',
        )
      ).statusCode,
      202,
    );
    assert.equal((await f.ctx.store.list('githubJobs')).length, 0);
    const member = cookieOf(
      await memberSession(f.app, f.cookie, {
        name: 'Member',
        email: 'member@example.test',
        password: 'local-test-password',
      }),
    );
    assert.equal(
      (await f.call('POST', `/github/repositories/${connected.repo.id}/sync`, {}, member))
        .statusCode,
      403,
    );
    const privateProject = (
      await f.call('POST', '/projects', { key: 'HIDDEN', name: 'Private', visibility: 'private' })
    ).json();
    const privateTask = (
      await f.call('POST', '/items', { title: 'Secret', projectId: privateProject.id })
    ).json();
    assert.equal(
      (await f.call('GET', `/github/items/${privateTask.id}`, undefined, member)).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('two-way issues merge independent edits, surface conflicts, and publish only explicit GitHub comments', async () => {
  const f = await fixture();
  try {
    const connected = await f.create(true);
    f.issues.push({
      id: 77,
      number: 7,
      title: 'Original title',
      body: 'Original description',
      state: 'open',
      html_url: 'https://github.com/example/repo/issues/7',
      user: { login: 'author' },
      labels: [{ name: 'bug' }],
    });
    const integration = await f.call('POST', '/integrations', {
      name: 'GitHub issues',
      connectionId: connected.connectionId,
      repository: 'example/repo',
      projectId: connected.projectId,
      syncMode: 'two-way',
    });
    assert.equal(integration.statusCode, 201, integration.body);
    const sync = async () => {
      const r = await f.call('POST', `/integrations/${integration.json().id}/sync`, {});
      assert.equal(r.statusCode, 200, r.body);
    };
    await sync();
    const item = (await f.ctx.store.list<WorkItem>('items')).find((i) => i.source?.number === 7)!;
    assert.equal(item.source?.syncMode, 'two-way');
    const edited = await f.call('PATCH', `/items/${item.id}`, {
      title: 'Trestl title',
      status: 'done',
    });
    assert.equal(edited.statusCode, 200, edited.body);
    await f.call('POST', `/items/${item.id}/comments`, { body: 'Private internal discussion' });
    f.issues[0].body = 'Description edited on GitHub';
    await sync();
    assert.equal(f.issues[0].title, 'Trestl title');
    assert.equal(f.issues[0].state, 'closed');
    assert.equal(
      (await f.ctx.store.get<WorkItem>('items', item.id))!.description,
      'Description edited on GitHub',
    );
    assert.equal(f.comments.length, 0, 'Internal comments must never be published automatically');
    await f.call('PATCH', `/items/${item.id}`, { title: 'Local competing title' });
    f.issues[0].title = 'Remote competing title';
    await sync();
    const conflicted = (await f.ctx.store.get<WorkItem>('items', item.id))!;
    assert.equal(conflicted.title, 'Local competing title');
    assert.match(conflicted.source?.syncError ?? '', /title/);
    assert.equal(f.issues[0].title, 'Remote competing title');
    const comparison = (await f.call('GET', `/github/items/${item.id}/issue-conflict`)).json();
    assert.equal(
      (
        await f.call('POST', `/github/items/${item.id}/issue-conflict`, {
          choice: 'local',
          fingerprint: 'stale',
          revision: comparison.revision,
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.call('POST', `/github/items/${item.id}/issue-conflict`, {
          choice: 'local',
          fingerprint: comparison.fingerprint,
          revision: comparison.revision,
        })
      ).statusCode,
      200,
    );
    await sync();
    assert.equal(f.issues[0].title, 'Local competing title');
    const comment = { body: 'Public follow-up', requestId: '11111111-1111-4111-8111-111111111111' };
    const posted = await f.call('POST', `/github/items/${item.id}/issue-comments`, comment);
    assert.equal(posted.statusCode, 200, posted.body);
    assert.equal(
      (await f.call('POST', `/github/items/${item.id}/issue-comments`, comment)).statusCode,
      200,
    );
    assert.equal(f.comments.length, 1);
    assert.match(f.comments[0].body, /Public follow-up/);
    assert.ok(!f.comments[0].body.includes('Private internal'));
    await sync();
    assert.equal(
      (await f.ctx.store.list<any>('activity')).filter(
        (a) => a.itemId === item.id && a.body.includes('Public follow-up'),
      ).length,
      1,
    );
    const native = (
      await f.call('POST', '/items', {
        title: 'Native task to publish',
        description: 'Release work',
        projectId: connected.projectId,
      })
    ).json();
    const published = await f.call('POST', `/github/items/${native.id}/publish`, {
      integrationId: integration.json().id,
    });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(f.issues.length, 2);
    await sync();
    assert.equal((await f.ctx.store.list<WorkItem>('items')).length, 2);
    assert.equal(
      (await f.ctx.store.get<WorkItem>('items', native.id))!.description,
      'Release work',
    );
    assert.equal(
      (
        await f.call('POST', `/github/items/${native.id}/publish`, {
          integrationId: integration.json().id,
        })
      ).statusCode,
      400,
    );
  } finally {
    await f.close();
  }
});

test('synchronization recovers a lost issue creation response without duplicating the native task', async () => {
  const f = await fixture();
  try {
    const connected = await f.create(true);
    const integration = (
      await f.call('POST', '/integrations', {
        name: 'Two-way GitHub',
        connectionId: connected.connectionId,
        repository: 'example/repo',
        projectId: connected.projectId,
        syncMode: 'two-way',
      })
    ).json();
    const item = (
      await f.call('POST', '/items', { title: 'Publish once', projectId: connected.projectId })
    ).json();
    f.loseIssueResponse(true);
    assert.equal(
      (await f.call('POST', `/github/items/${item.id}/publish`, { integrationId: integration.id }))
        .statusCode,
      502,
    );
    assert.equal(
      (await f.call('POST', `/github/items/${item.id}/publish`, { integrationId: integration.id }))
        .statusCode,
      409,
    );
    assert.equal(f.issues.length, 1);
    await f.call('PATCH', `/items/${item.id}`, { title: 'Edited while recovering' });
    f.loseIssueResponse(false);
    assert.equal(
      (await f.call('POST', `/integrations/${integration.id}/sync`, {})).statusCode,
      200,
    );
    const recovered = (await f.ctx.store.get<WorkItem>('items', item.id))!;
    assert.equal(recovered.source?.number, f.issues[0].number);
    assert.equal(recovered.title, 'Edited while recovering');
    assert.equal((await f.ctx.store.list('items')).length, 1);
    assert.equal((await f.ctx.store.list('githubPublications')).length, 0);
    assert.equal(
      (await f.call('POST', `/integrations/${integration.id}/sync`, {})).statusCode,
      200,
    );
    assert.equal(f.issues[0].title, 'Edited while recovering');
  } finally {
    await f.close();
  }
});

test('three-way issue merge combines independent fields and preserves conflicting values', () => {
  const base = {
    title: 'Base',
    description: 'Description',
    labels: ['bug'],
    state: 'open' as const,
  };
  const result = mergeIssueFields(
    base,
    { ...base, title: 'Local' },
    { ...base, description: 'Remote description' },
  );
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged.title, 'Local');
  assert.equal(result.merged.description, 'Remote description');
  assert.deepEqual(
    mergeIssueFields(base, { ...base, title: 'Local' }, { ...base, title: 'Remote' }).conflicts,
    ['title'],
  );
});
