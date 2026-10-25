import { MilestoneList } from './MilestoneItems';
import { Select } from './Select';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Ban,
  ChartNoAxesColumnIncreasing,
  ChevronDown,
  ChevronUp,
  Link2,
  LogOut,
  Monitor,
  Pencil,
  Plus,
  Printer,
  Settings2,
  Shield,
  Users,
  X,
} from 'lucide-react';
import type {
  Bootstrap,
  Project,
  Roadmap,
  RoadmapFeature,
  RoadmapHorizon,
} from '../../shared/types';
import { api, patch, ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { descendants, navigate, shortDate, today } from '../lib/model';
import { roadmapDelivery } from '../lib/roadmap-delivery';
import { clearDraft, draftKey, readDraft, saveDraft } from '../lib/drafts';
import {
  isRoadmapDraftDirty,
  shouldRecoverRoadmapDraft,
  type RoadmapDraft,
} from '../lib/roadmap-drafts';
import { Brand, Modal } from './ui';
import './roadmap.css';

const horizons: { id: RoadmapHorizon; title: string; description: string }[] = [
  { id: 'current', title: 'Current focus', description: 'Our priorities now' },
  { id: 'next', title: 'Up next', description: 'Selected next · not scheduled' },
  {
    id: 'future',
    title: 'Future possibilities',
    description: 'Under consideration · no commitment',
  },
  {
    id: 'deferred',
    title: 'Not prioritized',
    description: 'Deliberately outside the current plan',
  },
];
const emptyRoadmap: Roadmap = {
  revision: 0,
  headline: '',
  reviewNote: '',
  reviewedAt: null,
  features: [],
};
function AreaIcon({ area }: { area: string }) {
  const Icon = /reliab|secur/i.test(area)
    ? Shield
    : /effic|cost/i.test(area)
      ? ChartNoAxesColumnIncreasing
      : /operat/i.test(area)
        ? Settings2
        : Users;
  return <Icon size={19} strokeWidth={1.5} aria-hidden="true" />;
}
function DeliveryProgress({ feature, data }: { feature: RoadmapFeature; data: Bootstrap }) {
  const delivery = roadmapDelivery(feature, data);
  if (!delivery.linked) return null;
  return (
    <div className="roadmap-delivery-progress">
      <span>
        {delivery.total
          ? `${delivery.done}/${delivery.total} work items done`
          : 'Delivery linked · no work items yet'}
      </span>
      {delivery.total > 0 && (
        <progress
          value={delivery.done}
          max={delivery.total}
          aria-label={`${delivery.done} of ${delivery.total} work items done`}
        />
      )}
      {delivery.atRisk && (
        <span className="roadmap-delivery-risk">
          Needs attention{delivery.overdue ? ` · ${delivery.overdue} overdue` : ''}
          {delivery.blocked ? ` · ${delivery.blocked} blocked` : ''}
          {delivery.slippedMilestones ? ` · ${delivery.slippedMilestones} late milestones` : ''}
          {delivery.targetAtRisk ? ' · target at risk' : ''}
        </span>
      )}
    </div>
  );
}
function DeliveryLinks({ feature, close }: { feature: RoadmapFeature; close: () => void }) {
  const { data, openItem } = useApp();
  const delivery = roadmapDelivery(feature, data);
  if (!delivery.linked)
    return <p className="muted">No delivery links. This feature is an editorial priority.</p>;
  const directItems = delivery.items.filter((item) => feature.itemIds?.includes(item.id));
  return (
    <section className="roadmap-delivery-links" aria-label="Linked delivery">
      <h3>Delivery</h3>
      <DeliveryProgress feature={feature} data={data} />
      <p className="muted">Progress uses visible linked work. Editorial status stays as written.</p>
      <ul>
        {delivery.projects.map((project) => (
          <li key={project.id}>
            <a href={`#/project/${project.id}`}>Project: {project.name}</a>
          </li>
        ))}
        {delivery.milestones.map((milestone) => (
          <li key={milestone.id}>
            <a href={`#/project/${milestone.projectId}?tab=overview/${milestone.id}`}>
              Milestone: {milestone.title}
            </a>
          </li>
        ))}
        {directItems.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                close();
                openItem(item.id);
              }}
            >
              {item.identifier} · {item.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
export default function RoadmapView({
  project,
  presenting,
}: {
  project: Project;
  presenting: boolean;
}) {
  const { data, refresh, toast } = useApp();
  const projectIds = descendants(data.projects, project.id);
  const milestones = data.milestones.filter((m) => projectIds.has(m.projectId));
  const roadmap = project.roadmap ?? emptyRoadmap;
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    base: Roadmap;
    feature?: RoadmapFeature;
    settings?: boolean;
    horizon?: RoadmapHorizon;
  } | null>(null);
  const presentButton = useRef<HTMLButtonElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const wasPresenting = useRef(false);
  const feature = roadmap.features.find((f) => f.id === selected);
  const exit = () => navigate('project', project.id, 'roadmap');
  useEffect(() => {
    if (presenting) exitButton.current?.focus();
    else if (wasPresenting.current) presentButton.current?.focus();
    wasPresenting.current = presenting;
  }, [presenting]);
  useEffect(() => {
    if (!presenting) return;
    const fn = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"]')) exit();
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [presenting, project.id]);
  async function save(next: Roadmap) {
    await patch(`/projects/${project.id}/roadmap`, {
      expectedRevision: next.revision,
      headline: next.headline,
      reviewNote: next.reviewNote,
      reviewedAt: next.reviewedAt,
      features: next.features,
    });
    setEditor(null);
    try {
      await refresh();
      toast('Roadmap saved');
    } catch {
      toast('Roadmap saved. Refresh the page to see the latest version.', 'error');
    }
  }
  async function copyLink() {
    const url = new URL(location.href);
    url.hash = `/project/${project.id}?tab=roadmap-present`;
    try {
      await navigator.clipboard.writeText(url.href);
      toast('Presentation link copied. Workspace access required.');
    } catch {
      toast(
        'Could not copy the link. Open Present and copy the address from your browser.',
        'error',
      );
    }
  }
  return (
    <section
      className={`roadmap ${presenting ? 'is-presenting' : ''}`}
      aria-label={`${project.name} roadmap`}
    >
      <div
        className="roadmap-brandbar"
        data-tauri-drag-region={
          import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM === 'darwin' ? 'deep' : undefined
        }
      >
        <div className="roadmap-brand">
          <Brand small />
        </div>
        <button ref={exitButton} className="button" onClick={exit}>
          <LogOut size={17} />
          Exit presentation
        </button>
      </div>
      {!presenting && (
        <div className="roadmap-toolbar">
          <span className="muted">A shared view of what matters next</span>
          <div>
            <button className="button" onClick={() => setEditor({ base: roadmap, settings: true })}>
              <Pencil size={14} />
              Edit summary
            </button>
            <button className="button" onClick={copyLink}>
              <Link2 size={14} />
              Copy link
            </button>
            <button className="button roadmap-print-button" onClick={() => window.print()}>
              <Printer size={14} />
              Print / PDF
            </button>
            <button
              className="button"
              ref={presentButton}
              onClick={() => navigate('project', project.id, 'roadmap-present')}
            >
              <Monitor size={15} />
              Present
            </button>
            <button className="button primary" onClick={() => setEditor({ base: roadmap })}>
              <Plus size={15} />
              Add feature
            </button>
          </div>
        </div>
      )}
      <header className="roadmap-heading">
        <div>
          <p className="roadmap-eyebrow">Roadmap</p>
          <h2>{project.name}</h2>
          <p className="roadmap-headline">
            {roadmap.headline || 'Our priorities, next steps, and future possibilities.'}
          </p>
        </div>
        <div className="roadmap-review">
          <span>
            {roadmap.reviewedAt
              ? `Reviewed ${new Date(roadmap.reviewedAt + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
              : 'Not reviewed yet'}
          </span>
          {roadmap.reviewNote && <p>Since last review: {roadmap.reviewNote}</p>}
        </div>
      </header>
      {milestones.length > 0 && (
        <section className="roadmap-milestones" aria-label="Milestones">
          <h3>Milestones</h3>
          <MilestoneList milestones={milestones} />
        </section>
      )}
      <div className="roadmap-columns">
        {horizons.slice(0, 3).map((horizon) => {
          const features = roadmap.features.filter((f) => f.horizon === horizon.id);
          return (
            <section
              className={`roadmap-column horizon-${horizon.id}`}
              key={horizon.id}
              aria-label={horizon.title}
            >
              <div className="roadmap-column-heading">
                <h3>{horizon.title}</h3>
                <p>{horizon.description}</p>
              </div>
              <div className="roadmap-cards">
                {features.map((f) => (
                  <button
                    className="roadmap-card"
                    key={f.id}
                    onClick={() => setSelected(f.id)}
                    aria-label={`View ${f.title}`}
                  >
                    <div className="roadmap-card-body">
                      <h4>{f.title}</h4>
                      {f.summary && <p>{f.summary}</p>}
                      <DeliveryProgress feature={f} data={data} />
                    </div>
                    {(f.area || f.status || f.targetDate) && (
                      <div className="roadmap-card-meta">
                        {f.area && (
                          <span className="roadmap-area">
                            <AreaIcon area={f.area} />
                            {f.area}
                          </span>
                        )}
                        {f.status && (
                          <span
                            className={`roadmap-status ${/needs|blocked|risk/i.test(f.status) ? 'needs-attention' : ''}`}
                          >
                            {f.status}
                          </span>
                        )}
                        {f.targetDate && (
                          <span className="roadmap-date">Target {shortDate(f.targetDate)}</span>
                        )}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              {!features.length && (
                <p className="roadmap-empty">
                  {horizon.id === 'current'
                    ? 'No current priorities yet.'
                    : horizon.id === 'next'
                      ? 'Nothing selected next.'
                      : 'Room for future possibilities.'}
                </p>
              )}
              {!presenting && (
                <button
                  className="text-button roadmap-add"
                  onClick={() => setEditor({ base: roadmap, horizon: horizon.id })}
                >
                  <Plus size={14} />
                  Add feature
                </button>
              )}
            </section>
          );
        })}
      </div>
      <section className="roadmap-deferred" aria-label="Not prioritized">
        <div className="roadmap-deferred-heading">
          <h3>Not prioritized</h3>
          <p>Deliberately outside the current plan</p>
        </div>
        <div className="roadmap-deferred-items">
          {roadmap.features
            .filter((f) => f.horizon === 'deferred')
            .map((f) => (
              <button
                key={f.id}
                className="roadmap-deferred-item"
                onClick={() => setSelected(f.id)}
                aria-label={`View ${f.title}`}
              >
                <Ban size={30} strokeWidth={1.2} aria-hidden="true" />
                <span>
                  <h4>{f.title}</h4>
                  <p>{f.rationale || f.summary || 'No rationale added yet.'}</p>
                </span>
              </button>
            ))}
          {!roadmap.features.some((f) => f.horizon === 'deferred') && (
            <p className="roadmap-empty">No features deliberately deferred.</p>
          )}
        </div>
        {!presenting && (
          <button
            className="text-button roadmap-add"
            onClick={() => setEditor({ base: roadmap, horizon: 'deferred' })}
          >
            <Plus size={14} />
            Add
          </button>
        )}
      </section>
      <p className="roadmap-footnote">
        Priorities may change as we learn. Dates are shown only when agreed.
      </p>
      {feature && (
        <Modal title={feature.title} onClose={() => setSelected(null)}>
          <div className="simple-form roadmap-detail">
            <span className={`roadmap-detail-horizon horizon-${feature.horizon}`}>
              {horizons.find((h) => h.id === feature.horizon)?.title}
            </span>
            {feature.summary && <p>{feature.summary}</p>}
            <dl>
              <dt>Area</dt>
              <dd>{feature.area || 'Not specified'}</dd>
              <dt>Status</dt>
              <dd>{feature.status || 'Not specified'}</dd>
              <dt>Target date</dt>
              <dd>{feature.targetDate ? shortDate(feature.targetDate) : 'No date committed'}</dd>
            </dl>
            <h3>Scope</h3>
            <p className="roadmap-prose">{feature.scope || 'Scope has not been added yet.'}</p>
            <h3>
              {feature.horizon === 'deferred'
                ? 'Why this is not prioritized'
                : 'Priority rationale'}
            </h3>
            <p className="roadmap-prose">{feature.rationale || 'No rationale added yet.'}</p>
            <DeliveryLinks feature={feature} close={() => setSelected(null)} />
            {!presenting && (
              <div className="form-actions">
                <button
                  className="button primary"
                  onClick={() => {
                    setSelected(null);
                    setEditor({ base: roadmap, feature });
                  }}
                >
                  <Pencil size={14} />
                  Edit feature
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
      {editor && (
        <RoadmapEditor
          key={`${editor.base.revision}-${editor.feature?.id ?? 'new'}-${editor.settings}`}
          {...editor}
          data={data}
          projectId={project.id}
          save={save}
          reload={async () => {
            const latest = await api<Project>(`/projects/${project.id}`);
            return latest.roadmap ?? emptyRoadmap;
          }}
          close={() => setEditor(null)}
        />
      )}
    </section>
  );
}
function isRoadmapDraft(value: unknown): value is RoadmapDraft {
  if (!value || typeof value !== 'object') return false;
  const saved = value as RoadmapDraft;
  const validSummary = (summary: RoadmapDraft['summary']) =>
    !!summary &&
    typeof summary.headline === 'string' &&
    typeof summary.reviewNote === 'string' &&
    (summary.reviewedAt === null || typeof summary.reviewedAt === 'string');
  const validFeature = (entry: RoadmapFeature) =>
    !!entry &&
    ['id', 'title', 'summary', 'area', 'status', 'scope', 'rationale'].every(
      (key) => typeof entry[key as keyof RoadmapFeature] === 'string',
    ) &&
    horizons.some((horizon) => horizon.id === entry.horizon) &&
    (entry.targetDate === null || typeof entry.targetDate === 'string') &&
    ['projectIds', 'milestoneIds', 'itemIds'].every((key) => {
      const refs = entry[key as 'projectIds' | 'milestoneIds' | 'itemIds'];
      return (
        refs === undefined || (Array.isArray(refs) && refs.every((ref) => typeof ref === 'string'))
      );
    });
  return (
    validSummary(saved.base) &&
    Number.isInteger(saved.base.revision) &&
    saved.base.revision >= 0 &&
    Array.isArray(saved.base.features) &&
    saved.base.features.every(validFeature) &&
    validFeature(saved.draft) &&
    validSummary(saved.summary) &&
    Array.isArray(saved.order) &&
    saved.order.every((id) => typeof id === 'string')
  );
}
function RoadmapEditor({
  base: initialBase,
  feature,
  settings,
  horizon,
  save,
  reload,
  close,
  data,
  projectId,
}: {
  base: Roadmap;
  feature?: RoadmapFeature;
  settings?: boolean;
  horizon?: RoadmapHorizon;
  save: (next: Roadmap) => Promise<void>;
  reload: () => Promise<Roadmap>;
  close: () => void;
  data: Bootstrap;
  projectId: string;
}) {
  const storageKey = draftKey(
    data.user,
    `roadmap:${projectId}:${settings ? 'summary' : (feature?.id ?? `new:${horizon ?? 'current'}`)}`,
  );
  const [recovered] = useState(() => {
    const saved = readDraft(storageKey, isRoadmapDraft);
    if (saved && shouldRecoverRoadmapDraft(saved, initialBase, !!settings, horizon ?? 'current'))
      return saved;
    clearDraft(storageKey);
    return null;
  });
  const [base, setBase] = useState(recovered?.base ?? initialBase);
  const [draft, setDraft] = useState<RoadmapFeature>(
    recovered?.draft ??
      feature ?? {
        id: crypto.randomUUID(),
        title: '',
        summary: '',
        area: '',
        horizon: horizon ?? 'current',
        status: '',
        scope: '',
        rationale: '',
        targetDate: null,
      },
  );
  const [summary, setSummary] = useState(
    recovered?.summary ?? {
      headline: base.headline,
      reviewNote: base.reviewNote,
      reviewedAt: base.reviewedAt,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [order, setOrder] = useState(recovered?.order ?? base.features.map((f) => f.id));
  useEffect(() => {
    const snapshot = { base, draft, summary, order };
    if (isRoadmapDraftDirty(snapshot, !!settings, horizon ?? 'current'))
      saveDraft(storageKey, snapshot);
    else clearDraft(storageKey);
  }, [storageKey, base, draft, summary, order, settings, horizon]);
  function closeEditor() {
    if (busy) return;
    const snapshot = { base, draft, summary, order };
    if (isRoadmapDraftDirty(snapshot, !!settings, horizon ?? 'current'))
      saveDraft(storageKey, snapshot);
    else clearDraft(storageKey);
    close();
  }
  const field = <K extends keyof RoadmapFeature>(key: K, value: RoadmapFeature[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  async function persist(next: Roadmap) {
    setBusy(true);
    setError('');
    try {
      await save(next);
      clearDraft(storageKey);
    } catch (e) {
      setError((e as Error).message);
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const features = order
      .map((id) => (id === draft.id ? draft : base.features.find((f) => f.id === id)!))
      .filter(Boolean);
    if (!features.some((entry) => entry.id === draft.id)) features.push(draft);
    void persist(settings ? { ...base, ...summary } : { ...base, features });
  }
  const peers = order.filter(
    (id) => id === draft.id || base.features.find((f) => f.id === id)?.horizon === draft.horizon,
  );
  const position = peers.indexOf(draft.id);
  function move(direction: number) {
    const neighbor = peers[position + direction];
    if (!neighbor) return;
    const next = [...order],
      a = next.indexOf(draft.id),
      b = next.indexOf(neighbor);
    [next[a], next[b]] = [next[b], next[a]];
    setOrder(next);
  }
  return (
    <Modal
      title={settings ? 'Roadmap summary' : feature ? 'Edit feature' : 'Add feature'}
      onClose={closeEditor}
    >
      <form className="simple-form roadmap-editor" onSubmit={submit}>
        {recovered && <p className="muted">Recovered your unfinished roadmap draft.</p>}
        <fieldset disabled={busy || conflict}>
          {settings ? (
            <>
              <label className="field">
                Roadmap headline
                <input
                  className="input"
                  autoFocus
                  maxLength={240}
                  value={summary.headline}
                  onChange={(e) => setSummary({ ...summary, headline: e.target.value })}
                  placeholder="What are we focusing on, and why?"
                />
              </label>
              <label className="field">
                Since last review
                <textarea
                  className="input"
                  rows={3}
                  maxLength={500}
                  value={summary.reviewNote}
                  onChange={(e) => setSummary({ ...summary, reviewNote: e.target.value })}
                  placeholder="What changed since the last meeting?"
                />
              </label>
              <label className="field">
                Reviewed on
                <input
                  className="input"
                  type="date"
                  value={summary.reviewedAt ?? ''}
                  onChange={(e) => setSummary({ ...summary, reviewedAt: e.target.value || null })}
                />
              </label>
              <button
                className="text-button"
                type="button"
                onClick={() => setSummary({ ...summary, reviewedAt: today() })}
              >
                Mark reviewed today
              </button>
            </>
          ) : (
            <>
              <label className="field">
                Feature name
                <input
                  className="input"
                  autoFocus
                  required
                  maxLength={120}
                  value={draft.title}
                  onChange={(e) => field('title', e.target.value)}
                />
              </label>
              <label className="field">
                Purpose
                <textarea
                  className="input"
                  rows={2}
                  maxLength={240}
                  value={draft.summary}
                  onChange={(e) => field('summary', e.target.value)}
                  placeholder="What will this make better?"
                />
              </label>
              <div className="roadmap-form-row">
                <label className="field">
                  Priority group
                  <Select
                    className="input"
                    value={draft.horizon}
                    onChange={(e) => field('horizon', e.target.value as RoadmapHorizon)}
                  >
                    {horizons.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.title}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  Area
                  <input
                    className="input"
                    maxLength={60}
                    value={draft.area}
                    onChange={(e) => field('area', e.target.value)}
                    placeholder="e.g. Reliability"
                  />
                </label>
              </div>
              <label className="field">
                Status or short update
                <input
                  className="input"
                  list="roadmap-status-options"
                  maxLength={80}
                  value={draft.status}
                  onChange={(e) => field('status', e.target.value)}
                  placeholder="e.g. Scoped · awaiting capacity"
                />
              </label>
              <datalist id="roadmap-status-options">
                {[
                  'In progress',
                  'Needs a decision',
                  'Scoped · awaiting capacity',
                  'Scope in progress',
                  'Exploring',
                  'Scoped · no commitment',
                ].map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <label className="field">
                {draft.horizon === 'deferred'
                  ? 'Why is this not prioritized?'
                  : 'Priority rationale'}
                <textarea
                  className="input"
                  rows={2}
                  maxLength={500}
                  value={draft.rationale}
                  onChange={(e) => field('rationale', e.target.value)}
                  placeholder="Explain the tradeoff or when to revisit."
                  required={draft.horizon === 'deferred'}
                />
              </label>
              <label className="field">
                Scope
                <textarea
                  className="input"
                  rows={3}
                  maxLength={10000}
                  value={draft.scope}
                  onChange={(e) => field('scope', e.target.value)}
                  placeholder="What is included, and what is outside the scope?"
                />
              </label>
              <label className="field">
                Target date (optional)
                <input
                  className="input"
                  type="date"
                  value={draft.targetDate ?? ''}
                  onChange={(e) => field('targetDate', e.target.value || null)}
                />
              </label>
              <fieldset className="roadmap-reference-picker">
                <legend>Link delivery (optional)</legend>
                <p className="muted">
                  Connect work to show progress and delivery risks. You can keep this feature
                  editorial only.
                </p>
                {(
                  [
                    {
                      key: 'projectIds',
                      label: 'Projects',
                      options: data.projects.map((p) => ({ id: p.id, label: p.name })),
                    },
                    {
                      key: 'milestoneIds',
                      label: 'Milestones',
                      options: data.milestones.map((m) => ({
                        id: m.id,
                        label: `${data.projects.find((p) => p.id === m.projectId)?.name ?? 'Project'} · ${m.title}`,
                      })),
                    },
                    {
                      key: 'itemIds',
                      label: 'Work items',
                      options: data.items.map((i) => ({
                        id: i.id,
                        label: `${i.identifier} · ${i.title}`,
                      })),
                    },
                  ] as const
                ).map(({ key, label, options }) => (
                  <div key={key}>
                    <label className="field">
                      {label}
                      <Select
                        className="input"
                        value=""
                        disabled={(draft[key]?.length ?? 0) >= 100}
                        onChange={(e) => {
                          if (e.target.value && !draft[key]?.includes(e.target.value))
                            field(key, [...(draft[key] ?? []), e.target.value]);
                        }}
                      >
                        <option value="">Add {label.toLowerCase().replace(/s$/, '')}…</option>
                        {options
                          .filter((option) => !draft[key]?.includes(option.id))
                          .map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                      </Select>
                    </label>
                    <ul className="roadmap-reference-list">
                      {(draft[key] ?? []).map((id) => (
                        <li key={id}>
                          <span>
                            {options.find((option) => option.id === id)?.label ??
                              'Unavailable record'}
                          </span>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Remove ${options.find((option) => option.id === id)?.label ?? 'unavailable reference'}`}
                            onClick={() =>
                              field(
                                key,
                                draft[key]!.filter((value) => value !== id),
                              )
                            }
                          >
                            <X size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </fieldset>
              {feature && (
                <div className="roadmap-order">
                  <span>
                    Position in group: {position + 1} of {peers.length}
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled={position <= 0}
                    onClick={() => move(-1)}
                  >
                    <ChevronUp size={14} />
                    Move up
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={position >= peers.length - 1}
                    onClick={() => move(1)}
                  >
                    <ChevronDown size={14} />
                    Move down
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
        {error && (
          <p className="roadmap-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => {
            clearDraft(storageKey);
            close();
          }}
        >
          Discard draft
        </button>
        {conflict && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setBusy(true);
              void reload()
                .then((latest) => {
                  setBase(latest);
                  setOrder(latest.features.map((entry) => entry.id));
                  setConflict(false);
                  setError(
                    'Latest roadmap loaded. Your draft is kept; review it before saving again.',
                  );
                })
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
            disabled={busy}
          >
            Load latest and keep draft
          </button>
        )}
        {removing ? (
          <div className="roadmap-remove">
            <p>Remove “{feature?.title}” from the roadmap?</p>
            <button
              className="button danger"
              type="button"
              disabled={busy || conflict}
              onClick={() =>
                void persist({
                  ...base,
                  features: base.features.filter((f) => f.id !== feature?.id),
                })
              }
            >
              Remove feature
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => setRemoving(false)}
            >
              Keep feature
            </button>
          </div>
        ) : (
          <div className="form-actions">
            {feature && !settings && (
              <button
                type="button"
                className="text-button danger-text roadmap-remove-trigger"
                disabled={busy || conflict}
                onClick={() => setRemoving(true)}
              >
                Remove from roadmap
              </button>
            )}
            <button className="button" type="button" disabled={busy} onClick={closeEditor}>
              Cancel
            </button>
            <button className="button primary" disabled={busy || conflict}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
