import type { WorkItem } from '../../shared/types';
import { isDone, isMyWork, priorities, today } from './model';

export type HomeSection = 'attention' | 'continuing' | 'next' | 'someday';

export function homeSection(item: WorkItem, date = today()): HomeSection {
  // A real deadline always takes precedence over a postponed review.
  if (item.dueDate && item.dueDate <= date) return 'attention';
  if (item.followUpDate && item.followUpDate <= date) return 'attention';
  if (item.status === 'in_progress' || item.status === 'in_review') return 'continuing';
  if (item.followUpDate) return 'next';
  if (item.status === 'backlog' && !item.dueDate) return 'someday';
  return 'next';
}

export function nextHomeDate(item: WorkItem) {
  return [item.dueDate, item.followUpDate].filter((d): d is string => !!d).sort()[0] ?? null;
}

export function homeItems(items: WorkItem[], userId: string) {
  return items
    .filter((item) => isMyWork(item, userId) && !isDone(item))
    .sort((a, b) => {
      const dateOrder = (nextHomeDate(a) || '9999-12-31').localeCompare(
        nextHomeDate(b) || '9999-12-31',
      );
      return (
        dateOrder ||
        priorities.findIndex((p) => p.id === a.priority) -
          priorities.findIndex((p) => p.id === b.priority) ||
        a.position - b.position ||
        a.id.localeCompare(b.id)
      );
    });
}

export function tomorrow(date = today()) {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
}

/** Personal planning stays scoped to this workspace, profile and calendar day. */
export function homeTodayKey(workspaceId: string, userId: string, date = today()) {
  return `trestl.today.v1.${workspaceId}.${userId}.${date}`;
}

export function readHomeToday(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === 'string'))]
      : [];
  } catch {
    return [];
  }
}

export function saveHomeToday(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Planning still works during this visit when browser storage is unavailable.
  }
}
