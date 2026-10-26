import type { Activity, ActivityHeatmap, Project, ProjectUpdate, User, WorkItem } from './types.ts';

export interface ActivityHeatmapInput {
  /** Callers must first apply workspace, privacy, and optional project scope. */
  projects: readonly Project[];
  items: readonly WorkItem[];
  projectUpdates: readonly ProjectUpdate[];
  activity: readonly Activity[];
  users: readonly User[];
}

/** Count verified local actions once, using UTC calendar days rather than updatedAt snapshots. */
export function activityHeatmap(
  data: ActivityHeatmapInput,
  year: number,
  options: { userId?: string; now?: Date } = {},
): ActivityHeatmap {
  const current = options.now ?? new Date();
  if (!Number.isInteger(year) || year < 1970 || year > current.getUTCFullYear())
    throw new RangeError('Choose a calendar year between 1970 and the current UTC year');
  const days: ActivityHeatmap['days'] = [];
  for (
    const cursor = new Date(Date.UTC(year, 0, 1));
    cursor.getUTCFullYear() === year;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  )
    days.push({ date: cursor.toISOString().slice(0, 10), count: 0 });
  const counts = new Map(days.map((day) => [day.date, day]));
  const actors = new Set(data.users.map((user) => user.id));
  const items = new Map(data.items.map((item) => [item.id, item]));
  const projects = new Set(data.projects.map((project) => project.id));
  let total = 0;
  const native = (record: object) =>
    !('source' in record && record.source) && !('importedFrom' in record && record.importedFrom);
  const count = (actorId: string, timestamp: string) => {
    if (!actors.has(actorId) || (options.userId && actorId !== options.userId)) return;
    const parsed = new Date(timestamp);
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > current.getTime()) return;
    const day = counts.get(parsed.toISOString().slice(0, 10));
    if (!day) return;
    day.count++;
    total++;
  };
  for (const project of data.projects)
    if (native(project) && project.creationActorId)
      count(project.creationActorId, project.createdAt);
  for (const item of data.items) {
    const actor = item.creationActorId;
    if (native(item) && actor) count(actor, item.createdAt);
  }
  for (const update of data.projectUpdates)
    if (projects.has(update.projectId) && native(update)) count(update.authorId, update.createdAt);
  for (const entry of data.activity) {
    const item = items.get(entry.itemId);
    const legacyImport =
      item?.source &&
      entry.kind === 'event' &&
      /^Imported from (?:GitHub|Gitea) · /.test(entry.body);
    if (item && native(entry) && !legacyImport) count(entry.userId, entry.createdAt);
  }
  return { year, days, total };
}
