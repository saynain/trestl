import type { Bootstrap, WorkItem } from '../../shared/types';

/** Apply acknowledged writes without replacing unrelated work or regressing a newer revision. */
export function applyBootstrapItems(
  data: Bootstrap,
  changes: WorkItem[],
  removed: string[] = [],
): Bootstrap {
  const workspaceId = data.user.workspaceId ?? 'default';
  const byId = new Map(
    changes
      .filter((item) => (item.workspaceId ?? 'default') === workspaceId)
      .map((item) => [item.id, item]),
  );
  const deleted = new Set(removed);
  const items = data.items
    .filter((item) => !deleted.has(item.id))
    .map((item) => {
      const next = byId.get(item.id);
      byId.delete(item.id);
      return next && (next.revision ?? 0) >= (item.revision ?? 0) ? next : item;
    });
  items.push(...byId.values());
  return {
    ...data,
    items,
    milestones: data.milestones.map((milestone) => {
      const linked = items.filter(
        (item) => item.milestoneId === milestone.id && item.projectId === milestone.projectId,
      );
      return {
        ...milestone,
        itemIds: linked.map((item) => item.id),
        progress: {
          total: linked.length,
          done: linked.filter((item) => item.status === 'done').length,
        },
      };
    }),
  };
}
