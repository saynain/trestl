import { randomUUID } from 'node:crypto';
import type { Roadmap, RoadmapFeature } from '../shared/types.ts';
export function demoRoadmap(reviewedAt: string): Roadmap {
  const feature = (
    title: string,
    summary: string,
    area: string,
    horizon: RoadmapFeature['horizon'],
    status: string,
    rationale = '',
  ): RoadmapFeature => ({
    id: randomUUID(),
    title,
    summary,
    area,
    horizon,
    status,
    rationale,
    scope: '',
    targetDate: null,
  });
  return {
    revision: 1,
    headline: 'Safer operations now. A simpler developer experience next.',
    reviewedAt,
    reviewNote: 'Self-service onboarding moved to Up next',
    features: [
      feature(
        'Safer platform upgrades',
        'Reduce rollout risk and make recovery predictable.',
        'Reliability',
        'current',
        'In progress',
      ),
      feature(
        'Service ownership',
        'Make operational responsibility clear for every service.',
        'Operations',
        'current',
        'Needs a decision',
      ),
      feature(
        'Self-service onboarding',
        'Help teams launch services without manual setup.',
        'Developer experience',
        'next',
        'Scoped · awaiting capacity',
      ),
      feature(
        'SLO dashboards',
        'Agree how we measure and report service health.',
        'Reliability',
        'next',
        'Scope in progress',
      ),
      feature(
        'Preview environments',
        'Test changes safely before they reach production.',
        'Developer experience',
        'future',
        'Exploring',
      ),
      feature(
        'Cost visibility',
        'Understand spending by team and namespace.',
        'Efficiency',
        'future',
        'Scoped · no commitment',
      ),
      feature(
        'Multi-region platform',
        '',
        'Reliability',
        'deferred',
        '',
        'Reliability work takes precedence. Revisit when expansion requires it.',
      ),
      feature(
        'Custom developer portal',
        '',
        'Developer experience',
        'deferred',
        '',
        'Validate the standard onboarding path first.',
      ),
    ],
  };
}
