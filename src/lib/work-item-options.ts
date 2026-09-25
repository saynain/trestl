import type { Project, WorkItem } from '../../shared/types';

export function workItemOptions(
  items: Pick<WorkItem, 'id' | 'identifier' | 'title' | 'projectId'>[],
  projects: Pick<Project, 'id' | 'name' | 'key'>[],
  {
    projectId,
    excludeItemId,
    query = '',
    limit,
  }: {
    projectId?: string | null;
    excludeItemId?: string;
    query?: string;
    limit?: number;
  } = {},
) {
  const projectNames = new Map(
    projects.map((project) => [project.id, `${project.name} (${project.key})`]),
  );
  const search = query.trim().toLowerCase();
  // Items already come from the access-controlled bootstrap. Keep every eligible
  // project available and preserve its existing order within each priority group.
  return items
    .filter((item) => item.id !== excludeItemId)
    .map((item) => ({
      id: item.id,
      projectId: item.projectId,
      label: item.identifier,
      detail: `${item.title} · ${item.projectId ? projectNames.get(item.projectId) || 'Unavailable project' : 'Personal inbox'}`,
    }))
    .filter((option) => `${option.label} ${option.detail}`.toLowerCase().includes(search))
    .sort(
      (a, b) =>
        Number(!!projectId && b.projectId === projectId) -
        Number(!!projectId && a.projectId === projectId),
    )
    .slice(0, limit);
}
