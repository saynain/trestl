import type {
  WorkItem,
  Project,
  ProjectCanvas,
  CanvasCollection,
  Roadmap,
  Milestone,
  SavedView,
  ResourceLink,
  Bootstrap,
  ProjectUpdate,
} from '../../shared/types';
import { createDemoState } from './seed';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const clone = <T>(value: T): T => structuredClone(value);
const unavailable = () =>
  new ApiError(
    'This connection or account action needs your own Trestl installation. The demo uses sample data only; no external service is contacted.',
    403,
  );

/** No fetch, backend, credentials, or shared storage: each frame owns its demo state. */
export function createDemoApi() {
  const state = createDemoState();
  const { data } = state;
  let sequence = 100;
  let version = 1;
  const captures = new Map<string, { body: string; item: WorkItem }>();
  const id = () => `demo-new-${++sequence}`;
  const now = () => new Date().toISOString();
  function find<T extends { id: string }>(list: T[], key: string): T {
    const record = list.find((record) => record.id === key);
    if (!record)
      throw new ApiError('This demo record no longer exists. Reset the demo to start again.', 404);
    return record;
  }
  function revise<T extends { revision?: number }>(record: T, body: Record<string, unknown>) {
    if (body.expectedRevision !== undefined && body.expectedRevision !== (record.revision ?? 0))
      throw new ApiError('This record changed. Reopen it and try again.', 409);
    const {
      expectedRevision,
      undoCompletion: ignoredUndo,
      id: ignoredId,
      workspaceId: ignoredWorkspace,
      ...changes
    } = body;
    Object.assign(record, changes, { revision: (record.revision ?? 0) + 1 });
    return record;
  }
  function updateItem(item: WorkItem, body: Record<string, unknown>) {
    const result = revise(item, body);
    result.updatedAt = now();
    result.completedAt = result.status === 'done' ? item.completedAt || now() : null;
    state.activity.push({
      id: id(),
      itemId: item.id,
      userId: data.user.id,
      kind: 'event',
      body: 'Updated this work item',
      createdAt: now(),
    });
    return result;
  }
  function checkRevision(record: { revision?: number }, expectedRevision: unknown) {
    if (expectedRevision !== undefined && expectedRevision !== (record.revision ?? 0))
      throw new ApiError('This record changed. Reopen it and try again.', 409);
  }
  function pruneDeliveryLinks() {
    const access = {
      projectIds: new Set(data.projects.map((project) => project.id)),
      milestoneIds: new Set(data.milestones.map((milestone) => milestone.id)),
      itemIds: new Set(data.items.map((item) => item.id)),
    };
    for (const project of data.projects) {
      for (const feature of project.roadmap?.features || []) {
        for (const field of ['projectIds', 'milestoneIds', 'itemIds'] as const) {
          if (feature[field])
            feature[field] = feature[field]!.filter((id) => access[field].has(id));
        }
      }
    }
  }
  const connections = [
    {
      id: 'github-demo',
      name: 'GitHub · sample connection',
      provider: 'github',
      baseUrl: 'https://github.com',
      authType: 'github-app',
      shared: true,
    },
    {
      id: 'gitea-demo',
      name: 'Gitea · sample connection',
      provider: 'gitea',
      baseUrl: 'https://gitea.example.test',
      authType: 'token',
      shared: true,
    },
  ];
  async function request(path: string, options: RequestInit = {}): Promise<unknown> {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(path, 'https://demo.invalid');
    const parts = url.pathname.split('/').filter(Boolean);
    const [resource, key, child, childId] = parts;
    const method = (options.method ?? 'GET').toUpperCase();
    const body: Record<string, any> = options.body ? JSON.parse(String(options.body)) : {};
    if (url.pathname === '/auth/status' && method === 'GET')
      return {
        needsSetup: false,
        authenticated: true,
        authMode: 'local',
        installationName: data.workspace!.name,
      };
    if (url.pathname === '/bootstrap' && method === 'GET') return data;
    if (url.pathname === '/export' && method === 'GET')
      return {
        ...data,
        canvases: state.canvases,
        collections: state.collections,
        activity: state.activity,
      };
    if (url.pathname === '/git/connections' && method === 'GET') return connections;
    if (url.pathname === '/integrations' && method === 'GET')
      return {
        data: [
          {
            id: 'github-demo',
            name: 'Studio website · sample import',
            provider: 'github',
            repository: 'demo/studio-web',
            projectId: 'website',
            connectionId: 'github-demo',
            enabled: true,
            lastSyncAt: now(),
          },
        ],
      };
    if (url.pathname === '/tokens' && method === 'GET') return { data: [] };
    if (url.pathname === '/confluence/connection' && method === 'GET') return null;
    if (url.pathname === '/admin/authentication' && method === 'GET')
      return {
        mode: 'local',
        origin: '',
        issuer: '',
        clientId: '',
        allowedDomains: [],
        linkExistingEmails: [],
        clientSecretConfigured: false,
        proxySecretConfigured: false,
      };
    if (url.pathname === '/workspaces/current' && method === 'PATCH') {
      data.workspace!.name = String(body.name);
      return data.workspace;
    }
    if (resource === 'items') {
      if (key === 'batch' && method === 'POST') {
        const updates = body.updates as Record<string, unknown>[];
        const allowed = new Set(['id', 'expectedRevision', 'status', 'position', 'parentId']);
        if (
          !Array.isArray(updates) ||
          !updates.length ||
          updates.length > 1000 ||
          updates.some(
            (update) =>
              !update ||
              typeof update.id !== 'string' ||
              !Number.isInteger(update.expectedRevision) ||
              Number(update.expectedRevision) < 0 ||
              Object.keys(update).some((key) => !allowed.has(key)) ||
              !['status', 'position', 'parentId'].some((key) => key in update) ||
              (update.status !== undefined &&
                !['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'].includes(
                  String(update.status),
                )) ||
              (update.position !== undefined &&
                (typeof update.position !== 'number' || !Number.isFinite(update.position))) ||
              (update.parentId !== undefined &&
                update.parentId !== null &&
                typeof update.parentId !== 'string'),
          ) ||
          new Set(updates.map((update) => update.id)).size !== updates.length
        )
          throw new ApiError(
            'Choose valid, unique work items and planning changes for the batch.',
            400,
          );
        const proposed = new Map(data.items.map((item) => [item.id, clone(item)]));
        for (const update of updates) {
          const item = find(data.items, String(update.id));
          checkRevision(item, update.expectedRevision);
          Object.assign(proposed.get(item.id)!, update);
        }
        for (const item of proposed.values()) {
          const visited = new Set([item.id]);
          let cursor = item;
          while (cursor.parentId) {
            const parent = proposed.get(cursor.parentId);
            if (!parent || parent.projectId !== item.projectId || visited.has(parent.id))
              throw new ApiError(
                'Subtasks must have a parent in the same project and cannot form a cycle.',
                400,
              );
            visited.add(parent.id);
            cursor = parent;
          }
        }
        return {
          data: updates.map((update) => updateItem(find(data.items, String(update.id)), update)),
        };
      }
      if (!key && method === 'GET') return { data: data.items };
      if (!key && method === 'POST') {
        const captureKey = new Headers(options.headers).get('Idempotency-Key');
        const submittedBody = JSON.stringify(body);
        const previous = captureKey ? captures.get(captureKey) : undefined;
        if (previous) {
          if (previous.body !== submittedBody)
            throw new ApiError('Use a new retry key for a changed capture.', 409);
          return previous.item;
        }
        const newId = id();
        const project = data.projects.find((p) => p.id === body.projectId);
        const item: WorkItem = {
          id: newId,
          identifier: `${project?.key ?? 'IN'}-${sequence}`,
          revision: 1,
          workspaceId: 'demo',
          title: String(body.title || 'Untitled task'),
          description: '',
          projectId: null,
          parentId: null,
          type: 'task',
          status: 'todo',
          priority: 'none',
          assigneeId: null,
          startDate: null,
          dueDate: null,
          followUpDate: null,
          recurrence: null,
          labels: [],
          visibility: 'workspace',
          creatorId: data.user.id,
          createdAt: now(),
          updatedAt: now(),
          completedAt: null,
          position: data.items.length,
          ...body,
        };
        data.items.push(item);
        if (captureKey) captures.set(captureKey, { body: submittedBody, item: clone(item) });
        return item;
      }
      const item = find(data.items, key);
      if (!child && method === 'GET')
        return {
          item,
          activity: state.activity.filter((a) => a.itemId === key),
          relations: data.relations!.filter((r) => r.itemId === key || r.targetId === key),
          links: data.links.filter((l) => l.itemId === key),
        };
      if (!child && method === 'PATCH') {
        return { item: updateItem(item, body) };
      }
      if (!child && method === 'DELETE') {
        checkRevision(item, body.expectedRevision);
        const removed = new Set([key]);
        let changed = true;
        while (changed) {
          changed = false;
          data.items.forEach((i) => {
            if (i.parentId && removed.has(i.parentId) && !removed.has(i.id)) {
              removed.add(i.id);
              changed = true;
            }
          });
        }
        data.items = data.items.filter((i) => !removed.has(i.id));
        data.relations = data.relations!.filter(
          (r) => !removed.has(r.itemId) && !removed.has(r.targetId),
        );
        data.links = data.links.filter((l) => !l.itemId || !removed.has(l.itemId));
        state.activity = state.activity.filter((a) => !removed.has(a.itemId));
        pruneDeliveryLinks();
        return;
      }
      if (child === 'comments' && method === 'POST') {
        const entry = {
          id: id(),
          itemId: key,
          userId: data.user.id,
          kind: 'comment' as const,
          body: String(body.body),
          createdAt: now(),
        };
        state.activity.push(entry);
        return entry;
      }
      if (child === 'relations' && method === 'POST') {
        find(data.items, body.targetId);
        if (body.targetId === key) throw new ApiError('A task cannot depend on itself.', 400);
        const relation = {
          id: id(),
          itemId: key,
          targetId: String(body.targetId),
          kind: body.kind === 'blocks' ? ('blocks' as const) : ('related' as const),
        };
        data.relations!.push(relation);
        return relation;
      }
      if (child === 'relations' && method === 'DELETE') {
        data.relations = data.relations!.filter((r) => r.id !== childId);
        return;
      }
    }
    if (resource === 'projects') {
      if (!key && method === 'GET') return { data: data.projects };
      if (!key && method === 'POST') {
        const project: Project = {
          id: id(),
          key: 'NEW',
          name: 'New project',
          workspaceId: 'demo',
          description: '',
          color: '#c45532',
          icon: 'folder',
          parentId: null,
          lifecycle: 'fixed',
          status: 'active',
          startDate: null,
          dueDate: null,
          visibility: 'workspace',
          ownerId: data.user.id,
          createdAt: now(),
          ...body,
        };
        data.projects.push(project);
        return project;
      }
      const project = find(data.projects, key);
      if (child === 'updates' && method === 'GET')
        return {
          data: (data.projectUpdates || []).filter((update) => update.projectId === project.id),
        };
      if (child === 'updates' && method === 'POST') {
        if (
          !['on_track', 'at_risk', 'off_track'].includes(body.health) ||
          typeof body.body !== 'string' ||
          !body.body.trim()
        )
          throw new ApiError('Choose project health and add an update.', 400);
        const update: ProjectUpdate = {
          id: id(),
          projectId: project.id,
          authorId: data.user.id,
          health: body.health,
          body: body.body.trim(),
          createdAt: now(),
        };
        (data.projectUpdates ??= []).push(update);
        return update;
      }
      if (!child && method === 'GET') return project;
      if (!child && method === 'PATCH') {
        Object.assign(project, body);
        return project;
      }
      if (!child && method === 'DELETE') {
        const removed = new Set([key]);
        let changed = true;
        while (changed) {
          changed = false;
          data.projects.forEach((p) => {
            if (p.parentId && removed.has(p.parentId) && !removed.has(p.id)) {
              removed.add(p.id);
              changed = true;
            }
          });
        }
        const itemIds = new Set(
          data.items.filter((i) => i.projectId && removed.has(i.projectId)).map((i) => i.id),
        );
        data.projects = data.projects.filter((p) => !removed.has(p.id));
        data.items = data.items.filter((i) => !itemIds.has(i.id));
        data.milestones = data.milestones.filter((m) => !removed.has(m.projectId));
        data.links = data.links.filter(
          (l) =>
            (!l.projectId || !removed.has(l.projectId)) && (!l.itemId || !itemIds.has(l.itemId)),
        );
        data.relations = data.relations!.filter(
          (r) => !itemIds.has(r.itemId) && !itemIds.has(r.targetId),
        );
        state.activity = state.activity.filter((a) => !itemIds.has(a.itemId));
        state.canvases = state.canvases.filter((c) => !removed.has(c.projectId));
        state.collections = state.collections.filter((c) => !removed.has(c.projectId));
        data.projectUpdates = data.projectUpdates?.filter(
          (update) => !removed.has(update.projectId),
        );
        pruneDeliveryLinks();
        return;
      }
      if (child === 'roadmap' && method === 'PATCH') {
        if (!Array.isArray(body.features)) throw new ApiError('Choose roadmap features.', 400);
        for (const feature of body.features) {
          for (const [field, records] of [
            ['projectIds', data.projects],
            ['milestoneIds', data.milestones],
            ['itemIds', data.items],
          ] as const) {
            if (
              feature[field] !== undefined &&
              (!Array.isArray(feature[field]) ||
                feature[field].some(
                  (key: unknown) =>
                    typeof key !== 'string' || !records.some((record) => record.id === key),
                ))
            )
              throw new ApiError('Choose delivery links available in this demo.', 400);
          }
        }
        project.roadmap ??= {
          revision: 0,
          headline: '',
          reviewNote: '',
          reviewedAt: null,
          features: [],
        };
        revise(project.roadmap, body);
        return project;
      }
      if (child === 'canvases' || child === 'canvas-collections') {
        const list: (ProjectCanvas | CanvasCollection)[] =
          child === 'canvases' ? state.canvases : state.collections;
        if (!childId && method === 'GET')
          return {
            data: list
              .filter((c) => c.projectId === key)
              .map((c) => {
                const { scene, ...summary } = c as ProjectCanvas;
                return summary;
              }),
          };
        if (!childId && method === 'POST') {
          const record = {
            id: id(),
            projectId: key,
            workspaceId: 'demo',
            revision: 1,
            createdAt: now(),
            updatedAt: now(),
            ...body,
            ...(child === 'canvases'
              ? {
                  title: String(body.title || 'Untitled canvas'),
                  createdBy: data.user.id,
                  updatedBy: data.user.id,
                  collectionId: body.collectionId ?? null,
                  scene: body.scene ?? {
                    elements: [],
                    appState: { viewBackgroundColor: '#ffffff' },
                    files: {},
                  },
                }
              : { name: String(body.name || 'New collection') }),
          };
          if (child === 'canvases') state.canvases.push(record as ProjectCanvas);
          else state.collections.push(record as CanvasCollection);
          return record;
        }
        const record = find(list, childId);
        if (method === 'GET') return record;
        if (method === 'PATCH') {
          revise(record, body);
          record.updatedAt = now();
          return record;
        }
        if (method === 'DELETE') {
          if (body.expectedRevision !== undefined && body.expectedRevision !== record.revision)
            throw new ApiError('This record changed. Reopen it and try again.', 409);
          if (child === 'canvases') state.canvases = state.canvases.filter((c) => c.id !== childId);
          else {
            state.collections = state.collections.filter((c) => c.id !== childId);
            state.canvases.forEach((c) => {
              if (c.collectionId === childId) {
                c.collectionId = null;
                c.revision++;
              }
            });
          }
          return;
        }
      }
    }
    if (resource === 'milestones' || resource === 'views' || resource === 'links') {
      const list: (Milestone | SavedView | ResourceLink)[] = data[resource];
      if (method === 'GET') return key ? find(list, key) : { data: list };
      if (!key && method === 'POST') {
        const record = {
          id: id(),
          ...(resource === 'milestones'
            ? { completed: false, dueDate: null, revision: 1 }
            : resource === 'views'
              ? { userId: data.user.id, icon: 'bookmark', filters: {}, layout: 'list' }
              : { projectId: null, itemId: null, kind: 'link' }),
          ...body,
        };
        list.push(record as Milestone | SavedView | ResourceLink);
        return record;
      }
      if (method === 'PATCH') {
        const record = find(list, key);
        if (resource === 'milestones') return revise(record as Milestone, body);
        Object.assign(record, body);
        return record;
      }
      if (method === 'DELETE') {
        const record = find(list, key);
        if (resource === 'milestones') checkRevision(record as Milestone, body.expectedRevision);
        const index = list.findIndex((r) => r.id === key);
        if (index >= 0) list.splice(index, 1);
        if (resource === 'milestones') {
          data.items.forEach((item) => {
            if (item.milestoneId === key) {
              item.milestoneId = null;
              item.revision = (item.revision ?? 0) + 1;
            }
          });
          pruneDeliveryLinks();
        }
        return;
      }
    }
    // Never fall back to the live API, even for a newly added product feature.
    throw unavailable();
  }
  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const result = await request(path, options);
    if (options.method && options.method.toUpperCase() !== 'GET') version++;
    return clone(result) as T;
  }
  return Object.assign(api, {
    async fetchBootstrap(etag?: string): Promise<{ data?: Bootstrap; etag?: string }> {
      const current = `"demo-${version}"`;
      return etag === current ? { etag: current } : { data: clone(data), etag: current };
    },
  });
}
export const api = createDemoApi();
export const fetchBootstrap = (etag?: string) => api.fetchBootstrap(etag);
export const post = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const remove = (path: string) => api<void>(path, { method: 'DELETE' });
