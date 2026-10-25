import { remapMentionIds } from '../shared/mentions.ts';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from './context.ts';
import type { Database, Store } from './db.ts';
import type {
  Project,
  ProjectUpdate,
  WorkItem,
  Activity,
  ResourceLink,
  Milestone,
  Relation,
  ProjectCanvas,
  CanvasCollection,
  User,
} from '../shared/types.ts';
import type { ProjectImportPreview, ProjectImportResult } from '../shared/project-transfer.ts';
import { sameWorkspace, workspaceOf, workspaceMembers } from './workspaces.ts';
import { nextItemIdentifier } from './item-identifiers.ts';
import { filterRoadmapReferences } from './roadmap.ts';
import {
  projectPackage,
  importOptions,
  transferLimit,
  validatePackage,
  type ProjectPackage,
} from './project-transfer-schema.ts';

const transferWarnings = [
  'Only content accessible to the exporting account is included. References outside the exported project tree are omitted.',
  'Projects are copied with new IDs and work item numbers. The source is unchanged; internal references are updated where their targets are included; external links keep their original URLs.',
  'Screenshots uploaded to work item descriptions or comments stay on the source installation. Re-upload them after import if needed.',
  'Integration credentials and memberships are excluded. Linked issues become independent work items with their original external URL; live synchronization must be configured separately.',
];
const importWarnings = [
  'You own all imported projects. Original author names and dates are retained as imported history; private work items belong to you.',
  'Projects default to private. Selecting Workspace shares that project with installation members, subject to parent privacy. Assignee mapping does not grant access to private projects.',
];

export function registerProjectTransfer(
  app: FastifyInstance,
  ctx: AppContext,
  mutate: <T>(fn: (store: Store, tx: Database) => Promise<T>) => Promise<T>,
) {
  const { requireUser, canProject, canItem, fail, id, now } = ctx;
  function parse(value: unknown) {
    const parsed = projectPackage.parse(value);
    if (Buffer.byteLength(JSON.stringify(parsed)) > transferLimit)
      fail(413, 'Project exceeds the 32 MB transfer limit. Export smaller subprojects separately.');
    const error = validatePackage(parsed);
    if (error) fail(400, error);
    return parsed;
  }
  app.get<{ Params: { id: string } }>('/api/v1/projects/:id/export', async (request, reply) => {
    const user = requireUser(request);
    const result = await mutate(async (s) => {
      if (!(await canProject(user, request.params.id, s))) fail(404, 'Project not found');
      const allProjects = await s.list<Project>('projects');
      const allItems = await s.list<WorkItem>('items');
      const projectCache = new Map(allProjects.map((p) => [p.id, p]));
      const itemCache = new Map(allItems.map((i) => [i.id, i]));
      const snapshot: Store = {
        ...s,
        get: async <T>(collection: string, key: string): Promise<T | null> => {
          if (collection === 'projects') return (projectCache.get(key) as T | undefined) ?? null;
          if (collection === 'items') return (itemCache.get(key) as T | undefined) ?? null;
          return s.get<T>(collection, key);
        },
      };
      const selected = new Set([request.params.id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const p of allProjects)
          if (
            !selected.has(p.id) &&
            p.parentId &&
            selected.has(p.parentId) &&
            (await canProject(user, p.id, snapshot))
          ) {
            selected.add(p.id);
            changed = true;
          }
      }
      const projects = allProjects
        .filter((p) => selected.has(p.id))
        .map((p) => ({ ...p, parentId: p.id === request.params.id ? null : p.parentId }));
      const items: WorkItem[] = [];
      for (const item of allItems)
        if (
          item.projectId &&
          selected.has(item.projectId) &&
          (await canItem(user, item.id, snapshot))
        )
          items.push(item);
      const itemIds = new Set(items.map((i) => i.id));
      const milestones = (await s.list<Milestone>('milestones')).filter((m) =>
        selected.has(m.projectId),
      );
      const exportedAccess = {
        projectIds: selected,
        itemIds,
        milestoneIds: new Set(milestones.map((m) => m.id)),
      };
      for (const project of projects)
        if (project.roadmap)
          project.roadmap = filterRoadmapReferences(project.roadmap, exportedAccess);
      const members = await workspaceMembers(s, workspaceOf(user));
      const names = new Map(members.map((m) => [m.id, m.name]));
      const name = (userId: string) => names.get(userId) ?? 'Former member';
      const activity = (await s.list<Activity>('activity'))
        .filter((a) => itemIds.has(a.itemId))
        .map((a) => ({
          ...a,
          body:
            a.kind === 'event'
              ? a.body
                  .split(' · ')
                  .map((part) => {
                    const match = /^(assigneeId|projectId|parentId|milestoneId): (.+)$/.exec(part);
                    if (!match || match[2] === 'cleared') return part;
                    const label =
                      match[1] === 'assigneeId'
                        ? name(match[2])
                        : match[1] === 'projectId'
                          ? (projects.find((p) => p.id === match[2])?.name ?? 'another project')
                          : match[1] === 'milestoneId'
                            ? (milestones.find((m) => m.id === match[2])?.title ??
                              'another milestone')
                            : (items.find((i) => i.id === match[2])?.identifier ??
                              'another work item');
                    return `Changed ${match[1] === 'assigneeId' ? 'assignee' : match[1] === 'projectId' ? 'project' : match[1] === 'milestoneId' ? 'milestone' : 'parent item'} to ${label}`;
                  })
                  .join(' · ')
              : a.body,
          importedFrom: a.importedFrom ?? { authorName: a.source?.author || name(a.userId) },
        }));
      const canvases = (await s.list<ProjectCanvas>('canvases')).filter(
        (c) => selected.has(c.projectId) && sameWorkspace(user, c),
      );
      const projectUpdates = (await s.list<ProjectUpdate>('projectUpdates'))
        .filter((update) => selected.has(update.projectId))
        .map((update) => ({
          ...update,
          importedFrom: update.importedFrom ?? { authorName: name(update.authorId) },
        }));
      const peopleIds = new Set([
        ...projects.map((p) => p.ownerId),
        ...items.flatMap((i) => [i.creatorId, ...(i.assigneeId ? [i.assigneeId] : [])]),
        ...activity.map((a) => a.userId),
        ...projectUpdates.map((update) => update.authorId),
        ...canvases.flatMap((c) => [c.createdBy, c.updatedBy]),
      ]);
      const result = parse({
        format: 'trestl-project',
        version: 1,
        exportedAt: now(),
        rootProjectId: request.params.id,
        people: [...peopleIds].map((id) => ({ id, name: name(id) })),
        projects,
        items: items.map((i) => ({
          ...i,
          parentId: i.parentId && itemIds.has(i.parentId) ? i.parentId : null,
          externalUrl: i.externalUrl || i.source?.url || null,
          importedFrom: i.importedFrom ?? {
            authorName: name(i.creatorId),
            identifier: i.identifier,
          },
        })),
        activity,
        projectUpdates,
        relations: (await s.list<Relation>('relations')).filter(
          (r) => itemIds.has(r.itemId) && itemIds.has(r.targetId),
        ),
        links: (await s.list<ResourceLink>('links')).filter(
          (l) =>
            (l.projectId || l.itemId) &&
            (!l.projectId || selected.has(l.projectId)) &&
            (!l.itemId || itemIds.has(l.itemId)),
        ),
        milestones,
        canvases,
        canvasCollections: (await s.list<CanvasCollection>('canvasCollections')).filter(
          (c) => selected.has(c.projectId) && sameWorkspace(user, c),
        ),
        warnings: transferWarnings,
      });
      if (Buffer.byteLength(JSON.stringify(result)) > transferLimit - 65536)
        fail(
          413,
          'Project exceeds the 32 MB transfer limit. Export smaller subprojects separately.',
        );
      return result;
    });
    const root = result.projects.find((p) => p.id === result.rootProjectId)!;
    reply.header(
      'Content-Disposition',
      `attachment; filename="${root.key.toLowerCase()}.trestl-project.json"`,
    );
    return result;
  });

  async function preview(data: ProjectPackage, user: User): Promise<ProjectImportPreview> {
    const existing = (await ctx.store.list<Project>('projects')).filter((p) =>
      sameWorkspace(user, p),
    );
    const keys = new Set(existing.map((p) => p.key.toUpperCase()));
    const names = new Set(existing.map((p) => p.name.toLowerCase()));
    const projects = [...data.projects]
      .sort((a, b) =>
        a.id === data.rootProjectId
          ? -1
          : b.id === data.rootProjectId
            ? 1
            : a.name.localeCompare(b.name),
      )
      .map((p) => {
        let key = p.key,
          name = p.name,
          n = 2;
        while (keys.has(key)) {
          const suffix = String(n++);
          key = p.key.slice(0, 10 - suffix.length) + suffix;
        }
        n = 2;
        while (names.has(name.toLowerCase())) {
          const suffix = ` (import ${n++})`;
          name = p.name.slice(0, 240 - suffix.length) + suffix;
        }
        keys.add(key);
        names.add(name.toLowerCase());
        return { id: p.id, key, name, visibility: 'private' as const };
      });
    const assigned = new Set(data.items.flatMap((i) => (i.assigneeId ? [i.assigneeId] : [])));
    return {
      options: { projects, assignees: Object.fromEntries([...assigned].map((id) => [id, null])) },
      people: data.people.filter((p) => assigned.has(p.id)),
      counts: Object.fromEntries(
        [
          'projects',
          'items',
          'activity',
          'projectUpdates',
          'links',
          'relations',
          'milestones',
          'canvases',
          'canvasCollections',
        ].map((key) => [key, (data[key as keyof ProjectPackage] as unknown[]).length]),
      ),
      warnings: [...transferWarnings, ...importWarnings],
    };
  }
  app.post(
    '/api/v1/project-import/preview',
    { bodyLimit: transferLimit + 1024 * 1024 },
    async (request) => {
      const user = requireUser(request);
      const body = z.object({ package: projectPackage }).strict().parse(request.body);
      return preview(parse(body.package), user);
    },
  );
  app.post(
    '/api/v1/project-import',
    { bodyLimit: transferLimit + 1024 * 1024 },
    async (request, reply) => {
      const user = requireUser(request);
      const body = z
        .object({ package: projectPackage, options: importOptions, requestId: z.string().uuid() })
        .strict()
        .parse(request.body);
      const data = parse(body.package);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ package: data, options: body.options }))
        .digest('hex');
      const result = await mutate(async (s, tx) => {
        const receiptId = `project-import:${workspaceOf(user)}:${user.id}:${body.requestId}`;
        const previous = await s.get<{
          id: string;
          fingerprint: string;
          result: ProjectImportResult;
        }>('idempotency', receiptId);
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            fail(
              409,
              'This import request was already used with different content. Start a new import.',
            );
          return previous.result;
        }
        const members = (await workspaceMembers(s, workspaceOf(user))).filter((m) => !m.disabledAt);
        if (!members.some((m) => m.id === user.id))
          fail(403, 'Installation access is no longer available');
        const targets = new Set(members.map((m) => m.id));
        const sourcePeople = new Set(data.people.map((p) => p.id));
        for (const [source, target] of Object.entries(body.options.assignees))
          if (!sourcePeople.has(source) || (target && !targets.has(target)))
            fail(400, 'Choose active installation members for assignees');
        const options = new Map(body.options.projects.map((p) => [p.id, p]));
        if (
          options.size !== data.projects.length ||
          body.options.projects.length !== data.projects.length ||
          data.projects.some((p) => !options.has(p.id))
        )
          fail(400, 'Review every project in the file');
        const existing = (await s.list<Project>('projects')).filter((p) => sameWorkspace(user, p));
        const keys = new Set(existing.map((p) => p.key.toUpperCase()));
        const names = new Set(existing.map((p) => p.name.toLowerCase()));
        for (const option of options.values()) {
          if (keys.has(option.key) || names.has(option.name.toLowerCase()))
            fail(
              409,
              'A project name or key is already in use. Change it and retry, or load the file again for new suggestions.',
            );
          keys.add(option.key);
          names.add(option.name.toLowerCase());
        }
        const projectIds = new Map(data.projects.map((p) => [p.id, id()]));
        const itemIds = new Map(data.items.map((i) => [i.id, id()]));
        const milestoneIds = new Map(data.milestones.map((m) => [m.id, id()]));
        const canvasIds = new Map(data.canvases.map((c) => [c.id, id()]));
        const remap = (markdown: string) =>
          remapMentionIds(markdown, {
            project: projectIds,
            item: itemIds,
            milestone: milestoneIds,
            canvas: canvasIds,
          });
        const collectionIds = new Map(data.canvasCollections.map((c) => [c.id, id()]));
        const workspaceId = workspaceOf(user);
        for (const p of data.projects)
          await s.put<Project>('projects', {
            ...p,
            ...options.get(p.id)!,
            description: remap(p.description),
            id: projectIds.get(p.id)!,
            workspaceId,
            parentId: p.parentId ? projectIds.get(p.parentId)! : null,
            ownerId: user.id,
            creationActorId: null,
            memberIds: [],
            ...(p.roadmap
              ? {
                  roadmap: {
                    ...p.roadmap,
                    revision: 1,
                    features: p.roadmap.features.map((f) => ({
                      ...f,
                      id: id(),
                      ...(f.projectIds
                        ? { projectIds: f.projectIds.map((id) => projectIds.get(id)!) }
                        : {}),
                      ...(f.milestoneIds
                        ? { milestoneIds: f.milestoneIds.map((id) => milestoneIds.get(id)!) }
                        : {}),
                      ...(f.itemIds ? { itemIds: f.itemIds.map((id) => itemIds.get(id)!) } : {}),
                    })),
                  },
                }
              : {}),
          });
        const namesById = new Map(data.people.map((p) => [p.id, p.name]));
        for (const item of [...data.items].sort((a, b) =>
          a.identifier.localeCompare(b.identifier, undefined, { numeric: true }),
        )) {
          const projectId = projectIds.get(item.projectId)!;
          await s.put<WorkItem>('items', {
            ...item,
            description: remap(item.description),
            id: itemIds.get(item.id)!,
            workspaceId,
            projectId,
            identifier: await nextItemIdentifier(tx, projectId, workspaceId),
            parentId: item.parentId ? itemIds.get(item.parentId)! : null,
            milestoneId: item.milestoneId ? milestoneIds.get(item.milestoneId)! : null,
            creatorId: user.id,
            creationActorId: null,
            assigneeId: item.assigneeId ? (body.options.assignees[item.assigneeId] ?? null) : null,
            importedFrom: item.importedFrom ?? {
              authorName: namesById.get(item.creatorId)!,
              identifier: item.identifier,
            },
          });
        }
        for (const a of data.activity)
          await s.put<Activity>('activity', {
            ...a,
            body: remap(a.body),
            id: id(),
            itemId: itemIds.get(a.itemId)!,
            userId: user.id,
          });
        for (const update of data.projectUpdates)
          await s.put<ProjectUpdate>('projectUpdates', {
            ...update,
            body: remap(update.body),
            id: id(),
            sortKey: update.sortKey ?? update.id,
            projectId: projectIds.get(update.projectId)!,
            authorId: user.id,
          });
        for (const r of data.relations)
          await s.put<Relation>('relations', {
            ...r,
            id: id(),
            itemId: itemIds.get(r.itemId)!,
            targetId: itemIds.get(r.targetId)!,
          });
        for (const l of data.links)
          await s.put<ResourceLink>('links', {
            ...l,
            id: id(),
            projectId: l.projectId ? projectIds.get(l.projectId)! : null,
            itemId: l.itemId ? itemIds.get(l.itemId)! : null,
          });
        for (const m of data.milestones)
          await s.put<Milestone>('milestones', {
            ...m,
            id: milestoneIds.get(m.id)!,
            projectId: projectIds.get(m.projectId)!,
            revision: 1,
          });
        for (const c of data.canvasCollections)
          await s.put<CanvasCollection>('canvasCollections', {
            ...c,
            id: collectionIds.get(c.id)!,
            projectId: projectIds.get(c.projectId)!,
            workspaceId,
            revision: 1,
          });
        for (const c of data.canvases)
          await s.put<ProjectCanvas>('canvases', {
            ...c,
            id: canvasIds.get(c.id)!,
            projectId: projectIds.get(c.projectId)!,
            workspaceId,
            collectionId: c.collectionId ? collectionIds.get(c.collectionId)! : null,
            createdBy: user.id,
            updatedBy: user.id,
            revision: 1,
          });
        const result = {
          projectId: projectIds.get(data.rootProjectId)!,
          projectIds: [...projectIds.values()],
          itemCount: data.items.length,
        };
        await s.put('idempotency', { id: receiptId, fingerprint, result });
        return result;
      });
      return reply.code(201).send(result);
    },
  );
}
