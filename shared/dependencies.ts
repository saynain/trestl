import type { Relation, WorkItem } from './types';

export type DependencyState = 'resolved' | 'conflict' | 'undated' | 'waiting';
const finished = (item: WorkItem) => item.status === 'done' || item.status === 'canceled';
/** Blocks means finish-to-start, with inclusive calendar dates. */
export function dependencyState(blocker: WorkItem, dependent: WorkItem): DependencyState {
  if (finished(blocker) || finished(dependent)) return 'resolved';
  const start = dependent.startDate || dependent.dueDate;
  if (!blocker.dueDate || !start) return 'undated';
  return start <= blocker.dueDate ? 'conflict' : 'waiting';
}
export function blockingRelations(relations: Relation[], items: WorkItem[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return relations.flatMap((relation) => {
    const blocker = byId.get(relation.itemId);
    const dependent = byId.get(relation.targetId);
    return relation.kind === 'blocks' && blocker && dependent
      ? [{ relation, blocker, dependent, state: dependencyState(blocker, dependent) }]
      : [];
  });
}
export function scheduleConflicts(item: WorkItem, items: WorkItem[], relations: Relation[]) {
  return blockingRelations(
    relations,
    items.map((other) => (other.id === item.id ? item : other)),
  ).filter(
    (link) =>
      (link.blocker.id === item.id || link.dependent.id === item.id) && link.state === 'conflict',
  );
}
export function createsDependencyCycle(
  relations: Relation[],
  blockerId: string,
  dependentId: string,
) {
  const outgoing = new Map<string, string[]>();
  for (const relation of relations)
    if (relation.kind === 'blocks') {
      outgoing.set(relation.itemId, [...(outgoing.get(relation.itemId) || []), relation.targetId]);
    }
  const pending = [dependentId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === blockerId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(outgoing.get(id) || []));
  }
  return false;
}
