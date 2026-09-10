import type { WorkItem } from '../../shared/types';
import { isDone, isMyWork, priorities, today } from './model';

export type HomeSection = 'attention' | 'next' | 'someday';

export function homeSection(item: WorkItem, date = today()): HomeSection {
  // A real deadline always takes precedence over a postponed review.
  if (item.dueDate && item.dueDate <= date) return 'attention';
  if (item.followUpDate) return item.followUpDate <= date ? 'attention' : 'next';
  if (item.status === 'in_progress' || item.status === 'in_review') return 'attention';
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
