import { workProgress, type WorkProgress } from '../../shared/progress';
import type { Bootstrap } from '../../shared/types';
import { descendants } from './model';

/**
 * A project's work: items in the project or a subproject, plus items related to
 * any of them. Each item appears once, however many of those projects it touches.
 * Computed only from the caller's visible bootstrap records.
 */
export function projectItems(
  data: Pick<Bootstrap, 'projects' | 'items' | 'projectRelations'>,
  projectId: string,
) {
  const projectIds = descendants(data.projects, projectId);
  const linkedIds = new Set(
    (data.projectRelations || [])
      .filter((link) => projectIds.has(link.projectId))
      .map((link) => link.itemId),
  );
  const seen = new Set<string>();
  return data.items.filter((item) => {
    const inScope = (!!item.projectId && projectIds.has(item.projectId)) || linkedIds.has(item.id);
    if (!inScope || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
export function projectProgress(
  data: Pick<Bootstrap, 'projects' | 'items' | 'projectRelations'>,
  projectId: string,
) {
  return workProgress(projectItems(data, projectId));
}
export function progressLabel({ done, total, canceled }: WorkProgress) {
  return `${done} of ${total} done${canceled ? ` · ${canceled} canceled` : ''}`;
}
