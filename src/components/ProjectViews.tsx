import { MilestoneItems, MilestoneProgress } from './MilestoneItems';
import { ProjectUpdates } from './ProjectUpdates';
import { Select } from './Select';
import { useState, type FormEvent } from 'react';
import {
  ArrowUpRight,
  Box,
  CalendarDays,
  Check,
  ChevronRight,
  ExternalLink,
  Flag,
  FolderPlus,
  GitBranch,
  Link2,
  LockKeyhole,
  Plus,
  Trash2,
  BookOpen,
  Circle,
  Pencil,
  ArrowRight,
  CircleCheck,
} from 'lucide-react';
import type { Project, ResourceLink, WorkItem } from '../../shared/types';
import { useApp } from '../lib/context';
import { descendants, isDone, isOverdue, navigate, shortDate, statuses, today } from '../lib/model';
import { patch, post, remove } from '../lib/api';
import { Avatar, EmptyState, Modal, ProjectIcon, StatusIcon } from './ui';
import ConfluenceSearch from './ConfluenceSearch';
import GitIssueSearch from './GitIssueSearch';
import { MarkdownBody } from './MarkdownBody';
export function AllProjects() {
  const { data, createProject, editProject } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const projects = data.projects.filter((p) => showArchived || p.status !== 'archived');
  return (
    <div className="projects-content">
      <div className="section-title">
        <span>{projects.length} projects</span>
        <label className="check-field">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Include archived
        </label>
      </div>
      <div className="projects-table">
        <div className="projects-table-head">
          <span>Project</span>
          <span>Status / lifecycle</span>
          <span>Work</span>
          <span>Target date</span>
          <span>Owner</span>
        </div>
        {projects.map((project) => {
          const ids = descendants(data.projects, project.id);
          const items = data.items.filter((i) => i.projectId && ids.has(i.projectId));
          const done = items.filter(isDone).length;
          return (
            <div className="project-table-entry" key={project.id}>
              <button
                className="project-table-row"
                onClick={() => navigate('project', project.id, 'overview')}
              >
                <span className="project-table-name">
                  <span className="project-small-icon" style={{ background: `${project.color}15` }}>
                    <ProjectIcon project={project} size={22} />
                  </span>
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.parentId
                        ? data.projects.find((p) => p.id === project.parentId)?.name
                        : project.key}
                      {project.visibility === 'private' && <> · Private</>}
                    </small>
                  </span>
                </span>
                <span className="lifecycle-badge">
                  <span className={`tiny-dot ${project.status}`} aria-hidden="true" />
                  <strong>
                    {project.status.charAt(0).toUpperCase() + project.status.slice(1)}
                  </strong>
                  <small>{project.lifecycle === 'ongoing' ? 'Ongoing' : 'Time-bound'}</small>
                </span>
                <span className="project-progress">
                  <span className="progress-track">
                    <span style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
                  </span>
                  <small>
                    {done}/{items.length}
                  </small>
                </span>
                <span className="muted">{shortDate(project.dueDate) || '—'}</span>
                <Avatar user={data.users.find((u) => u.id === project.ownerId)} />
              </button>
              <button
                className="icon-button project-table-edit"
                aria-label={`Edit ${project.name}`}
                title="Edit project"
                onClick={() => editProject(project)}
              >
                <Pencil size={15} />
              </button>
            </div>
          );
        })}
      </div>
      {projects.length === 0 && (
        <EmptyState
          title="Every project starts somewhere"
          description="Create a space for an initiative or an ongoing responsibility."
          action={
            <button className="button primary" onClick={() => createProject()}>
              <Plus size={15} />
              Create project
            </button>
          }
        />
      )}
    </div>
  );
}
export function Overview({
  project,
  items,
  milestoneId,
}: {
  project: Project;
  items: WorkItem[];
  milestoneId?: string;
}) {
  const { data, refresh, toast, createProject, editProject, openItem } = useApp();
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [selectedMilestone, setSelectedMilestone] = useState<string | null>(milestoneId ?? null);
  const [milestoneTitle, setMilestoneTitle] = useState('');
  const [milestoneDue, setMilestoneDue] = useState('');
  const [busy, setBusy] = useState(false);
  const active = items.filter((i) => !isDone(i));
  const done = items.filter((i) => i.status === 'done');
  const overdue = items.filter(isOverdue);
  const children = data.projects.filter((p) => p.parentId === project.id);
  const ids = descendants(data.projects, project.id);
  const milestones = data.milestones.filter((m) => ids.has(m.projectId));
  async function milestone(e: FormEvent) {
    e.preventDefault();
    const form = new FormData(e.currentTarget as HTMLFormElement);
    setBusy(true);
    try {
      await post('/milestones', {
        projectId: project.id,
        title: milestoneTitle,
        dueDate: String(form.get('dueDate') || '') || null,
      });
      await refresh();
      setMilestoneOpen(false);
      setMilestoneTitle('');
      setMilestoneDue('');
      toast('Milestone added');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overview-content">
      {selectedMilestone && milestones.find((m) => m.id === selectedMilestone) && (
        <Modal
          title={milestones.find((m) => m.id === selectedMilestone)!.title}
          onClose={() => {
            setSelectedMilestone(null);
            if (milestoneId) navigate('project', project.id, 'overview');
          }}
        >
          <MilestoneItems milestone={milestones.find((m) => m.id === selectedMilestone)!} />
        </Modal>
      )}
      <div className="overview-main">
        <ProjectUpdates key={project.id} project={project} />
        <section className="overview-section">
          <div className="section-heading">
            <h2>About this project</h2>
            <button
              className="icon-button"
              aria-label="Edit project"
              onClick={() => editProject(project)}
            >
              <Pencil size={15} />
            </button>
          </div>
          <MarkdownBody className="project-description">
            {project.description ||
              'Give this project a little context. What are we working toward?'}
          </MarkdownBody>
          <div className="project-facts">
            <span>
              <Avatar user={data.users.find((u) => u.id === project.ownerId)} size={22} />
              {data.users.find((u) => u.id === project.ownerId)?.name}
            </span>
            <span>
              <CalendarDays size={14} />
              {project.lifecycle === 'ongoing'
                ? 'Ongoing responsibility'
                : `${shortDate(project.startDate) || 'No start date'} → ${shortDate(project.dueDate) || 'No target date'}`}
            </span>
            <span>
              {project.visibility === 'private' ? <LockKeyhole size={14} /> : <Box size={14} />}{' '}
              {project.visibility === 'private' ? 'Private project' : 'Workspace project'}
            </span>
          </div>
        </section>
        <section className="overview-section">
          <div className="section-heading">
            <h2>Work at a glance</h2>
            <button className="text-button" onClick={() => navigate('project', project.id)}>
              View work items
              <ArrowRight size={14} />
            </button>
          </div>
          <div className="work-summary">
            <div>
              <strong>{active.length}</strong>
              <span>Active items</span>
            </div>
            <div>
              <strong className={overdue.length ? 'overdue' : ''}>{overdue.length}</strong>
              <span>Overdue</span>
            </div>
            <div>
              <strong>{done.length}</strong>
              <span>Completed</span>
            </div>
          </div>
          <div className="status-distribution">
            {statuses
              .filter((s) => s.id !== 'canceled')
              .map((s) => {
                const count = items.filter((i) => i.status === s.id).length;
                return (
                  count > 0 && (
                    <span
                      key={s.id}
                      style={{ flex: count, background: s.color }}
                      title={`${count} ${s.name.toLowerCase()}`}
                    />
                  )
                );
              })}
          </div>
          <div className="distribution-legend">
            {statuses.map((s) => {
              const count = items.filter((i) => i.status === s.id).length;
              return (
                count > 0 && (
                  <span key={s.id}>
                    <i style={{ background: s.color }} />
                    {s.name}
                    <b>{count}</b>
                  </span>
                )
              );
            })}
          </div>
        </section>
        <section className="overview-section">
          <div className="section-heading">
            <h2>
              Subprojects <span className="count-badge">{children.length}</span>
            </h2>
            <button className="text-button" onClick={() => createProject(project.id)}>
              <Plus size={14} />
              Add subproject
            </button>
          </div>
          {children.length > 0 ? (
            children.map((child) => {
              const childIds = descendants(data.projects, child.id);
              const childItems = data.items.filter((i) => i.projectId && childIds.has(i.projectId));
              return (
                <button
                  key={child.id}
                  className="subproject-row"
                  onClick={() => navigate('project', child.id, 'overview')}
                >
                  <span className="project-small-icon" style={{ background: `${child.color}15` }}>
                    <ProjectIcon project={child} size={21} />
                  </span>
                  <span>
                    <strong>{child.name}</strong>
                    <small>
                      {childItems.filter((i) => !isDone(i)).length} active items ·{' '}
                      {child.lifecycle === 'ongoing'
                        ? 'Ongoing'
                        : shortDate(child.dueDate) || 'No target date'}
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              );
            })
          ) : (
            <div className="inline-empty">
              <FolderPlus size={21} />
              <p>Break an initiative into smaller projects, without losing the bigger picture.</p>
              <button className="button" onClick={() => createProject(project.id)}>
                Create subproject
              </button>
            </div>
          )}
        </section>
        <section className="overview-section">
          <div className="section-heading">
            <h2>Milestones</h2>
            <button className="text-button" onClick={() => setMilestoneOpen(true)}>
              <Plus size={14} />
              Add milestone
            </button>
          </div>
          {milestones.length > 0 ? (
            milestones.map((m) => (
              <div className="milestone-row" key={m.id}>
                <button
                  className="icon-button"
                  title={m.completed ? 'Mark incomplete' : 'Complete milestone'}
                  onClick={async () => {
                    try {
                      await patch(`/milestones/${m.id}`, { completed: !m.completed });
                      await refresh();
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                >
                  {m.completed ? <CircleCheck size={18} className="green" /> : <Circle size={18} />}
                </button>
                <button
                  className={`milestone-title-button ${m.completed ? 'completed-title' : ''}`}
                  onClick={() => setSelectedMilestone(m.id)}
                >
                  {m.title}
                </button>
                <MilestoneProgress milestone={m} />
                <small>{shortDate(m.dueDate) || 'No date'}</small>
                <button
                  className="icon-button subtle"
                  aria-label={`Delete milestone ${m.title}`}
                  onClick={async () => {
                    try {
                      await remove(`/milestones/${m.id}`);
                      await refresh();
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <p className="muted overview-empty">Mark the moments that matter along the way.</p>
          )}
        </section>
      </div>
      <aside className="overview-aside">
        {!!data.projectRelations?.some((r) => r.projectId === project.id) && (
          <section>
            <h3>Related work items</h3>
            {data.projectRelations
              .filter((r) => r.projectId === project.id)
              .map((relation) => {
                const item = data.items.find((i) => i.id === relation.itemId);
                return item ? (
                  <button
                    className="upcoming-item"
                    key={relation.id}
                    onClick={() => openItem(item.id)}
                  >
                    <span>
                      <StatusIcon status={item.status} />
                      <small>{item.identifier}</small>
                    </span>
                    <strong>{item.title}</strong>
                  </button>
                ) : null;
              })}
          </section>
        )}
        <h3>Coming up</h3>
        {active
          .filter((i) => i.dueDate)
          .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!))
          .slice(0, 6)
          .map((item) => (
            <button className="upcoming-item" key={item.id} onClick={() => openItem(item.id)}>
              <span>
                <StatusIcon status={item.status} />
                <small>{item.identifier}</small>
                <time className={isOverdue(item) ? 'overdue' : ''}>{shortDate(item.dueDate)}</time>
              </span>
              <strong>{item.title}</strong>
            </button>
          ))}
        {!active.some((i) => i.dueDate) && (
          <p className="muted">No deadlines ahead. Add a due date to a work item to see it here.</p>
        )}
        <div className="overview-aside-note">
          <Flag size={18} />
          <p>
            {project.lifecycle === 'ongoing'
              ? 'Good platforms are never finished. Keep the next step clear.'
              : 'Small steps, clear ownership, and a shared finish line.'}
          </p>
        </div>
      </aside>
      {milestoneOpen && (
        <Modal title="Add milestone" onClose={() => setMilestoneOpen(false)}>
          <form className="simple-form" onSubmit={milestone}>
            <label className="field">
              Milestone name
              <input
                className="input"
                autoFocus
                required
                value={milestoneTitle}
                onChange={(e) => setMilestoneTitle(e.target.value)}
                placeholder="e.g. Ready for production"
              />
            </label>
            <label className="field">
              Target date
              <input
                type="date"
                name="dueDate"
                className="input"
                value={milestoneDue}
                onInput={(e) => setMilestoneDue(e.currentTarget.value)}
                onChange={(e) => setMilestoneDue(e.target.value)}
              />
            </label>
            <div className="form-actions">
              <button type="button" className="button" onClick={() => setMilestoneOpen(false)}>
                Cancel
              </button>
              <button disabled={busy} className="button primary">
                Add milestone
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
export function Resources({ project }: { project: Project }) {
  const { data, refresh, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<ResourceLink['kind']>('confluence');
  const [confluenceOpen, setConfluenceOpen] = useState(false);
  const [gitIssueOpen, setGitIssueOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const links = data.links.filter((l) => l.projectId === project.id && !l.itemId);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/links', { title, url, kind, projectId: project.id, itemId: null });
      await refresh();
      setOpen(false);
      setTitle('');
      setUrl('');
      toast('Resource linked');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="resources-content">
      <div className="section-heading">
        <div>
          <h2>Everything connected to this project</h2>
          <p className="muted">
            Keep documentation in Confluence and code in your repositories. Bring the links together
            here.
          </p>
        </div>
        <div className="resource-actions">
          <button className="button" onClick={() => setGitIssueOpen(true)}>
            <GitBranch size={15} />
            Find Git issue
          </button>
          <button className="button" onClick={() => setConfluenceOpen(true)}>
            <BookOpen size={15} />
            Find in Confluence
          </button>
          <button className="button primary" onClick={() => setOpen(true)}>
            <Plus size={15} />
            Link resource
          </button>
        </div>
      </div>
      {links.length > 0 ? (
        <div className="resource-list">
          {links.map((link) => (
            <div className="resource-row" key={link.id}>
              <span className={`resource-icon ${link.kind}`}>
                {link.kind === 'confluence' ? (
                  <BookOpen size={22} />
                ) : link.kind === 'repository' ? (
                  <GitBranch size={22} />
                ) : (
                  <Link2 size={22} />
                )}
              </span>
              <a href={link.url} target="_blank" rel="noreferrer">
                <strong>{link.title}</strong>
                <small>
                  {new URL(link.url).hostname}
                  <span>
                    {' '}
                    ·{' '}
                    {link.kind === 'confluence'
                      ? 'Confluence'
                      : link.kind === 'repository'
                        ? 'Repository'
                        : 'Link'}
                  </span>
                </small>
              </a>
              <a
                className="icon-button"
                href={link.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${link.title}`}
              >
                <ExternalLink size={16} />
              </a>
              <button
                className="icon-button"
                aria-label={`Remove ${link.title}`}
                onClick={async () => {
                  try {
                    await remove(`/links/${link.id}`);
                    await refresh();
                    toast('Resource removed');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Link2 size={26} />}
          title="The context belongs with the work"
          description="Link a Confluence page, repository, runbook, or anything your team needs."
          action={
            <button className="button" onClick={() => setOpen(true)}>
              <Plus size={15} />
              Link your first resource
            </button>
          }
        />
      )}
      <div className="resource-sync-note">
        <GitBranch size={20} />
        <div>
          <strong>Bring repository issues into this project</strong>
          <p>Use a saved Git connection to import issues and keep source changes up to date.</p>
        </div>
        <button className="button" onClick={() => navigate('settings', undefined, 'integrations')}>
          Manage integrations
          <ArrowUpRight size={14} />
        </button>
      </div>
      {gitIssueOpen && (
        <GitIssueSearch projectId={project.id} onClose={() => setGitIssueOpen(false)} />
      )}
      {confluenceOpen && (
        <ConfluenceSearch projectId={project.id} onClose={() => setConfluenceOpen(false)} />
      )}
      {open && (
        <Modal title="Link a resource" onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="simple-form">
            <label className="field">
              Type
              <Select
                className="select"
                value={kind}
                onChange={(e) => setKind(e.target.value as ResourceLink['kind'])}
              >
                <option value="confluence">Confluence page</option>
                <option value="repository">Repository</option>
                <option value="link">Other link</option>
              </Select>
            </label>
            <label className="field">
              Title
              <input
                className="input"
                required
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Platform architecture"
              />
            </label>
            <label className="field">
              URL
              <input
                className="input"
                type="url"
                required
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button className="button" type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button disabled={busy} className="button primary">
                Link resource
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
