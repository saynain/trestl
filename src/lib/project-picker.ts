import type { Bootstrap, Project } from '../../shared/types';
import { navigate } from './model';
import { projectAncestors } from './navigation';
import type { Favorite } from './preferences';

/** Recently opened projects and the last view used in each, kept per profile in this browser. */
export interface ProjectHistory {
  recent: string[];
  views: Record<string, string>;
}
const recentLimit = 8;
const viewLimit = 100;
const historyKey = (userId: string) => `trestl.project-history.v1.${userId}`;

export function readProjectHistory(userId: string): ProjectHistory {
  try {
    const saved = JSON.parse(localStorage.getItem(historyKey(userId)) || 'null');
    const recent: string[] = Array.isArray(saved?.recent)
      ? [
          ...new Set<string>(
            saved.recent.filter((id: unknown): id is string => typeof id === 'string' && !!id),
          ),
        ].slice(0, recentLimit)
      : [];
    const views: Record<string, string> = {};
    if (saved?.views && typeof saved.views === 'object' && !Array.isArray(saved.views)) {
      for (const [id, tab] of Object.entries(saved.views)) {
        const view = typeof tab === 'string' ? rememberedTab(tab) : undefined;
        if (id && view) views[id] = view;
      }
    }
    return { recent, views };
  } catch {
    return { recent: [], views: {} };
  }
}

export function saveProjectHistory(userId: string, history: ProjectHistory) {
  try {
    localStorage.setItem(historyKey(userId), JSON.stringify(history));
  } catch {
    /* History is a convenience; navigation still works without storage. */
  }
}

/** The part of a project route worth restoring. Item panels and presentations are not. */
export function rememberedTab(tab: string): string | undefined {
  if (tab === 'roadmap-present') return 'roadmap';
  if (['overview', 'list', 'board', 'gantt', 'resources', 'canvases', 'roadmap'].includes(tab))
    return tab;
  if (/^(overview|canvases)\/[^/?#]+$/.test(tab)) return tab;
  return undefined;
}

export function recordProjectVisit(
  history: ProjectHistory,
  projectId: string,
  tab: string,
): ProjectHistory {
  const recent = [projectId, ...history.recent.filter((id) => id !== projectId)].slice(
    0,
    recentLimit,
  );
  const view = rememberedTab(tab);
  if (!view) return { recent, views: history.views };
  // Reinsert so the most recently used views survive trimming.
  const views = Object.entries(history.views).filter(([id]) => id !== projectId);
  views.push([projectId, view]);
  return { recent, views: Object.fromEntries(views.slice(-viewLimit)) };
}

/** Where to open a project: its last valid view, or Overview. */
export function projectDestination(
  data: Pick<Bootstrap, 'projects' | 'milestones' | 'canvases'>,
  history: ProjectHistory,
  projectId: string,
): string {
  const tab = history.views[projectId];
  if (!tab) return 'overview';
  const [section, id] = tab.split('/');
  if (!id) return tab;
  if (section === 'overview')
    return data.milestones.some(
      (milestone) => milestone.id === id && milestone.projectId === projectId,
    )
      ? tab
      : 'overview';
  return data.canvases?.some((canvas) => canvas.id === id && canvas.projectId === projectId)
    ? tab
    : 'canvases';
}

/** Open a project where the user left it, for navigation that switches between projects. */
export function openProject(data: Bootstrap, projectId: string) {
  navigate(
    'project',
    projectId,
    projectDestination(data, readProjectHistory(data.user.id), projectId),
  );
}

export interface ProjectPickerEntry {
  project: Project;
  /** Ancestor names, outermost first, so similar child names stay distinguishable. */
  path: string[];
  /** Private itself or inside a private parent. */
  restricted: boolean;
}
export interface ProjectPickerSection {
  id: 'recent' | 'favorites' | 'all' | 'matches';
  label: string;
  entries: ProjectPickerEntry[];
}

function compareEntries(a: ProjectPickerEntry, b: ProjectPickerEntry) {
  const left = [...a.path, a.project.name];
  const right = [...b.path, b.project.name];
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const order = left[index].localeCompare(right[index], undefined, { sensitivity: 'base' });
    if (order) return order;
  }
  return left.length - right.length || a.project.id.localeCompare(b.project.id);
}

/** Lower is better; undefined means the project does not match. */
function matchRank(entry: ProjectPickerEntry, query: string): number | undefined {
  const name = entry.project.name.toLowerCase();
  const key = entry.project.key.toLowerCase();
  const haystack = `${entry.path.join(' ')} ${name} ${key}`.toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.every((term) => haystack.includes(term))) return undefined;
  if (name.startsWith(query) || key === query) return 0;
  if (name.split(/[\s\-_/]+/).some((word) => word.startsWith(terms[0]))) return 1;
  if (name.includes(query)) return 2;
  if (key.startsWith(terms[0])) return 3;
  return 4;
}

/**
 * Picker contents built only from projects in the signed-in user's bootstrap, so stored
 * recents and favorites can never reveal a project the user cannot open.
 */
export function projectPickerSections(
  data: Pick<Bootstrap, 'projects'>,
  favorites: Favorite[],
  recent: string[],
  currentId?: string,
  query = '',
): ProjectPickerSection[] {
  const byId = new Map(data.projects.map((project) => [project.id, project]));
  const entries = new Map<string, ProjectPickerEntry>();
  for (const project of data.projects) {
    if (project.status === 'archived') continue;
    const ancestors = projectAncestors(data.projects, project);
    entries.set(project.id, {
      project,
      path: ancestors.map((ancestor) => ancestor.name),
      restricted: [...ancestors, project].some((entry) => entry.visibility === 'private'),
    });
  }
  const favoriteIds = favorites
    .filter((favorite) => favorite.kind === 'project')
    .map((favorite) => favorite.id);
  const pick = (ids: string[]) =>
    ids.flatMap((id) => {
      const entry = byId.has(id) ? entries.get(id) : undefined;
      return entry ? [entry] : [];
    });
  const search = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (search) {
    const recency = (id: string) => {
      const index = recent.indexOf(id);
      return index < 0 ? recent.length : index;
    };
    const matches = [...entries.values()]
      .map((entry) => ({ entry, rank: matchRank(entry, search) }))
      .filter((match): match is { entry: ProjectPickerEntry; rank: number } => match.rank != null)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          recency(a.entry.project.id) - recency(b.entry.project.id) ||
          Number(!favoriteIds.includes(a.entry.project.id)) -
            Number(!favoriteIds.includes(b.entry.project.id)) ||
          compareEntries(a.entry, b.entry),
      )
      .map((match) => match.entry);
    return [{ id: 'matches', label: 'Projects', entries: matches }];
  }
  return [
    {
      id: 'recent' as const,
      label: 'Recent',
      entries: pick(recent.filter((id) => id !== currentId)).slice(0, 5),
    },
    { id: 'favorites' as const, label: 'Favorites', entries: pick(favoriteIds) },
    {
      id: 'all' as const,
      label: 'All projects',
      entries: [...entries.values()].sort(compareEntries),
    },
  ].filter((section) => section.entries.length > 0);
}
