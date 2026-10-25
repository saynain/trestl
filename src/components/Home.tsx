import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, CircleCheck, Hourglass, Lightbulb, Lock, Plus, Sun } from 'lucide-react';
import type { WorkItem } from '../../shared/types';
import { api, patch, ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { useShortcuts } from '../lib/keyboard';
import { navigate, priorities, shortDate, statuses, today, types } from '../lib/model';
import {
  homeItems,
  homeSection,
  homeTodayKey,
  readHomeToday,
  saveHomeToday,
  tomorrow,
  type HomeSection,
} from '../lib/home';
import { EmptyState, PriorityIcon, StatusIcon } from './ui';
import './home.css';

const sections = [
  {
    id: 'attention',
    label: 'Needs attention',
    description: 'Overdue deadlines, work due today, and follow-ups ready for review.',
    empty: 'Nothing needs your attention right now',
    hint: 'Dated follow-ups appear here when it’s time. Continuing holds work already in progress.',
  },
  {
    id: 'today',
    label: 'Today',
    description:
      'Your chosen focus for today. Adding here does not change deadlines or notify others.',
    empty: 'Choose a little focus for today',
    hint: 'Use the sun beside an item to add it to Today. Your selection starts fresh each day.',
  },
  {
    id: 'continuing',
    label: 'Continuing',
    description: 'Work in progress or review without an overdue or immediate date.',
    empty: 'Room to start something',
    hint: 'Work you start appears here. Deadlines and dated reviews take precedence.',
  },
  {
    id: 'next',
    label: 'Next up',
    description: 'Upcoming dates and tasks you can pick up next.',
    empty: 'Room for what comes next',
    hint: 'Capture a task or schedule a follow-up above. It can stay in your personal inbox.',
  },
  {
    id: 'someday',
    label: 'Someday',
    description: 'Ideas and backlog items without a date. Keep them here until you’re ready.',
    empty: 'Keep a little room for possibilities',
    hint: 'Choose Someday above to save something you might want to do in the future.',
  },
  {
    id: 'all',
    label: 'All my work',
    description: 'Your open work from projects and your personal inbox.',
    empty: 'A clear space for what’s next',
    hint: 'Add something you want to do, remember, or follow up on. No project needed.',
  },
] as const;

type CaptureKind = 'task' | 'followup' | 'someday';
const captureKinds = [
  { id: 'task', label: 'Task', icon: CircleCheck },
  { id: 'followup', label: 'Follow-up', icon: Hourglass },
  { id: 'someday', label: 'Someday', icon: Lightbulb },
] as const;

function QuickCapture({ scope }: { scope: string }) {
  const { data, refresh, toast, toastAction, openItem, applyItems, removeItems } = useApp();
  const draftKey = `trestl.capture.v1.${scope}`;
  const [draft, setDraft] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
      return {
        title: typeof saved?.title === 'string' ? saved.title.slice(0, 240) : '',
        kind: (captureKinds.some((kind) => kind.id === saved?.kind)
          ? saved.kind
          : 'task') as CaptureKind,
        date: typeof saved?.date === 'string' ? saved.date : '',
      };
    } catch {
      return { title: '', kind: 'task' as CaptureKind, date: '' };
    }
  });
  const { title, kind, date } = draft;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState<WorkItem | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const attemptKey = `${draftKey}.attempt`;
  const [initialAttempt] = useState<{ body: string; key: string; createdAt: number } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(attemptKey) || 'null');
      return typeof saved?.body === 'string' &&
        typeof saved?.key === 'string' &&
        typeof saved.createdAt === 'number' &&
        Date.now() - saved.createdAt < 30 * 60000
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const pending = useRef(initialAttempt);
  useEffect(() => {
    try {
      if (title || date || kind !== 'task') localStorage.setItem(draftKey, JSON.stringify(draft));
      else localStorage.removeItem(draftKey);
    } catch {
      // Capture remains available if browser storage is disabled.
    }
  }, [draft, draftKey, title, date, kind]);
  async function undoCapture(item: WorkItem) {
    try {
      await api<void>(`/items/${item.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: item.revision ?? 0 }),
      });
      removeItems([item.id]);
      setAdded((current) => (current?.id === item.id ? null : current));
      toast('Capture removed');
    } catch (e) {
      toast((e as Error).message, 'error');
      if (e instanceof ApiError && e.status === 409) await refresh().catch(() => {});
    }
  }
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !title.trim()) return;
    setSaving(true);
    setError('');
    const submittedDate = String(new FormData(event.currentTarget).get('captureDate') || '');
    const body = JSON.stringify({
      title: title.trim(),
      projectId: null,
      assigneeId: data.user.id,
      visibility: 'private',
      type: kind === 'someday' ? 'idea' : kind,
      status: kind === 'someday' ? 'backlog' : 'todo',
      dueDate: kind === 'task' ? submittedDate || null : null,
      followUpDate: kind !== 'task' ? submittedDate || null : null,
    });
    if (pending.current?.body !== body || Date.now() - pending.current.createdAt >= 30 * 60000)
      pending.current = { body, key: crypto.randomUUID(), createdAt: Date.now() };
    try {
      localStorage.setItem(attemptKey, JSON.stringify(pending.current));
    } catch {
      // The in-memory attempt still prevents duplicate retries during this visit.
    }
    try {
      const item = await api<WorkItem>('/items', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': pending.current.key },
      });
      pending.current = null;
      try {
        localStorage.removeItem(draftKey);
        localStorage.removeItem(attemptKey);
      } catch {
        // Browser storage may be disabled.
      }
      applyItems([item]);
      setAdded(item);
      setDraft({ title: '', kind: 'task', date: '' });
      navigate('home', undefined, homeSection(item));
      toastAction('Added to your personal inbox', {
        label: 'Open',
        onClick: () => openItem(item.id),
      });
      input.current?.focus();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        pending.current = null;
        try {
          localStorage.removeItem(attemptKey);
        } catch {}
      }
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="home-capture"
      onSubmit={capture}
      aria-label="Add to personal inbox"
      data-update-safe={!title && !date && kind === 'task' && !saving ? 'true' : undefined}
    >
      <input
        ref={input}
        className="input home-capture-title"
        aria-label="What would you like to remember?"
        placeholder="What would you like to remember?"
        value={title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        maxLength={240}
        required
        disabled={saving}
      />
      <div className="home-capture-options">
        <div className="home-capture-kinds" role="group" aria-label="Capture as">
          {captureKinds.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={kind === id}
              disabled={saving}
              onClick={() => setDraft({ ...draft, kind: id })}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
        <label className="home-capture-date">
          {kind === 'task' ? 'Due on' : 'Review on'}
          <input
            className="input"
            type="date"
            name="captureDate"
            value={date}
            onInput={(e) => setDraft({ ...draft, date: e.currentTarget.value })}
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            required={kind === 'followup'}
            disabled={saving}
          />
        </label>
        <button className="button primary" disabled={!title.trim() || saving}>
          <Plus size={15} />
          {saving ? 'Adding…' : 'Add item'}
        </button>
      </div>
      <p className="home-capture-hint">
        <Lock size={12} />
        Private · Assigned to you · Personal inbox
        {kind !== 'task' && ' · Review date is a reminder, not a delivery deadline'}
      </p>
      {added && (
        <div className="home-capture-receipt" role="status">
          <span>
            Added: <strong>{added.title}</strong>
          </span>
          <button className="button" type="button" onClick={() => openItem(added.id)}>
            Open
          </button>
          <button className="button" type="button" onClick={() => void undoCapture(added)}>
            Undo
          </button>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

export default function Home({ tab }: { tab: string }) {
  const { data } = useApp();
  const scope = `${data.workspace?.id || data.user.workspaceId || 'default'}.${data.user.id}`;
  return <HomeWorkspace key={scope} scope={scope} tab={tab} />;
}

function HomeWorkspace({ tab, scope }: { tab: string; scope: string }) {
  const { data, refresh, toast, toastAction, openItem, applyItems } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLElement>(null);
  const section = sections.find((s) => s.id === tab) || sections[0];
  const date = today();
  const todayKey = homeTodayKey(
    data.workspace?.id || data.user.workspaceId || 'default',
    data.user.id,
    date,
  );
  const [todaySelection, setTodaySelection] = useState<{ key: string; ids: string[] }>(() => ({
    key: todayKey,
    ids: readHomeToday(todayKey),
  }));
  const todayIds = todaySelection.key === todayKey ? todaySelection.ids : readHomeToday(todayKey);
  const selectedToday = new Set(todayIds);
  const items = homeItems(data.items, data.user.id);
  const buckets: Record<HomeSection, WorkItem[]> = {
    attention: [],
    continuing: [],
    next: [],
    someday: [],
  };
  for (const item of items) buckets[homeSection(item, date)].push(item);
  const todayItems = items.filter((item) => selectedToday.has(item.id));
  const visible =
    section.id === 'all' ? items : section.id === 'today' ? todayItems : buckets[section.id];
  const projects = new Map(data.projects.map((project) => [project.id, project.name]));
  useEffect(() => {
    tabs.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [section.id]);
  function toggleToday(item: WorkItem) {
    const ids = selectedToday.has(item.id)
      ? todayIds.filter((id) => id !== item.id)
      : [...todayIds, item.id];
    setTodaySelection({ key: todayKey, ids });
    saveHomeToday(todayKey, ids);
    toast(selectedToday.has(item.id) ? 'Removed from Today' : 'Added to Today');
  }
  function focusItem(direction: number) {
    if (!visible.length) return false;
    const active =
      document.activeElement?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId || focused;
    const index = visible.findIndex((item) => item.id === active);
    const next =
      visible[
        Math.max(
          0,
          Math.min(
            visible.length - 1,
            index < 0 ? (direction > 0 ? 0 : visible.length - 1) : index + direction,
          ),
        )
      ];
    setFocused(next.id);
    root.current
      ?.querySelector<HTMLButtonElement>(`[data-item-id="${next.id}"] .home-item-main`)
      ?.focus();
    return true;
  }
  useShortcuts(
    'list',
    {
      next: () => focusItem(1),
      previous: () => focusItem(-1),
      open: () => {
        const active = document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.closest('button') &&
          !active.classList.contains('home-item-main')
        )
          return false;
        const id =
          document.activeElement?.closest<HTMLElement>('[data-item-id]')?.dataset.itemId || focused;
        if (!id || !visible.some((item) => item.id === id)) return false;
        openItem(id);
        return true;
      },
    },
    { root },
  );
  async function update(item: WorkItem, changes: Partial<WorkItem>, message: string) {
    if (busy) return;
    setBusy(item.id);
    try {
      const { item: saved } = await patch<{ item: WorkItem }>(`/items/${item.id}`, {
        ...changes,
        expectedRevision: item.revision ?? 0,
      });
      applyItems([saved]);
      if (item.recurrence && changes.status !== undefined && changes.status !== item.status)
        void refresh().catch(() => {});
      const undoChanges = Object.fromEntries(
        Object.keys(changes).map((key) => [key, item[key as keyof WorkItem]]),
      );
      toastAction(message, {
        label: 'Undo',
        onClick: () => {
          void patch<{ item: WorkItem }>(`/items/${saved.id}`, {
            ...undoChanges,
            ...(item.recurrence && saved.status === 'done' && item.status !== 'done'
              ? { undoCompletion: true }
              : {}),
            expectedRevision: saved.revision ?? 0,
          })
            .then(({ item: restored }) => {
              applyItems([restored]);
              if (item.recurrence && changes.status !== undefined) void refresh().catch(() => {});
              toast('Change undone');
            })
            .catch(async (e: unknown) => {
              toast((e as Error).message, 'error');
              if (e instanceof ApiError && e.status === 409) await refresh().catch(() => {});
            });
        },
      });
    } catch (e) {
      toast((e as Error).message, 'error');
      if (e instanceof ApiError && e.status === 409) await refresh().catch(() => {});
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="home-page" ref={root}>
      <header className="home-heading">
        <h1>A little space to get things done.</h1>
        <p>Your tasks and follow-ups, with or without a project.</p>
      </header>
      <QuickCapture scope={scope} />
      <nav ref={tabs} className="home-tabs" aria-label="Personal work">
        {sections.map((s) => (
          <button
            key={s.id}
            className={section.id === s.id ? 'active' : ''}
            aria-current={section.id === s.id ? 'page' : undefined}
            onClick={() => navigate('home', undefined, s.id)}
          >
            {s.label}
            <span>
              {s.id === 'all'
                ? items.length
                : s.id === 'today'
                  ? todayItems.length
                  : buckets[s.id].length}
            </span>
          </button>
        ))}
      </nav>
      <p className="home-section-description">{section.description}</p>
      {visible.length ? (
        <ul className="home-work-list" aria-label={section.label}>
          {visible.map((item) => {
            const due = item.dueDate;
            const followUp = item.followUpDate;
            return (
              <li
                key={item.id}
                className={`home-work-row${focused === item.id ? ' focused' : ''}`}
                data-item-id={item.id}
                onFocus={() => setFocused(item.id)}
              >
                <button
                  className="home-complete"
                  aria-label={`Complete ${item.title}`}
                  disabled={!!busy}
                  onClick={() => void update(item, { status: 'done' }, 'Work item completed')}
                >
                  <StatusIcon status={item.status} />
                  <Check className="home-complete-check" size={15} />
                </button>
                <button className="home-item-main" onClick={() => openItem(item.id)}>
                  <strong>{item.title}</strong>
                  <span>
                    {item.projectId ? projects.get(item.projectId) || 'Project' : 'Personal inbox'}
                    <span aria-hidden="true"> · </span>
                    {types.find((type) => type.id === item.type)?.name}
                    <span aria-hidden="true"> · </span>
                    {statuses.find((status) => status.id === item.status)?.name}
                  </span>
                </button>
                <span
                  className="home-item-priority"
                  title={priorities.find((priority) => priority.id === item.priority)?.name}
                >
                  <PriorityIcon priority={item.priority} />
                  {priorities.find((priority) => priority.id === item.priority)?.name}
                </span>
                <div className="home-item-dates">
                  {due && (
                    <span className={due < date ? 'overdue' : ''}>
                      Due {due === date ? 'today' : shortDate(due)}
                    </span>
                  )}
                  {followUp && (
                    <span className={followUp <= date ? 'home-review-ready' : ''}>
                      Review {followUp === date ? 'today' : shortDate(followUp)}
                    </span>
                  )}
                </div>
                {followUp && followUp <= date ? (
                  <button
                    className="button home-row-action"
                    disabled={!!busy}
                    title="Move the review to tomorrow. The due date stays the same."
                    aria-label={`Follow up tomorrow: ${item.title}`}
                    onClick={() =>
                      void update(
                        item,
                        { followUpDate: tomorrow(date) },
                        'Follow-up moved to tomorrow',
                      )
                    }
                  >
                    Tomorrow
                  </button>
                ) : homeSection(item, date) === 'someday' ? (
                  <button
                    className="button home-row-action"
                    disabled={!!busy}
                    aria-label={`Move to Next up: ${item.title}`}
                    onClick={() => void update(item, { status: 'todo' }, 'Ready in Next up')}
                  >
                    Move to Next up
                  </button>
                ) : null}
                <button
                  className="home-today-toggle"
                  aria-pressed={selectedToday.has(item.id)}
                  aria-label={`${selectedToday.has(item.id) ? 'Remove from' : 'Add to'} Today: ${item.title}`}
                  title={selectedToday.has(item.id) ? 'Remove from Today' : 'Add to Today'}
                  onClick={() => toggleToday(item)}
                >
                  <Sun size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon={<CircleCheck size={26} />}
          title={section.empty}
          description={section.hint}
        />
      )}
      <p className="home-scope-note">
        Assigned to you, plus unassigned items in your personal inbox. This workspace only. J / K to
        focus items; Enter to open.
      </p>
    </div>
  );
}
