import { useShortcuts, activateItemControl } from '../lib/keyboard';
import { itemActions, formatShortcut, type ItemAction } from '../lib/shortcuts';
import { Select } from './Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Plus,
  CalendarDays,
  LockKeyhole,
  ListFilter,
  BookmarkPlus,
  X,
  Layers,
  Tag,
} from 'lucide-react';
import type { Priority, Status, WorkItem } from '../../shared/types';
import { useApp } from '../lib/context';
import { patch, post } from '../lib/api';
import {
  navigate,
  readRoute,
  filterWorkItems,
  groupWorkItemsByTag,
  sortWorkItems,
  isDone,
  isOverdue,
  priorities,
  shortDate,
  statuses,
  today,
} from '../lib/model';
import { Avatar, EmptyState, Modal, PriorityIcon, StatusIcon } from './ui';
import { SourceBadge } from './SourceBadge';
interface Props {
  items: WorkItem[];
  projectId?: string;
  board?: boolean;
  initialFilters?: Record<string, string>;
  baseFilters?: Record<string, string>;
}
const groupingOptions = [
  { id: 'status', name: 'Status' },
  { id: 'priority', name: 'Priority' },
  { id: 'project', name: 'Project' },
  { id: 'tag', name: 'Tag' },
  { id: 'none', name: 'No grouping' },
];
export default function WorkList({
  items,
  projectId,
  board = false,
  initialFilters = {},
  baseFilters = {},
}: Props) {
  const { data, refresh, toast, openItem, createItem } = useApp();
  const [search, setSearch] = useState(initialFilters.search || '');
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState(initialFilters.status || '');
  const [priorityFilter, setPriorityFilter] = useState(initialFilters.priority || '');
  const [assigneeFilter, setAssigneeFilter] = useState(initialFilters.assigneeId || '');
  const [typeFilter, setTypeFilter] = useState(initialFilters.type || '');
  const [sourceFilter, setSourceFilter] = useState(initialFilters.source || '');
  const [tagFilter, setTagFilter] = useState(
    initialFilters.untagged === 'true'
      ? 'untagged'
      : initialFilters.tag
        ? `tag:${initialFilters.tag.toLowerCase()}`
        : '',
  );
  const tagOptions = useMemo(
    () => groupWorkItemsByTag(items).filter((group) => group.id !== 'untagged'),
    [items],
  );
  const tag = tagFilter.startsWith('tag:') ? tagFilter.slice(4) : '';
  const untagged = tagFilter === 'untagged' ? 'true' : '';
  const repositories = [
    ...new Map(
      items.flatMap((item) =>
        item.source ? [[item.source.integrationId, item.source] as const] : [],
      ),
    ).values(),
  ].sort((a, b) => a.repository.localeCompare(b.repository));
  const [groupBy, setGroupBy] = useState(
    initialFilters.groupBy || (initialFilters.due || initialFilters.followUp ? 'none' : 'status'),
  );
  const [showDone, setShowDone] = useState(initialFilters.showDone === 'true');
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const pointerDrag = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const filterPanel = useRef<HTMLDivElement>(null);
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const displayTrigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dateField = initialFilters.followUp === 'true' ? 'followUpDate' : 'dueDate';
  const overdue = (item: WorkItem) =>
    dateField === 'followUpDate'
      ? !!item.followUpDate && item.followUpDate < today() && !isDone(item)
      : isOverdue(item);
  const filterCount =
    Number(!!statusFilter) +
    Number(!!priorityFilter) +
    Number(!!assigneeFilter) +
    Number(!!typeFilter) +
    Number(!!sourceFilter) +
    Number(!!tagFilter);
  const visible = useMemo(
    () =>
      sortWorkItems(
        filterWorkItems(
          items,
          data.user.id,
          {
            status: statusFilter,
            priority: priorityFilter,
            assigneeId: assigneeFilter,
            type: typeFilter,
            source: sourceFilter,
            tag,
            untagged,
            search,
          },
          showDone,
        ),
        initialFilters,
      ),
    [
      items,
      showDone,
      statusFilter,
      priorityFilter,
      assigneeFilter,
      typeFilter,
      sourceFilter,
      tag,
      untagged,
      search,
      data.user.id,
      initialFilters.due,
      initialFilters.followUp,
    ],
  );
  const groupOptions =
    board || groupBy === 'status'
      ? statuses.map((s) => ({ id: s.id, name: s.name }))
      : groupBy === 'priority'
        ? priorities.map((p) => ({ id: p.id, name: p.name }))
        : groupBy === 'project'
          ? [
              ...data.projects.map((p) => ({ id: p.id, name: p.name })),
              { id: 'inbox', name: 'Inbox' },
            ]
          : [
              {
                id: 'all',
                name: initialFilters.followUp
                  ? 'Follow-ups'
                  : initialFilters.due
                    ? 'Upcoming deadlines'
                    : 'Work items',
              },
            ];
  const groups =
    groupBy === 'tag' && !board
      ? groupWorkItemsByTag(visible)
      : groupOptions
          .map((g) => ({
            ...g,
            items: visible.filter((i) =>
              groupBy === 'none' && !board
                ? true
                : (board || groupBy === 'status'
                    ? i.status
                    : groupBy === 'priority'
                      ? i.priority
                      : i.projectId || 'inbox') === g.id,
            ),
          }))
          .filter((g) =>
            board
              ? showDone || g.id === statusFilter || !['done', 'canceled'].includes(g.id)
              : g.items.length > 0,
          );
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
        drag.moved = true;
        setDragging(drag.id);
        document.body.classList.add('board-dragging');
      }
    };
    const end = (e: PointerEvent) => {
      const drag = pointerDrag.current;
      pointerDrag.current = null;
      setDragging(null);
      document.body.classList.remove('board-dragging');
      if (e.type === 'pointercancel' || !drag?.moved) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 50);
      const column = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-board-status]');
      const item = items.find((i) => i.id === drag.id);
      if (column?.dataset.boardStatus && item && item.status !== column.dataset.boardStatus)
        void update(item, { status: column.dataset.boardStatus as Status });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('board-dragging');
    };
  }, [items]);
  function activeRow() {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-item-id]',
    );
    return focused && listRef.current?.contains(focused)
      ? focused
      : listRef.current?.querySelector<HTMLElement>('[data-item-id]:hover') || null;
  }
  function activeItem() {
    return items.find((item) => item.id === activeRow()?.dataset.itemId);
  }
  function moveFocus(direction: number) {
    const rendered = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-item-id]') || [],
    );
    if (!rendered.length) return false;
    const row = activeRow();
    const index = row ? rendered.indexOf(row) : -1;
    const next =
      index < 0
        ? direction > 0
          ? 0
          : rendered.length - 1
        : Math.max(0, Math.min(rendered.length - 1, index + direction));
    rendered[next].focus();
    rendered[next].scrollIntoView({ block: 'nearest' });
  }
  function act(action: ItemAction) {
    const item = activeItem();
    if (!item) return false;
    if (!activateItemControl(activeRow(), action)) openItem(item.id, action);
  }
  const copy = (identifier: boolean) => {
    const item = activeItem();
    if (!item) return false;
    const url = new URL(location.href);
    url.hash = `/item/${item.id}`;
    void navigator.clipboard
      .writeText(identifier ? item.identifier : url.href)
      .then(() => toast(identifier ? 'Identifier copied' : 'Link copied'))
      .catch(() => toast('Could not access clipboard', 'error'));
  };
  useShortcuts(
    'list',
    {
      ...((filterOpen || displayOpen) && {
        dismiss: () => {
          setFilterOpen(false);
          setDisplayOpen(false);
          if (filterOpen) filterTrigger.current?.focus();
          else displayTrigger.current?.focus();
        },
      }),
      listSearch: () => {
        searchInput.current?.focus();
        searchInput.current?.select();
      },
      filter: () => {
        setFilterOpen((value) => !value);
        setDisplayOpen(false);
      },
      layout: () => {
        const route = readRoute();
        navigate(route.page, route.id, board ? 'list' : 'board');
      },
      next: () => moveFocus(1),
      previous: () => moveFocus(-1),
      open: () => {
        const focused = document.activeElement as HTMLElement | null;
        if (
          focused?.closest('button,a,input,textarea,select') &&
          !focused.matches('[data-item-id]')
        )
          return false;
        const item = activeItem();
        if (!item) return false;
        openItem(item.id);
      },
      ...Object.fromEntries(itemActions.map((action) => [action, () => act(action)])),
      assignMe: () => {
        const item = activeItem();
        if (!item || saving) return false;
        if (item.assigneeId !== data.user.id) void update(item, { assigneeId: data.user.id });
      },
      subtask: () => {
        const item = activeItem();
        if (!item) return false;
        createItem(item.projectId, 'todo', item.id);
      },
      copyLink: () => copy(false),
      copyId: () => copy(true),
    },
    { root: listRef },
  );
  useEffect(() => {
    if (filterOpen)
      filterPanel.current?.querySelector<HTMLButtonElement>('.picker-trigger')?.focus();
  }, [filterOpen]);
  async function update(item: WorkItem, fields: Partial<WorkItem>) {
    setSaving(true);
    try {
      await patch(`/items/${item.id}`, fields);
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }
  async function saveView() {
    if (!viewName.trim()) return;
    const filters: Record<string, string> = {
      ...initialFilters,
      ...baseFilters,
      ...(projectId ? { projectId } : {}),
      showDone: String(showDone),
      groupBy,
    };
    for (const key of [
      'status',
      'priority',
      'assigneeId',
      'type',
      'source',
      'tag',
      'untagged',
      'search',
    ])
      delete filters[key];
    for (const [key, value] of Object.entries({
      status: statusFilter,
      priority: priorityFilter,
      assigneeId: assigneeFilter,
      type: typeFilter,
      source: sourceFilter,
      tag,
      untagged,
      search: search.trim(),
    }))
      if (value) filters[key] = value;
    setSaving(true);
    try {
      await post('/views', {
        name: viewName.trim(),
        icon: 'bookmark',
        layout: board ? 'board' : 'list',
        filters,
      });
      await refresh();
      setSaveOpen(false);
      toast('View saved to your sidebar');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }
  function statusControl(item: WorkItem) {
    return (
      <span className="inline-control status-control" onClick={(e) => e.stopPropagation()}>
        <StatusIcon status={item.status} />
        <Select
          shortcut="s"
          value={item.status}
          aria-label={`Status of ${item.identifier}`}
          onChange={(e) => update(item, { status: e.target.value as Status })}
        >
          {statuses.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </span>
    );
  }
  function itemRow(item: WorkItem) {
    return (
      <div
        className="work-row"
        key={item.id}
        data-item-id={item.id}
        tabIndex={0}
        role="button"
        aria-label={`${item.identifier} ${item.title}`}
        onClick={() => openItem(item.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            openItem(item.id);
          }
          if (e.key === ' ') {
            e.preventDefault();
            update(item, { status: item.status === 'done' ? 'todo' : 'done' });
          }
        }}
      >
        {statusControl(item)}
        <span className="item-identifier">{item.identifier}</span>
        <div className={`item-name ${item.source ? 'has-source' : ''}`}>
          <div className="item-title-line">
            <span className={isDone(item) ? 'completed-title' : ''}>{item.title}</span>
            {item.visibility === 'private' && <LockKeyhole size={12} className="muted" />}
            <span className="row-labels">
              {item.labels.slice(0, 2).map((label) => (
                <span
                  key={label}
                  className={`label-tag label-${label.toLowerCase().replace(/[^a-z]/g, '')}`}
                >
                  {label}
                </span>
              ))}
            </span>
          </div>
          <SourceBadge item={item} />
        </div>
        <span className="inline-control priority-cell" onClick={(e) => e.stopPropagation()}>
          <PriorityIcon priority={item.priority} />
          <span className="priority-name">
            {priorities.find((p) => p.id === item.priority)?.name}
          </span>
          <Select
            shortcut="p"
            aria-label={`Priority of ${item.identifier}`}
            value={item.priority}
            onChange={(e) => update(item, { priority: e.target.value as Priority })}
          >
            {priorities.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </span>
        <span className="inline-control assignee-cell" onClick={(e) => e.stopPropagation()}>
          <Avatar user={data.users.find((u) => u.id === item.assigneeId)} />
          <Select
            shortcut="a"
            aria-label={`Assignee of ${item.identifier}`}
            value={item.assigneeId || ''}
            onChange={(e) => update(item, { assigneeId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {data.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </span>
        <span className={`due-cell ${overdue(item) ? 'overdue' : ''}`}>
          {item[dateField] ? (
            <>
              <CalendarDays size={12} />
              {shortDate(item[dateField])}
            </>
          ) : (
            <span className="empty-date">—</span>
          )}
        </span>
      </div>
    );
  }
  return (
    <div className={`work-view ${board ? 'board-view' : ''}`}>
      <div className="work-toolbar">
        <div className="popover-parent">
          <button
            ref={filterTrigger}
            title="Filter (F)"
            className={`button ${filterCount ? 'filter-active' : ''}`}
            onClick={() => {
              setFilterOpen(!filterOpen);
              setDisplayOpen(false);
            }}
          >
            <ListFilter size={15} />
            Filter{filterCount > 0 && <span className="filter-number">{filterCount}</span>}
          </button>
          {filterOpen && (
            <>
              <button
                className="popover-dismiss"
                aria-label="Close filters"
                onClick={() => setFilterOpen(false)}
              />
              <div
                ref={filterPanel}
                className="popover filter-popover"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setFilterOpen(false);
                    filterTrigger.current?.focus();
                  }
                }}
              >
                <h4>Filter work items</h4>
                <label className="field">
                  Tag
                  <Select
                    className="select"
                    value={tagFilter}
                    onChange={(e) => setTagFilter(e.target.value)}
                  >
                    <option value="">All tags</option>
                    <option value="untagged">No tags</option>
                    {tagOptions.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                    {tag && !tagOptions.some((group) => group.id === tagFilter) && (
                      <option value={tagFilter}>{tag} (no items here)</option>
                    )}
                  </Select>
                </label>
                <label className="field">
                  Source
                  <Select
                    className="select"
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value)}
                  >
                    <option value="">All sources</option>
                    <option value="native">Native · Trestl</option>
                    <option value="gitea">Gitea</option>
                    <option value="github">GitHub</option>
                    <optgroup label="Repositories">
                      {repositories.map((source) => (
                        <option
                          key={source.integrationId}
                          value={`integration:${source.integrationId}`}
                        >
                          {source.repository} · {new URL(source.url).host}
                        </option>
                      ))}
                    </optgroup>
                    {sourceFilter.startsWith('integration:') &&
                      !repositories.some(
                        (source) => sourceFilter === `integration:${source.integrationId}`,
                      ) && <option value={sourceFilter}>Saved repository (no items here)</option>}
                  </Select>
                </label>
                <label className="field">
                  Status
                  <Select
                    className="select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {statuses.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  Priority
                  <Select
                    className="select"
                    value={priorityFilter}
                    onChange={(e) => setPriorityFilter(e.target.value)}
                  >
                    <option value="">All priorities</option>
                    {priorities.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  Assignee
                  <Select
                    className="select"
                    value={assigneeFilter}
                    onChange={(e) => setAssigneeFilter(e.target.value)}
                  >
                    <option value="">Anyone</option>
                    <option value="me">Assigned to me</option>
                    {data.users.map((u) => (
                      <option value={u.id} key={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  Type
                  <Select
                    className="select"
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                  >
                    <option value="">All types</option>
                    <option value="task">Task</option>
                    <option value="bug">Bug</option>
                    <option value="idea">Idea</option>
                    <option value="followup">Follow-up</option>
                  </Select>
                </label>
                <button
                  className="button ghost"
                  onClick={() => {
                    setStatusFilter('');
                    setPriorityFilter('');
                    setAssigneeFilter('');
                    setTypeFilter('');
                    setSourceFilter('');
                    setTagFilter('');
                  }}
                >
                  Clear filters
                </button>
              </div>
            </>
          )}
        </div>
        <label className="list-search">
          <Search size={15} />
          <input
            ref={searchInput}
            aria-label="Search work items"
            placeholder="Search work items…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setSearch('');
                event.currentTarget.blur();
              }
            }}
          />
          {search ? (
            <button onClick={() => setSearch('')} aria-label="Clear search">
              <X size={13} />
            </button>
          ) : (
            <kbd>{formatShortcut('mod+f')}</kbd>
          )}
        </label>
        <div className="toolbar-spacer" />
        <button
          className="icon-button save-view-button"
          title="Save view"
          aria-label="Save view"
          onClick={() => setSaveOpen(true)}
        >
          <BookmarkPlus size={17} />
        </button>
        {!board && (
          <label className="group-select">
            <span>Group by:</span>
            <Select
              aria-label="Group by"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
            >
              {groupingOptions.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
            <ChevronDown size={13} />
          </label>
        )}
        <div className="popover-parent">
          <button
            className="button display-button"
            ref={displayTrigger}
            aria-label="Display"
            onClick={() => {
              setDisplayOpen(!displayOpen);
              setFilterOpen(false);
            }}
          >
            <SlidersHorizontal size={14} />
            <span>Display</span>
            <ChevronDown size={12} />
          </button>
          {displayOpen && (
            <>
              <button
                className="popover-dismiss"
                aria-label="Close display options"
                onClick={() => setDisplayOpen(false)}
              />
              <div className="popover display-popover">
                {!board && (
                  <label className="field">
                    Group by
                    <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                      {groupingOptions.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={showDone}
                    onChange={(e) => setShowDone(e.target.checked)}
                  />
                  Show completed items
                </label>
              </div>
            </>
          )}
        </div>
      </div>
      <div ref={listRef} className={board ? 'board-columns' : 'work-groups'}>
        {!board && visible.length === 0 ? (
          <EmptyState
            icon={<Layers size={27} />}
            title={items.length ? 'No matching work items' : 'A clear space for what’s next'}
            description={
              items.length
                ? 'Try another search or adjust your filters.'
                : 'Capture a task, an idea, or something to follow up on.'
            }
            action={
              <button className="button primary" onClick={() => createItem(projectId)}>
                <Plus size={15} />
                Create work item
              </button>
            }
          />
        ) : (
          groups.map((group) =>
            board ? (
              <section
                key={group.id}
                data-board-status={group.id}
                className={`board-column ${dragging ? 'drop-ready' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData('text/plain');
                  const item = items.find((i) => i.id === id);
                  setDragging(null);
                  if (item) update(item, { status: group.id as Status });
                }}
              >
                <header>
                  <StatusIcon status={group.id as Status} />
                  <strong>{group.name}</strong>
                  <span>{group.items.length}</span>
                  <button
                    className="icon-button"
                    onClick={() => createItem(projectId, group.id as Status)}
                    aria-label={`Add ${group.name} item`}
                  >
                    <Plus size={15} />
                  </button>
                </header>
                {group.items.map((item) => (
                  <article
                    key={item.id}
                    className={`board-card ${dragging === item.id ? 'dragging' : ''}`}
                    onPointerDown={(e) => {
                      if (
                        e.button !== 0 ||
                        (e.target as HTMLElement).closest('select,input,button,a')
                      )
                        return;
                      pointerDrag.current = {
                        id: item.id,
                        x: e.clientX,
                        y: e.clientY,
                        moved: false,
                      };
                    }}
                    onClick={() => {
                      if (!suppressClick.current) openItem(item.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && e.key === 'Enter') {
                        e.preventDefault();
                        openItem(item.id);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    data-item-id={item.id}
                    aria-label={`${item.identifier} ${item.title}`}
                  >
                    <div className="board-card-meta">
                      <span>{item.identifier}</span>
                      <PriorityIcon priority={item.priority} />
                    </div>
                    <h3>{item.title}</h3>
                    <SourceBadge item={item} />
                    {item.labels.length > 0 && (
                      <div className="board-labels">
                        {item.labels.slice(0, 2).map((l) => (
                          <span className="label-tag" key={l}>
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="board-card-footer">
                      {statusControl(item)}
                      {item[dateField] && (
                        <span className={overdue(item) ? 'overdue' : ''}>
                          <CalendarDays size={12} />
                          {shortDate(item[dateField])}
                        </span>
                      )}
                      <Avatar user={data.users.find((u) => u.id === item.assigneeId)} size={22} />
                    </div>
                  </article>
                ))}
                <button
                  className="board-add"
                  onClick={() => createItem(projectId, group.id as Status)}
                >
                  <Plus size={15} />
                  Add item
                </button>
              </section>
            ) : (
              <section key={group.id} className="work-group">
                <div className="group-header">
                  <button
                    className="group-name"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        next.has(group.id) ? next.delete(group.id) : next.add(group.id);
                        return next;
                      })
                    }
                  >
                    {collapsed.has(group.id) ? (
                      <ChevronRight size={14} />
                    ) : (
                      <ChevronDown size={14} />
                    )}
                    <span>
                      {groupBy === 'status' ? (
                        <StatusIcon status={group.id as Status} />
                      ) : groupBy === 'priority' ? (
                        <PriorityIcon priority={group.id as Priority} />
                      ) : groupBy === 'tag' ? (
                        <Tag size={14} />
                      ) : null}
                    </span>
                    <strong>{group.name}</strong>
                    <small>{group.items.length}</small>
                  </button>
                  <span className="group-col-priority">Priority</span>
                  <span className="group-col-assignee">Assignee</span>
                  <span className="group-col-due">
                    {dateField === 'followUpDate' ? 'Follow-up' : 'Due date'}
                  </span>
                </div>
                {!collapsed.has(group.id) && (
                  <>
                    {group.items.map(itemRow)}
                    <button
                      className="add-item-row"
                      onClick={() =>
                        createItem(
                          groupBy === 'project'
                            ? group.id === 'inbox'
                              ? null
                              : group.id
                            : projectId,
                          groupBy === 'status' ? (group.id as Status) : 'todo',
                        )
                      }
                    >
                      <Plus size={14} />
                      Add item
                    </button>
                  </>
                )}
              </section>
            ),
          )
        )}
      </div>
      <div className="work-footer">
        <span>
          {visible.length} work {visible.length === 1 ? 'item' : 'items'}
          {projectId ? ' · Includes subprojects' : ''}
        </span>
        <span>
          {saving ? (
            'Saving…'
          ) : (
            <>
              <kbd>J</kbd>
              <kbd>K</kbd> navigate <span className="footer-divider">·</span> <kbd>↵</kbd> open
            </>
          )}
        </span>
      </div>
      {saveOpen && (
        <Modal title="Save this view" onClose={() => setSaveOpen(false)}>
          <form
            className="simple-form"
            onSubmit={(e) => {
              e.preventDefault();
              saveView();
            }}
          >
            <p className="muted">Keep this list and its filters in your sidebar.</p>
            <label className="field">
              View name
              <input
                className="input"
                autoFocus
                value={viewName}
                onChange={(e) => setViewName(e.target.value)}
                required
                placeholder="e.g. Platform priorities"
                maxLength={100}
              />
            </label>
            <div className="form-actions">
              <button type="button" className="button" onClick={() => setSaveOpen(false)}>
                Cancel
              </button>
              <button disabled={saving} className="button primary">
                Save view
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
