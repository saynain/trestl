import type { Bootstrap, RoadmapFeature } from '../../shared/types';
import { descendants, today } from './model';

/** Derived only from the caller's bootstrap. Linking never changes editorial status. */
export function roadmapDelivery(feature: RoadmapFeature, data: Bootstrap, date = today()) {
  const projects = data.projects.filter((project) => feature.projectIds?.includes(project.id));
  const milestones = data.milestones.filter((milestone) =>
    feature.milestoneIds?.includes(milestone.id),
  );
  const projectIds = new Set(
    projects.flatMap((project) => [...descendants(data.projects, project.id)]),
  );
  const milestoneIds = new Set(milestones.map((milestone) => milestone.id));
  const itemIds = new Set(feature.itemIds ?? []);
  const items = data.items.filter(
    (item) =>
      itemIds.has(item.id) ||
      (!!item.projectId && projectIds.has(item.projectId)) ||
      (!!item.milestoneId && milestoneIds.has(item.milestoneId)),
  );
  const deliverables = items.filter((item) => item.status !== 'canceled');
  const unfinished = deliverables.filter((item) => item.status !== 'done');
  const openItemIds = new Set(unfinished.map((item) => item.id));
  const visibleItems = new Map(data.items.map((item) => [item.id, item]));
  const blocked = new Set(
    (data.relations ?? [])
      .filter((relation) => {
        const blocker = visibleItems.get(relation.itemId);
        return (
          relation.kind === 'blocks' &&
          openItemIds.has(relation.targetId) &&
          blocker &&
          !['done', 'canceled'].includes(blocker.status)
        );
      })
      .map((relation) => relation.targetId),
  ).size;
  const overdue = unfinished.filter((item) => item.dueDate && item.dueDate < date).length;
  const slippedMilestones = milestones.filter(
    (milestone) => !milestone.completed && milestone.dueDate && milestone.dueDate < date,
  ).length;
  const targetAtRisk =
    !!feature.targetDate &&
    ((feature.targetDate < date &&
      (unfinished.length > 0 || milestones.some((m) => !m.completed))) ||
      unfinished.some((item) => item.dueDate && item.dueDate > feature.targetDate!) ||
      milestones.some((m) => !m.completed && m.dueDate && m.dueDate > feature.targetDate!));
  const done = deliverables.length - unfinished.length;
  return {
    projects,
    milestones,
    items,
    done,
    total: deliverables.length,
    linked: projects.length > 0 || milestones.length > 0 || items.length > 0,
    overdue,
    blocked,
    slippedMilestones,
    targetAtRisk,
    atRisk: overdue > 0 || blocked > 0 || slippedMilestones > 0 || targetAtRisk,
  };
}
