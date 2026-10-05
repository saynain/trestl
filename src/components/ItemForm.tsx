import { assigneeOptions } from '../lib/assignees';
import { ImageMarkdownTextarea } from './ImageMarkdownTextarea';
import { Select } from './Select';
import { useShortcuts, activateItemControl } from '../lib/keyboard';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Lock, Plus } from 'lucide-react';
import type { ItemType, Priority, Status, Visibility, WorkItem } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import {
  clearDraft,
  draftKey,
  isRetryIntent,
  readDraft,
  retryIntent,
  saveDraft,
} from '../lib/drafts';
import { useApp } from '../lib/context';
import { priorities, statuses, types } from '../lib/model';
import { Modal } from './ui';
import './item.css';

interface CreationDraft {
  title: string;
  description: string;
  project: string;
  itemStatus: Status;
  priority: Priority;
  type: ItemType;
  assigneeId: string;
  startDate: string;
  dueDate: string;
  followUpDate: string;
  visibility: Visibility;
}
const isCreationDraft = (value: unknown): value is CreationDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return (
    ['title', 'description', 'project', 'assigneeId', 'startDate', 'dueDate', 'followUpDate'].every(
      (key) => typeof draft[key] === 'string',
    ) &&
    statuses.some((entry) => entry.id === draft.itemStatus) &&
    priorities.some((entry) => entry.id === draft.priority) &&
    types.some((entry) => entry.id === draft.type) &&
    ['workspace', 'private'].includes(String(draft.visibility))
  );
};

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
  const { data, applyItems, toast, openItem } = useApp();
  const storageKey = draftKey(
    data.user,
    `create:${projectId || ''}:${parentId || ''}:${status || ''}`,
  );
  const recovered = useRef(readDraft(storageKey, isCreationDraft)).current;
  const retryKey = `${storageKey}.retry`;
  const pending = useRef(readDraft(retryKey, isRetryIntent));
  const formRef = useRef<HTMLFormElement>(null);
  const parent = data.items.find((i) => i.id === parentId);
  const [title, setTitle] = useState(recovered?.title || '');
  const [description, setDescription] = useState(recovered?.description || '');
  const [project, setProject] = useState(
    recovered?.project ?? (projectId || parent?.projectId || ''),
  );
  const [itemStatus, setStatus] = useState<Status>(recovered?.itemStatus || status || 'todo');
  const [priority, setPriority] = useState<Priority>(recovered?.priority || 'none');
  const [type, setType] = useState<ItemType>(recovered?.type || 'task');
  const [assigneeId, setAssignee] = useState(
    recovered?.assigneeId ?? (project || parentId ? '' : data.user.id),
  );
  const [startDate, setStartDate] = useState(recovered?.startDate || '');
  const [dueDate, setDueDate] = useState(recovered?.dueDate || '');
  const [followUpDate, setFollowUpDate] = useState(recovered?.followUpDate || '');
  const [visibility, setVisibility] = useState<Visibility>(
    recovered?.visibility || parent?.visibility || (projectId ? 'workspace' : 'private'),
  );
  const [saving, setSaving] = useState(false);
  const [imageUploading, setImageUploading] = useState(false);
  const [error, setError] = useState('');
  const [recoveredDraft, setRecoveredDraft] = useState(!!recovered);
  function discardDraft() {
    clearDraft(storageKey);
    clearDraft(retryKey);
    pending.current = null;
    onClose();
  }
  useEffect(() => {
    if (title || description)
      saveDraft(storageKey, {
        title,
        description,
        project,
        itemStatus,
        priority,
        type,
        assigneeId,
        startDate,
        dueDate,
        followUpDate,
        visibility,
      });
    else clearDraft(storageKey);
  }, [
    storageKey,
    title,
    description,
    project,
    itemStatus,
    priority,
    type,
    assigneeId,
    startDate,
    dueDate,
    followUpDate,
    visibility,
  ]);
  async function submit(e?: FormEvent, keepOpen = false) {
    e?.preventDefault();
    if (!title.trim() || saving || imageUploading || !formRef.current?.reportValidity()) return;
    const formData = new FormData(formRef.current);
    const submittedStartDate = String(formData.get('startDate') || '');
    const submittedDueDate = String(formData.get('dueDate') || '');
    const submittedFollowUpDate = String(formData.get('followUpDate') || '');
    setSaving(true);
    setError('');
    try {
      const body = {
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
      };
      pending.current = retryIntent(body, pending.current);
      saveDraft(retryKey, pending.current);
      const item = await api<WorkItem>('/items', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Idempotency-Key': pending.current.key },
      });
      applyItems([item]);
      clearDraft(storageKey);
      clearDraft(retryKey);
      pending.current = null;
      setRecoveredDraft(false);
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
      if (err instanceof ApiError && err.status === 404) {
        clearDraft(retryKey);
        pending.current = null;
      }
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
    { root: formRef, enabled: !saving && !imageUploading },
  );
  return (
    <Modal
      title={parent ? `Add subtask to ${parent.identifier}` : 'New work item'}
      onClose={onClose}
    >
      <form ref={formRef} className="item-form" onSubmit={submit}>
        <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          {recoveredDraft && (
            <p className="muted" role="status">
              Recovered your unfinished draft.
            </p>
          )}
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
          <ImageMarkdownTextarea
            projectId={project || null}
            className="item-description-input"
            aria-label="Description"
            placeholder="Add a description, a thought, or some context…"
            value={description}
            setValue={setDescription}
            onBusyChange={setImageUploading}
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
            <button type="button" className="button ghost" onClick={discardDraft}>
              {title || description ? 'Discard draft' : 'Cancel'}
            </button>
            <button
              type="submit"
              title="Create work item; add Shift to the keyboard shortcut to keep composing"
              className="button primary"
              disabled={!title.trim() || saving || imageUploading}
            >
              <Plus size={14} />
              {saving ? 'Creating…' : 'Create work item'}
            </button>
          </footer>
        </fieldset>
      </form>
    </Modal>
  );
}
