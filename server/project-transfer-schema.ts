import { z } from 'zod';
import { canvasScene } from './canvases.ts';
import { roadmapUpdate } from './roadmap.ts';

export const transferLimit = 32 * 1024 * 1024;
const id = z.string().uuid();
const title = z.string().trim().min(1).max(240);
const text = z.string().max(100000);
const stamp = z.iso.datetime({ offset: true });
const date = z.iso.date().nullable();
const visibility = z.enum(['private', 'workspace']);
const url = z
  .url()
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }, 'Use a web link without embedded credentials');
export const projectKey = z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/);
const author = z.object({ authorName: title, identifier: z.string().max(100).optional() }).strict();
const project = z
  .object({
    id,
    key: projectKey,
    name: title,
    description: text,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    icon: z.string().max(40),
    parentId: id.nullable(),
    lifecycle: z.enum(['ongoing', 'fixed']),
    status: z.enum(['active', 'planned', 'completed', 'archived']),
    startDate: date,
    dueDate: date,
    visibility,
    ownerId: id,
    createdAt: stamp,
    roadmap: roadmapUpdate
      .omit({ expectedRevision: true })
      .extend({ revision: z.number().int().nonnegative() })
      .optional(),
  })
  .strip();
const item = z
  .object({
    id,
    identifier: z.string().min(1).max(100),
    title,
    description: text,
    projectId: id,
    parentId: id.nullable(),
    type: z.enum(['task', 'bug', 'idea', 'followup']),
    status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled']),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
    assigneeId: id.nullable(),
    creatorId: id,
    startDate: date.optional(),
    dueDate: date,
    followUpDate: date,
    recurrence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
    labels: z.array(z.string().min(1).max(40)).max(30),
    visibility,
    createdAt: stamp,
    updatedAt: stamp,
    completedAt: stamp.nullable(),
    position: z.number().finite(),
    externalUrl: url.nullable().optional(),
    importedFrom: author.optional(),
  })
  .strip();
export const projectPackage = z
  .object({
    format: z.literal('trestl-project'),
    version: z.literal(1),
    exportedAt: stamp,
    rootProjectId: id,
    people: z.array(z.object({ id, name: title }).strict()).max(2000),
    projects: z.array(project).min(1).max(200),
    items: z.array(item).max(20000),
    activity: z
      .array(
        z
          .object({
            id,
            itemId: id,
            userId: id,
            kind: z.enum(['comment', 'event']),
            body: text,
            createdAt: stamp,
            importedFrom: author,
          })
          .strip(),
      )
      .max(100000),
    relations: z
      .array(
        z.object({ id, itemId: id, targetId: id, kind: z.enum(['blocks', 'related']) }).strict(),
      )
      .max(40000),
    links: z
      .array(
        z
          .object({
            id,
            projectId: id.nullable(),
            itemId: id.nullable(),
            title,
            url,
            kind: z.enum(['confluence', 'repository', 'link']),
          })
          .strict(),
      )
      .max(20000),
    milestones: z
      .array(z.object({ id, projectId: id, title, dueDate: date, completed: z.boolean() }).strip())
      .max(10000),
    canvasCollections: z
      .array(
        z.object({ id, projectId: id, name: title, createdAt: stamp, updatedAt: stamp }).strip(),
      )
      .max(2000),
    canvases: z
      .array(
        z
          .object({
            id,
            projectId: id,
            title,
            collectionId: id.nullable().optional(),
            scene: canvasScene,
            createdBy: id,
            updatedBy: id,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .strip(),
      )
      .max(1000),
    warnings: z.array(z.string().max(500)).max(20),
  })
  .strict();
export type ProjectPackage = z.infer<typeof projectPackage>;
export const importOptions = z
  .object({
    projects: z
      .array(z.object({ id, name: title, key: projectKey, visibility }).strict())
      .min(1)
      .max(200),
    assignees: z.record(id, id.nullable()),
  })
  .strict();

/** Validate all references before any writes; packages are untrusted input. */
export function validatePackage(data: ProjectPackage): string | null {
  const groups = [
    data.people,
    data.projects,
    data.items,
    data.activity,
    data.relations,
    data.links,
    data.milestones,
    data.canvases,
    data.canvasCollections,
  ];
  for (const group of groups)
    if (new Set(group.map((v) => v.id)).size !== group.length)
      return 'Duplicate IDs in project file';
  const projects = new Map(data.projects.map((v) => [v.id, v]));
  const items = new Map(data.items.map((v) => [v.id, v]));
  const people = new Set(data.people.map((v) => v.id));
  const collections = new Map(data.canvasCollections.map((v) => [v.id, v]));
  if (!projects.has(data.rootProjectId)) return 'Root project is missing';
  const acyclic = (nodes: { id: string; parentId: string | null }[]) => {
    const parents = new Map(nodes.map((v) => [v.id, v.parentId]));
    const done = new Set<string>();
    for (const node of nodes) {
      const visiting = new Set<string>();
      let current: string | null = node.id;
      while (current && !done.has(current)) {
        if (visiting.has(current) || !parents.has(current)) return false;
        visiting.add(current);
        current = parents.get(current)!;
      }
      for (const visited of visiting) done.add(visited);
    }
    return true;
  };
  if (
    data.projects.some((p) => (p.id === data.rootProjectId) !== (p.parentId === null)) ||
    !acyclic(data.projects) ||
    !acyclic(data.items)
  )
    return 'Invalid project or work item hierarchy';
  for (const p of data.projects) {
    if (!people.has(p.ownerId)) return 'Project owner is missing from people';
    if (p.startDate && p.dueDate && p.startDate > p.dueDate)
      return 'Project dates are out of order';
  }
  for (const i of data.items) {
    if (
      !projects.has(i.projectId) ||
      !people.has(i.creatorId) ||
      (i.assigneeId && !people.has(i.assigneeId))
    )
      return 'Work item references missing project or person';
    if (i.startDate && i.dueDate && i.startDate > i.dueDate)
      return 'Work item dates are out of order';
  }
  if (data.activity.some((a) => !items.has(a.itemId) || !people.has(a.userId)))
    return 'Activity references missing work item or person';
  if (
    data.relations.some(
      (r) => !items.has(r.itemId) || !items.has(r.targetId) || r.itemId === r.targetId,
    )
  )
    return 'Invalid work item relation';
  // A directed graph check avoids importing dependency cycles, including indirect ones.
  const edges = new Map<string, string[]>();
  const degrees = new Map(data.items.map((v) => [v.id, 0]));
  for (const r of data.relations.filter((r) => r.kind === 'blocks')) {
    const next = edges.get(r.itemId) ?? [];
    next.push(r.targetId);
    edges.set(r.itemId, next);
    degrees.set(r.targetId, degrees.get(r.targetId)! + 1);
  }
  const queue = [...degrees].filter(([, n]) => n === 0).map(([id]) => id);
  for (let n = 0; n < queue.length; n++)
    for (const next of edges.get(queue[n]!) ?? []) {
      degrees.set(next, degrees.get(next)! - 1);
      if (degrees.get(next) === 0) queue.push(next);
    }
  if (queue.length !== data.items.length) return 'Work item dependencies contain a cycle';
  if (
    data.links.some(
      (l) =>
        (!l.projectId && !l.itemId) ||
        (l.projectId && !projects.has(l.projectId)) ||
        (l.itemId && !items.has(l.itemId)),
    )
  )
    return 'Link references missing project or work item';
  if (
    [...data.milestones, ...data.canvases, ...data.canvasCollections].some(
      (v) => !projects.has(v.projectId),
    )
  )
    return 'Project content references a missing project';
  if (
    data.canvases.some(
      (c) =>
        !people.has(c.createdBy) ||
        !people.has(c.updatedBy) ||
        (c.collectionId && collections.get(c.collectionId)?.projectId !== c.projectId),
    )
  )
    return 'Invalid canvas collection or author';
  return null;
}
