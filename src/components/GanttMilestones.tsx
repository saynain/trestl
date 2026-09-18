import { MilestoneItems, MilestoneList } from './MilestoneItems';
import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { Diamond } from 'lucide-react';
import type { Milestone } from '../../shared/types';
import { patch } from '../lib/api';
import { useApp } from '../lib/context';
import { dateAt, dayNumber } from '../lib/gantt';
import { shortDate } from '../lib/model';
import { Modal } from './ui';

export default function GanttMilestones({
  milestones,
  origin,
  cell,
  count,
  viewport,
  onHeight,
}: {
  milestones: Milestone[];
  origin: number;
  cell: number;
  count: number;
  viewport: RefObject<HTMLDivElement | null>;
  onHeight: (height: number) => void;
}) {
  const { refresh, toast } = useApp();
  const [editing, setEditing] = useState<Milestone | null>(null);
  const [listing, setListing] = useState(false);
  const [draft, setDraft] = useState({ title: '', dueDate: '', completed: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ id: string; dueDate: string } | null>(null);
  const drag = useRef<{
    milestone: Milestone;
    x: number;
    scroll: number;
    days: number;
    moved: boolean;
  } | null>(null);
  const suppress = useRef(false);
  const ends: number[] = [];
  const markers = milestones
    .map((m) => (preview?.id === m.id ? { ...m, dueDate: preview.dueDate } : m))
    .filter(
      (m) => m.dueDate && dayNumber(m.dueDate) >= origin && dayNumber(m.dueDate) < origin + count,
    )
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || a.id.localeCompare(b.id))
    .map((m) => {
      const x = (dayNumber(m.dueDate!) - origin + 0.5) * cell;
      let lane = ends.findIndex((end) => end < x - 16);
      if (lane < 0) lane = ends.length;
      ends[lane] = x + Math.min(200, m.title.length * 6 + 65);
      return { milestone: m, x, lane };
    })
    // Keep DOM order stable while dragging past another marker.
    .sort((a, b) => a.milestone.id.localeCompare(b.milestone.id));
  const height = Math.max(53, ends.length * 30 + 20);
  useLayoutEffect(() => {
    onHeight(height);
  }, [height, onHeight]);
  function edit(m: Milestone) {
    setError('');
    setListing(false);
    setEditing(m);
    setDraft({ title: m.title, dueDate: m.dueDate || '', completed: m.completed });
  }
  async function save(
    m: Milestone,
    changes: Partial<Pick<Milestone, 'title' | 'dueDate' | 'completed'>>,
  ) {
    setBusy(true);
    setError('');
    try {
      await patch(`/milestones/${m.id}`, { ...changes, expectedRevision: m.revision ?? 0 });
      await refresh();
      setEditing(null);
      toast('Milestone updated');
    } catch (e) {
      setError((e as Error).message);
      toast((e as Error).message, 'error');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
      setPreview(null);
    }
  }
  function begin(e: PointerEvent<HTMLButtonElement>, m: Milestone) {
    if (busy || e.button !== 0) return;
    drag.current = {
      milestone: m,
      x: e.clientX,
      scroll: viewport.current?.scrollLeft || 0,
      days: 0,
      moved: false,
    };
    suppress.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active) return;
    const distance = e.clientX - active.x + (viewport.current?.scrollLeft || 0) - active.scroll;
    if (Math.abs(distance) > 5) {
      active.moved = true;
      suppress.current = true;
    }
    active.days = Math.round(distance / cell);
    if (active.moved)
      setPreview({
        id: active.milestone.id,
        dueDate: dateAt(dayNumber(active.milestone.dueDate!) + active.days),
      });
  }
  function finish() {
    const active = drag.current;
    drag.current = null;
    if (active?.moved && active.days)
      void save(active.milestone, {
        dueDate: dateAt(dayNumber(active.milestone.dueDate!) + active.days),
      });
    else setPreview(null);
  }
  return (
    <>
      <div className="gantt-pair gantt-milestones" style={{ height }}>
        <button
          className="gantt-label gantt-milestones-manage"
          onClick={() => setListing(true)}
          aria-label="Manage milestones"
        >
          <Diamond size={14} />
          <strong>Milestones</strong>
          <small>{milestones.length}</small>
        </button>
        <div className="gantt-track">
          {markers.map(({ milestone: m, x, lane }) => (
            <button
              key={m.id}
              disabled={busy}
              className={`gantt-milestone ${m.completed ? 'is-complete' : ''} ${preview?.id === m.id ? 'is-dragging' : ''}`}
              style={{ left: x, top: 16 + lane * 30 }}
              aria-label={`Milestone ${m.title}, ${shortDate(m.dueDate)}${m.completed ? ', completed' : ''}`}
              title={`${m.title} · ${shortDate(m.dueDate)}\nDrag to move · Click to edit`}
              onPointerDown={(e) => begin(e, m)}
              onPointerMove={move}
              onPointerUp={finish}
              onPointerCancel={() => {
                drag.current = null;
                suppress.current = true;
                setPreview(null);
              }}
              onClick={() => {
                if (!suppress.current) edit(m);
                suppress.current = false;
              }}
            >
              <Diamond size={13} fill="currentColor" />
              <span>
                {m.title} · {m.progress?.done ?? 0}/{m.progress?.total ?? 0}
                {preview?.id === m.id && <small>{shortDate(m.dueDate)}</small>}
              </span>
            </button>
          ))}
          {!markers.length && (
            <button className="gantt-schedule-button" onClick={() => setListing(true)}>
              View {milestones.length} milestones
            </button>
          )}
        </div>
      </div>
      {listing && (
        <Modal title="Project milestones" onClose={() => setListing(false)}>
          <MilestoneList milestones={milestones} onEdit={edit} />
        </Modal>
      )}
      {editing && (
        <Modal
          title="Edit milestone"
          onClose={() => {
            if (!busy) setEditing(null);
          }}
        >
          <MilestoneItems milestone={editing} />
          <form
            className="gantt-schedule-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save(editing, {
                title: draft.title.trim(),
                dueDate: draft.dueDate || null,
                completed: draft.completed,
              });
            }}
          >
            <label className="gantt-milestone-name">
              Milestone name
              <input
                value={draft.title}
                required
                maxLength={240}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <div className="gantt-date-fields">
              <label>
                Milestone date
                <input
                  type="date"
                  value={draft.dueDate}
                  onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                />
              </label>
              <label className="gantt-milestone-completed">
                <input
                  type="checkbox"
                  checked={draft.completed}
                  onChange={(e) => setDraft({ ...draft, completed: e.target.checked })}
                />
                Completed
              </label>
            </div>
            {error && (
              <p role="alert" className="conflict">
                {error} Close and reopen this milestone to load its latest version.
              </p>
            )}
            <div className="gantt-schedule-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setDraft({ ...draft, dueDate: '' })}
              >
                Clear date
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy || !draft.title.trim()}>
                {busy ? 'Saving…' : 'Save milestone'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
