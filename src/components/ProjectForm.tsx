import { Select } from './Select';
import { useState, type FormEvent } from 'react';
import { Lock, FolderTree } from 'lucide-react';
import type { Project, Visibility } from '../../shared/types';
import { patch, post } from '../lib/api';
import { useApp } from '../lib/context';
import { descendants, navigate } from '../lib/model';
import { Avatar, Modal } from './ui';
import './item.css';
const colors = ['#34775a', '#537ba6', '#9470b0', '#bb8550', '#b46e79', '#5b9193', '#657280'];
export default function ProjectForm({
  onClose,
  parentId,
  project,
}: {
  onClose: () => void;
  parentId?: string;
  project?: Project;
}) {
  const { data, refresh, toast } = useApp();
  const [name, setName] = useState(project?.name || '');
  const [key, setKey] = useState(project?.key || '');
  const [keyEdited, setKeyEdited] = useState(!!project);
  const [description, setDescription] = useState(project?.description || '');
  const [parent, setParent] = useState(project?.parentId || parentId || '');
  const [color, setColor] = useState(project?.color || colors[0]);
  const [lifecycle, setLifecycle] = useState<Project['lifecycle']>(project?.lifecycle || 'ongoing');
  const [status, setStatus] = useState<Project['status']>(project?.status || 'active');
  const [startDate, setStartDate] = useState(project?.startDate || '');
  const [dueDate, setDueDate] = useState(project?.dueDate || '');
  const [visibility, setVisibility] = useState<Visibility>(project?.visibility || 'workspace');
  const [memberIds, setMemberIds] = useState<string[]>(project?.memberIds ?? []);
  const [memberSearch, setMemberSearch] = useState('');
  const ownerId = project?.ownerId ?? data.user.id;
  const owner = data.users.find((user) => user.id === ownerId);
  const canManageAccess = ownerId === data.user.id;
  const members = data.users.filter((user) => user.id !== ownerId);
  const matchingMembers = members.filter((user) =>
    `${user.name} ${user.email}`.toLowerCase().includes(memberSearch.trim().toLowerCase()),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const excluded = project ? descendants(data.projects, project.id) : new Set<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    const formData = new FormData(e.currentTarget);
    const submittedStartDate = String(formData.get('startDate') || '');
    const submittedDueDate = String(formData.get('dueDate') || '');
    if (submittedStartDate && submittedDueDate && submittedDueDate < submittedStartDate) {
      setError('The end date must be on or after the start date.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: name.trim(),
        ...(key.trim() ? { key: key.trim().toUpperCase() } : {}),
        description,
        parentId: parent || null,
        color,
        icon: project?.icon || 'folder',
        lifecycle,
        status,
        startDate: submittedStartDate || null,
        dueDate: submittedDueDate || null,
        visibility,
        ...(canManageAccess ? { memberIds } : {}),
      };
      const result = project
        ? await patch<Project>(`/projects/${project.id}`, payload)
        : await post<Project>('/projects', payload);
      await refresh();
      onClose();
      if (!project) navigate('project', result.id);
      toast(project ? 'Project updated' : 'Project created');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save project');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={project ? 'Edit project' : parentId ? 'New subproject' : 'New project'}
      onClose={onClose}
    >
      <form className="project-form" onSubmit={submit}>
        <div className="project-form-identity">
          <div className="project-form-symbol" style={{ background: color }}>
            <FolderTree size={25} />
          </div>
          <label className="field">
            Project name
            <input
              autoFocus
              required
              className="input"
              placeholder="e.g. Kubernetes Platform"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyEdited) {
                  const words = e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9 ]/g, '')
                    .trim()
                    .split(/\s+/);
                  const generated =
                    words.length > 1
                      ? words.map((w) => w[0]).join('')
                      : words[0]?.slice(0, 4) || '';
                  setKey(generated.slice(0, 10));
                }
              }}
              maxLength={160}
            />
          </label>
        </div>
        <div className="project-colors" role="group" aria-label="Project color">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              aria-label={`Use ${c}`}
              aria-pressed={c === color}
              className={c === color ? 'selected' : ''}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <label className="field">
          Description
          <textarea
            className="input"
            rows={5}
            aria-describedby="project-description-hint"
            placeholder="What is this project about?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <small id="project-description-hint" className="muted">
            Markdown supported
          </small>
        </label>
        <div className="project-form-grid">
          <label className="field">
            Identifier prefix
            <input
              className="input"
              placeholder="e.g. K8S"
              required
              pattern="[A-Z][A-Z0-9]{1,9}"
              title="2–10 letters or digits, starting with a letter"
              value={key}
              onChange={(e) => {
                setKeyEdited(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              }}
              maxLength={10}
            />
          </label>
          <label className="field">
            Parent project
            <Select className="select" value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">No parent · top level</option>
              {data.projects
                .filter((p) => !excluded.has(p.id) && p.status !== 'archived')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </label>
        </div>
        <fieldset className="lifecycle-options">
          <legend>Lifecycle</legend>
          <label className={lifecycle === 'ongoing' ? 'selected' : ''}>
            <input
              type="radio"
              name="lifecycle"
              value="ongoing"
              checked={lifecycle === 'ongoing'}
              onChange={() => setLifecycle('ongoing')}
            />
            <span>
              <strong>Ongoing</strong>
              <small>Teams, platforms, and responsibilities</small>
            </span>
          </label>
          <label className={lifecycle === 'fixed' ? 'selected' : ''}>
            <input
              type="radio"
              name="lifecycle"
              value="fixed"
              checked={lifecycle === 'fixed'}
              onChange={() => setLifecycle('fixed')}
            />
            <span>
              <strong>Time-bound</strong>
              <small>Initiatives with a beginning and an end</small>
            </span>
          </label>
        </fieldset>
        <div className="project-form-grid">
          <label className="field">
            Start date <span className="muted">(optional)</span>
            <input
              type="date"
              name="startDate"
              className="input"
              value={startDate}
              onInput={(e) => setStartDate(e.currentTarget.value)}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="field">
            {lifecycle === 'ongoing' ? 'Target date' : 'End date'}{' '}
            <span className="muted">(optional)</span>
            <input
              type="date"
              name="dueDate"
              className="input"
              value={dueDate}
              min={startDate || undefined}
              onInput={(e) => setDueDate(e.currentTarget.value)}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label className="field">
            Visibility
            <Select
              className="select"
              value={visibility}
              disabled={!canManageAccess}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              <option value="workspace">Workspace</option>
              <option value="private">Private</option>
            </Select>
          </label>
          <label className="field">
            Status
            <Select
              className="select"
              value={status}
              onChange={(e) => setStatus(e.target.value as Project['status'])}
            >
              <option value="active">Active</option>
              <option value="planned">Planned</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </Select>
          </label>
        </div>
        {visibility === 'private' && (
          <fieldset className="project-access">
            <legend>People with access</legend>
            <div className="project-access-person">
              <Avatar user={owner} />
              <span className="project-access-name">{owner?.name ?? 'Project owner'}</span>
              <span className="muted">Owner · always included</span>
            </div>
            {canManageAccess && members.length > 0 && (
              <input
                className="input"
                type="search"
                aria-label="Search workspace members"
                placeholder="Search workspace members…"
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
              />
            )}
            <div className="project-access-members">
              {(canManageAccess
                ? matchingMembers
                : members.filter((user) => memberIds.includes(user.id))
              ).map((user) => (
                <label key={user.id} className="project-access-person">
                  <input
                    type="checkbox"
                    aria-label={`Give ${user.name} access`}
                    checked={memberIds.includes(user.id)}
                    disabled={!canManageAccess}
                    onChange={(event) =>
                      setMemberIds((current) =>
                        event.target.checked
                          ? [...current, user.id]
                          : current.filter((id) => id !== user.id),
                      )
                    }
                  />
                  <Avatar user={user} />
                  <span className="project-access-name">
                    {user.name}
                    <small>{user.email}</small>
                  </span>
                </label>
              ))}
              {canManageAccess && matchingMembers.length === 0 && (
                <p className="muted">
                  {members.length
                    ? 'No members match your search.'
                    : 'No other workspace members yet.'}
                </p>
              )}
            </div>
            <p className="privacy-hint" aria-live="polite">
              <Lock size={13} />
              {canManageAccess
                ? memberIds.length
                  ? 'Only you and the selected people can access this project.'
                  : 'Only you can access this project.'
                : 'Only the owner can change who has access.'}
            </p>
            {parent && (
              <p className="privacy-hint">
                People also need access to the parent project. Private items remain private to their
                creators.
              </p>
            )}
          </fieldset>
        )}
        {!canManageAccess && visibility === 'workspace' && (
          <p className="privacy-hint">Only the owner can change who has access.</p>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <footer className="item-form-footer">
          <span className="muted">Repositories can be connected later.</span>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : project ? 'Save changes' : 'Create project'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
