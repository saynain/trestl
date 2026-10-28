import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mentionMarkdown } from '../shared/mentions.ts';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import type {
  Project,
  ProjectUpdate,
  WorkItem,
  Activity,
  ProjectCanvas,
  CanvasCollection,
} from '../shared/types.ts';

const password = 'project-transfer-test-password';
test('portable project transfer preserves content, isolates access, validates references, and commits atomically', async () => {
  const source = await createApp({ dataDir: ':memory:', integrations: false });
  const dest = await createApp({ dataDir: ':memory:', integrations: false });
  try {
    const setup = async (app: typeof source, name: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: { name, email: `${name.toLowerCase()}@transfer.test`, password, seedDemo: false },
      });
      assert.equal(res.statusCode, 201, res.body);
      return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    };
    const sourceCookie = await setup(source, 'Original');
    const destCookie = await setup(dest, 'Destination');
    const call = async (
      app: typeof source,
      cookie: string,
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: `/api/v1${path}`,
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    const src = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown) =>
      call(source, sourceCookie, method, path, payload);
    const dst = (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: unknown) =>
      call(dest, destCookie, method, path, payload);
    const srcUser = (await src('GET', '/bootstrap')).json().user;
    const dstUser = (await dst('GET', '/bootstrap')).json().user;
    const sourceContext = source.getDecorator<AppContext>('context');
    const destContext = dest.getDecorator<AppContext>('context');
    const project = (
      await src('POST', '/projects', { key: 'MOVE', name: 'Platform', visibility: 'workspace' })
    ).json<Project>();
    const child = (
      await src('POST', '/projects', { key: 'CHILD', name: 'Subproject', parentId: project.id })
    ).json<Project>();
    const item = (
      await src('POST', '/items', {
        title: 'Build the platform',
        projectId: project.id,
        assigneeId: srcUser.id,
        description: 'Keep **markdown**',
        labels: ['work'],
        visibility: 'workspace',
      })
    ).json<WorkItem>();
    const subtask = (
      await src('POST', '/items', {
        title: 'Check deployment',
        projectId: project.id,
        parentId: item.id,
        visibility: 'private',
      })
    ).json<WorkItem>();
    const childItem = (
      await src('POST', '/items', { title: 'Document', projectId: child.id, parentId: item.id })
    ).json<WorkItem>();
    await sourceContext.store.put('projects', {
      ...project,
      roadmap: {
        revision: 3,
        headline: 'Ship it',
        reviewNote: 'Reviewed',
        reviewedAt: '2026-09-01',
        features: [
          {
            id: randomUUID(),
            title: 'Release',
            summary: 'First release',
            area: 'Core',
            horizon: 'current',
            status: 'Active',
            scope: 'Scope',
            rationale: 'Why',
            targetDate: null,
          },
        ],
      },
    });
    await sourceContext.store.put('items', {
      ...item,
      source: {
        provider: 'gitea',
        integrationId: randomUUID(),
        repository: 'team/app',
        number: 5,
        url: 'https://git.example.test/team/app/issues/5',
        state: 'open',
        lastSyncedAt: null,
        connected: true,
      },
    });
    const originalAuthor = randomUUID();
    await sourceContext.store.put<Activity>('activity', {
      id: randomUUID(),
      itemId: item.id,
      userId: originalAuthor,
      kind: 'comment',
      body: 'Original discussion',
      createdAt: '2025-01-01T12:00:00.000Z',
      source: { provider: 'gitea', author: 'Former contributor' },
    });
    await sourceContext.store.put('links', {
      id: randomUUID(),
      projectId: project.id,
      itemId: item.id,
      title: 'Repository',
      url: 'https://git.example.test/team/app',
      kind: 'repository',
    });
    const milestoneId = randomUUID();
    await sourceContext.store.put('milestones', {
      id: milestoneId,
      projectId: child.id,
      title: 'Launch',
      dueDate: '2026-12-01',
      completed: false,
    });
    const milestoneReference = mentionMarkdown({ kind: 'milestone', id: milestoneId }, 'Launch');
    await src('PATCH', `/items/${childItem.id}`, { milestoneId });
    await src('PATCH', `/items/${childItem.id}`, { description: milestoneReference });
    await src('POST', `/items/${childItem.id}/comments`, { body: milestoneReference });
    await sourceContext.store.put('relations', {
      id: randomUUID(),
      itemId: item.id,
      targetId: childItem.id,
      kind: 'blocks',
    });
    const collection: CanvasCollection = {
      id: randomUUID(),
      projectId: project.id,
      workspaceId: srcUser.workspaceId,
      name: 'Designs',
      revision: 2,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    };
    await sourceContext.store.put('canvasCollections', collection);
    const canvas: ProjectCanvas = {
      id: randomUUID(),
      projectId: project.id,
      workspaceId: srcUser.workspaceId,
      title: 'Architecture',
      collectionId: collection.id,
      revision: 2,
      createdBy: srcUser.id,
      updatedBy: srcUser.id,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
      scene: {
        elements: [
          { id: 'image', type: 'image', x: 0, y: 0, width: 100, height: 100, fileId: 'img' },
        ],
        appState: { viewBackgroundColor: '#ffffff' },
        files: {
          img: {
            id: 'img',
            mimeType: 'image/png',
            dataURL: 'data:image/png;base64,aGVsbG8=',
            created: 1,
          },
        },
      },
    };
    await sourceContext.store.put('canvases', canvas);
    // A different member's private work is never included, even in an admin export.
    const other = (
      await src('POST', '/users', { name: 'Colleague', email: 'colleague@transfer.test', password })
    ).json();
    const hiddenItemId = randomUUID();
    await sourceContext.store.put('items', {
      ...childItem,
      id: hiddenItemId,
      title: 'Hidden personal note',
      visibility: 'private',
      creatorId: other.id,
    });
    const outside = (await src('POST', '/projects', { key: 'OUTSIDE', name: 'Outside' })).json();
    const outsideItem = (
      await src('POST', '/items', { title: 'External dependency', projectId: outside.id })
    ).json();
    await sourceContext.store.put('relations', {
      id: randomUUID(),
      itemId: item.id,
      targetId: outsideItem.id,
      kind: 'related',
    });
    await sourceContext.store.put('integrations', {
      id: randomUUID(),
      secret: 'MUST_NOT_EXPORT',
      projectId: project.id,
    });
    const updateOne = (
      await src('POST', `/projects/${project.id}/updates`, {
        health: 'at_risk',
        body: '**Blocked:** waiting for review.',
      })
    ).json<ProjectUpdate>();
    const updateTwo = (
      await src('POST', `/projects/${project.id}/updates`, {
        health: 'on_track',
        body: 'Review complete.',
      })
    ).json<ProjectUpdate>();
    // Same instant in different time zones must keep the source tie-break order after re-keying.
    await sourceContext.store.put('projectUpdates', {
      ...updateOne,
      createdAt: '2025-01-01T12:00:00.000Z',
    });
    await sourceContext.store.put('projectUpdates', {
      ...updateTwo,
      createdAt: '2025-01-01T13:00:00.000+01:00',
    });
    await sourceContext.store.put<ProjectUpdate>('projectUpdates', {
      id: randomUUID(),
      projectId: child.id,
      authorId: originalAuthor,
      health: 'off_track',
      body: 'Historical child update',
      createdAt: '2024-01-01T12:00:00.000Z',
      importedFrom: { authorName: 'Historical contributor' },
    });
    await src('POST', `/projects/${outside.id}/updates`, {
      health: 'off_track',
      body: 'Outside update must not export',
    });
    const hidden = (
      await src('POST', '/projects', {
        key: 'HIDDEN',
        name: 'Hidden child',
        parentId: project.id,
        visibility: 'private',
        ownerId: other.id,
      })
    ).json<Project>();
    await sourceContext.store.put<ProjectUpdate>('projectUpdates', {
      id: randomUUID(),
      projectId: hidden.id,
      authorId: other.id,
      health: 'off_track',
      body: 'Private update must not export',
      createdAt: project.createdAt,
    });
    const linkedProject = (await sourceContext.store.get<Project>('projects', project.id))!;
    linkedProject.roadmap!.features[0] = {
      ...linkedProject.roadmap!.features[0],
      projectIds: [child.id, outside.id, hidden.id],
      milestoneIds: [milestoneId],
      itemIds: [item.id, childItem.id, outsideItem.id, hiddenItemId],
    };
    await sourceContext.store.put('projects', linkedProject);
    const sourceUpdates = (await src('GET', `/projects/${project.id}/updates`)).json().data;
    const exported = await src('GET', `/projects/${project.id}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    assert.match(String(exported.headers['content-disposition']), /trestl-project.json/);
    const pack = exported.json();
    const linkedFeature = pack.projects.find((p: Project) => p.id === project.id).roadmap
      .features[0];
    assert.deepEqual(linkedFeature.projectIds, [child.id]);
    assert.deepEqual(linkedFeature.milestoneIds, [milestoneId]);
    assert.deepEqual(linkedFeature.itemIds, [item.id, childItem.id]);
    assert.equal(pack.projects.length, 2);
    assert.equal(pack.items.length, 3);
    assert.equal(pack.projectUpdates.length, 3);
    assert(!exported.body.includes('Private update must not export'));
    assert(!exported.body.includes('Outside update must not export'));
    assert(
      pack.projectUpdates
        .filter((u: ProjectUpdate) => u.projectId === project.id)
        .every((u: ProjectUpdate) => u.importedFrom?.authorName === 'Original'),
    );
    assert.equal(pack.relations.length, 1);
    assert.equal(
      pack.activity.find(
        (a: Activity) => a.kind === 'event' && a.body.includes('Changed milestone'),
      ).body,
      'Changed milestone to Launch',
    );
    assert.equal(pack.items.find((i: WorkItem) => i.id === childItem.id).milestoneId, milestoneId);
    assert.equal(
      pack.activity.find((a: Activity) => a.kind === 'comment' && a.body === 'Original discussion')
        .importedFrom.authorName,
      'Former contributor',
    );
    assert(!exported.body.includes('MUST_NOT_EXPORT'));
    assert(!exported.body.includes('password'));
    assert(!exported.body.includes('@transfer.test'));
    assert(!exported.body.includes('Hidden personal note'));
    assert(!exported.body.includes('integrationId'));
    assert.equal(
      pack.items.find((i: WorkItem) => i.id === item.id).externalUrl,
      'https://git.example.test/team/app/issues/5',
    );
    const single = (await src('GET', `/projects/${child.id}/export`)).json();
    assert.equal(single.projects.length, 1);
    assert.equal(single.projectUpdates.length, 1);
    assert.equal(single.projects[0].parentId, null);
    assert.equal(single.items[0].parentId, null);
    // Existing destination names/keys produce proposals, without changing any data.
    await dst('POST', '/projects', { key: 'MOVE', name: 'Platform' });
    const contract = (await dst('GET', '/openapi.json')).json();
    assert(contract.paths['/project-import'].post);
    assert(contract.components.schemas.ProjectPackage.properties.canvases);
    const before = await destContext.store.list('projects');
    const previewResponse = await dst('POST', '/project-import/preview', { package: pack });
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const review = previewResponse.json();
    assert.equal(review.counts.projectUpdates, 3);
    assert.equal(review.options.projects[0].key, 'MOVE2');
    assert.equal(review.options.projects[0].name, 'Platform (import 2)');
    assert(review.options.projects.every((p: Project) => p.visibility === 'private'));
    assert.equal(review.options.assignees[srcUser.id], null);
    assert.deepEqual(await destContext.store.list('projects'), before);
    review.options.assignees[srcUser.id] = dstUser.id;
    const payload = { package: pack, options: review.options, requestId: randomUUID() };
    const responses = await Promise.all([
      dst('POST', '/project-import', payload),
      dst('POST', '/project-import', payload),
    ]);
    for (const res of responses) assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(responses[0].json(), responses[1].json());
    const imported = responses[0].json();
    const projects = await destContext.store.list<Project>('projects');
    assert.equal(projects.length, 3);
    const newRoot = projects.find((p) => p.id === imported.projectId)!;
    const newChild = projects.find((p) => p.parentId === newRoot.id)!;
    assert.equal(newRoot.ownerId, dstUser.id);
    assert.equal(
      newRoot.creationActorId,
      null,
      'Import ownership must not claim historical creation credit',
    );
    assert.equal(newChild.creationActorId, null);
    assert.deepEqual(newRoot.memberIds, []);
    assert.equal(newRoot.roadmap?.features[0].title, 'Release');
    assert.notEqual(
      newRoot.roadmap?.features[0].id,
      pack.projects.find((p: Project) => p.id === project.id).roadmap.features[0].id,
    );
    assert(newChild);
    const importedUpdates = (await dst('GET', `/projects/${newRoot.id}/updates`)).json()
      .data as ProjectUpdate[];
    assert.equal((await destContext.store.list('projectUpdates')).length, 3);
    assert.deepEqual(
      importedUpdates.map((u) => [u.health, u.body, u.createdAt]),
      sourceUpdates.map((u: ProjectUpdate) => [u.health, u.body, u.createdAt]),
    );
    assert(
      importedUpdates.every(
        (u) => u.authorId === dstUser.id && u.importedFrom?.authorName === 'Original',
      ),
    );
    assert(
      importedUpdates.every(
        (u) => !pack.projectUpdates.some((original: ProjectUpdate) => original.id === u.id),
      ),
    );
    const importedChildUpdates = (await dst('GET', `/projects/${newChild.id}/updates`)).json().data;
    assert.equal(importedChildUpdates[0].importedFrom.authorName, 'Historical contributor');
    assert.notEqual(newRoot.id, project.id);
    const newItems = await destContext.store.list<WorkItem>('items');
    assert.equal(newItems.length, 3);
    assert.ok(newItems.every((item) => item.creationActorId === null));
    const importedHeatmap = await dst('GET', `/activity/heatmap?projectId=${newRoot.id}`);
    assert.equal(importedHeatmap.statusCode, 200, importedHeatmap.body);
    assert.equal(
      importedHeatmap.json().total,
      0,
      'Imported history is provenance, never verified importer activity',
    );
    const newItem = newItems.find((i) => i.title === item.title)!;
    const linkedMilestone = (await dst('GET', '/milestones')).json().data[0];
    assert.notEqual(linkedMilestone.id, milestoneId);
    assert.equal(
      newItems.find((i) => i.title === childItem.title)?.milestoneId,
      linkedMilestone.id,
    );
    assert.deepEqual(linkedMilestone.progress, { total: 1, done: 0, canceled: 0 });
    const importedReference = mentionMarkdown(
      { kind: 'milestone', id: linkedMilestone.id },
      'Launch',
    );
    const newChildItem = newItems.find((i) => i.title === childItem.title)!;
    assert.deepEqual(newRoot.roadmap?.features[0].projectIds, [newChild.id]);
    assert.deepEqual(newRoot.roadmap?.features[0].milestoneIds, [linkedMilestone.id]);
    assert.deepEqual(newRoot.roadmap?.features[0].itemIds, [newItem.id, newChildItem.id]);
    assert.equal(newChildItem.description, importedReference);
    assert(
      (await destContext.store.list<Activity>('activity')).some(
        (a) => a.itemId === newChildItem.id && a.kind === 'comment' && a.body === importedReference,
      ),
    );
    assert.equal(newItem.identifier, 'MOVE2-01');
    assert.equal(newItem.assigneeId, dstUser.id);
    assert.equal(newItem.source, undefined);
    assert.equal(newItems.find((i) => i.title === childItem.title)?.parentId, newItem.id);
    assert.equal(newItem.description, item.description);
    assert.equal(newItem.importedFrom?.authorName, srcUser.name);
    assert.equal(newItems.find((i) => i.title === subtask.title)?.parentId, newItem.id);
    assert.equal(newItems.find((i) => i.title === subtask.title)?.visibility, 'private');
    const newActivity = await destContext.store.list<Activity>('activity');
    const originalComment = newActivity.find(
      (a) => a.kind === 'comment' && a.body === 'Original discussion',
    )!;
    assert.equal(originalComment.importedFrom?.authorName, 'Former contributor');
    assert.equal(originalComment.createdAt, '2025-01-01T12:00:00.000Z');
    assert.equal(originalComment.itemId, newItem.id);
    const newCanvas = (await destContext.store.list<ProjectCanvas>('canvases'))[0];
    assert.deepEqual(newCanvas.scene, canvas.scene);
    assert.notEqual(newCanvas.collectionId, collection.id);
    assert.equal(
      newCanvas.collectionId,
      (await destContext.store.list<CanvasCollection>('canvasCollections'))[0].id,
    );
    assert.equal(newCanvas.projectId, newRoot.id);
    const nextItem = (await dst('POST', '/items', { title: 'Next', projectId: newRoot.id })).json();
    assert.equal(nextItem.identifier, 'MOVE2-03');
    const again = (await dst('GET', `/projects/${newRoot.id}/export`)).json();
    assert.equal(
      again.activity.find((a: Activity) => a.kind === 'comment' && a.body === 'Original discussion')
        .importedFrom.authorName,
      'Former contributor',
    );
    assert.equal(again.projectUpdates.length, 3);
    assert(
      again.projectUpdates
        .filter((u: ProjectUpdate) => u.projectId === newRoot.id)
        .every((u: ProjectUpdate) => u.importedFrom?.authorName === 'Original'),
    );
    assert.deepEqual(
      again.projectUpdates
        .filter((u: ProjectUpdate) => u.projectId === newRoot.id)
        .map((u: ProjectUpdate) => u.sortKey)
        .sort(),
      [updateOne.id, updateTwo.id].sort(),
    );
    const sourceAfter = (await src('GET', `/projects/${project.id}/export`)).json();
    delete sourceAfter.exportedAt;
    const sourceBefore = structuredClone(pack);
    delete sourceBefore.exportedAt;
    assert.deepEqual(sourceAfter, sourceBefore);
    // Read-only tokens cannot import; unprivileged users cannot export private projects.
    const token = (await dst('POST', '/tokens', { name: 'read', scope: 'read' })).json().token;
    assert.equal(
      (
        await dest.inject({
          method: 'POST',
          url: '/api/v1/project-import',
          headers: { authorization: `Bearer ${token}` },
          payload,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await dest.inject({ url: `/api/v1/projects/${newRoot.id}/export` })).statusCode,
      401,
    );
    const member = (
      await dst('POST', '/users', { name: 'Member', email: 'member@transfer.test', password })
    ).json();
    const login = await dest.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: member.email, password },
    });
    const memberCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    assert.equal(
      (await call(dest, memberCookie, 'GET', `/projects/${newRoot.id}/export`)).statusCode,
      404,
    );
    // Validation runs before writes and rejects corrupted hierarchies/references.
    const badPackages: any[] = [];
    const change = (fn: (p: any) => void) => {
      const p = structuredClone(pack);
      fn(p);
      badPackages.push(p);
    };
    change((p) => (p.items[0].milestoneId = randomUUID()));
    change(
      (p) =>
        (p.projects.find((project: Project) => project.roadmap).roadmap.features[0].projectIds = [
          randomUUID(),
        ]),
    );
    change(
      (p) =>
        (p.projects.find((project: Project) => project.roadmap).roadmap.features[0].milestoneIds = [
          randomUUID(),
        ]),
    );
    change(
      (p) =>
        (p.projects.find((project: Project) => project.roadmap).roadmap.features[0].itemIds = [
          randomUUID(),
        ]),
    );
    change(
      (p) => (p.items.find((i: WorkItem) => i.projectId === project.id).milestoneId = milestoneId),
    );
    change((p) => (p.version = 2));
    change((p) => p.projectUpdates.push(p.projectUpdates[0]));
    change((p) => (p.projectUpdates[0].projectId = randomUUID()));
    change((p) => (p.projectUpdates[0].authorId = randomUUID()));
    change((p) => (p.projectUpdates[0].health = 'invalid'));
    change((p) => (p.projectUpdates[0].body = '  '));
    change((p) => (p.projectUpdates[0].createdAt = 'not-a-date'));
    change((p) => p.projects.push(p.projects[0]));
    change((p) => (p.projects[0].parentId = p.projects[0].id));
    change((p) => (p.items[0].projectId = randomUUID()));
    change((p) => (p.items[0].parentId = p.items[0].id));
    change((p) => (p.links[0].url = 'javascript:alert(1)'));
    change((p) => (p.canvases[0].collectionId = randomUUID()));
    change((p) => (p.canvases[0].scene.files = {}));
    change((p) =>
      p.relations.push({
        ...p.relations[0],
        id: randomUUID(),
        itemId: p.relations[0].targetId,
        targetId: p.relations[0].itemId,
      }),
    );
    const snapshot = await destContext.store.list('projects');
    for (const invalid of badPackages) {
      const res = await dst('POST', '/project-import', {
        ...payload,
        package: invalid,
        requestId: randomUUID(),
      });
      assert.equal(res.statusCode, 400, res.body);
    }
    assert.deepEqual(await destContext.store.list('projects'), snapshot);
    assert.equal(
      (await dst('POST', '/project-import', { ...payload, requestId: randomUUID() })).statusCode,
      409,
    );
    assert.equal(
      (
        await dst('POST', '/project-import', {
          ...payload,
          options: { ...payload.options, assignees: { [srcUser.id]: randomUUID() } },
        })
      ).statusCode,
      409,
    );
    // Simulate an actual database failure after project/item inserts and verify rollback.
    const rollbackPack = structuredClone(pack);
    rollbackPack.links[0].title = 'Reject me';
    const rollbackOptions = (
      await dst('POST', '/project-import/preview', { package: rollbackPack })
    ).json().options;
    const rollbackPayload = {
      package: rollbackPack,
      options: rollbackOptions,
      requestId: randomUUID(),
    };
    await destContext.db.query(
      "ALTER TABLE entities ADD CONSTRAINT transfer_test_failure CHECK (collection <> 'links' OR data->>'title' <> 'Reject me')",
    );
    const failed = await dst('POST', '/project-import', rollbackPayload);
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual(await destContext.store.list('projects'), snapshot);
    assert.equal((await destContext.store.list('items')).length, 4);
    assert.equal((await destContext.store.list('projectUpdates')).length, 3);
    await destContext.db.query('ALTER TABLE entities DROP CONSTRAINT transfer_test_failure');
    assert.equal((await dst('POST', '/project-import', rollbackPayload)).statusCode, 201);
    // Ordinary members can import their own copies, with access checked on mappings.
    const memberReview = (
      await call(dest, memberCookie, 'POST', '/project-import/preview', { package: pack })
    ).json();
    memberReview.options.assignees[srcUser.id] = randomUUID();
    const invalidMapping = await call(dest, memberCookie, 'POST', '/project-import', {
      package: pack,
      options: memberReview.options,
      requestId: randomUUID(),
    });
    assert.equal(invalidMapping.statusCode, 400, invalidMapping.body);
    memberReview.options.assignees[srcUser.id] = member.id;
    const memberImport = await call(dest, memberCookie, 'POST', '/project-import', {
      package: pack,
      options: memberReview.options,
      requestId: randomUUID(),
    });
    assert.equal(memberImport.statusCode, 201, memberImport.body);
    assert.equal(
      (await destContext.store.get<Project>('projects', memberImport.json().projectId))?.ownerId,
      member.id,
    );
    // Legacy v1 packages omit this optional collection entirely.
    const legacy = structuredClone(pack);
    delete legacy.projectUpdates;
    legacy.items.forEach((i: WorkItem) => delete i.milestoneId);
    const legacyPreview = (
      await dst('POST', '/project-import/preview', { package: legacy })
    ).json();
    assert.equal(legacyPreview.counts.projectUpdates, 0);
    const legacyImport = await dst('POST', '/project-import', {
      package: legacy,
      options: legacyPreview.options,
      requestId: randomUUID(),
    });
    assert.equal(legacyImport.statusCode, 201, legacyImport.body);
    assert.deepEqual(
      (await dst('GET', `/projects/${legacyImport.json().projectId}/updates`)).json().data,
      [],
    );
    const nextPreview = (await dst('POST', '/project-import/preview', { package: again })).json();
    const nextImport = await dst('POST', '/project-import', {
      package: again,
      options: nextPreview.options,
      requestId: randomUUID(),
    });
    assert.equal(nextImport.statusCode, 201, nextImport.body);
    const nextUpdates = (
      await dst('GET', `/projects/${nextImport.json().projectId}/updates`)
    ).json().data;
    assert.deepEqual(
      nextUpdates.map((u: ProjectUpdate) => [u.sortKey, u.health, u.importedFrom]),
      importedUpdates.map((u) => [u.sortKey, u.health, u.importedFrom]),
    );
  } finally {
    await source.close();
    await dest.close();
  }
});
