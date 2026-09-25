import { ParentPicker, HierarchyMenu } from './ParentPicker';
import { childProgress, parentBoardItems } from '../lib/hierarchy';
import { assigneeOptions } from '../lib/assignees';
import { useShortcuts, activateItemControl } from '../lib/keyboard';
import { itemActions, formatShortcut, type ItemAction } from '../lib/shortcuts';
import { Select } from './Select';
import { BoardSettings } from './BoardSettings';
import {
  boardMoveUpdates,
  moveColumn,
  readBoardPreferences,
  saveBoardPreferences,
  type BoardPreferences,
} from '../lib/board';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { buildWorkTree, flattenWorkTree } from '../lib/work-tree';
import './work-tree.css';
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
  GripVertical,
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
  const [milestoneFilter, setMilestoneFilter] = useState(initialFilters.milestoneId || '');
  const [sourceFilter, setSourceFilter] = useState(initialFilters.source || '');
  const [hierarchyFilter, setHierarchyFilter] = useState(
    initialFilters.hierarchy || (initialFilters.parentId ? 'subtasks' : ''),
  );
  const [parentFilter, setParentFilter] = useState(initialFilters.parentId || '');
  const [indentSubtasks, setIndentSubtasks] = useState(initialFilters.indentSubtasks !== 'false');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [parentTargets, setParentTargets] = useState<WorkItem[] | null>(null);
  const progress = useMemo(() => childProgress(data.items), [data.items]);
  const hierarchyParentId = hierarchyFilter === 'subtasks' ? parentFilter : '';
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
  const route = readRoute();
  const boardKey = `trestl.board.v1.${data.user.id}.${data.user.workspaceId || 'default'}.${route.page}.${route.id || projectId || ''}`;
  const [boardPreferences, setBoardPreferences] = useState(() =>
    readBoardPreferences(boardKey, initialFilters.board, initialFilters.showDone === 'true'),
  );
  const [listShowDone, setListShowDone] = useState(initialFilters.showDone === 'true');
  const showDone = board ? boardPreferences.showDone : listShowDone;
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);
  const [columnDragging, setColumnDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ status: Status; beforeId: string | null } | null>(
    null,
  );
  function customizeBoard(value: BoardPreferences) {
    setBoardPreferences(value);
    saveBoardPreferences(boardKey, value);
  }
  function setShowDone(value: boolean) {
    if (board) customizeBoard({ ...boardPreferences, showDone: value });
    else setListShowDone(value);
  }
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [expandedItems, setExpandedItems] = useState(new Set<string>());
  const appliedTreeFilter = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const pointerDrag = useRef<{
    id: string;
    kind: 'card' | 'column';
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
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
    Number(!!milestoneFilter) +
    Number(!!sourceFilter) +
    Number(!!tagFilter) +
    Number(!!hierarchyFilter);
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
            milestoneId: milestoneFilter,
            hierarchy: hierarchyFilter,
            parentId: hierarchyParentId,
            tag,
            untagged,
            search,
          },
          showDone,
          data.items,
        ),
        board ? {} : initialFilters,
      ),
    [
      items,
      board,
      showDone,
      statusFilter,
      priorityFilter,
      assigneeFilter,
      typeFilter,
      sourceFilter,
      milestoneFilter,
      hierarchyFilter,
      hierarchyParentId,
      data.items,
      tag,
      untagged,
      search,
      data.user.id,
      initialFilters.due,
      initialFilters.followUp,
    ],
  );
  const treeFiltered = filterCount > 0 || !!search.trim();
  const treeFilterKey = JSON.stringify([
    search.trim(),
    statusFilter,
    priorityFilter,
    assigneeFilter,
    typeFilter,
    sourceFilter,
    milestoneFilter,
    tagFilter,
    hierarchyFilter,
    hierarchyParentId,
  ]);
  useEffect(() => {
    setSelected(new Set());
  }, [treeFilterKey]);
  const tree = useMemo(
    () => buildWorkTree(items, visible, sortWorkItems(data.items, initialFilters), treeFiltered),
    [items, visible, data.items, treeFiltered, initialFilters.due, initialFilters.followUp],
  );
  useEffect(() => {
    if (board) return;
    if (!treeFiltered) {
      appliedTreeFilter.current = null;
      return;
    }
    if (appliedTreeFilter.current === treeFilterKey) return;
    appliedTreeFilter.current = treeFilterKey;
    setCollapsed(new Set());
    setExpandedItems(
      new Set(
        [...tree.nodes.values()].filter((node) => node.children.length).map((node) => node.item.id),
      ),
    );
  }, [tree, treeFiltered, treeFilterKey, board]);
  const groupedItems = board
    ? boardPreferences.collapseSubtasks
      ? parentBoardItems(visible)
      : visible
    : indentSubtasks
      ? tree.roots.map((node) => node.item)
      : visible;
  const groupOptions = board
    ? boardPreferences.columns.filter((column) => !column.hidden || column.id === statusFilter)
    : groupBy === 'status'
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
      ? groupWorkItemsByTag(groupedItems)
      : groupOptions
          .map((g) => ({
            ...g,
            items: groupedItems.filter((i) =>
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
  function pointerTarget(x: number, y: number, draggedId: string) {
    const column = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-board-status]');
    if (!column || !listRef.current?.contains(column)) return null;
    const cards = Array.from(column.querySelectorAll<HTMLElement>('[data-item-id]')).filter(
      (card) => card.dataset.itemId !== draggedId,
    );
    const before = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return y < rect.top + rect.height / 2;
    });
    return {
      status: column.dataset.boardStatus as Status,
      beforeId: before?.dataset.itemId || null,
    };
  }
  async function moveCard(item: WorkItem, status: Status, beforeId: string | null) {
    const updates = boardMoveUpdates(items, item, status, beforeId);
    if (!updates.length || saving) return;
    setSaving(true);
    try {
      for (const entry of updates)
        await patch(`/items/${entry.item.id}`, { status: entry.status, position: entry.position });
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      try {
        await refresh();
      } finally {
        setSaving(false);
      }
    }
  }
  useEffect(() => {
    if (!board) return;
    const move = (e: PointerEvent) => {
      const drag = pointerDrag.current;
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
        drag.moved = true;
        if (drag.kind === 'card') {
          setDragging(drag.id);
          setDropTarget(pointerTarget(e.clientX, e.clientY, drag.id));
        } else setColumnDragging(drag.id);
        document.body.classList.add('board-dragging');
        const bounds = listRef.current?.getBoundingClientRect();
        if (bounds && e.clientY >= bounds.top && e.clientY <= bounds.bottom) {
          if (e.clientX > bounds.right - 45) listRef.current!.scrollLeft += 18;
          if (e.clientX < bounds.left + 45) listRef.current!.scrollLeft -= 18;
        }
      }
    };
    const end = (e: PointerEvent) => {
      const drag = pointerDrag.current;
      pointerDrag.current = null;
      setDragging(null);
      setColumnDragging(null);
      setDropTarget(null);
      document.body.classList.remove('board-dragging');
      if (e.type === 'pointercancel' || !drag?.moved) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 50);
      const target = pointerTarget(e.clientX, e.clientY, drag.id);
      if (!target) return;
      if (drag.kind === 'column') {
        customizeBoard({
          ...boardPreferences,
          columns: moveColumn(boardPreferences.columns, drag.id, target.status),
        });
      } else {
        const item = items.find((entry) => entry.id === drag.id);
        if (item) void moveCard(item, target.status, target.beforeId);
      }
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
  }, [board, items, boardPreferences, saving]);
  function activeRow() {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-item-id]',
    );
    return focused && listRef.current?.contains(focused)
      ? focused
      : listRef.current?.querySelector<HTMLElement>('[data-item-id]:hover') || null;
  }
  function activeItem() {
    return data.items.find((item) => item.id === activeRow()?.dataset.itemId);
  }
  function toggleItem(id: string) {
    setExpandedItems((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function navigateTree(direction: 'open' | 'close') {
    if (board || !indentSubtasks) return false;
    const row = activeRow();
    if (!row) return false;
    const focused = document.activeElement as HTMLElement | null;
    if (row.contains(focused) && focused !== row && !focused?.closest('.tree-toggle')) return false;
    const id = row.dataset.itemId!;
    const node = tree.nodes.get(id);
    if (!node) return false;
    if (direction === 'open' && node.children.length) {
      if (!expandedItems.has(id)) {
        toggleItem(id);
        row.focus();
      } else {
        const child = row.nextElementSibling as HTMLElement | null;
        if (child?.dataset.treeParent === id) child.focus();
      }
    } else if (direction === 'close') {
      if (node.children.length && expandedItems.has(id)) {
        toggleItem(id);
        row.focus();
      } else if (row.dataset.treeParent) {
        const rows = row.closest('.work-group')?.querySelectorAll<HTMLElement>('[data-item-id]');
        Array.from(rows || [])
          .find((entry) => entry.dataset.itemId === row.dataset.treeParent)
          ?.focus();
      }
    }
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
      expandTree: () => navigateTree('open'),
      collapseTree: () => navigateTree('close'),
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
  async function setParentForItems(targets: WorkItem[], parentId: string | null) {
    if (saving) return false;
    setSaving(true);
    const completed = new Set<string>();
    let failure = '';
    try {
      for (const item of targets) {
        try {
          await patch(`/items/${item.id}`, { parentId, expectedRevision: item.revision ?? 0 });
          completed.add(item.id);
        } catch (error) {
          failure = (error as Error).message;
          break;
        }
      }
      await refresh();
      setSelected((previous) => new Set([...previous].filter((id) => !completed.has(id))));
      if (failure) {
        toast(`${completed.size} of ${targets.length} updated. ${failure}`, 'error');
        // Close the dialog so another attempt uses fresh revisions from bootstrap.
      } else
        toast(
          parentId
            ? `Parent set for ${completed.size} work items`
            : `Moved ${completed.size} work items to top level`,
        );
      return true;
    } catch (error) {
      toast((error as Error).message, 'error');
      return false;
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
      indentSubtasks: String(indentSubtasks),
      ...(board ? { board: JSON.stringify(boardPreferences) } : {}),
    };
    for (const key of [
      'status',
      'priority',
      'assigneeId',
      'type',
      'source',
      'hierarchy',
      'parentId',
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
      milestoneId: milestoneFilter,
      hierarchy: hierarchyFilter,
      parentId: hierarchyParentId,
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
  function itemRow({
    node,
    depth,
    parentId,
    position,
    setSize,
  }: ReturnType<typeof flattenWorkTree>[number]) {
    const { item } = node;
    const expanded = expandedItems.has(item.id);
    return (
      <div
        className={`work-row work-tree-row ${depth ? 'work-tree-child' : ''} ${!node.matches && treeFiltered ? 'work-tree-context' : ''}`}
        key={item.id}
        data-item-id={item.id}
        data-tree-parent={parentId}
        style={{ '--tree-depth': Math.min(depth, 4) } as CSSProperties}
        tabIndex={0}
        role="treeitem"
        aria-selected={selecting ? selected.has(item.id) : undefined}
        aria-level={depth + 1}
        aria-posinset={position}
        aria-setsize={setSize}
        aria-expanded={node.children.length ? expanded : undefined}
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
        <div className="work-tree-main">
          {selecting && (
            <input
              type="checkbox"
              className="hierarchy-select"
              aria-label={`Select ${item.identifier}`}
              checked={selected.has(item.id)}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  event.target.checked ? next.add(item.id) : next.delete(item.id);
                  return next;
                })
              }
            />
          )}
          {node.childCount > 0 ? (
            <button
              className="tree-toggle tree-chevron"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} subtasks of ${item.identifier}`}
              aria-expanded={node.children.length ? expanded : undefined}
              disabled={!node.children.length}
              title={
                node.children.length
                  ? `${expanded ? 'Collapse' : 'Expand'} subtasks (← / →)`
                  : !indentSubtasks
                    ? 'Subtasks are displayed as separate rows'
                    : 'No subtasks match the current filters'
              }
              onClick={(event) => {
                event.stopPropagation();
                toggleItem(item.id);
              }}
            >
              {expanded && node.children.length ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
          ) : (
            <span className="tree-spacer" aria-hidden="true" />
          )}
          {statusControl(item)}
          <span className="item-identifier">{item.identifier}</span>
          <div className={`item-name ${item.source ? 'has-source' : ''}`}>
            <div className="item-title-line">
              <span className={isDone(item) ? 'completed-title' : ''}>{item.title}</span>
              {node.childCount > 0 && (
                <button
                  className="tree-toggle tree-count"
                  aria-label={`${node.completedChildren} of ${node.childCount} subtasks completed for ${item.identifier}`}
                  aria-expanded={node.children.length ? expanded : undefined}
                  disabled={!node.children.length}
                  title={`${node.completedChildren} of ${node.childCount} subtasks completed${treeFiltered ? ` · ${node.children.length} shown by filters` : ''}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleItem(item.id);
                  }}
                >
                  {node.completedChildren}/{node.childCount} subtasks done
                </button>
              )}
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
            {depth > 0 && (
              <span className="tree-status">
                {statuses.find((status) => status.id === item.status)?.name}
              </span>
            )}
            {!node.matches && treeFiltered && (
              <span className="tree-context-label">Parent context</span>
            )}
          </div>
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
            {assigneeOptions(data.users, item.assigneeId).map((u) => (
              <option key={u.id} value={u.id} disabled={u.disabled}>
                {u.label}
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
          <HierarchyMenu
            item={item}
            disabled={saving}
            onParent={() => setParentTargets([item])}
            onClear={() => void setParentForItems([item], null)}
          />
        </span>
      </div>
    );
  }
  return (
    <div
      className={`work-view ${selecting ? 'hierarchy-selecting' : ''} ${board ? 'board-view' : ''} ${board && boardPreferences.compact ? 'board-compact' : ''}`}
    >
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
                  Hierarchy
                  <Select
                    className="select"
                    value={hierarchyFilter}
                    onChange={(event) => setHierarchyFilter(event.target.value)}
                  >
                    <option value="">All levels</option>
                    <option value="top-level">Top level only</option>
                    <option value="has-subtasks">Has subtasks</option>
                    <option value="subtasks">Subtasks of…</option>
                  </Select>
                </label>
                {hierarchyFilter === 'subtasks' && (
                  <label className="field">
                    Subtasks of
                    <Select
                      className="select"
                      searchable
                      aria-label="Subtasks of"
                      value={parentFilter}
                      onChange={(event) => setParentFilter(event.target.value)}
                    >
                      <option value="">Choose a parent…</option>
                      {data.items
                        .filter((item) => progress.has(item.id))
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.identifier} · {item.title}
                          </option>
                        ))}
                      {parentFilter &&
                        !data.items.some(
                          (item) => item.id === parentFilter && progress.has(item.id),
                        ) && <option value={parentFilter}>Saved parent (no subtasks here)</option>}
                    </Select>
                  </label>
                )}
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
                  Milestone
                  <Select
                    value={milestoneFilter}
                    onChange={(e) => setMilestoneFilter(e.target.value)}
                  >
                    <option value="">All milestones</option>
                    <option value="null">No milestone</option>
                    {data.milestones
                      .filter(
                        (m) =>
                          !projectId ||
                          m.projectId === projectId ||
                          items.some((item) => item.projectId === m.projectId),
                      )
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.title} · {data.projects.find((p) => p.id === m.projectId)?.name}
                        </option>
                      ))}
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
                    setMilestoneFilter('');
                    setSourceFilter('');
                    setTagFilter('');
                    setHierarchyFilter('');
                    setParentFilter('');
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
        {!board && (
          <button
            className="button"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting(!selecting);
              setSelected(new Set());
            }}
          >
            {selecting ? 'Done selecting' : 'Select items'}
          </button>
        )}
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
        {board && (
          <button className="button" onClick={() => setBoardSettingsOpen(true)}>
            <SlidersHorizontal size={14} />
            Customize board
          </button>
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
                {!board && (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={indentSubtasks}
                      onChange={(event) => setIndentSubtasks(event.target.checked)}
                    />
                    Show subtasks under their parent
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
      {boardSettingsOpen && (
        <BoardSettings
          value={boardPreferences}
          onSave={customizeBoard}
          onClose={() => setBoardSettingsOpen(false)}
        />
      )}
      {board && (
        <p className="board-hint">
          Drag column handles to rearrange. Drag cards to move or reorder; use Alt + ↑ / ↓ on a
          focused card to reorder with the keyboard.
        </p>
      )}
      {selecting && !board && (
        <div className="hierarchy-selection">
          <strong>{selected.size} selected</strong>
          <button
            className="button small"
            onClick={() => setSelected(new Set(visible.map((item) => item.id)))}
          >
            Select all {visible.length} matching
          </button>
          <button
            className="button small"
            disabled={!selected.size || saving}
            onClick={() => setParentTargets(data.items.filter((item) => selected.has(item.id)))}
          >
            Set parent
          </button>
          <button
            className="button small ghost"
            disabled={!selected.size}
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}
      <div ref={listRef} className={board ? 'board-columns' : 'work-groups'}>
        {(board ? groups.length === 0 : visible.length === 0) ? (
          <EmptyState
            icon={<Layers size={27} />}
            title={
              board
                ? 'No visible columns'
                : items.length
                  ? 'No matching work items'
                  : 'A clear space for what’s next'
            }
            description={
              board
                ? 'Choose the columns you want to see in Customize board.'
                : items.length
                  ? 'Try another search or adjust your filters.'
                  : 'Capture a task, an idea, or something to follow up on.'
            }
            action={
              board ? (
                <button className="button primary" onClick={() => setBoardSettingsOpen(true)}>
                  Customize board
                </button>
              ) : (
                <button className="button primary" onClick={() => createItem(projectId)}>
                  <Plus size={15} />
                  Create work item
                </button>
              )
            }
          />
        ) : (
          groups.map((group) =>
            board ? (
              <section
                key={group.id}
                data-board-status={group.id}
                className={`board-column ${dropTarget?.status === group.id ? 'drop-ready' : ''} ${columnDragging === group.id ? 'column-dragging' : ''}`}
              >
                <header>
                  <button
                    className="icon-button board-column-handle"
                    aria-label={`Rearrange ${group.name} column`}
                    title="Drag to rearrange, or press Enter to customize"
                    onClick={() => {
                      if (!suppressClick.current) setBoardSettingsOpen(true);
                    }}
                    onPointerDown={(event) => {
                      if (event.button !== 0) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      pointerDrag.current = {
                        id: group.id,
                        kind: 'column',
                        x: event.clientX,
                        y: event.clientY,
                        moved: false,
                      };
                    }}
                  >
                    <GripVertical size={14} />
                  </button>
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
                    className={`board-card ${dragging === item.id ? 'dragging' : ''} ${dropTarget?.beforeId === item.id ? 'board-drop-before' : ''}`}
                    onPointerDown={(e) => {
                      if (
                        saving ||
                        e.button !== 0 ||
                        (e.target as HTMLElement).closest('select,input,button,a')
                      )
                        return;
                      e.currentTarget.setPointerCapture(e.pointerId);
                      pointerDrag.current = {
                        id: item.id,
                        kind: 'card',
                        x: e.clientX,
                        y: e.clientY,
                        moved: false,
                      };
                    }}
                    onClick={() => {
                      if (!suppressClick.current) openItem(item.id);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.target === e.currentTarget &&
                        e.altKey &&
                        ['ArrowUp', 'ArrowDown'].includes(e.key)
                      ) {
                        e.preventDefault();
                        const index = group.items.findIndex((entry) => entry.id === item.id);
                        if (e.key === 'ArrowUp' && index > 0)
                          void moveCard(item, item.status, group.items[index - 1].id);
                        if (e.key === 'ArrowDown' && index < group.items.length - 1)
                          void moveCard(item, item.status, group.items[index + 2]?.id || null);
                      }
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
                    {progress.has(item.id) && (
                      <span className="hierarchy-progress">
                        {progress.get(item.id)!.done}/{progress.get(item.id)!.total} subtasks done
                      </span>
                    )}
                    <SourceBadge item={item} />
                    {boardPreferences.showLabels && item.labels.length > 0 && (
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
                  className={`board-add ${dropTarget?.status === group.id && !dropTarget.beforeId ? 'board-drop-before' : ''}`}
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
                    <small
                      title={`${group.items.length} ${indentSubtasks ? 'top-level ' : ''}items`}
                    >
                      {group.items.length}
                    </small>
                  </button>
                  <span className="group-col-priority">Priority</span>
                  <span className="group-col-assignee">Assignee</span>
                  <span className="group-col-due">
                    {dateField === 'followUpDate' ? 'Follow-up' : 'Due date'}
                  </span>
                </div>
                {!collapsed.has(group.id) && (
                  <>
                    <div
                      role="tree"
                      aria-label={groupBy === 'none' ? group.name : `${group.name} work items`}
                    >
                      {(indentSubtasks
                        ? flattenWorkTree(
                            group.items.map((item) => tree.nodes.get(item.id)!),
                            expandedItems,
                          )
                        : group.items.map((item, index) => ({
                            node: { ...tree.nodes.get(item.id)!, children: [] },
                            depth: 0,
                            position: index + 1,
                            setSize: group.items.length,
                          }))
                      ).map(itemRow)}
                    </div>
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
              {!board && (
                <>
                  {' '}
                  <span className="footer-divider">·</span> <kbd>←</kbd>
                  <kbd>→</kbd> subtasks
                </>
              )}
            </>
          )}
        </span>
      </div>
      {parentTargets && (
        <ParentPicker
          items={parentTargets}
          onClose={() => setParentTargets(null)}
          onSave={(parentId) => setParentForItems(parentTargets, parentId)}
        />
      )}
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
