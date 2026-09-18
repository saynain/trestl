import { useRef, useState, type FormEvent } from 'react';
import { Check, CircleCheck, Hourglass, Lightbulb, Lock, Plus } from 'lucide-react';
import type { WorkItem } from '../../shared/types';
import { api, patch, ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { navigate, shortDate, statuses, today, types } from '../lib/model';
import { homeItems, homeSection, tomorrow, type HomeSection } from '../lib/home';
import { EmptyState, StatusIcon } from './ui';
import './home.css';

const sections = [
  {
    id: 'attention',
    label: 'Needs attention',
    description: 'Due or ready to follow up, plus work already in progress.',
    empty: 'Nothing needs your attention right now',
    hint: 'Your dated follow-ups will appear here when it’s time. Next up holds the work you can pick up whenever you’re ready.',
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

function QuickCapture() {
  const { data, refresh, toast } = useApp();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<CaptureKind>('task');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<{ body: string; key: string } | null>(null);
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !title.trim()) return;
    setSaving(true);
    setError('');
    const submittedDate = String(new FormData(event.currentTarget).get('followUpDate') || '');
    const body = JSON.stringify({
      title: title.trim(),
      projectId: null,
      assigneeId: data.user.id,
      visibility: 'private',
      type: kind === 'someday' ? 'idea' : kind,
      status: kind === 'someday' ? 'backlog' : 'todo',
      followUpDate: submittedDate || null,
    });
    if (pending.current?.body !== body) pending.current = { body, key: crypto.randomUUID() };
    try {
      const item = await api<WorkItem>('/items', {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': pending.current.key },
      });
      pending.current = null;
      setTitle('');
      setDate('');
      navigate('home', undefined, homeSection(item));
      toast('Added to your personal inbox');
      input.current?.focus();
      try {
        await refresh();
      } catch {
        toast('Item saved. Refresh the page to see it.', 'error');
      }
    } catch (e) {
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
        onChange={(e) => setTitle(e.target.value)}
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
              onClick={() => setKind(id)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
        <label className="home-capture-date">
          Follow up on
          <input
            className="input"
            type="date"
            name="followUpDate"
            value={date}
            onInput={(e) => setDate(e.currentTarget.value)}
            onChange={(e) => setDate(e.target.value)}
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
      </p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

export default function Home({ tab }: { tab: string }) {
  const { data, refresh, toast, openItem } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const section = sections.find((s) => s.id === tab) || sections[0];
  const date = today();
  const items = homeItems(data.items, data.user.id);
  const buckets: Record<HomeSection, WorkItem[]> = { attention: [], next: [], someday: [] };
  for (const item of items) buckets[homeSection(item, date)].push(item);
  const visible = section.id === 'all' ? items : buckets[section.id];
  const projects = new Map(data.projects.map((project) => [project.id, project.name]));
  async function update(item: WorkItem, changes: Partial<WorkItem>, message: string) {
    if (busy) return;
    setBusy(item.id);
    try {
      await patch(`/items/${item.id}`, { ...changes, expectedRevision: item.revision ?? 0 });
      toast(message);
      await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
      if (e instanceof ApiError && e.status === 409) await refresh().catch(() => {});
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="home-page">
      <header className="home-heading">
        <h1>A little space to get things done.</h1>
        <p>Your tasks and follow-ups, with or without a project.</p>
      </header>
      <QuickCapture />
      <nav className="home-tabs" aria-label="Personal work">
        {sections.map((s) => (
          <button
            key={s.id}
            className={section.id === s.id ? 'active' : ''}
            aria-current={section.id === s.id ? 'page' : undefined}
            onClick={() => navigate('home', undefined, s.id)}
          >
            {s.label}
            <span>{s.id === 'all' ? items.length : buckets[s.id].length}</span>
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
              <li key={item.id} className="home-work-row" data-item-id={item.id}>
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
                <div className="home-item-dates">
                  {due && (
                    <span className={due < date ? 'overdue' : ''}>
                      Due {due === date ? 'today' : shortDate(due)}
                    </span>
                  )}
                  {followUp && (
                    <span className={followUp <= date ? 'home-review-ready' : ''}>
                      Follow up {followUp === date ? 'today' : shortDate(followUp)}
                    </span>
                  )}
                </div>
                {followUp && followUp <= date ? (
                  <button
                    className="button home-row-action"
                    disabled={!!busy}
                    title="Move the follow-up to tomorrow. The due date stays the same."
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
        Assigned to you, plus unassigned items in your personal inbox. This workspace only.
      </p>
    </div>
  );
}
