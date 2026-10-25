import type { Roadmap, RoadmapFeature, RoadmapHorizon } from '../../shared/types';

export interface RoadmapDraft {
  base: Roadmap;
  draft: RoadmapFeature;
  summary: Pick<Roadmap, 'headline' | 'reviewNote' | 'reviewedAt'>;
  order: string[];
}
const featureFields = [
  'title',
  'summary',
  'area',
  'horizon',
  'status',
  'scope',
  'rationale',
  'targetDate',
  'projectIds',
  'milestoneIds',
  'itemIds',
] as const;
const summaryFields = ['headline', 'reviewNote', 'reviewedAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fieldValue = (feature: RoadmapFeature, key: (typeof featureFields)[number]) =>
  ['projectIds', 'milestoneIds', 'itemIds'].includes(key) ? (feature[key] ?? []) : feature[key];
function changedFields(saved: RoadmapDraft, horizon: RoadmapHorizon) {
  const original = saved.base.features.find((feature) => feature.id === saved.draft.id) ?? {
    id: saved.draft.id,
    title: '',
    summary: '',
    area: '',
    horizon,
    status: '',
    scope: '',
    rationale: '',
    targetDate: null,
  };
  return featureFields.filter(
    (key) => !same(fieldValue(saved.draft, key), fieldValue(original, key)),
  );
}
export function isRoadmapDraftDirty(
  saved: RoadmapDraft,
  settings = false,
  horizon: RoadmapHorizon = 'current',
) {
  return settings
    ? summaryFields.some((key) => !same(saved.summary[key], saved.base[key]))
    : changedFields(saved, horizon).length > 0 ||
        !same(
          saved.order,
          saved.base.features.map((feature) => feature.id),
        );
}

/** Old untouched snapshots and edits already committed by another tab are not unfinished work. */
export function shouldRecoverRoadmapDraft(
  saved: RoadmapDraft,
  latest: Roadmap,
  settings = false,
  horizon: RoadmapHorizon = 'current',
) {
  if (!isRoadmapDraftDirty(saved, settings, horizon)) return false;
  if (settings)
    return summaryFields.some(
      (key) => !same(saved.summary[key], saved.base[key]) && !same(saved.summary[key], latest[key]),
    );
  const current = latest.features.find((feature) => feature.id === saved.draft.id);
  if (
    changedFields(saved, horizon).some(
      (key) => !current || !same(fieldValue(saved.draft, key), fieldValue(current, key)),
    )
  )
    return true;
  const orderChanged = !same(
    saved.order,
    saved.base.features.map((feature) => feature.id),
  );
  return (
    orderChanged &&
    !same(
      saved.order.filter((id) => latest.features.some((feature) => feature.id === id)),
      latest.features.map((feature) => feature.id).filter((id) => saved.order.includes(id)),
    )
  );
}
