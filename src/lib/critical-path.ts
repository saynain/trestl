import type { Relation, WorkItem } from '../../shared/types';
import { dayNumber } from './gantt';
import { isDone } from './model';

/** CPM forward/backward passes, using inclusive calendar-day durations.
 * Scope is unfinished project work plus its visible unfinished predecessors.
 * Dates provide durations, not fixed-start constraints; resource limits and gaps
 * are not modeled. Missing durations make the result explicitly partial.
 */
export function criticalPath(
  projectItems: WorkItem[],
  allItems: WorkItem[],
  relations: Relation[],
) {
  const all = new Map(allItems.map((item) => [item.id, item]));
  const incoming = new Map<string, string[]>();
  for (const relation of relations)
    if (relation.kind === 'blocks') {
      incoming.set(relation.targetId, [
        ...(incoming.get(relation.targetId) || []),
        relation.itemId,
      ]);
    }
  const scope = new Map<string, WorkItem>();
  const pending = projectItems.map((item) => item.id);
  while (pending.length) {
    const id = pending.pop()!;
    const item = all.get(id);
    if (!item || isDone(item) || scope.has(id)) continue;
    scope.set(id, item);
    pending.push(...(incoming.get(id) || []));
  }
  const durations = new Map<string, number>();
  const excluded: WorkItem[] = [];
  for (const item of scope.values()) {
    const duration = item.dueDate
      ? dayNumber(item.dueDate) - dayNumber(item.startDate || item.dueDate) + 1
      : NaN;
    if (Number.isFinite(duration) && duration > 0) durations.set(item.id, duration);
    else excluded.push(item);
  }
  const edges = relations.filter(
    (r) => r.kind === 'blocks' && scope.has(r.itemId) && scope.has(r.targetId),
  );
  const outgoing = new Map<string, string[]>();
  const indegree = new Map([...scope.keys()].map((id) => [id, 0]));
  for (const edge of edges) {
    outgoing.set(edge.itemId, [...(outgoing.get(edge.itemId) || []), edge.targetId]);
    indegree.set(edge.targetId, indegree.get(edge.targetId)! + 1);
  }
  const queue = [...scope.keys()].filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    order.push(id);
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const criticalIds = new Set<string>();
  const criticalRelations = new Set<string>();
  const float = new Map<string, number>();
  const result = {
    criticalIds,
    criticalRelations,
    float,
    excluded,
    duration: 0,
    externalCount: [...scope.keys()].filter((id) => !projectItems.some((item) => item.id === id))
      .length,
    status: 'empty' as 'empty' | 'cycle' | 'partial' | 'ready',
  };
  // Check the entire active graph, including undated nodes, before dropping any.
  if (order.length !== scope.size) return { ...result, status: 'cycle' as const };
  if (!durations.size) return result;
  const early = new Map<string, number>();
  let finish = 0;
  for (const id of order) {
    if (!durations.has(id)) continue;
    const start = Math.max(
      0,
      ...(incoming.get(id) || [])
        .filter((parent) => durations.has(parent))
        .map((parent) => (early.get(parent) || 0) + durations.get(parent)!),
    );
    early.set(id, start);
    finish = Math.max(finish, start + durations.get(id)!);
  }
  const late = new Map<string, number>();
  for (const id of [...order].reverse()) {
    if (!durations.has(id)) continue;
    const successors = (outgoing.get(id) || []).filter((next) => durations.has(next));
    const latestFinish = successors.length
      ? Math.min(...successors.map((next) => late.get(next)!))
      : finish;
    late.set(id, latestFinish - durations.get(id)!);
    const slack = late.get(id)! - early.get(id)!;
    float.set(id, slack);
    if (slack === 0) criticalIds.add(id);
  }
  for (const edge of edges)
    if (
      criticalIds.has(edge.itemId) &&
      criticalIds.has(edge.targetId) &&
      early.get(edge.itemId)! + durations.get(edge.itemId)! === early.get(edge.targetId)
    )
      criticalRelations.add(edge.id);
  return {
    ...result,
    duration: finish,
    status: excluded.length ? ('partial' as const) : ('ready' as const),
  };
}
