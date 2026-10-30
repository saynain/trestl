import type { WorkItem } from './types';
export interface WorkProgress {
  /** Work still in scope: everything except canceled items. */
  total: number;
  done: number;
  /** Neither done nor canceled. */
  open: number;
  canceled: number;
}
/**
 * The one progress rule for projects, milestones and reviews. Only done counts
 * as completed; canceled work is reported separately and left out of the total,
 * so dropped scope neither inflates nor drags down progress. Each item counts once.
 */
export function workProgress(items: Iterable<WorkItem>): WorkProgress {
  const seen = new Set<string>();
  let total = 0;
  let done = 0;
  let canceled = 0;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.status === 'canceled') canceled++;
    else {
      total++;
      if (item.status === 'done') done++;
    }
  }
  return { total, done, open: total - done, canceled };
}
