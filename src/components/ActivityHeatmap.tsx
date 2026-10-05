import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import type { ActivityHeatmap as HeatmapData } from '../../shared/types';
import { api } from '../lib/api';
import { useApp } from '../lib/context';
import {
  activityCalendar,
  activityDayLabel,
  activityYears,
  type HeatmapDay,
} from '../lib/activity-heatmap';
import './activity-heatmap.css';

type Resource =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; data: HeatmapData }
  | { key: string; status: 'error'; message: string };

export default function ActivityHeatmap({
  projectId,
  userId,
}: {
  projectId?: string;
  userId?: string;
}) {
  const { data } = useApp();
  const currentYear = new Date().getUTCFullYear();
  const [year, setYear] = useState(currentYear);
  const [retry, setRetry] = useState(0);
  const [resource, setResource] = useState<Resource>({ key: '', status: 'loading' });
  const [focused, setFocused] = useState<{ key: string; date: string } | null>(null);
  const [selected, setSelected] = useState<{ key: string; day: HeatmapDay } | null>(null);
  const headingId = useId();
  const noteId = useId();
  const key = JSON.stringify([data.user.workspaceId, data.user.id, projectId, userId, year]);
  const result = resource.key === key ? resource : undefined;
  const calendar = useMemo(
    () => activityCalendar(year, result?.status === 'ready' ? result.data.days : []),
    [year, result],
  );
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ year: String(year) });
    if (projectId) query.set('projectId', projectId);
    if (userId) query.set('userId', userId);
    setResource({ key, status: 'loading' });
    setSelected(null);
    void api<HeatmapData>(`/activity/heatmap?${query}`, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setResource({ key, status: 'ready', data: response });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setResource({
            key,
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not load activity.',
          });
      });
    return () => controller.abort();
  }, [key, year, projectId, userId, retry, data.items, data.projects, data.projectUpdates]);

  const years = useMemo(
    () =>
      activityYears(currentYear, [
        ...data.items.map((item) => item.createdAt),
        ...data.projects.map((project) => project.createdAt),
        ...(data.projectUpdates ?? []).map((update) => update.createdAt),
        `${year}-01-01T00:00:00Z`,
      ]),
    [currentYear, year, data.items, data.projects, data.projectUpdates],
  );
  const firstFocusDate =
    year === currentYear ? new Date().toISOString().slice(0, 10) : `${year}-01-01`;
  return (
    <section className="activity-heatmap" aria-labelledby={headingId}>
      <header className="activity-heatmap-header">
        <div>
          <h2 id={headingId}>Activity</h2>
          {result?.status === 'ready' && (
            <p>
              <strong>{result.data.total.toLocaleString()}</strong>{' '}
              {result.data.total === 1 ? 'activity' : 'activities'} in {year}
            </p>
          )}
        </div>
        <label className="activity-heatmap-year">
          <span>Year</span>
          <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
            {years.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </header>
      {(!result || result.status === 'loading') && <p role="status">Loading activity…</p>}
      {result?.status === 'error' && (
        <div className="activity-heatmap-error" role="alert">
          <span>{result.message}</span>
          <button className="button small" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      )}
      {result?.status === 'ready' && (
        <>
          <div
            className="activity-heatmap-scroll"
            tabIndex={0}
            role="region"
            aria-label={`Activity calendar for ${year}; scroll horizontally to see the full year`}
            aria-describedby={noteId}
          >
            <div
              className="activity-heatmap-calendar"
              style={{ '--heatmap-weeks': calendar.weeks.length } as CSSProperties}
            >
              <div className="activity-heatmap-months" aria-hidden="true">
                {calendar.months.map((month) => (
                  <span
                    key={month.label}
                    style={{
                      gridColumn: `${month.column + 1} / span ${Math.min(3, calendar.weeks.length - month.column)}`,
                    }}
                  >
                    {month.label}
                  </span>
                ))}
              </div>
              <div className="activity-heatmap-weekdays" aria-hidden="true">
                <span>Mon</span>
                <span>Wed</span>
                <span>Fri</span>
              </div>
              <div className="activity-heatmap-weeks">
                {calendar.weeks.map((week, index) => (
                  <div className="activity-heatmap-week" key={index}>
                    {week.map((day, weekday) =>
                      day.date ? (
                        <button
                          key={day.date}
                          type="button"
                          className={`activity-heatmap-day activity-level-${day.level}`}
                          title={activityDayLabel(day)}
                          tabIndex={
                            (focused?.key === key ? focused.date : firstFocusDate) === day.date
                              ? 0
                              : -1
                          }
                          onFocus={() => {
                            setFocused({ key, date: day.date! });
                            setSelected({ key, day });
                          }}
                          aria-label={activityDayLabel(day)}
                          aria-pressed={selected?.key === key && selected.day.date === day.date}
                          onClick={() => setSelected({ key, day })}
                          onKeyDown={(event) => {
                            const offset = {
                              ArrowLeft: -7,
                              ArrowRight: 7,
                              ArrowUp: -1,
                              ArrowDown: 1,
                            }[event.key];
                            if (offset === undefined) return;
                            const buttons = Array.from(
                              event.currentTarget
                                .closest('.activity-heatmap-weeks')!
                                .querySelectorAll<HTMLButtonElement>('button'),
                            );
                            const target = buttons[buttons.indexOf(event.currentTarget) + offset];
                            if (target) {
                              event.preventDefault();
                              target.focus();
                            }
                          }}
                        />
                      ) : (
                        <span
                          key={`padding-${weekday}`}
                          className="activity-heatmap-padding"
                          aria-hidden="true"
                        />
                      ),
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="activity-heatmap-footer">
            <p role="status">
              {selected?.key === key
                ? activityDayLabel(selected.day)
                : result.data.total
                  ? 'Select a day to see its activity count.'
                  : 'No visible activity in this year yet.'}
            </p>
            <div
              className="activity-heatmap-legend"
              aria-label="Activity intensity from less to more"
            >
              <span>Less</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span
                  key={level}
                  className={`activity-heatmap-day activity-level-${level}`}
                  aria-hidden="true"
                />
              ))}
              <span>More</span>
            </div>
          </div>
        </>
      )}
      <p className="activity-heatmap-note" id={noteId}>
        Dates in UTC · Visible activity only. Includes creations, comments, work item changes and
        project updates. Use arrow keys to move between days.
      </p>
    </section>
  );
}
