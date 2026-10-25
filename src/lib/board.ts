import type { Status, WorkItem } from '../../shared/types';
import { statuses } from './model';

export interface BoardColumn {
  id: Status;
  name: string;
  hidden: boolean;
}
export interface BoardPreferences {
  columns: BoardColumn[];
  compact: boolean;
  showLabels: boolean;
  showDone: boolean;
  collapseSubtasks: boolean;
}
export function defaultBoardPreferences(showDone = false): BoardPreferences {
  return {
    // `statuses` follows the workflow, so columns read left to right.
    columns: statuses.map(({ id, name }) => ({ id, name, hidden: false })),
    compact: false,
    showLabels: true,
    showDone,
    collapseSubtasks: false,
  };
}
export function parseBoardPreferences(value: string | null, showDone = false): BoardPreferences {
  const defaults = defaultBoardPreferences(showDone);
  try {
    const saved = JSON.parse(value || 'null');
    if (!saved || !Array.isArray(saved.columns)) return defaults;
    const columns: BoardColumn[] = [];
    for (const column of saved.columns) {
      const status = statuses.find((status) => status.id === column?.id);
      if (!status || columns.some((entry) => entry.id === status.id)) continue;
      columns.push({
        id: status.id,
        name:
          typeof column.name === 'string'
            ? column.name.trim().slice(0, 60) || status.name
            : status.name,
        hidden: column.hidden === true,
      });
    }
    columns.push(
      ...defaults.columns.filter((column) => !columns.some((entry) => entry.id === column.id)),
    );
    if (columns.every((column) => column.hidden)) columns[0].hidden = false;
    return {
      columns,
      compact: saved.compact === true,
      collapseSubtasks: saved.collapseSubtasks === true,
      showLabels: saved.showLabels !== false,
      showDone: typeof saved.showDone === 'boolean' ? saved.showDone : showDone,
    };
  } catch {
    return defaults;
  }
}
export function readBoardPreferences(key: string, fallback?: string, showDone = false) {
  try {
    return parseBoardPreferences(localStorage.getItem(key) ?? fallback ?? null, showDone);
  } catch {
    return parseBoardPreferences(fallback ?? null, showDone);
  }
}
export function saveBoardPreferences(key: string, preferences: BoardPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    // The current session remains usable when browser storage is unavailable.
  }
}
export function moveColumn(columns: BoardColumn[], id: string, target: string) {
  const from = columns.findIndex((column) => column.id === id);
  const to = columns.findIndex((column) => column.id === target);
  if (from < 0 || to < 0 || from === to) return columns;
  const next = [...columns];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Place an item before a sibling, or at the end. Rebalance only exhausted/tied ranks. */
export function boardMoveUpdates(
  items: WorkItem[],
  item: WorkItem,
  status: Status,
  beforeId: string | null,
) {
  const siblings = items
    .filter((entry) => entry.status === status && entry.id !== item.id)
    .sort((a, b) => a.position - b.position || b.createdAt.localeCompare(a.createdAt));
  const index = beforeId ? siblings.findIndex((entry) => entry.id === beforeId) : siblings.length;
  if (index < 0) return [];
  const previous = siblings[index - 1];
  const next = siblings[index];
  // A drop in the current slot must not create activity or change the item's rank.
  if (
    item.status === status &&
    (!previous || previous.position < item.position) &&
    (!next || item.position < next.position)
  )
    return [];
  const position =
    previous && next
      ? previous.position + (next.position - previous.position) / 2
      : previous
        ? previous.position + 1024
        : next
          ? next.position - 1024
          : 0;
  if (
    Number.isFinite(position) &&
    (!previous || position > previous.position) &&
    (!next || position < next.position)
  )
    return [{ item, status, position }];
  siblings.splice(index, 0, item);
  return siblings
    .map((entry, i) => ({ item: entry, status, position: i * 1024 }))
    .filter((entry) => entry.item.position !== entry.position || entry.item.status !== status);
}
