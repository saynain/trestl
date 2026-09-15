import { compareProjectUpdates } from '../../shared/project-updates';
import { useState, type FormEvent } from 'react';
import { Plus, Activity, UserRound } from 'lucide-react';
import type { Project, ProjectHealth, ProjectUpdate } from '../../shared/types';
import { useApp } from '../lib/context';
import { post } from '../lib/api';
import { navigate, shortDate } from '../lib/model';
import {
  latestProjectUpdate,
  latestProjectUpdates,
  projectHealth,
  reviewProjects,
  updateIsStale,
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
export function UpdateComposer({ project, onClose }: { project: Project; onClose: () => void }) {
  const { data, refresh, toast } = useApp();
  const [health, setHealth] = useState<ProjectHealth>(
    latestProjectUpdate(data.projectUpdates || [], project.id)?.health || 'on_track',
  );
  const [body, setBody] = useState('');
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
export function WeeklyReview() {
  const { data } = useApp();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [compose, setCompose] = useState<Project | null>(null);
  const updates = latestProjectUpdates(data.projectUpdates || []);
  const projects = reviewProjects(data.projects, updates);
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
  return (
    <div className="weekly-review">
      <div className="section-heading">
        <div>
          <h2>Weekly project review</h2>
          <p className="muted">
            {projects.length} active projects · {projects.filter(needsUpdate).length} need an
            update. Risks appear first.
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
      <div className="review-projects">
        {shown.map((project) => {
          const update = updates.get(project.id);
          const owner = data.users.find((u) => u.id === project.ownerId);
          return (
            <article className="review-project" key={project.id}>
              <div className="review-project-heading">
                <button
                  className="review-project-name"
                  onClick={() => navigate('project', project.id, 'overview')}
                >
                  <ProjectIcon project={project} size={23} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.key}
                      {project.parentId
                        ? ` · ${data.projects.find((p) => p.id === project.parentId)?.name || ''}`
                        : ''}
                    </small>
                  </span>
                </button>
                <button className="button" onClick={() => setCompose(project)}>
                  <Plus size={14} />
                  Update
                </button>
              </div>
              <div className="review-project-facts">
                <span>Owner: {owner?.name || 'Unassigned'}</span>
                <span>
                  Target:{' '}
                  {shortDate(project.dueDate) ||
                    (project.lifecycle === 'ongoing' ? 'Ongoing' : 'Not set')}
                </span>
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
            </article>
          );
        })}
      </div>
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
        <UpdateComposer key={compose.id} project={compose} onClose={() => setCompose(null)} />
      )}
    </div>
  );
}
