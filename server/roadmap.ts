import { z } from 'zod';

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
