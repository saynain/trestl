import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import {
  CalendarDays,
  GitBranch,
  Link2,
  LockKeyhole,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Diamond,
  Maximize2,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { Project, WorkItem } from '../../shared/types';
import { useApp } from '../lib/context';
import { blockingRelations, scheduleConflicts } from '../../shared/dependencies';
import { patch } from '../lib/api';
import {
  descendants,
  groupedStatuses,
  isDone,
  itemSearchText,
  shortDate,
  today,
} from '../lib/model';
import { dateAt, dayNumber, scheduleRange, shiftSchedule } from '../lib/gantt';
import { Avatar, EmptyState, Modal, StatusIcon } from './ui';
import './gantt.css';
import GanttMilestones from './GanttMilestones';
import { criticalPath } from '../lib/critical-path';

type Schedule = { startDate: string | null; dueDate: string | null };
type Drag = {
  item: WorkItem;
  x: number;
  scroll: number;
  edge: 'move' | 'start' | 'end';
  days: number;
};
export default function GanttView({ project, items }: { project: Project; items: WorkItem[] }) {
  const { data, refresh, toast, openItem, createItem } = useApp();
  const currentDay = dayNumber(today());
  const [origin, setOrigin] = useState(currentDay - (window.innerWidth <= 760 ? 1 : 7));
  const [zoom, setZoom] = useState<'weeks' | 'months'>('weeks');
  const [fitDays, setFitDays] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [showDependencies, setShowDependencies] = useState(true);
  const [showCritical, setShowCritical] = useState(false);
  const [milestoneHeight, setMilestoneHeight] = useState(53);
  const [scheduleError, setScheduleError] = useState('');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [editing, setEditing] = useState<WorkItem | null>(null);
  const [draft, setDraft] = useState<Schedule>({ startDate: null, dueDate: null });
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ id: string; dates: Schedule } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [available, setAvailable] = useState(900);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setAvailable(el.clientWidth - (window.innerWidth <= 760 ? 220 : 330)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const visible = items.filter(
    (item) =>
      (showDone || !isDone(item)) && itemSearchText(item).includes(search.trim().toLowerCase()),
  );
  const scheduled = visible.filter((item) => scheduleRange(item));
  const unscheduled = visible.filter((item) => !scheduleRange(item));
  const projectIds = descendants(data.projects, project.id);
  const milestones = data.milestones.filter(
    (m) => projectIds.has(m.projectId) && (showDone || !m.completed),
  );
  const count = fitDays || (zoom === 'weeks' ? 42 : 112);
  const cell = fitDays ? Math.max(1, available) / count : zoom === 'weeks' ? 36 : 14;
  const width = Math.max(count * cell, available);
  const actualCount = Math.ceil(width / cell);
  // Keep headers bounded even when fitting years of work into one viewport.
  const dayStep = Math.max(1, Math.ceil(12 / cell));
  const days = Array.from(
    { length: Math.ceil(actualCount / dayStep) },
    (_, i) => origin + i * dayStep,
  );
  const monthGroups: { label: string; start: number; length: number }[] = [];
  for (let day = origin; day < origin + actualCount;) {
    const date = new Date(day * 86400000);
    const yearly = actualCount > 730;
    const next = new Date(date);
    next.setUTCDate(1);
    if (yearly) {
      next.setUTCMonth(0);
      next.setUTCFullYear(next.getUTCFullYear() + 1);
    } else next.setUTCMonth(next.getUTCMonth() + 1);
    const end = Math.min(Math.floor(next.getTime() / 86400000), origin + actualCount);
    monthGroups.push({
      label: date.toLocaleDateString('en-GB', {
        ...(yearly ? {} : { month: 'long' as const }),
        year: 'numeric',
        timeZone: 'UTC',
      }),
      start: day - origin,
      length: end - day,
    });
    day = end;
  }
  const workingItems = data.items.map((item) =>
    preview?.id === item.id ? { ...item, ...preview.dates } : item,
  );
  const links = blockingRelations(data.relations || [], workingItems);
  const critical = criticalPath(items, workingItems, data.relations || []);
  const hasCritical = showCritical && critical.criticalIds.size > 0;
  const projectLinks = links.filter((link) =>
    items.some((item) => item.id === link.blocker.id || item.id === link.dependent.id),
  );
  const blockedCount = new Set(
    projectLinks
      .filter(
        (link) => link.state !== 'resolved' && items.some((item) => item.id === link.dependent.id),
      )
      .map((link) => link.dependent.id),
  ).size;
  const conflictCount = projectLinks.filter((link) => link.state === 'conflict').length;
  const undatedCount = projectLinks.filter((link) => link.state === 'undated').length;
  const draftConflicts = editing
    ? scheduleConflicts({ ...editing, ...draft }, data.items, data.relations || [])
    : [];
  const draftLinks = editing
    ? blockingRelations(
        data.relations || [],
        data.items.map((item) => (item.id === editing.id ? { ...item, ...draft } : item)),
      )
    : [];
  function dependencyBadge(item: WorkItem) {
    const connected = links.filter(
      (link) => link.blocker.id === item.id || link.dependent.id === item.id,
    );
    if (!connected.length) return null;
    const blockers = connected.filter(
      (link) => link.dependent.id === item.id && link.state !== 'resolved',
    );
    const conflict = connected.some((link) => link.state === 'conflict');
    const label = blockers.length
      ? `Blocked by ${blockers.length} unfinished ${blockers.length === 1 ? 'task' : 'tasks'}`
      : `${connected.length} dependencies`;
    return (
      <button
        className={`gantt-dependency-badge ${conflict ? 'conflict' : blockers.length ? 'waiting' : ''}`}
        aria-label={`${item.title}: ${label}${conflict ? ', schedule conflict' : ''}`}
        title={connected
          .map(
            (link) =>
              `${link.dependent.id === item.id ? 'Blocked by' : 'Blocks'} ${link.dependent.id === item.id ? link.blocker.identifier : link.dependent.identifier}: ${link.state}`,
          )
          .join('\n')}
        onClick={() => edit(item)}
      >
        {conflict ? (
          <AlertTriangle size={12} />
        ) : blockers.length ? (
          <LockKeyhole size={12} />
        ) : (
          <Link2 size={12} />
        )}
        <span>{blockers.length || connected.length}</span>
      </button>
    );
  }
  function edit(item: WorkItem) {
    setScheduleError('');
    setDraft({ startDate: item.startDate || null, dueDate: item.dueDate });
    setEditing(item);
  }
  async function save(item: WorkItem, dates: Schedule) {
    setScheduleError('');
    const conflicts = scheduleConflicts({ ...item, ...dates }, data.items, data.relations || []);
    if (conflicts.length) {
      setEditing(item);
      setDraft(dates);
      setPreview(null);
      setScheduleError(
        'These dates overlap linked work. Adjust the dates or review the dependency below.',
      );
      return;
    }
    setBusy(true);
    try {
      await patch(`/items/${item.id}`, { ...dates, expectedRevision: item.revision ?? 0 });
      await refresh();
      setEditing(null);
      toast('Schedule updated');
    } catch (error) {
      setScheduleError((error as Error).message);
      setEditing(item);
      setDraft(dates);
      toast((error as Error).message, 'error');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      setPreview(null);
    }
  }
  function begin(event: PointerEvent<HTMLButtonElement>, item: WorkItem) {
    if (busy || event.button !== 0) return;
    const edge = (event.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.dataset.edge as
      Drag['edge'] | undefined;
    drag.current = {
      item,
      x: event.clientX,
      scroll: viewport.current?.scrollLeft || 0,
      edge: edge || 'move',
      days: 0,
    };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    const distance = event.clientX - active.x + (viewport.current?.scrollLeft || 0) - active.scroll;
    if (Math.abs(distance) > 5) suppressClick.current = true;
    active.days = Math.round(distance / cell);
    if (suppressClick.current)
      setPreview({
        id: active.item.id,
        dates: shiftSchedule(active.item, active.days, active.edge),
      });
  }
  function finish() {
    const active = drag.current;
    drag.current = null;
    if (active?.days && suppressClick.current)
      void save(active.item, shiftSchedule(active.item, active.days, active.edge));
    else setPreview(null);
  }
  function reset(nextOrigin: number) {
    setOrigin(nextOrigin);
    viewport.current?.scrollTo({ left: 0 });
  }
  function fit() {
    const dates = scheduled.flatMap((item) => {
      const range = scheduleRange(item)!;
      return [range.start, range.end];
    });
    milestones.forEach((m) => {
      if (m.dueDate) dates.push(dayNumber(m.dueDate));
    });
    if (!dates.length) {
      setFitDays(null);
      reset(currentDay - (window.innerWidth <= 760 ? 1 : 7));
      return;
    }
    const start = Math.min(...dates);
    const end = Math.max(...dates);
    setFitDays(Math.max(21, end - start + 9));
    reset(start - 4);
  }
  const groups = groupedStatuses
    .map((status) => ({
      ...status,
      items: scheduled
        .filter((item) => item.status === status.id)
        .sort((a, b) => scheduleRange(a)!.start - scheduleRange(b)!.start),
    }))
    .filter((group) => group.items.length);
  const rowCenters = new Map<string, number>();
  let rowY = milestones.length ? milestoneHeight : 0;
  for (const group of groups) {
    rowY += 37;
    if (!collapsed.has(group.id))
      for (const item of group.items) {
        rowCenters.set(item.id, rowY + 24.5);
        rowY += 49;
      }
  }
  const dependencyPaths = links.flatMap((link) => {
    const fromY = rowCenters.get(link.blocker.id);
    const toY = rowCenters.get(link.dependent.id);
    const from = scheduleRange(link.blocker);
    const to = scheduleRange(link.dependent);
    if (
      fromY === undefined ||
      toY === undefined ||
      !from ||
      !to ||
      !link.blocker.dueDate ||
      from.end < origin ||
      from.end >= origin + actualCount ||
      to.start < origin ||
      to.start >= origin + actualCount
    )
      return [];
    const fromX =
      (from.end - origin + (link.blocker.startDate ? 1 : 0.5)) * cell -
      (link.blocker.startDate ? 4 : 0);
    const toX =
      (to.start - origin + (link.dependent.startDate && link.dependent.dueDate ? 0 : 0.5)) * cell +
      (link.dependent.startDate && link.dependent.dueDate ? 4 : 0);
    const bend = fromX + 10;
    const laneY = toY - 20;
    const path =
      toX - fromX > 24
        ? `M ${fromX} ${fromY} H ${Math.min(bend, (fromX + toX) / 2)} V ${toY} H ${toX - 3}`
        : `M ${fromX} ${fromY} H ${bend} V ${laneY} H ${toX - 10} V ${toY} H ${toX - 3}`;
    return [{ ...link, path }];
  });
  const style = { '--gantt-width': `${width}px`, '--gantt-day': `${cell}px` } as CSSProperties;
  const completed = items.filter((item) => item.status === 'done').length;
  return (
    <section
      className={`gantt-view ${hasCritical ? 'show-critical' : ''}`}
      aria-label="Project Gantt chart"
      style={style}
    >
      <div className="gantt-intro">
        <div>
          <div className="gantt-eyebrow">
            <CalendarDays size={13} /> PROJECT TIMELINE
          </div>
          <h2>A little perspective on what’s ahead.</h2>
          <p>
            {scheduled.length} scheduled <span>·</span> {unscheduled.length} without dates
            {project.dueDate && (
              <>
                {' '}
                <span>·</span> Target {shortDate(project.dueDate)}
              </>
            )}
          </p>
        </div>
        <div className="gantt-progress">
          <span>
            <strong>{items.length ? Math.round((completed / items.length) * 100) : 0}%</strong>{' '}
            complete
          </span>
          <div>
            <i style={{ width: `${items.length ? (completed / items.length) * 100 : 0}%` }} />
          </div>
          <small>
            {completed} of {items.length} items done
          </small>
        </div>
      </div>
      <div className="gantt-toolbar">
        <div className="gantt-navigation">
          <button
            className="button"
            onClick={() => {
              setFitDays(null);
              reset(currentDay - (window.innerWidth <= 760 ? 1 : 7));
            }}
          >
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Previous period"
            onClick={() => reset(origin - (zoom === 'weeks' ? 14 : 56))}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Next period"
            onClick={() => reset(origin + (zoom === 'weeks' ? 14 : 56))}
          >
            <ChevronRight size={16} />
          </button>
          <strong>
            {shortDate(dateAt(origin))} – {shortDate(dateAt(origin + actualCount - 1))},{' '}
            {dateAt(origin + actualCount - 1).slice(0, 4)}
          </strong>
        </div>
        <div className="gantt-tools">
          <label className="gantt-search">
            <Search size={14} />
            <input
              aria-label="Search timeline"
              placeholder="Find an item…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button aria-label="Clear search" onClick={() => setSearch('')}>
                <X size={12} />
              </button>
            )}
          </label>
          <label className="gantt-completed">
            <input
              type="checkbox"
              checked={showDone}
              onChange={(e) => setShowDone(e.target.checked)}
            />
            Completed
          </label>
          <button
            className={`button gantt-dependency-toggle ${showDependencies ? 'active' : ''}`}
            aria-pressed={showDependencies}
            onClick={() => setShowDependencies((value) => !value)}
            title="Show dependency arrows"
          >
            <Link2 size={13} />
            Dependencies
          </button>
          <button
            className={`button gantt-critical-toggle ${showCritical ? 'active' : ''}`}
            aria-pressed={showCritical}
            onClick={() => setShowCritical((value) => !value)}
            title="Highlight tasks with zero scheduling slack"
          >
            <GitBranch size={13} />
            Critical path
          </button>
          <button className="button gantt-fit" onClick={fit} title="Fit all scheduled items">
            <Maximize2 size={13} />
            Fit
          </button>
          <div className="gantt-zoom" aria-label="Timeline scale">
            {(['weeks', 'months'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={zoom === value && !fitDays}
                onClick={() => {
                  setFitDays(null);
                  setZoom(value);
                }}
              >
                {value === 'weeks' ? 'Weeks' : 'Months'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {projectLinks.length > 0 && (
        <div className="gantt-dependency-summary">
          <span>
            <Link2 size={13} />
            {projectLinks.length} dependencies
          </span>
          <span>{blockedCount} blocked</span>
          {conflictCount > 0 && (
            <span className="conflict">
              <AlertTriangle size={12} />
              {conflictCount} schedule {conflictCount === 1 ? 'conflict' : 'conflicts'}
            </span>
          )}
          {undatedCount > 0 && <span>{undatedCount} need dates</span>}
          <small>Dependent work starts after its blocker finishes.</small>
        </div>
      )}
      {showCritical && (
        <div className="gantt-critical-summary" role="status">
          <div>
            <GitBranch size={15} />
            <strong>
              {critical.status === 'cycle'
                ? 'Resolve circular dependencies to calculate the critical path'
                : critical.status === 'empty'
                  ? 'Add dates to unfinished work to calculate the critical path'
                  : `${critical.criticalIds.size} critical tasks · ${critical.duration}-day longest chain`}
            </strong>
            {critical.status === 'partial' && (
              <span className="gantt-critical-partial">
                Partial · {critical.excluded.length}{' '}
                {critical.excluded.length === 1 ? 'task needs' : 'tasks need'} dates
              </span>
            )}
            {critical.externalCount > 0 && (
              <span>Includes {critical.externalCount} upstream tasks from other projects</span>
            )}
          </div>
          <details>
            <summary>How this is calculated</summary>
            <p>
              Tasks with zero float form the longest dependency chain. Float is the number of days a
              task can slip without extending that chain. Calculated across unfinished project work
              and visible upstream blockers, regardless of search or collapsed groups. Uses full
              planned calendar-day durations; a due-date-only task counts as one day. Resource
              limits, fixed start dates, and gaps between tasks are not modeled. Milestones are
              independent date markers and do not constrain this calculation.
            </p>
            {critical.excluded.length > 0 && (
              <p>
                Missing durations make this an incomplete estimate:{' '}
                {critical.excluded.map((item) => item.identifier).join(', ')}.
              </p>
            )}
            {conflictCount > 0 && (
              <p>
                Existing date conflicts are flagged separately. This highlight analyzes durations
                and dependencies; it does not repair the current schedule.
              </p>
            )}
          </details>
        </div>
      )}
      <div className="gantt-scroll" ref={viewport} tabIndex={0} aria-label="Scrollable timeline">
        <div className="gantt-grid">
          <div className="gantt-header gantt-pair">
            <div className="gantt-label gantt-column-title">
              <span>
                Work item <small>{visible.length}</small>
              </span>
              <span>Schedule</span>
            </div>
            <div className="gantt-calendar">
              <div className="gantt-months">
                {monthGroups.map((group) => (
                  <span
                    key={`${group.label}-${group.start}`}
                    style={{ left: group.start * cell, width: group.length * cell }}
                  >
                    {group.label}
                  </span>
                ))}
              </div>
              <div className="gantt-days">
                {days.map((day, i) => (
                  <span
                    key={day}
                    className={day === currentDay ? 'is-today' : ''}
                    style={{ left: (day - origin) * cell, width: cell }}
                  >
                    {cell >= 26 ? (
                      <>
                        <small>
                          {new Date(day * 86400000).toLocaleDateString('en', {
                            weekday: 'narrow',
                            timeZone: 'UTC',
                          })}
                        </small>
                        {dateAt(day).slice(8).replace(/^0/, '')}
                      </>
                    ) : dayStep > 1 || i % 7 === 0 ? (
                      dateAt(day).slice(8).replace(/^0/, '')
                    ) : (
                      ''
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="gantt-body">
            {(showDependencies || hasCritical) && dependencyPaths.length > 0 && (
              <svg
                className="gantt-dependency-lines"
                width={width}
                height={rowY}
                aria-label="Task dependencies"
              >
                <defs>
                  <marker
                    id="gantt-arrow"
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" />
                  </marker>
                </defs>
                {dependencyPaths
                  .filter(
                    (link) => showDependencies || critical.criticalRelations.has(link.relation.id),
                  )
                  .map((link) => (
                    <path
                      key={link.relation.id}
                      d={link.path}
                      className={`${link.state} ${hasCritical && critical.criticalRelations.has(link.relation.id) ? 'is-critical' : ''}`}
                      markerEnd="url(#gantt-arrow)"
                      role="button"
                      tabIndex={0}
                      aria-label={`${link.blocker.identifier} blocks ${link.dependent.identifier}${link.state === 'conflict' ? ': schedule conflict' : ''}`}
                      onClick={() => edit(link.dependent)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          edit(link.dependent);
                        }
                      }}
                    >
                      <title>
                        {link.blocker.identifier} → {link.dependent.identifier}: {link.state}
                      </title>
                    </path>
                  ))}
              </svg>
            )}
            <div className="gantt-grid-background" aria-hidden="true">
              {cell >= 20 &&
                days
                  .filter((day) => [0, 6].includes(new Date(day * 86400000).getUTCDay()))
                  .map((day) => (
                    <i key={day} style={{ left: (day - origin) * cell, width: cell }} />
                  ))}
              {currentDay >= origin && currentDay < origin + actualCount && (
                <div
                  className="gantt-today-line"
                  style={{ left: (currentDay - origin + 0.5) * cell }}
                >
                  <span>Today</span>
                </div>
              )}
            </div>
            {milestones.length > 0 && (
              <GanttMilestones
                milestones={milestones}
                origin={origin}
                cell={cell}
                count={actualCount}
                viewport={viewport}
                onHeight={setMilestoneHeight}
              />
            )}
            {groups.map((group) => (
              <div key={group.id} className="gantt-group">
                <div className="gantt-pair gantt-group-heading">
                  <button
                    className="gantt-label"
                    aria-expanded={!collapsed.has(group.id)}
                    onClick={() =>
                      setCollapsed((old) => {
                        const next = new Set(old);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(group.id) ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <StatusIcon status={group.id} />
                    <strong>{group.name}</strong>
                    <small>{group.items.length}</small>
                  </button>
                  <div className="gantt-track" />
                </div>
                {!collapsed.has(group.id) &&
                  group.items.map((item) => {
                    const dates = preview?.id === item.id ? preview.dates : item;
                    const range = scheduleRange(dates)!;
                    const left = Math.max(0, (range.start - origin) * cell + 4);
                    const right = Math.min(width, (range.end - origin + 1) * cell - 4);
                    const inView = range.end >= origin && range.start < origin + actualCount;
                    const point = !dates.startDate || !dates.dueDate;
                    return (
                      <div
                        className={`gantt-pair gantt-item-row ${preview?.id === item.id ? 'is-dragging' : ''} ${hasCritical && critical.criticalIds.has(item.id) ? 'is-critical' : ''}`}
                        key={item.id}
                        data-item-id={item.id}
                      >
                        <div className="gantt-label">
                          <button className="gantt-item-name" onClick={() => openItem(item.id)}>
                            <span>{item.identifier}</span>
                            <strong>{item.title}</strong>
                            {hasCritical && critical.criticalIds.has(item.id) && (
                              <GitBranch
                                size={12}
                                className="gantt-critical-icon"
                                aria-label="Critical task"
                              />
                            )}
                          </button>
                          {dependencyBadge(item)}
                          <Avatar
                            user={data.users.find((user) => user.id === item.assigneeId)}
                            size={22}
                          />
                          <button
                            className="gantt-date-button"
                            onClick={() => edit(item)}
                            title="Edit schedule"
                          >
                            {shortDate(item.dueDate || item.startDate || null)}
                          </button>
                        </div>
                        <div className="gantt-track">
                          {inView ? (
                            <button
                              disabled={busy}
                              className={`gantt-bar ${point ? 'is-point' : ''} ${isDone(item) ? 'is-complete' : ''} ${links.some((link) => link.state === 'conflict' && (link.blocker.id === item.id || link.dependent.id === item.id)) ? 'has-conflict' : ''}`}
                              style={
                                {
                                  left,
                                  width: Math.max(12, right - left),
                                  '--bar-color': group.color,
                                } as CSSProperties
                              }
                              aria-label={`Schedule ${item.title}: ${dates.startDate ? shortDate(dates.startDate) : 'No start date'} to ${dates.dueDate ? shortDate(dates.dueDate) : 'No due date'}`}
                              title={`${item.title}${showCritical && critical.float.has(item.id) ? ` · ${critical.float.get(item.id)}d float${critical.criticalIds.has(item.id) ? ' · Critical path' : ''}` : ''}\n${dates.startDate || 'No start'} → ${dates.dueDate || 'No due date'}\nDrag to move. Click to edit dates.`}
                              onPointerDown={(event) => begin(event, item)}
                              onPointerMove={move}
                              onPointerUp={finish}
                              onPointerCancel={() => {
                                drag.current = null;
                                setPreview(null);
                                suppressClick.current = true;
                              }}
                              onClick={() => {
                                if (!suppressClick.current) edit(item);
                                suppressClick.current = false;
                              }}
                            >
                              <span className="gantt-handle start" data-edge="start" />
                              {point ? (
                                <Diamond size={12} fill="currentColor" />
                              ) : (
                                <>
                                  {item.status === 'done' && <Check size={12} />}
                                  <span className="gantt-bar-title">{item.title}</span>
                                  {right - left > 80 && (
                                    <small>
                                      {showCritical && critical.float.has(item.id)
                                        ? `${critical.float.get(item.id)}d float`
                                        : `${range.end - range.start + 1}d`}
                                    </small>
                                  )}
                                </>
                              )}
                              <span className="gantt-handle end" data-edge="end" />
                            </button>
                          ) : (
                            <button
                              className={`gantt-offscreen ${range.end < origin ? 'before' : 'after'}`}
                              onClick={() => reset(range.start - 4)}
                            >
                              {range.end < origin ? <ChevronLeft size={12} /> : null}
                              {shortDate(dateAt(range.start))}
                              {range.end >= origin ? <ChevronRight size={12} /> : null}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            ))}
            {unscheduled.length > 0 && (
              <div className="gantt-group">
                <div className="gantt-pair gantt-group-heading">
                  <button
                    className="gantt-label"
                    aria-expanded={!collapsed.has('unscheduled')}
                    onClick={() =>
                      setCollapsed((old) => {
                        const next = new Set(old);
                        if (next.has('unscheduled')) next.delete('unscheduled');
                        else next.add('unscheduled');
                        return next;
                      })
                    }
                  >
                    {collapsed.has('unscheduled') ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <CalendarDays size={14} />
                    <strong>Unscheduled</strong>
                    <small>{unscheduled.length}</small>
                  </button>
                  <div className="gantt-track gantt-unscheduled-hint">
                    A place for work that’s still taking shape
                  </div>
                </div>
                {!collapsed.has('unscheduled') &&
                  unscheduled.map((item) => (
                    <div key={item.id} className="gantt-pair gantt-item-row" data-item-id={item.id}>
                      <div className="gantt-label">
                        <button className="gantt-item-name" onClick={() => openItem(item.id)}>
                          <span>{item.identifier}</span>
                          <strong>{item.title}</strong>
                        </button>
                        {dependencyBadge(item)}
                        <Avatar
                          user={data.users.find((user) => user.id === item.assigneeId)}
                          size={22}
                        />
                        <button className="gantt-date-button" onClick={() => edit(item)}>
                          Set dates
                        </button>
                      </div>
                      <div className="gantt-track">
                        <button className="gantt-schedule-button" onClick={() => edit(item)}>
                          <Plus size={13} />
                          Schedule item
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
            {!visible.length && (
              <div className="gantt-empty">
                <EmptyState
                  title={search ? 'No matching work items' : 'Make room for what’s next'}
                  description={
                    search
                      ? 'Try another search or include completed items.'
                      : 'Add a work item, then give it a start and due date to build your timeline.'
                  }
                />
              </div>
            )}
            <div className="gantt-pair gantt-add-row">
              <div className="gantt-label">
                <button onClick={() => createItem(project.id)}>
                  <Plus size={14} />
                  Add work item
                </button>
              </div>
              <div className="gantt-track" />
            </div>
          </div>
        </div>
      </div>
      <footer className="gantt-footer">
        <span>
          <i className="gantt-legend-bar" />
          Date range <Diamond size={11} />
          Single date
        </span>
        <span>Drag to move · Drag edges to resize · Click to edit dates</span>
      </footer>
      {editing && (
        <Modal
          title="Schedule work item"
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <form
            className="gantt-schedule-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(editing, draft);
            }}
          >
            <div className="gantt-schedule-item">
              <StatusIcon status={editing.status} />
              <span>
                <small>{editing.identifier}</small>
                <strong>{editing.title}</strong>
              </span>
            </div>
            <div className="gantt-date-fields">
              <label>
                Start date
                <input
                  type="date"
                  value={draft.startDate || ''}
                  max={draft.dueDate || undefined}
                  onChange={(event) =>
                    setDraft({ ...draft, startDate: event.target.value || null })
                  }
                />
              </label>
              <label>
                Due date
                <input
                  type="date"
                  value={draft.dueDate || ''}
                  min={draft.startDate || undefined}
                  onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null })}
                />
              </label>
            </div>
            <p>Use both dates for a duration, or one date for a single point on the timeline.</p>
            {(scheduleError || draftConflicts.length > 0) && (
              <div className="gantt-schedule-warning" role="alert">
                <AlertTriangle size={15} />
                <span>
                  {scheduleError || 'This schedule overlaps linked work.'}
                  {draftConflicts.map((link) => (
                    <span key={link.relation.id}>
                      {link.dependent.identifier} must start after {link.blocker.identifier}{' '}
                      finishes on {shortDate(link.blocker.dueDate)}.
                    </span>
                  ))}
                </span>
              </div>
            )}
            <div className="gantt-dependency-details">
              <div>
                <strong>Dependencies</strong>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setEditing(null);
                    openItem(editing.id);
                  }}
                >
                  Manage relationships
                </button>
              </div>
              {draftLinks
                .filter(
                  (link) => link.blocker.id === editing.id || link.dependent.id === editing.id,
                )
                .map((link) => {
                  const incoming = link.dependent.id === editing.id;
                  const other = incoming ? link.blocker : link.dependent;
                  return (
                    <button
                      type="button"
                      key={link.relation.id}
                      className="gantt-dependency-detail"
                      onClick={() => {
                        setEditing(null);
                        openItem(other.id);
                      }}
                    >
                      <StatusIcon status={other.status} />
                      <span>
                        <small>
                          {incoming ? 'Blocked by' : 'Blocks'} {other.identifier}
                          {other.projectId !== editing.projectId ? ' · Other project' : ''}
                        </small>
                        <strong>{other.title}</strong>
                      </span>
                      <span className={`gantt-dependency-state ${link.state}`}>
                        {link.state === 'resolved'
                          ? 'Resolved'
                          : link.state === 'conflict'
                            ? 'Date conflict'
                            : link.state === 'undated'
                              ? 'Needs dates'
                              : 'Waiting'}
                        <small>
                          {incoming
                            ? `Due ${shortDate(other.dueDate) || 'not set'}`
                            : `Starts ${shortDate(other.startDate || other.dueDate) || 'not set'}`}
                        </small>
                      </span>
                    </button>
                  );
                })}
              {!draftLinks.some(
                (link) => link.blocker.id === editing.id || link.dependent.id === editing.id,
              ) && <p>No blocking relationships. Add them in the task’s Relationships section.</p>}
            </div>
            <div className="gantt-schedule-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setDraft({ startDate: null, dueDate: null })}
              >
                Clear dates
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy || draftConflicts.length > 0}>
                {busy ? 'Saving…' : 'Save schedule'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
