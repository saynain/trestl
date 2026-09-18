import type { WorkItem } from '../../shared/types';

/** Candidates are already authorized by bootstrap; exclude every selected subtree. */
export function parentCandidates(items: WorkItem[], movingIds: readonly string[]) {
  const excluded = new Set(movingIds);
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const siblings = children.get(item.parentId) || [];
    siblings.push(item.id);
    children.set(item.parentId, siblings);
  }
  const pending = [...excluded];
  while (pending.length) {
    for (const child of children.get(pending.pop()!) || []) {
      if (excluded.has(child)) continue;
      excluded.add(child);
      pending.push(child);
    }
  }
  return items.filter((item) => !excluded.has(item.id));
}

/** Keep filtered children discoverable when their parent is outside the visible board. */
export function parentBoardItems(items: WorkItem[]) {
  const visible = new Set(items.map((item) => item.id));
  return items.filter((item) => !item.parentId || !visible.has(item.parentId));
}

export function childProgress(items: WorkItem[]) {
  const progress = new Map<string, { total: number; done: number }>();
  for (const item of items) {
    if (!item.parentId) continue;
    const count = progress.get(item.parentId) || { total: 0, done: 0 };
    count.total++;
    if (item.status === 'done') count.done++;
    progress.set(item.parentId, count);
  }
  return progress;
}
