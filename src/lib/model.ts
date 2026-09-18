import type { Bootstrap, Priority, Project, Status, WorkItem } from '../../shared/types';
export const statuses: { id: Status; name: string; color: string }[] = [
  { id: 'in_progress', name: 'In progress', color: '#d09335' },
  { id: 'todo', name: 'Todo', color: '#87919b' },
  { id: 'in_review', name: 'In review', color: '#9773be' },
  { id: 'backlog', name: 'Backlog', color: '#9da5af' },
  { id: 'done', name: 'Done', color: '#398665' },
  { id: 'canceled', name: 'Canceled', color: '#9da5af' },
];
export const priorities: { id: Priority; name: string; color: string }[] = [
  { id: 'urgent', name: 'Urgent', color: '#c85d50' },
  { id: 'high', name: 'High', color: '#c18a36' },
  { id: 'medium', name: 'Medium', color: '#7d8792' },
  { id: 'low', name: 'Low', color: '#a6afb8' },
  { id: 'none', name: 'No priority', color: '#b6bdc4' },
];
export const types = [
  { id: 'task', name: 'Task' },
  { id: 'bug', name: 'Bug' },
  { id: 'idea', name: 'Idea' },
  { id: 'followup', name: 'Follow-up' },
] as const;
export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
export function shortDate(value: string | null) {
  if (!value) return '';
  return new Date(value.slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
  });
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function isDone(item: WorkItem) {
  return item.status === 'done' || item.status === 'canceled';
}
/** Personal inbox captures remain yours even before you assign them. */
export function isMyWork(item: WorkItem, userId: string) {
  return (
    item.assigneeId === userId || (!item.projectId && !item.assigneeId && item.creatorId === userId)
  );
}
export function itemSearchText(item: WorkItem) {
  return [
    item.title,
    item.identifier,
    item.description,
    ...item.labels,
    item.source ? `${item.source.provider} ${item.source.repository} #${item.source.number}` : '',
  ]
    .join(' ')
    .toLowerCase();
}
export function isOverdue(item: WorkItem) {
  return !!item.dueDate && item.dueDate < today() && !isDone(item);
}
export function descendants(projects: Project[], id: string): Set<string> {
  const result = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    projects.forEach((p) => {
      if (p.parentId && result.has(p.parentId) && !result.has(p.id)) {
        result.add(p.id);
        changed = true;
      }
    });
  }
  return result;
}
export interface Route {
  page: string;
  id?: string;
  tab: string;
  itemId?: string;
  activityId?: string;
}
export function readRoute(): Route {
  if (window.location.pathname === '/cli-login') return { page: 'cli-login', tab: 'list' };
  const [path, search] = window.location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = path.split('/');
  const query = new URLSearchParams(search || '');
  return {
    page: page || 'home',
    id,
    tab: query.get('tab') || 'list',
    activityId: query.get('activity') || undefined,
    itemId: page === 'item' ? id : query.get('item') || undefined,
  };
}
export function navigate(page: string, id?: string, tab = 'list', itemId?: string) {
  const params = new URLSearchParams();
  if (tab !== 'list' || page === 'view') params.set('tab', tab);
  if (itemId) params.set('item', itemId);
  window.location.hash = `/${page}${id ? `/${id}` : ''}${params.size ? `?${params}` : ''}`;
}
export function filteredItems(data: Bootstrap, route: Route) {
  let items = data.items;
  if (route.page === 'project' && route.id) {
    const ids = descendants(data.projects, route.id);
    items = items.filter((i) => i.projectId && ids.has(i.projectId));
  }
  if (route.page === 'my-work' || route.page === 'home')
    items = items.filter((i) => isMyWork(i, data.user.id));
  if (route.page === 'inbox')
    items = items.filter((i) => !i.projectId && i.creatorId === data.user.id);
  if (route.page === 'view') {
    const view = data.views.find((v) => v.id === route.id);
    if (!view) return [];
    const filters = view.filters;
    if (filters.scope === 'my-work') items = items.filter((i) => isMyWork(i, data.user.id));
    if (filters.scope === 'inbox')
      items = items.filter((i) => !i.projectId && i.creatorId === data.user.id);
    if (filters.projectId) {
      const ids = descendants(data.projects, filters.projectId);
      items = items.filter((i) => i.projectId && ids.has(i.projectId));
    }
    if (filters.due === 'upcoming')
      items = items.filter((i) => i.dueDate && i.dueDate >= today() && !isDone(i));
    if (filters.followUp === 'true') items = items.filter((i) => i.followUpDate && !isDone(i));
  }
  return items;
}

/** Editable view filters are applied once, after the page's immutable scope. */
export function filterWorkItems(
  items: WorkItem[],
  userId: string,
  filters: Record<string, string>,
  showDone = false,
  hierarchyItems: WorkItem[] = items,
) {
  const parents = new Set(hierarchyItems.map((item) => item.parentId).filter(Boolean));
  const search = (filters.search || '').trim().toLowerCase();
  return items.filter(
    (item) =>
      (showDone || !!filters.status || !isDone(item)) &&
      (!filters.status || item.status === filters.status) &&
      (!filters.priority || item.priority === filters.priority) &&
      (!filters.assigneeId ||
        item.assigneeId === (filters.assigneeId === 'me' ? userId : filters.assigneeId)) &&
      (!filters.type || item.type === filters.type) &&
      (filters.hierarchy !== 'top-level' || !item.parentId) &&
      (filters.hierarchy !== 'subtasks' || !!item.parentId) &&
      (filters.hierarchy !== 'has-subtasks' || parents.has(item.id)) &&
      (!filters.parentId || item.parentId === filters.parentId) &&
      (!filters.tag ||
        item.labels.some((tag) => tag.toLowerCase() === filters.tag.toLowerCase())) &&
      (filters.untagged !== 'true' || item.labels.length === 0) &&
      (!filters.source ||
        (filters.source === 'native'
          ? !item.source
          : filters.source.startsWith('integration:')
            ? item.source?.integrationId === filters.source.slice('integration:'.length)
            : item.source?.provider === filters.source)) &&
      (!search || itemSearchText(item).includes(search)),
  );
}
/** An item belongs to every one of its tags; names are case-insensitive. */
export function groupWorkItemsByTag(items: WorkItem[]) {
  const groups = new Map<string, { id: string; name: string; items: WorkItem[] }>();
  const untagged: WorkItem[] = [];
  for (const item of items) {
    if (!item.labels.length) untagged.push(item);
    const seen = new Set<string>();
    for (const tag of item.labels) {
      const id = `tag:${tag.toLowerCase()}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const group = groups.get(id) || { id, name: tag, items: [] };
      group.items.push(item);
      groups.set(id, group);
    }
  }
  const result = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (untagged.length) result.push({ id: 'untagged', name: 'No tags', items: untagged });
  return result;
}
export function sortWorkItems(items: WorkItem[], filters: Record<string, string> = {}) {
  const dateField = filters.followUp === 'true' ? 'followUpDate' : filters.due ? 'dueDate' : null;
  return [...items].sort((a, b) => {
    if (dateField) {
      const comparison = (a[dateField] || '9999-12-31').localeCompare(b[dateField] || '9999-12-31');
      if (comparison) return comparison;
    }
    return a.position - b.position || b.createdAt.localeCompare(a.createdAt);
  });
}
