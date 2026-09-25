import { assigneeOptions } from '../lib/assignees';
import { MentionTextarea } from './MentionTextarea';
import { Select } from './Select';
import { useShortcuts, activateItemControl } from '../lib/keyboard';
import { useRef, useState, type FormEvent } from 'react';
import { Lock, Plus } from 'lucide-react';
import type { ItemType, Priority, Status, Visibility, WorkItem } from '../../shared/types';
import { post } from '../lib/api';
import { useApp } from '../lib/context';
import { priorities, statuses, types } from '../lib/model';
import { Modal } from './ui';
import './item.css';

export default function ItemForm({
  onClose,
  projectId,
  status,
  parentId,
}: {
  onClose: () => void;
  projectId?: string | null;
  status?: Status;
  parentId?: string;
}) {
  const { data, refresh, toast, openItem } = useApp();
  const formRef = useRef<HTMLFormElement>(null);
  const parent = data.items.find((i) => i.id === parentId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [project, setProject] = useState(projectId || parent?.projectId || '');
  const [itemStatus, setStatus] = useState<Status>(status || 'todo');
  const [priority, setPriority] = useState<Priority>('none');
  const [type, setType] = useState<ItemType>('task');
  const [assigneeId, setAssignee] = useState(project || parentId ? '' : data.user.id);
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(
    parent?.visibility || (projectId ? 'workspace' : 'private'),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(e?: FormEvent, keepOpen = false) {
    e?.preventDefault();
    if (!title.trim() || saving || !formRef.current?.reportValidity()) return;
    const formData = new FormData(formRef.current);
    const submittedStartDate = String(formData.get('startDate') || '');
    const submittedDueDate = String(formData.get('dueDate') || '');
    const submittedFollowUpDate = String(formData.get('followUpDate') || '');
    setSaving(true);
    setError('');
    try {
      const item = await post<WorkItem>('/items', {
        title: title.trim(),
        description,
        projectId: project || null,
        parentId: parentId || null,
        status: itemStatus,
        priority,
        type,
        assigneeId: assigneeId || null,
        startDate: submittedStartDate || null,
        dueDate: submittedDueDate || null,
        followUpDate: submittedFollowUpDate || null,
        visibility,
      });
      await refresh();
      if (keepOpen) {
        setTitle('');
        setDescription('');
        formRef.current?.querySelector<HTMLInputElement>('.item-title-input')?.focus();
      } else {
        onClose();
        openItem(item.id);
      }
      toast(`${item.identifier} created`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create work item');
    } finally {
      setSaving(false);
    }
  }
  useShortcuts(
    'composer',
    {
      composeStatus: () => activateItemControl(formRef.current, 'status'),
      composePriority: () => activateItemControl(formRef.current, 'priority'),
      composeAssignee: () => activateItemControl(formRef.current, 'assignee'),
      composeProject: () => activateItemControl(formRef.current, 'project'),
      submit: () => {
        void submit();
      },
      createMore: () => {
        void submit(undefined, true);
      },
    },
    { root: formRef, enabled: !saving },
  );
  return (
    <Modal
      title={parent ? `Add subtask to ${parent.identifier}` : 'New work item'}
      onClose={onClose}
    >
      <form ref={formRef} className="item-form" onSubmit={submit}>
        <div className="form-context">
          <Select
            aria-label="Project"
            className="select"
            shortcut="shift+p"
            shortcutHint="ctrl+shift+j"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">Personal inbox</option>
            {data.projects
              .filter((p) => p.status !== 'archived')
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          <span className="muted">/</span>
          <Select
            aria-label="Work item type"
            className="select"
            value={type}
            onChange={(e) => setType(e.target.value as ItemType)}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <input
          className="item-title-input"
          autoFocus
          aria-label="Work item title"
          placeholder="What needs to be done?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={240}
          required
        />
        <MentionTextarea
          projectId={project || null}
          className="item-description-input"
          aria-label="Description"
          placeholder="Add a description, a thought, or some context…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={5}
        />
        <div className="item-form-properties">
          <label className="field">
            Status
            <Select
              className="select"
              shortcut="s"
              shortcutHint="ctrl+shift+s"
              value={itemStatus}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
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
              shortcut="p"
              shortcutHint="ctrl+shift+p"
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
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
              shortcut="a"
              shortcutHint="ctrl+shift+a"
              value={assigneeId}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">Unassigned</option>
              {assigneeOptions(data.users).map((u) => (
                <option key={u.id} value={u.id} disabled={u.disabled}>
                  {u.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            Start date
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
            Due date
            <input
              type="date"
              name="dueDate"
              className="input"
              value={dueDate}
              onInput={(e) => setDueDate(e.currentTarget.value)}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label className="field">
            Follow up on
            <input
              type="date"
              name="followUpDate"
              className="input"
              value={followUpDate}
              onInput={(e) => setFollowUpDate(e.currentTarget.value)}
              onChange={(e) => setFollowUpDate(e.target.value)}
            />
          </label>
          <label className="field">
            Visibility
            <Select
              className="select"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as Visibility)}
            >
              <option value="workspace">Workspace</option>
              <option value="private">Private · only you</option>
            </Select>
          </label>
        </div>
        {visibility === 'private' && (
          <p className="privacy-hint">
            <Lock size={13} /> Only you can see this work item.
          </p>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <footer className="item-form-footer">
          <span className="muted">
            Markdown supported <span className="shortcut-hint">⌘ / Ctrl ↵ to create</span>
          </span>
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            title="Create work item; add Shift to the keyboard shortcut to keep composing"
            className="button primary"
            disabled={!title.trim() || saving}
          >
            <Plus size={14} />
            {saving ? 'Creating…' : 'Create work item'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
