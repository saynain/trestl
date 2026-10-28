import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { openDatabase, type Database } from '../server/db.ts';
import { cookieOf, memberSession } from './installation-fixture.ts';

export const testSecret = 'backup-test-secret-0123456789abcdef0123456789';
export const gitToken = 'gitea-token-that-must-survive-a-restore';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==',
  'base64',
);
const owner = { email: 'owner@backup.test', password: 'correct-horse-battery' };
const member = { name: 'Member', email: 'member@backup.test', password: 'member-horse-battery' };

/** A fake Gitea that records the credentials Trestl sends. */
export async function fakeGitea() {
  const authorizations: string[] = [];
  const server: Server = createServer((request, response) => {
    authorizations.push(request.headers.authorization ?? '');
    const url = new URL(request.url!, 'http://localhost');
    const body = /\/issues\/42$/.test(url.pathname)
      ? { id: 42, number: 42, title: 'Remote issue', body: 'Body', state: 'open' }
      : [];
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    authorizations,
    close: () => new Promise<void>((accept) => server.close(() => accept())),
  };
}

function client(app: FastifyInstance, cookie: string) {
  return async (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown) => {
    const response = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    assert.ok(
      response.statusCode < 300,
      `${method} ${path}: ${response.statusCode} ${response.body}`,
    );
    return response.json();
  };
}

export type Fixture = Awaited<ReturnType<typeof populate>>;

/** Everything an installation backup has to bring back. */
export async function populate(app: FastifyInstance, gitOrigin: string) {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { installationName: 'Backup test', name: 'Owner', ...owner, seedDemo: false },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  const api = client(app, cookieOf(setup));
  const memberId = (await memberSession(app, cookieOf(setup), member)).json().id as string;
  const shared = await api('POST', '/projects', { key: 'TEAM', name: 'Team work' });
  const secret = await api('POST', '/projects', {
    key: 'MINE',
    name: 'Private plans',
    visibility: 'private',
  });
  const image = await app.inject({
    method: 'POST',
    url: '/api/v1/images',
    headers: { cookie: cookieOf(setup), 'content-type': 'image/png' },
    payload: png,
  });
  assert.equal(image.statusCode, 201, image.body);
  const imageUrl = image.json().url as string;
  const item = await api('POST', '/items', {
    title: 'Shared task with a screenshot',
    projectId: shared.id,
    description: `![Screenshot](${imageUrl})`,
  });
  const privateItem = await api('POST', '/items', {
    title: 'Personal follow-up',
    visibility: 'private',
  });
  const secretItem = await api('POST', '/items', { title: 'Hidden plan', projectId: secret.id });
  const comment = await api('POST', `/items/${item.id}/comments`, { body: 'Looks good' });
  const update = await api('POST', `/projects/${shared.id}/updates`, {
    health: 'at_risk',
    body: 'Waiting for review',
  });
  const canvas = await api('POST', `/projects/${shared.id}/canvases`, { title: 'Architecture' });
  const dataURL = `data:image/png;base64,${png.toString('base64')}`;
  const scene = {
    elements: [
      { id: 'box', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, version: 1 },
      { id: 'pic', type: 'image', x: 0, y: 60, width: 10, height: 10, version: 1, fileId: 'png' },
    ],
    appState: { viewBackgroundColor: '#ffffff' },
    files: { png: { id: 'png', mimeType: 'image/png', dataURL, created: 1 } },
  };
  await api('PATCH', `/projects/${shared.id}/canvases/${canvas.id}`, {
    scene,
    expectedRevision: canvas.revision,
  });
  const token = await api('POST', '/tokens', { name: 'Agent', scope: 'write' });
  const connection = await api('POST', '/git/connections', {
    provider: 'gitea',
    name: 'Team Gitea',
    baseUrl: gitOrigin,
    token: gitToken,
    shared: true,
  });
  return {
    memberId,
    projects: { shared: shared.id as string, secret: secret.id as string },
    items: {
      shared: item.id as string,
      private: privateItem.id as string,
      secret: secretItem.id as string,
    },
    comment: comment.id as string,
    update: update.id as string,
    imageUrl,
    canvas: { id: canvas.id as string, scene },
    apiToken: token.token as string,
    connection: connection.id as string,
  };
}

async function login(app: FastifyInstance, account: { email: string; password: string }) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: account,
  });
  assert.equal(response.statusCode, 200, response.body);
  return cookieOf(response);
}

/** Exercise the restored installation through the API, as its users would. */
export async function verifyRestored(
  app: FastifyInstance,
  fixture: Fixture,
  gitea: { authorizations: string[] },
) {
  const ownerApi = client(app, await login(app, owner));
  const memberCookie = await login(app, member);
  const memberApi = client(app, memberCookie);
  const bootstrap = await ownerApi('GET', '/bootstrap');
  assert.equal(bootstrap.workspace.name, 'Backup test');
  const projectIds = bootstrap.projects.map((p: { id: string }) => p.id);
  assert.ok(projectIds.includes(fixture.projects.shared));
  assert.ok(projectIds.includes(fixture.projects.secret));
  const memberProjects = (await memberApi('GET', '/bootstrap')).projects.map(
    (p: { id: string }) => p.id,
  );
  assert.ok(memberProjects.includes(fixture.projects.shared));
  assert.ok(!memberProjects.includes(fixture.projects.secret), 'Private projects stay private');
  for (const path of [`/items/${fixture.items.private}`, `/items/${fixture.items.secret}`]) {
    assert.equal((await ownerApi('GET', path)).item.id, path.split('/')[2]);
    const hidden = await app.inject({ url: `/api/v1${path}`, headers: { cookie: memberCookie } });
    assert.equal(hidden.statusCode, 404, 'Private work stays private');
  }
  const detail = await memberApi('GET', `/items/${fixture.items.shared}`);
  assert.equal(detail.item.title, 'Shared task with a screenshot');
  assert.ok(detail.activity.some((entry: { id: string }) => entry.id === fixture.comment));
  const image = await app.inject({ url: fixture.imageUrl, headers: { cookie: memberCookie } });
  assert.equal(image.statusCode, 200);
  assert.deepEqual(image.rawPayload, png);
  const updates = await memberApi('GET', `/projects/${fixture.projects.shared}/updates`);
  assert.ok(updates.data.some((u: { id: string }) => u.id === fixture.update));
  const canvas = await memberApi(
    'GET',
    `/projects/${fixture.projects.shared}/canvases/${fixture.canvas.id}`,
  );
  assert.deepEqual(canvas.scene, fixture.canvas.scene);
  const viaToken = await app.inject({
    url: `/api/v1/items/${fixture.items.shared}`,
    headers: { authorization: `Bearer ${fixture.apiToken}` },
  });
  assert.equal(viaToken.statusCode, 200, 'API tokens keep working');
  // The restored credential is decrypted with APP_SECRET and sent to the provider.
  gitea.authorizations.length = 0;
  const issue = await ownerApi(
    'GET',
    `/git/connections/${fixture.connection}/issue?repository=owner/repo&number=42`,
  );
  assert.equal(issue.title, 'Remote issue');
  assert.ok(gitea.authorizations.includes(`token ${gitToken}`));
}

/** Every row of every table, independent of the backup code. */
export async function tableContents(database: Database) {
  const tables = (
    await database.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    )
  ).rows.map((row) => row.name);
  const contents: Record<string, string[]> = {};
  for (const table of tables)
    contents[table] = (
      await database.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY 1`,
      )
    ).rows.map((row) => row.row);
  return contents;
}

export async function contentsOf(options: { dataDir?: string; databaseUrl?: string }) {
  const database = await openDatabase({ ...options, initialize: false, mustExist: true });
  try {
    return await database.transaction(async (tx) => {
      await tx.query(`SET LOCAL TimeZone='UTC'`);
      return tableContents(tx);
    });
  } finally {
    await database.close();
  }
}
