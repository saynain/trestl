import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCalendar, activityDayLabel, activityYears } from '../src/lib/activity-heatmap.ts';

test('UTC activity calendar covers a complete year in Sunday-first seven-day columns', () => {
  const calendar = activityCalendar(2026, []);
  assert.equal(calendar.weeks.length, 53);
  assert.ok(calendar.weeks.every((week) => week.length === 7));
  assert.deepEqual(
    calendar.weeks[0].map((day) => day.date),
    [null, null, null, null, '2026-01-01', '2026-01-02', '2026-01-03'],
  );
  const dates = calendar.weeks.flat().flatMap((day) => (day.date ? [day.date] : []));
  assert.equal(dates.length, 365);
  assert.equal(new Set(dates).size, 365);
  assert.equal(dates.at(-1), '2026-12-31');
  assert.equal(calendar.months.length, 12);
  assert.deepEqual(calendar.months[0], { label: 'Jan', column: 0 });
  assert.deepEqual(calendar.months.at(-1), { label: 'Dec', column: 48 });
});

test('calendar handles leap days and rare 54-week calendar years without losing dates', () => {
  const calendar = activityCalendar(2000, []);
  const dates = calendar.weeks.flat().filter((day) => day.date);
  assert.equal(calendar.weeks.length, 54);
  assert.equal(dates.length, 366);
  assert.ok(dates.some((day) => day.date === '2000-02-29'));
  assert.equal(dates.at(-1)?.date, '2000-12-31');
  assert.throws(() => activityCalendar(1969, []), RangeError);
  assert.throws(() => activityCalendar(2026.5, []), RangeError);
});

test('activity levels distinguish zero and four intensities without invalid or outside-year rows', () => {
  const calendar = activityCalendar(2026, [
    { date: '2026-01-01', count: 1 },
    { date: '2026-01-02', count: 2 },
    { date: '2026-01-03', count: 3 },
    { date: '2026-01-04', count: 4 },
    { date: '2026-01-05', count: -10 },
    { date: '2026-01-06', count: NaN },
    { date: '2026-02-30', count: 100 },
    { date: '2025-12-31', count: 100 },
  ]);
  const days = calendar.weeks.flat().filter((day) => day.date);
  assert.deepEqual(
    days.slice(0, 7).map((day) => day.level),
    [1, 2, 3, 4, 0, 0, 0],
  );
  const merged = activityCalendar(2026, [
    { date: '2026-01-01', count: 1 },
    { date: '2026-01-01', count: 2 },
  ])
    .weeks.flat()
    .find((day) => day.date === '2026-01-01');
  assert.equal(merged?.count, 3);
});

test('accessible activity labels use UTC and singular/plural counts', () => {
  assert.equal(
    activityDayLabel({ date: '2026-01-01', count: 1 }),
    '1 activity on January 1, 2026 (UTC)',
  );
  assert.equal(
    activityDayLabel({ date: '2026-12-31', count: 2 }),
    '2 activities on December 31, 2026 (UTC)',
  );
  assert.equal(activityDayLabel({ date: null, count: 0 }), '');
});

test('year choices expose old visible history and retain five recent years', () => {
  assert.deepEqual(activityYears(2026, []), [2026, 2025, 2024, 2023, 2022]);
  const years = activityYears(2026, [
    '2019-12-31T23:59:59Z',
    'invalid',
    '1960-01-01',
    '2050-01-01',
  ]);
  assert.equal(years[0], 2026);
  assert.equal(years.at(-1), 2019);
  assert.equal(years.length, 8);
  assert.deepEqual(activityYears(1971, []), [1971, 1970]);
});
