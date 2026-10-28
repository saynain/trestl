import { compareProjectUpdates } from '../../shared/project-updates';
import { useState, type FormEvent } from 'react';
import { Plus, Activity, ArrowRight, ChevronRight, UserRound } from 'lucide-react';
import type { Project, ProjectHealth, ProjectUpdate } from '../../shared/types';
import { useApp } from '../lib/context';
import { post } from '../lib/api';
import { navigate, shortDate, today } from '../lib/model';
import { progressLabel, projectProgress } from '../lib/progress';
import {
  latestProjectUpdate,
  latestProjectUpdates,
  projectHealth,
  projectEvidenceDraft,
  projectReviewSummary,
  type ProjectReviewEvidence,
  updateAge,
  updateIsStale,
  workspaceReviewProjects,
} from '../lib/project-updates';
import { Avatar, EmptyState, Modal, ProjectIcon } from './ui';
import { Select } from './Select';
import { MarkdownBody } from './MarkdownBody';
import './project-updates.css';

export function HealthBadge({ health }: { health?: ProjectHealth }) {
  return (
    <span className={`project-health ${health || 'unknown'}`}>
      <Activity size={14} />
      {health ? projectHealth[health] : 'No update'}
    </span>
  );
}
function UpdateBody({ update, latest = true }: { update: ProjectUpdate; latest?: boolean }) {
  const { data } = useApp();
  const author = data.users.find((u) => u.id === update.authorId);
  return (
    <>
      <div className="project-update-meta">
        <HealthBadge health={update.health} />
        {update.importedFrom ? <UserRound size={16} /> : <Avatar user={author} size={22} />}
        <span>{update.importedFrom?.authorName || author?.name || 'Former member'}</span>
        {update.importedFrom && (
          <span title="Original author name from the imported project file">Imported</span>
        )}
        <time dateTime={update.createdAt} title={new Date(update.createdAt).toLocaleString()}>
          {shortDate(update.createdAt.slice(0, 10))}
        </time>
        {latest && updateIsStale(update) && (
          <span className="update-stale">Needs update · 7+ days</span>
        )}
      </div>
      <MarkdownBody>{update.body}</MarkdownBody>
    </>
  );
}
export function UpdateComposer({
  project,
  onClose,
  initialBody = '',
}: {
  project: Project;
  onClose: () => void;
  initialBody?: string;
}) {
  const { data, refresh, toast } = useApp();
  const [health, setHealth] = useState<ProjectHealth>(
    latestProjectUpdate(data.projectUpdates || [], project.id)?.health || 'on_track',
  );
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !body.trim()) return;
    setBusy(true);
    setError('');
    try {
      await post(`/projects/${project.id}/updates`, { health, body: body.trim() });
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
      return;
    }
    // Once saved, close even if refresh fails so retrying cannot duplicate the update.
    try {
      await refresh();
      toast('Project update posted');
    } catch {
      toast('Update saved. Refresh to see it.', 'error');
    }
    onClose();
  }
  return (
    <Modal
      title={`Update ${project.name}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="simple-form" onSubmit={submit}>
        <label className="field">
          Project health
          <Select
            value={health}
            disabled={busy}
            onChange={(e) => setHealth(e.target.value as ProjectHealth)}
          >
            {Object.entries(projectHealth).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label className="field">
          Update
          <textarea
            className="input project-update-input"
            autoFocus
            required
            maxLength={20000}
            disabled={busy}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What changed? Any blockers or decisions needed? What’s next?"
          />
        </label>
        <small className="muted">
          Markdown supported. Visible to everyone with access to this project.
        </small>
        {initialBody && (
          <small className="muted">
            Draft includes work shared with everyone who can access this project. Add context and
            choose the health before posting.
          </small>
        )}
        {error && (
          <p role="alert" className="overdue">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !body.trim()}>
            {busy ? 'Posting…' : 'Post update'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ProjectUpdates({ project }: { project: Project }) {
  const { data } = useApp();
  const [compose, setCompose] = useState(false);
  const updates = (data.projectUpdates || [])
    .filter((u) => u.projectId === project.id)
    .sort(compareProjectUpdates);
  return (
    <section className="overview-section project-updates-section">
      <div className="section-heading">
        <h2>Latest update</h2>
        <button className="text-button" onClick={() => setCompose(true)}>
          <Plus size={14} />
          Write update
        </button>
      </div>
      {updates[0] ? (
        <UpdateBody update={updates[0]} />
      ) : (
        <p className="muted">
          How is this project going? Share progress, blockers, and next steps with a health update.
        </p>
      )}
      {updates.length > 1 && (
        <details className="update-history">
          <summary>Previous updates ({updates.length - 1})</summary>
          {updates.slice(1).map((u) => (
            <article key={u.id}>
              <UpdateBody update={u} latest={false} />
            </article>
          ))}
        </details>
      )}
      {compose && <UpdateComposer project={project} onClose={() => setCompose(false)} />}
    </section>
  );
}
/** Latest health with a compact age; amber once the update is a week old. */
export function UpdateHealth({ update }: { update?: ProjectUpdate }) {
  return (
    <span className="update-health">
      <HealthBadge health={update?.health} />
      {update && (
        <time
          dateTime={update.createdAt}
          title={new Date(update.createdAt).toLocaleString()}
          className={updateIsStale(update) ? 'update-stale' : undefined}
        >
          {updateAge(update)}
        </time>
      )}
    </span>
  );
}
export function WeeklyReview() {
  const { data } = useApp();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ project: Project; body: string } | null>(null);
  const updates = latestProjectUpdates(data.projectUpdates || []);
  const { projects, omittedPrivate } = workspaceReviewProjects(data, updates);
  const needsUpdate = (p: Project) => {
    const u = updates.get(p.id);
    return !u || updateIsStale(u);
  };
  const shown = projects.filter((p) => {
    const u = updates.get(p.id);
    return (
      (filter === 'all' || (filter === 'needs_update' ? needsUpdate(p) : u?.health === filter)) &&
      `${p.name} ${p.key}`.toLowerCase().includes(query.toLowerCase())
    );
  });
  const day = today();
  return (
    <div className="weekly-review">
      <div className="section-heading">
        <div>
          <h2>Weekly project review</h2>
          <p className="muted">
            {projects.length} active projects · {projects.filter(needsUpdate).length} need an
            update. Risks appear first.
            {omittedPrivate > 0 &&
              ` ${omittedPrivate} private ${omittedPrivate === 1 ? 'project' : 'projects'} omitted.`}
          </p>
        </div>
      </div>
      <div className="review-filters">
        <input
          className="input"
          aria-label="Search active projects"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          aria-label="Filter project health"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All health statuses</option>
          {Object.entries(projectHealth).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          <option value="needs_update">Needs update</option>
        </Select>
      </div>
      {shown.length > 0 && (
        <div className="review-scan">
          <div className="review-scan-line review-scan-head-line">
            <div className="review-scan-head">
              <span>Project</span>
              <span>Health</span>
              <span>Owner</span>
              <span>Lifecycle</span>
              <span>Next milestone</span>
              <span>Open blockers</span>
            </div>
          </div>
          {shown.map((project) => {
            const update = updates.get(project.id);
            const owner = data.users.find((u) => u.id === project.ownerId);
            const parent = data.projects.find((p) => p.id === project.parentId);
            const { evidence, omittedRestricted, blockers, nextMilestone } = projectReviewSummary(
              data,
              project.id,
            );
            const open = openId === project.id;
            return (
              <div className={`review-scan-entry ${open ? 'open' : ''}`} key={project.id}>
                <div className="review-scan-line">
                  <button
                    className="review-scan-row"
                    aria-expanded={open}
                    aria-controls={open ? `review-${project.id}` : undefined}
                    onClick={() => setOpenId(open ? null : project.id)}
                  >
                    <span className="review-scan-project">
                      <ChevronRight size={14} className="review-scan-chevron" aria-hidden="true" />
                      <ProjectIcon project={project} size={20} />
                      <span>
                        <strong>{project.name}</strong>
                        <small>{parent ? parent.name : project.key}</small>
                      </span>
                    </span>
                    <UpdateHealth update={update} />
                    <span className="review-scan-owner">
                      <Avatar user={owner} size={20} />
                      <span>{owner?.name || 'Unassigned'}</span>
                    </span>
                    <span className="review-scan-stack">
                      <span>{project.lifecycle === 'ongoing' ? 'Ongoing' : 'Time-bound'}</span>
                      {project.lifecycle !== 'ongoing' && (
                        <small>{shortDate(project.dueDate) || 'No target date'}</small>
                      )}
                    </span>
                    <span className="review-scan-stack">
                      {nextMilestone ? (
                        <>
                          <span>{nextMilestone.title}</span>
                          <small
                            className={
                              nextMilestone.dueDate && nextMilestone.dueDate < day ? 'overdue' : ''
                            }
                          >
                            {shortDate(nextMilestone.dueDate) || 'No date'}
                          </small>
                        </>
                      ) : (
                        <span className="muted">No milestone</span>
                      )}
                    </span>
                    <span className={blockers ? 'review-scan-blockers' : 'muted'}>
                      {blockers ? `${blockers} ${blockers === 1 ? 'blocker' : 'blockers'}` : 'None'}
                    </span>
                  </button>
                  <button
                    className="button review-scan-update"
                    aria-label={`Update ${project.name}`}
                    onClick={() => setCompose({ project, body: '' })}
                  >
                    <Plus size={14} />
                    <span>Update</span>
                  </button>
                </div>
                {open && (
                  <div className="review-scan-detail" id={`review-${project.id}`}>
                    <ReviewEvidence
                      project={project}
                      evidence={evidence}
                      omittedRestricted={omittedRestricted}
                      onDraft={() =>
                        setCompose({
                          project,
                          body: projectEvidenceDraft(evidence, data, project.id),
                        })
                      }
                    />
                    <div className="review-project-facts">
                      <span>Work: {progressLabel(projectProgress(data, project.id))}</span>
                      <button
                        className="text-button"
                        onClick={() => navigate('project', project.id, 'overview')}
                      >
                        Open project
                        <ArrowRight size={13} />
                      </button>
                    </div>
                    {update ? (
                      <UpdateBody update={update} />
                    ) : (
                      <div className="review-no-update">
                        <HealthBadge />
                        <p className="muted">
                          No update yet. Add progress and next steps before the meeting.
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!shown.length && (
        <EmptyState
          title={projects.length ? 'No matching projects' : 'No active projects'}
          description={
            projects.length
              ? 'Try another search or health filter.'
              : 'Projects with an Active status will appear here.'
          }
        />
      )}
      {compose && (
        <UpdateComposer
          key={compose.project.id}
          project={compose.project}
          initialBody={compose.body}
          onClose={() => setCompose(null)}
        />
      )}
    </div>
  );
}

function ReviewEvidence({
  project,
  evidence,
  onDraft,
  omittedRestricted,
}: {
  project: Project;
  evidence: ProjectReviewEvidence;
  onDraft: () => void;
  omittedRestricted: boolean;
}) {
  const { openItem } = useApp();
  const itemGroup = (
    label: string,
    items: ProjectReviewEvidence['completed'],
    date: 'dueDate' | 'completedAt',
  ) => (
    <details className="review-evidence-group">
      <summary>
        {label}
        <strong>{items.length}</strong>
      </summary>
      {items.length ? (
        <ul>
          {items.slice(0, 10).map((item) => (
            <li key={item.id}>
              <button className="review-evidence-link" onClick={() => openItem(item.id)}>
                <span>
                  <small>{item.identifier}</small> {item.title}
                </span>
                <time dateTime={item[date] || undefined}>{shortDate(item[date])}</time>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None recorded.</p>
      )}
      {items.length > 10 && (
        <button className="text-button" onClick={() => navigate('project', project.id)}>
          View project work · {items.length - 10} more
        </button>
      )}
    </details>
  );
  return (
    <section className="review-evidence" aria-label={`Delivery evidence for ${project.name}`}>
      <div className="review-evidence-heading">
        <small className="muted">
          Work since {shortDate(evidence.since)}
          {evidence.includesSubprojects ? ' · includes subprojects' : ''}
        </small>
        <button className="text-button" onClick={onDraft}>
          Draft from evidence
        </button>
      </div>
      <div className="review-evidence-grid">
        {itemGroup('Completed', evidence.completed, 'completedAt')}
        {itemGroup('Overdue', evidence.overdue, 'dueDate')}
        {itemGroup('Next 7 days', evidence.upcoming, 'dueDate')}
        <details className="review-evidence-group">
          <summary>
            Dependencies<strong>{evidence.blockers.length}</strong>
          </summary>
          {evidence.blockers.length ? (
            <ul>
              {evidence.blockers.slice(0, 10).map(({ relation, blocker, dependent, state }) => (
                <li key={relation.id}>
                  <button className="review-evidence-link" onClick={() => openItem(dependent.id)}>
                    {dependent.identifier}: {dependent.title}
                  </button>
                  <small className="muted">
                    Waits on{' '}
                    <button className="text-button" onClick={() => openItem(blocker.id)}>
                      {blocker.identifier}
                    </button>
                    {state === 'conflict' ? ' · schedule conflict' : ''}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No unresolved dependencies.</p>
          )}
          {evidence.blockers.length > 10 && (
            <button
              className="text-button"
              onClick={() => navigate('project', project.id, 'gantt')}
            >
              View timeline · {evidence.blockers.length - 10} more
            </button>
          )}
        </details>
        <details className="review-evidence-group">
          <summary>
            Milestone slips<strong>{evidence.slippedMilestones.length}</strong>
          </summary>
          {evidence.slippedMilestones.length ? (
            <ul>
              {evidence.slippedMilestones.slice(0, 10).map((milestone) => (
                <li key={milestone.id}>
                  <button
                    className="review-evidence-link"
                    onClick={() => navigate('project', milestone.projectId, 'overview')}
                  >
                    <span>{milestone.title}</span>
                    <time dateTime={milestone.dueDate || undefined}>
                      {shortDate(milestone.dueDate)}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No past-due milestones.</p>
          )}
          {evidence.slippedMilestones.length > 10 && (
            <button
              className="text-button"
              onClick={() => navigate('project', project.id, 'overview')}
            >
              View milestones · {evidence.slippedMilestones.length - 10} more
            </button>
          )}
        </details>
      </div>
      {omittedRestricted && (
        <p className="muted review-evidence-privacy">
          Restricted work is visible here to you but omitted from the shared update draft.
        </p>
      )}
    </section>
  );
}
