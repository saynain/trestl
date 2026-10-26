import { z } from 'zod';
import type { Roadmap, RoadmapFeature } from '../shared/types.ts';

const references = z
  .array(z.string().uuid())
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Delivery references must be unique')
  .optional();

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Invalid calendar date')
  .nullable();
export const roadmapUpdate = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    headline: z.string().trim().max(240),
    reviewNote: z.string().trim().max(500),
    reviewedAt: calendarDate,
    features: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: z.string().trim().min(1).max(120),
            summary: z.string().trim().max(240),
            area: z.string().trim().max(60),
            horizon: z.enum(['current', 'next', 'future', 'deferred']),
            status: z.string().trim().max(80),
            scope: z.string().trim().max(10000),
            rationale: z.string().trim().max(500),
            targetDate: calendarDate,
            projectIds: references,
            milestoneIds: references,
            itemIds: references,
          })
          .strict(),
      )
      .max(100)
      .refine(
        (features) => new Set(features.map((f) => f.id)).size === features.length,
        'Feature IDs must be unique',
      ),
  })
  .strict();

export interface RoadmapReferenceAccess {
  projectIds: ReadonlySet<string>;
  milestoneIds: ReadonlySet<string>;
  itemIds: ReadonlySet<string>;
}

/** Access sets must contain only records visible to the caller in the active workspace. */
export function validateRoadmapReferences(
  features: readonly RoadmapFeature[],
  access: RoadmapReferenceAccess,
): string | null {
  for (const feature of features)
    for (const kind of ['projectIds', 'milestoneIds', 'itemIds'] as const)
      if (feature[kind]?.some((id) => !access[kind].has(id)))
        return 'Choose accessible delivery records in this workspace';
  return null;
}

/** Remove hidden/deleted targets without exposing their identities in read responses. */
export function filterRoadmapReferences(roadmap: Roadmap, access: RoadmapReferenceAccess): Roadmap {
  return {
    ...roadmap,
    features: roadmap.features.map((feature) => ({
      ...feature,
      ...(feature.projectIds
        ? { projectIds: feature.projectIds.filter((id) => access.projectIds.has(id)) }
        : {}),
      ...(feature.milestoneIds
        ? { milestoneIds: feature.milestoneIds.filter((id) => access.milestoneIds.has(id)) }
        : {}),
      ...(feature.itemIds
        ? { itemIds: feature.itemIds.filter((id) => access.itemIds.has(id)) }
        : {}),
    })),
  };
}
