import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDemoApi, ApiError } from './api';
import type {
  Bootstrap,
  WorkItem,
  ItemDetail,
  ProjectCanvas,
  Project,
  CanvasCollection,
  ActivityHeatmap,
} from '../../shared/types';
const write = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

test('activity heatmaps aggregate scoped demo history and respond to new comments', async () => {
  const api = createDemoApi();
  const year = new Date().getUTCFullYear();
  const before = await api<ActivityHeatmap>(`/activity/heatmap?year=${year}`);
  assert.ok(before.total > 0);
  assert.equal(
    before.total,
    before.days.reduce((sum, day) => sum + day.count, 0),
  );
  await api('/items/task-1/comments', write('POST', { body: 'Heatmap update' }));
  const after = await api<ActivityHeatmap>(`/activity/heatmap?year=${year}`);
  assert.equal(after.total, before.total + 1);
  const allProject = await api<ActivityHeatmap>(`/activity/heatmap?projectId=studio&year=${year}`);
  const personalProject = await api<ActivityHeatmap>(
    `/activity/heatmap?projectId=studio&userId=demo-you&year=${year}`,
  );
  assert.ok(allProject.total >= personalProject.total);
  assert.ok(allProject.total > 0);
  await assert.rejects(
    api('/activity/heatmap?userId=missing'),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
  await assert.rejects(
    api('/activity/heatmap?year=bad'),
    (e: unknown) => e instanceof ApiError && e.status === 400,
  );
});

test('the real application gets an authenticated sample workspace and isolated state', async () => {
  const first = createDemoApi(),
    second = createDemoApi();
  assert.equal((await first<{ authenticated: boolean }>('/auth/status')).authenticated, true);
  const seed = await first<Bootstrap>('/bootstrap');
  assert.ok(seed.items.length >= 20);
  assert.ok(seed.projects[0].roadmap!.features.length >= 4);
  seed.items[0].title = 'Cannot mutate the backing state';
  assert.notEqual((await first<Bootstrap>('/bootstrap')).items[0].title, seed.items[0].title);
  const item = await first<WorkItem>(
    '/items',
    write('POST', { title: 'A new idea', projectId: 'studio' }),
  );
  const updated = await first<{ item: WorkItem }>(
    `/items/${item.id}`,
    write('PATCH', { status: 'done', expectedRevision: item.revision }),
  );
  assert.equal(updated.item.status, 'done');
  assert.equal(updated.item.revision, 2);
  const detail = await first<ItemDetail>(`/items/${item.id}`);
  assert.equal(detail.item.status, 'done');
  assert.ok(detail.item.completedAt);
  assert.equal((await second<Bootstrap>('/bootstrap')).items.length, seed.items.length);
  await assert.rejects(
    first(`/items/${item.id}`, write('PATCH', { title: 'Stale write', expectedRevision: 1 })),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
});

test('task details support internal comments, links, and relationships', async () => {
  const api = createDemoApi();
  await api('/items/task-1/comments', write('POST', { body: 'A local demo comment' }));
  await api('/items/task-1/relations', write('POST', { targetId: 'task-2', kind: 'related' }));
  await api(
    '/links',
    write('POST', {
      itemId: 'task-1',
      title: 'Reference',
      url: 'https://example.test',
      kind: 'link',
    }),
  );
  const detail = await api<ItemDetail>('/items/task-1');
  assert.ok(detail.activity.some((a) => a.body === 'A local demo comment'));
  assert.ok(detail.relations.some((r) => r.targetId === 'task-2'));
  assert.equal(detail.links[0].title, 'Reference');
});

test('roadmap edits and canvas editor autosaves use revisioned local state', async () => {
  const api = createDemoApi();
  const seed = await api<Bootstrap>('/bootstrap');
  await api(
    '/projects/studio/roadmap',
    write('PATCH', {
      ...seed.projects[0].roadmap,
      expectedRevision: 1,
      headline: 'The next chapter',
    }),
  );
  assert.equal((await api<Project>('/projects/studio')).roadmap!.headline, 'The next chapter');
  const canvas = await api<ProjectCanvas>('/projects/studio/canvases/launch-map');
  const group = await api<CanvasCollection>(
    '/projects/studio/canvas-collections',
    write('POST', { name: 'Launch' }),
  );
  await api(
    '/projects/studio/canvases/launch-map',
    write('PATCH', {
      expectedRevision: canvas.revision,
      collectionId: group.id,
      scene: { ...canvas.scene, elements: [] },
    }),
  );
  assert.equal(
    (await api<ProjectCanvas>('/projects/studio/canvases/launch-map')).scene.elements.length,
    0,
  );
  await api(
    `/projects/studio/canvas-collections/${group.id}`,
    write('DELETE', { expectedRevision: 1 }),
  );
  assert.equal(
    (await api<ProjectCanvas>('/projects/studio/canvases/launch-map')).collectionId,
    null,
  );
});

test('deleting a project removes dependent sample records', async () => {
  const api = createDemoApi();
  await api('/projects/studio', { method: 'DELETE' });
  const seed = await api<Bootstrap>('/bootstrap');
  assert.ok(!seed.projects.some((p) => p.id === 'website' || p.id === 'studio'));
  assert.ok(!seed.items.some((i) => i.projectId === 'studio' || i.projectId === 'website'));
  assert.ok(
    seed.relations!.every(
      (r) =>
        seed.items.some((i) => i.id === r.itemId) && seed.items.some((i) => i.id === r.targetId),
    ),
  );
});

test('unsupported, credential, and provider operations fail closed without a network fallback', async () => {
  const api = createDemoApi();
  for (const path of [
    '/git/connections',
    '/auth/logout',
    '/tokens',
    '/integrations/github-demo/sync',
    '/unknown-new-feature',
  ])
    await assert.rejects(
      api(path, write('POST', { token: 'example-not-a-secret' })),
      (error: unknown) => error instanceof ApiError && error.status === 403,
    );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api('/bootstrap', { signal: controller.signal }), { name: 'AbortError' });
});

test('conditional bootstrap remains entirely local and changes after successful writes', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('The demo must never contact an API');
  });
  const api = createDemoApi();
  const first = await api.fetchBootstrap();
  assert.ok(first.data?.items.length);
  assert.deepEqual(await api.fetchBootstrap(first.etag), { etag: first.etag });
  first.data!.items[0].title = 'Cannot change demo backing state';
  await api('/items', write('POST', { title: 'Local capture' }));
  const changed = await api.fetchBootstrap(first.etag);
  assert.notEqual(changed.etag, first.etag);
  assert.ok(changed.data!.items.some((item) => item.title === 'Local capture'));
  assert.notEqual(changed.data!.items[0].title, first.data!.items[0].title);
});

test('atomic planning batches reject stale or invalid writes without partially moving cards', async () => {
  const api = createDemoApi();
  const initial = await api<Bootstrap>('/bootstrap');
  const [first, second] = initial.items.filter((item) => item.projectId === 'studio');
  const batch = (updates: unknown[]) =>
    api<{ data: WorkItem[] }>('/items/batch', write('POST', { updates }));
  await assert.rejects(
    batch([
      { id: first.id, expectedRevision: first.revision, position: 20 },
      { id: second.id, expectedRevision: 999, status: 'done' },
    ]),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  assert.deepEqual((await api<ItemDetail>(`/items/${first.id}`)).item, first);
  const moved = await batch([
    { id: first.id, expectedRevision: first.revision, position: 20, status: 'in_progress' },
    { id: second.id, expectedRevision: second.revision, position: 21 },
  ]);
  assert.equal(moved.data[0].position, 20);
  assert.equal(moved.data[0].revision, (first.revision ?? 0) + 1);
  assert.equal(moved.data[1].position, 21);
  await assert.rejects(
    batch([
      { id: first.id, expectedRevision: moved.data[0].revision, parentId: second.id },
      { id: second.id, expectedRevision: moved.data[1].revision, parentId: first.id },
    ]),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  assert.equal((await api<ItemDetail>(`/items/${first.id}`)).item.parentId, first.parentId);
  await assert.rejects(
    batch([
      { id: first.id, expectedRevision: moved.data[0].revision, position: 2 },
      { id: first.id, expectedRevision: moved.data[0].revision, position: 3 },
    ]),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
});

test('capture retries are idempotent and stale delete Undo cannot remove edited work', async () => {
  const api = createDemoApi();
  const options = {
    ...write('POST', { title: 'Captured once', visibility: 'private' }),
    headers: { 'Idempotency-Key': 'capture-attempt' },
  };
  const first = await api<WorkItem>('/items', options);
  assert.equal((await api<WorkItem>('/items', options)).id, first.id);
  assert.equal(
    (await api<Bootstrap>('/bootstrap')).items.filter((item) => item.id === first.id).length,
    1,
  );
  await assert.rejects(
    api('/items', { ...write('POST', { title: 'Changed capture' }), headers: options.headers }),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  const { item } = await api<{ item: WorkItem }>(
    `/items/${first.id}`,
    write('PATCH', { expectedRevision: first.revision, title: 'Edited later' }),
  );
  await assert.rejects(
    api(`/items/${item.id}`, write('DELETE', { expectedRevision: first.revision })),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  assert.equal((await api<ItemDetail>(`/items/${item.id}`)).item.title, 'Edited later');
});

test('roadmap delivery links and weekly review updates persist in the isolated frame', async () => {
  const api = createDemoApi();
  const project = await api<Project>('/projects/studio');
  const roadmap = project.roadmap!;
  const features = roadmap.features.map((feature, index) =>
    index
      ? feature
      : { ...feature, projectIds: ['website'], milestoneIds: ['milestone-1'], itemIds: ['task-1'] },
  );
  const saved = await api<Project>(
    '/projects/studio/roadmap',
    write('PATCH', { ...roadmap, features, expectedRevision: roadmap.revision }),
  );
  assert.equal(saved.id, project.id);
  assert.deepEqual(saved.roadmap!.features[0].itemIds, ['task-1']);
  await assert.rejects(
    api(
      '/projects/studio/roadmap',
      write('PATCH', {
        ...saved.roadmap,
        expectedRevision: saved.roadmap!.revision,
        features: [{ ...features[0], itemIds: ['not-present'] }],
      }),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 400,
  );
  await api(
    '/projects/studio/updates',
    write('POST', { health: 'at_risk', body: 'Review from local demo evidence' }),
  );
  const data = await api<Bootstrap>('/bootstrap');
  assert.equal(data.projectUpdates!.at(-1)!.body, 'Review from local demo evidence');
  assert.equal(data.projectUpdates!.at(-1)!.health, 'at_risk');
  const linked = await api<ItemDetail>('/items/task-1');
  await api('/items/task-1', write('DELETE', { expectedRevision: linked.item.revision }));
  assert.deepEqual((await api<Project>('/projects/studio')).roadmap!.features[0].itemIds, []);
  assert.equal((await createDemoApi()<Bootstrap>('/bootstrap')).projectUpdates?.length || 0, 0);
});
