import type { WorkItem } from '../../shared/types';

export interface WorkTreeNode {
  item: WorkItem;
  children: WorkTreeNode[];
  childCount: number;
  completedChildren: number;
  matches: boolean;
}

/** Build branches from authorized items; scope determines which ancestors may be context. */
export function buildWorkTree(
  scope: WorkItem[],
  matches: WorkItem[],
  orderedItems: WorkItem[],
  filtered = false,
) {
  const byId = new Map(orderedItems.map((item) => [item.id, item]));
  const scoped = new Set(scope.map((item) => item.id));
  const matching = new Set(matches.map((item) => item.id));
  const children = new Map<string, WorkItem[]>();
  for (const item of byId.values()) {
    if (!item.parentId) continue;
    const siblings = children.get(item.parentId) || [];
    siblings.push(item);
    children.set(item.parentId, siblings);
  }
  const included = new Set(matching);
  for (const item of matches) {
    let parentId = item.parentId;
    const visited = new Set([item.id]);
    while (parentId && scoped.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      included.add(parentId);
      parentId = byId.get(parentId)?.parentId || null;
    }
  }
  // Opening a normal branch shows all subtasks, including completed children.
  // Explicit filters instead retain only matches and their ancestor context.
  if (!filtered) {
    const pending = [...included];
    while (pending.length) {
      for (const child of children.get(pending.pop()!) || []) {
        if (included.has(child.id)) continue;
        included.add(child.id);
        pending.push(child.id);
      }
    }
  }
  const nodes = new Map<string, WorkTreeNode>();
  for (const item of byId.values()) {
    if (!included.has(item.id)) continue;
    const direct = children.get(item.id) || [];
    nodes.set(item.id, {
      item,
      children: [],
      childCount: direct.length,
      completedChildren: direct.filter((child) => child.status === 'done').length,
      matches: matching.has(item.id),
    });
  }
  const roots: WorkTreeNode[] = [];
  const attached = new Map<string, string>();
  for (const node of nodes.values()) {
    const parent = node.item.parentId ? nodes.get(node.item.parentId) : undefined;
    // Defensive for old/imported malformed data, even though the API rejects cycles.
    let ancestor = parent?.item.id;
    while (ancestor && ancestor !== node.item.id) ancestor = attached.get(ancestor);
    if (parent && ancestor !== node.item.id) {
      parent.children.push(node);
      attached.set(node.item.id, parent.item.id);
    } else roots.push(node);
  }
  return { roots, nodes };
}

export function flattenWorkTree(roots: WorkTreeNode[], expanded: ReadonlySet<string>) {
  const result: {
    node: WorkTreeNode;
    depth: number;
    parentId?: string;
    position: number;
    setSize: number;
  }[] = [];
  const pending = roots
    .map((node, index) => ({
      node,
      depth: 0,
      parentId: undefined as string | undefined,
      position: index + 1,
      setSize: roots.length,
    }))
    .reverse();
  while (pending.length) {
    const row = pending.pop()!;
    result.push(row);
    if (!expanded.has(row.node.item.id)) continue;
    for (let i = row.node.children.length - 1; i >= 0; i--)
      pending.push({
        node: row.node.children[i],
        depth: row.depth + 1,
        parentId: row.node.item.id,
        position: i + 1,
        setSize: row.node.children.length,
      });
  }
  return result;
}
