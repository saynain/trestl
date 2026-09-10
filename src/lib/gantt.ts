import type { WorkItem } from '../../shared/types';

// Calendar-day arithmetic in UTC avoids daylight-saving gaps and repeated hours.
const DAY = 86_400_000;
export function dayNumber(date: string) {
  return Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY);
}
export function dateAt(day: number) {
  return new Date(day * DAY).toISOString().slice(0, 10);
}
export function scheduleRange(item: Pick<WorkItem, 'startDate' | 'dueDate'>) {
  const start = item.startDate || item.dueDate;
  const end = item.dueDate || item.startDate;
  return start && end ? { start: dayNumber(start), end: dayNumber(end) } : null;
}
export function shiftSchedule(
  item: Pick<WorkItem, 'startDate' | 'dueDate'>,
  days: number,
  edge: 'move' | 'start' | 'end',
) {
  const range = scheduleRange(item);
  if (!range) return { startDate: null, dueDate: null };
  if (edge === 'start')
    return {
      startDate: dateAt(Math.min(range.start + days, range.end)),
      dueDate: item.dueDate || null,
    };
  if (edge === 'end')
    return {
      startDate: item.startDate || null,
      dueDate: dateAt(Math.max(range.end + days, range.start)),
    };
  return {
    startDate: item.startDate ? dateAt(range.start + days) : null,
    dueDate: item.dueDate ? dateAt(range.end + days) : null,
  };
}
