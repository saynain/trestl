import { compareProjectUpdates } from '../../shared/project-updates';
import { blockingRelations } from '../../shared/dependencies';
import type { Bootstrap, Project, ProjectUpdate, WorkItem } from '../../shared/types';
import { descendants, isDone } from './model';
import { projectItems } from './progress';
export const projectHealth = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
export function latestProjectUpdates(updates: ProjectUpdate[]) {
  const latest = new Map<string, ProjectUpdate>();
  for (const update of updates) {
    const previous = latest.get(update.projectId);
    if (!previous || compareProjectUpdates(update, previous) < 0)
      latest.set(update.projectId, update);
  }
  return latest;
}
export function latestProjectUpdate(updates: ProjectUpdate[], projectId: string) {
  return latestProjectUpdates(updates).get(projectId);
}
export function updateIsStale(update: ProjectUpdate, now = Date.now()) {
  return now - new Date(update.createdAt).getTime() >= 7 * 86400000;
}
/** Compact age of an update for scan tables, such as "3d ago". */
export function updateAge(update: ProjectUpdate, now = Date.now()) {
  const days = Math.floor((now - Date.parse(update.createdAt)) / 86400000);
  if (days < 1) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
export function reviewProjects(
  projects: Project[],
  updates: ProjectUpdate[] | Map<string, ProjectUpdate>,
  now = Date.now(),
) {
  const latest = Array.isArray(updates) ? latestProjectUpdates(updates) : updates;
  const rank = (p: Project) => {
    const update = latest.get(p.id);
    return !update
      ? 2
      : update.health === 'off_track'
        ? 0
        : update.health === 'at_risk'
          ? 1
          : updateIsStale(update, now)
            ? 3
            : 4;
  };
  return projects
    .filter((p) => p.status === 'active')
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function calendarDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Evidence is computed only from the caller's visible bootstrap records. */
export function projectReviewEvidence(data: Bootstrap, projectId: string, now = Date.now()) {
  const projectIds = descendants(data.projects, projectId);
  const items = projectItems(data, projectId);
  const itemIds = new Set(items.map((item) => item.id));
  const latest = latestProjectUpdate(data.projectUpdates || [], projectId);
  const since = latest ? Date.parse(latest.createdAt) : now - 7 * 86400000;
  const today = calendarDay(new Date(now));
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  const through = calendarDay(nextWeek);
  const byDueDate = (a: (typeof items)[number], b: (typeof items)[number]) =>
    (a.dueDate || '').localeCompare(b.dueDate || '') || a.identifier.localeCompare(b.identifier);
  return {
    since: new Date(since).toISOString(),
    includesSubprojects: projectIds.size > 1,
    completed: items
      .filter((item) => {
        const completedAt = item.completedAt ? Date.parse(item.completedAt) : NaN;
        return item.status === 'done' && completedAt >= since && completedAt <= now;
      })
      .sort((a, b) => Date.parse(b.completedAt!) - Date.parse(a.completedAt!)),
    overdue: items
      .filter((item) => !isDone(item) && item.dueDate && item.dueDate < today)
      .sort(byDueDate),
    upcoming: items
      .filter(
        (item) => !isDone(item) && item.dueDate && item.dueDate >= today && item.dueDate <= through,
      )
      .sort(byDueDate),
    blockers: blockingRelations(data.relations || [], data.items).filter(
      (link) => itemIds.has(link.dependent.id) && link.state !== 'resolved',
    ),
    slippedMilestones: data.milestones
      .filter(
        (milestone) =>
          projectIds.has(milestone.projectId) &&
          !milestone.completed &&
          milestone.dueDate &&
          milestone.dueDate < today,
      )
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)),
  };
}
export type ProjectReviewEvidence = ReturnType<typeof projectReviewEvidence>;
/**
 * The weekly review is a shared screen: it lists only projects everyone in the
 * workspace can see. Private projects, and projects beneath them, are counted
 * but never shown.
 */
export function workspaceReviewProjects(
  data: Bootstrap,
  updates: ProjectUpdate[] | Map<string, ProjectUpdate>,
  now = Date.now(),
) {
  const active = reviewProjects(data.projects, updates, now);
  const projects = active.filter((project) => projectAudience(data, project.id) === null);
  return { projects, omittedPrivate: active.length - projects.length };
}
/** Scan-table facts, counted only from work shared with everyone who can see the project. */
export function projectReviewSummary(data: Bootstrap, projectId: string, now = Date.now()) {
  const evidence = projectReviewEvidence(data, projectId, now);
  const shared = projectDraftEvidence(evidence, data, projectId);
  const target = projectAudience(data, projectId);
  const projectIds = descendants(data.projects, projectId);
  const nextMilestone = data.milestones
    .filter(
      (milestone) =>
        projectIds.has(milestone.projectId) &&
        !milestone.completed &&
        containsAudience(projectAudience(data, milestone.projectId), target),
    )
    .sort(
      (a, b) =>
        (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    )[0];
  return {
    evidence,
    omittedRestricted: shared.omittedRestricted,
    blockers: shared.blockers.length,
    nextMilestone,
  };
}

// null means the whole workspace, including future members. Comparing only
// current users would incorrectly treat a private project as workspace-wide.
type Audience = Set<string> | null;
function intersectAudience(a: Audience, b: Audience): Audience {
  if (a === null) return b;
  if (b === null) return a;
  return new Set([...a].filter((id) => b.has(id)));
}
function projectAudience(
  data: Bootstrap,
  projectId: string,
  visited = new Set<string>(),
): Audience {
  if (visited.has(projectId)) return new Set();
  visited.add(projectId);
  const project = data.projects.find((entry) => entry.id === projectId);
  if (
    !project ||
    (project.workspaceId && data.workspace && project.workspaceId !== data.workspace.id)
  )
    return new Set();
  const audience: Audience =
    project.visibility === 'private'
      ? new Set([project.ownerId, ...(project.memberIds || [])])
      : null;
  return project.parentId
    ? intersectAudience(audience, projectAudience(data, project.parentId, visited))
    : audience;
}
function itemAudience(data: Bootstrap, item: WorkItem, visited = new Set<string>()): Audience {
  if (visited.has(item.id)) return new Set();
  visited.add(item.id);
  if (item.workspaceId && data.workspace && item.workspaceId !== data.workspace.id)
    return new Set();
  let audience: Audience = item.visibility === 'private' ? new Set([item.creatorId]) : null;
  if (item.projectId) audience = intersectAudience(audience, projectAudience(data, item.projectId));
  if (item.parentId) {
    const parent = data.items.find((entry) => entry.id === item.parentId);
    audience = intersectAudience(
      audience,
      parent ? itemAudience(data, parent, visited) : new Set(),
    );
  }
  return audience;
}
function containsAudience(source: Audience, target: Audience) {
  if (target !== null && target.size === 0) return false;
  if (source === null) return true;
  if (target === null) return false;
  return [...target].every((id) => source.has(id));
}
/** Public update drafts must not widen the audience of private work or children. */
export function projectDraftEvidence(
  evidence: ProjectReviewEvidence,
  data: Bootstrap,
  projectId: string,
) {
  const target = projectAudience(data, projectId);
  const shareItem = (item: WorkItem) => containsAudience(itemAudience(data, item), target);
  const completed = evidence.completed.filter(shareItem);
  const overdue = evidence.overdue.filter(shareItem);
  const upcoming = evidence.upcoming.filter(shareItem);
  const blockers = evidence.blockers.filter(
    ({ blocker, dependent }) => shareItem(blocker) && shareItem(dependent),
  );
  const slippedMilestones = evidence.slippedMilestones.filter((milestone) =>
    containsAudience(projectAudience(data, milestone.projectId), target),
  );
  return {
    ...evidence,
    completed,
    overdue,
    upcoming,
    blockers,
    slippedMilestones,
    omittedRestricted:
      completed.length !== evidence.completed.length ||
      overdue.length !== evidence.overdue.length ||
      upcoming.length !== evidence.upcoming.length ||
      blockers.length !== evidence.blockers.length ||
      slippedMilestones.length !== evidence.slippedMilestones.length,
  };
}
/** A proposed summary, never an automatically posted health assessment. */
export function projectEvidenceDraft(
  visibleEvidence: ProjectReviewEvidence,
  data: Bootstrap,
  projectId: string,
) {
  const evidence = projectDraftEvidence(visibleEvidence, data, projectId);
  const text = (value: string) => value.replace(/\s+/g, ' ').slice(0, 160);
  const work = (items: ProjectReviewEvidence['completed']) =>
    items.length
      ? [
          ...items.slice(0, 15).map((item) => `- ${item.identifier}: ${text(item.title)}`),
          ...(items.length > 15 ? [`- ${items.length - 15} more; see project work.`] : []),
        ].join('\n')
      : '- None recorded';
  return [
    `## Progress since ${evidence.since.slice(0, 10)}`,
    work(evidence.completed),
    '## Delivery risks',
    evidence.overdue.length
      ? `Overdue work:\n${work(evidence.overdue)}`
      : 'No overdue work recorded.',
    evidence.blockers.length
      ? `Dependencies:\n${evidence.blockers
          .slice(0, 15)
          .map(
            ({ blocker, dependent }) =>
              `- ${dependent.identifier} waits on ${blocker.identifier}: ${text(blocker.title)}`,
          )
          .join(
            '\n',
          )}${evidence.blockers.length > 15 ? `\n- ${evidence.blockers.length - 15} more; see project timeline.` : ''}`
      : 'No unresolved dependencies recorded.',
    evidence.slippedMilestones.length
      ? `Past-due milestones:\n${evidence.slippedMilestones
          .slice(0, 15)
          .map((milestone) => `- ${text(milestone.title)} (due ${milestone.dueDate})`)
          .join(
            '\n',
          )}${evidence.slippedMilestones.length > 15 ? `\n- ${evidence.slippedMilestones.length - 15} more; see project overview.` : ''}`
      : 'No past-due milestones recorded.',
    '## Next seven days',
    work(evidence.upcoming),
    '## Decisions and next steps',
    '- Add context and choose the project health before posting.',
  ].join('\n\n');
}
