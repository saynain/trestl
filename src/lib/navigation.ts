import type { Bootstrap, Project } from '../../shared/types';
import type { Favorite } from './preferences';

export function hasFavorite(favorites: Favorite[], entry: Favorite): boolean {
  return favorites.some((favorite) => favorite.kind === entry.kind && favorite.id === entry.id);
}

export function toggleFavorite(favorites: Favorite[], entry: Favorite): Favorite[] {
  return hasFavorite(favorites, entry)
    ? favorites.filter((favorite) => favorite.kind !== entry.kind || favorite.id !== entry.id)
    : [...favorites, entry];
}

export function projectAncestors(projects: Project[], project: Project): Project[] {
  const ancestors: Project[] = [];
  const visited = new Set([project.id]);
  let parentId = project.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = projects.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  return ancestors;
}

export function favoriteEntries(data: Bootstrap, favorites: Favorite[]) {
  return favorites.flatMap((favorite) => {
    const project =
      favorite.kind === 'project'
        ? data.projects.find(
            (project) => project.id === favorite.id && project.status !== 'archived',
          )
        : undefined;
    const view =
      favorite.kind === 'view' ? data.views.find((view) => view.id === favorite.id) : undefined;
    return project || view ? [{ ...favorite, name: (project || view)!.name, project, view }] : [];
  });
}
