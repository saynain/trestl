const dayMs = 24 * 60 * 60 * 1000;
export interface HeatmapDay {
  date: string | null;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}
export interface HeatmapMonth {
  label: string;
  column: number;
}

/** Calendar years, aligned to Sunday columns, with UTC dates independent of browser time zone. */
export function activityCalendar(year: number, days: { date: string; count: number }[]) {
  if (!Number.isInteger(year) || year < 1970 || year > 9999)
    throw new RangeError('Choose a calendar year between 1970 and 9999.');
  const first = Date.UTC(year, 0, 1);
  const last = Date.UTC(year, 11, 31);
  const start = first - new Date(first).getUTCDay() * dayMs;
  const end = last + (6 - new Date(last).getUTCDay()) * dayMs;
  const counts = new Map<string, number>();
  for (const day of days) {
    const stamp = Date.parse(`${day.date}T00:00:00Z`);
    if (
      !Number.isFinite(stamp) ||
      stamp < first ||
      stamp > last ||
      new Date(stamp).toISOString().slice(0, 10) !== day.date ||
      !Number.isFinite(day.count) ||
      day.count <= 0
    )
      continue;
    counts.set(day.date, (counts.get(day.date) ?? 0) + Math.floor(day.count));
  }
  const maximum = Math.max(0, ...counts.values());
  const weeks: HeatmapDay[][] = [];
  const months: HeatmapMonth[] = [];
  for (let stamp = start; stamp <= end; stamp += dayMs) {
    const date = new Date(stamp);
    const index = Math.round((stamp - start) / dayMs);
    const column = Math.floor(index / 7);
    if (!weeks[column]) weeks[column] = [];
    if (stamp < first || stamp > last) {
      weeks[column].push({ date: null, count: 0, level: 0 });
      continue;
    }
    const key = date.toISOString().slice(0, 10);
    const count = counts.get(key) ?? 0;
    const level = count ? (Math.min(4, Math.ceil((count / maximum) * 4)) as 1 | 2 | 3 | 4) : 0;
    weeks[column].push({ date: key, count, level });
    if (date.getUTCDate() === 1)
      months.push({
        label: date.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }),
        column,
      });
  }
  return { weeks, months };
}

export function activityDayLabel(day: Pick<HeatmapDay, 'date' | 'count'>) {
  if (!day.date) return '';
  const date = new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${day.count} ${day.count === 1 ? 'activity' : 'activities'} on ${date} (UTC)`;
}

/** Keep recent empty years available while exposing older visible records. */
export function activityYears(currentYear: number, timestamps: string[]) {
  let earliest = Math.max(1970, currentYear - 4);
  for (const timestamp of timestamps) {
    const stamp = Date.parse(timestamp);
    if (!Number.isFinite(stamp)) continue;
    const year = new Date(stamp).getUTCFullYear();
    if (year >= 1970 && year <= currentYear) earliest = Math.min(earliest, year);
  }
  return Array.from({ length: currentYear - earliest + 1 }, (_, index) => currentYear - index);
}
