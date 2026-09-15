import { compareProjectUpdates } from '../../shared/project-updates';
import type { Project, ProjectUpdate } from '../../shared/types';
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
