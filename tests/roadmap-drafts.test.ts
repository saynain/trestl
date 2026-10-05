import test from 'node:test';
import assert from 'node:assert/strict';
import { demoRoadmap } from '../server/roadmap-demo.ts';
import {
  isRoadmapDraftDirty,
  shouldRecoverRoadmapDraft,
  type RoadmapDraft,
} from '../src/lib/roadmap-drafts.ts';

function snapshot(): RoadmapDraft {
  const base = demoRoadmap('2026-10-05');
  return {
    base,
    draft: { ...base.features[0] },
    summary: { headline: base.headline, reviewNote: base.reviewNote, reviewedAt: base.reviewedAt },
    order: base.features.map((feature) => feature.id),
  };
}
test('opening and closing roadmap editors without changes creates no draft, even after revision advances', () => {
  const saved = snapshot();
  assert.equal(isRoadmapDraftDirty(saved), false);
  assert.equal(isRoadmapDraftDirty(saved, true), false);
  const later = structuredClone(saved.base);
  later.revision++;
  later.features[0].summary = 'An actual update made after the untouched editor closed';
  assert.equal(shouldRecoverRoadmapDraft(saved, later), false);
  const original = saved.draft.title;
  saved.draft.title = 'Temporary edit';
  assert.equal(isRoadmapDraftDirty(saved), true);
  saved.draft.title = original;
  saved.draft.itemIds = [];
  assert.equal(isRoadmapDraftDirty(saved), false, 'Clearing absent delivery links is not an edit');
});
test('changed feature drafts survive closing and edits already applied elsewhere stop recovering', () => {
  const saved = snapshot();
  saved.draft.title = 'My unfinished feature title';
  assert.equal(shouldRecoverRoadmapDraft(saved, saved.base), true);
  const latest = structuredClone(saved.base);
  latest.revision++;
  latest.features[0].title = saved.draft.title;
  latest.features[0].summary = 'Another author changed an untouched field';
  assert.equal(
    shouldRecoverRoadmapDraft(saved, latest),
    false,
    'Do not revive old unchanged fields after the intended edit is saved',
  );
  latest.features[0].title = 'Another author changed my field';
  assert.equal(
    shouldRecoverRoadmapDraft(saved, latest),
    true,
    'Unresolved competing edits must remain recoverable',
  );
});
test('summary and order changes are intentional edits and recover only while unresolved', () => {
  const saved = snapshot();
  saved.summary.reviewNote = 'A real weekly review note';
  assert.equal(isRoadmapDraftDirty(saved, true), true);
  assert.equal(shouldRecoverRoadmapDraft(saved, saved.base, true), true);
  const latest = structuredClone(saved.base);
  latest.reviewNote = saved.summary.reviewNote;
  latest.headline = 'A concurrent headline update';
  assert.equal(shouldRecoverRoadmapDraft(saved, latest, true), false);
  saved.order.reverse();
  assert.equal(isRoadmapDraftDirty(saved), true);
  assert.equal(shouldRecoverRoadmapDraft(saved, latest), true);
  latest.features.reverse();
  assert.equal(shouldRecoverRoadmapDraft(saved, latest), false);
});
test('empty new-feature defaults are not drafts, but changed fields or priority group recover', () => {
  const saved = snapshot();
  saved.draft = {
    id: 'new-feature',
    title: '',
    summary: '',
    area: '',
    horizon: 'next',
    status: '',
    scope: '',
    rationale: '',
    targetDate: null,
  };
  assert.equal(isRoadmapDraftDirty(saved, false, 'next'), false);
  saved.draft.horizon = 'current';
  assert.equal(shouldRecoverRoadmapDraft(saved, saved.base, false, 'next'), true);
  saved.draft.horizon = 'next';
  saved.draft.title = 'A new priority';
  assert.equal(shouldRecoverRoadmapDraft(saved, saved.base, false, 'next'), true);
  const latest = structuredClone(saved.base);
  latest.features.push({ ...saved.draft });
  assert.equal(shouldRecoverRoadmapDraft(saved, latest, false, 'next'), false);
});
