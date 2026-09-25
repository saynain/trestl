import type { Project, User } from '../../shared/types';

/** The audience is the intersection of the project's and each ancestor's access. */
export function projectAccessMembers(project: Project, projects: Project[], users: User[]): User[] {
  const byId = new Map(projects.map((entry) => [entry.id, entry]));
  const ancestors: Project[] = [];
  const visited = new Set<string>();
  let current: Project | undefined = project;
  while (current) {
    if (visited.has(current.id)) return [];
    visited.add(current.id);
    ancestors.push(current);
    if (!current.parentId) break;
    current = byId.get(current.parentId);
    if (!current) return [];
  }
  return users
    .filter((user) =>
      ancestors.every(
        (entry) =>
          (entry.workspaceId ?? 'default') === (user.workspaceId ?? 'default') &&
          (entry.visibility !== 'private' ||
            entry.ownerId === user.id ||
            entry.memberIds?.includes(user.id)),
      ),
    )
    .sort((a, b) =>
      a.id === project.ownerId ? -1 : b.id === project.ownerId ? 1 : a.name.localeCompare(b.name),
    );
}

/** The project team is independent of visibility; ownership implies membership. */
export function projectTeamMembers(project: Project, users: User[]): User[] {
  return users
    .filter(
      (user) =>
        (project.workspaceId ?? 'default') === (user.workspaceId ?? 'default') &&
        (user.id === project.ownerId || project.memberIds?.includes(user.id)),
    )
    .sort((a, b) =>
      a.id === project.ownerId ? -1 : b.id === project.ownerId ? 1 : a.name.localeCompare(b.name),
    );
}
