import { ParentSelect, ParentPicker, HierarchyMenu } from './ParentPicker';
import { ImageMarkdownTextarea } from './ImageMarkdownTextarea';
import { workItemOptions } from '../lib/work-item-options';
import { assigneeOptions } from '../lib/assignees';
import { useShortcuts, activateItemControl, isTyping } from '../lib/keyboard';
import { itemActions, type ItemAction } from '../lib/shortcuts';
import { Select } from './Select';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  CircleAlert,
  CircleDot,
  Tag,
  UserRound,
  CalendarDays,
  ArrowRightLeft,
  GitFork,
  ChevronRight,
  Link2,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { MarkdownBody } from './MarkdownBody';
import type {
  Bootstrap,
  ItemDetail as Detail,
  ItemType,
  Priority,
  Status,
  Visibility,
  WorkItem,
} from '../../shared/types';
import { ApiError, api, patch, post, remove } from '../lib/api';
import { useApp } from '../lib/context';
import {
  clearDraft,
  draftKey,
  draftTextChanges,
  isRetryIntent,
  hasDraftChanges,
  type DraftText,
  readDraft,
  retryIntent,
  saveDraft,
} from '../lib/drafts';
import { priorities, statuses, types, shortDate } from '../lib/model';
import { Avatar, GitHubIcon, Modal, StatusIcon } from './ui';
import './item.css';
interface EditDraft {
  title: string;
  description: string;
  revision: number;
  base?: DraftText;
}
const isEditDraft = (value: unknown): value is EditDraft => {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.title === 'string' &&
    typeof draft.description === 'string' &&
    typeof draft.revision === 'number' &&
    Number.isInteger(draft.revision) &&
    draft.revision >= 0 &&
    (draft.base === undefined ||
      (!!draft.base &&
        typeof draft.base === 'object' &&
        typeof (draft.base as DraftText).title === 'string' &&
        typeof (draft.base as DraftText).description === 'string'))
  );
};
const isCommentDraft = (value: unknown): value is { body: string } =>
  !!value && typeof value === 'object' && typeof (value as { body?: unknown }).body === 'string';

function Property({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="item-property" data-property={name}>
      <span>{name}</span>
      {children}
    </label>
  );
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
/** A work item as its own page in the main area; Back or Escape returns to where it was opened. */
function ItemPage({
  title,
  onClose,
  className = '',
  children,
}: {
  title: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTyping(event.target)) return;
      if (document.querySelector('[role="dialog"], .popover, .profile-popover')) return;
      close.current();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
  return (
    <section ref={root} tabIndex={-1} className={`item-page ${className}`} aria-label={title}>
      <header className="item-page-header">
        <button type="button" className="text-button item-page-back" onClick={onClose}>
          <ArrowLeft size={15} />
          Back
        </button>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}
function DatePropertyInput({
  value,
  onSave,
  shortcut,
}: {
  value: string | null;
  onSave: (value: string | null) => void;
  shortcut?: string;
}) {
  const [draft, setDraft] = useState(value || '');
  useEffect(() => {
    setDraft(value || '');
  }, [value]);
  return (
    <input
      type="date"
      data-shortcut={shortcut}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onInput={(event) => setDraft(event.currentTarget.value)}
      onBlur={(event) => {
        const next = event.currentTarget.value;
        setDraft(next);
        if (next !== (value || '')) onSave(next || null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
function activityText(body: string, data: Bootstrap) {
  const fields: Record<string, string> = {
    status: 'status',
    priority: 'priority',
    assigneeId: 'assignee',
    projectId: 'project',
    milestoneId: 'milestone',
    parentId: 'parent item',
    type: 'type',
    startDate: 'start date',
    dueDate: 'due date',
    followUpDate: 'follow-up date',
    recurrence: 'recurrence',
    visibility: 'visibility',
    labels: 'tags',
    title: 'title',
    description: 'description',
    position: 'position',
    externalUrl: 'source link',
  };
  return body
    .split(' · ')
    .map((part) => {
      const separator = part.indexOf(': ');
      if (separator < 0) return part;
      const key = part.slice(0, separator),
        value = part.slice(separator + 2),
        field = fields[key];
      if (!field) return part;
      if (key === 'description') return 'updated the description';
      if (key === 'position') return 'reordered the work item';
      if (value === 'cleared' || !value) return `removed the ${field}`;
      const readable =
        key === 'status'
          ? statuses.find((entry) => entry.id === value)?.name
          : key === 'priority'
            ? priorities.find((entry) => entry.id === value)?.name
            : key === 'type'
              ? types.find((entry) => entry.id === value)?.name
              : key === 'assigneeId'
                ? data.users.find((entry) => entry.id === value)?.name || 'a member'
                : key === 'projectId'
                  ? data.projects.find((entry) => entry.id === value)?.name || 'a project'
                  : key === 'milestoneId'
                    ? data.milestones.find((entry) => entry.id === value)?.title || 'a milestone'
                    : key === 'parentId'
                      ? data.items.find((entry) => entry.id === value)?.identifier || 'a work item'
                      : key === 'startDate' || key === 'dueDate' || key === 'followUpDate'
                        ? shortDate(value)
                        : key === 'visibility'
                          ? value === 'private'
                            ? 'Private'
                            : 'Workspace'
                          : key === 'recurrence'
                            ? value.charAt(0).toUpperCase() + value.slice(1)
                            : value;
      return `changed ${field} to ${readable || value}`;
    })
    .join(' · ');
}

function ActivityIcon({ body }: { body: string }) {
  const field = body.split(': ')[0];
  const Icon =
    field === 'status'
      ? CircleDot
      : field === 'assigneeId'
        ? UserRound
        : field === 'labels'
          ? Tag
          : ['startDate', 'dueDate', 'followUpDate'].includes(field)
            ? CalendarDays
            : ['projectId', 'parentId', 'position'].includes(field)
              ? ArrowRightLeft
              : Pencil;
  return <Icon size={16} aria-hidden="true" />;
}

export default function ItemDetail({
  id,
  activityId,
  presentation = 'modal',
  onClose,
  initialAction,
  onActionHandled,
}: {
  id: string;
  activityId?: string;
  presentation?: 'modal' | 'page';
  onClose: () => void;
  initialAction?: ItemAction;
  onActionHandled?: () => void;
}) {
  const { data, refresh, applyItems, toast, openItem, createItem, uiPreferences } = useApp();
  const editKey = draftKey(data.user, `edit:${id}`);
  const commentKey = draftKey(data.user, `comment:${id}`);
  const commentRetryKey = `${commentKey}.retry`;
  const pendingComment = useRef(readDraft(commentRetryKey, isRetryIntent));
  const editBase = useRef<DraftText>({ title: '', description: '' });
  const [editRevision, setEditRevision] = useState(0);
  const currentId = useRef(id);
  currentId.current = id;
  const [latestLoaded, setLatestLoaded] = useState(false);
  const [conflict, setConflict] = useState<Partial<WorkItem> | null>(null);
  const actionRoot = useRef<HTMLDivElement>(null);
  const [editField, setEditField] = useState<'title' | 'description'>('title');
  const [detail, setDetail] = useState<Detail | null>(null);
  useEffect(() => {
    if (detail?.item.id === id && activityId)
      document.getElementById(`activity-${activityId}`)?.scrollIntoView({ block: 'center' });
  }, [detail?.item.id, id, activityId]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [descriptionUploading, setDescriptionUploading] = useState(false);
  const [comment, setComment] = useState('');
  const [commentUploading, setCommentUploading] = useState(false);
  const [commentPreview, setCommentPreview] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [mobilePropertiesExpanded, setMobilePropertiesExpanded] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkKind, setLinkKind] = useState('link');
  const [showParent, setShowParent] = useState(false);
  const [showRelation, setShowRelation] = useState(false);
  const [relationTarget, setRelationTarget] = useState('');
  const [relationKind, setRelationKind] = useState('blocks');
  const reload = useCallback(async () => {
    const next = await api<Detail>(`/items/${id}`);
    if (currentId.current === id)
      setDetail((current) =>
        current?.item.id === id && (current.item.revision ?? 0) > (next.item.revision ?? 0)
          ? current
          : next,
      );
    return next;
  }, [id]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    setEditing(false);
    setComment(readDraft(commentKey, isCommentDraft)?.body || '');
    pendingComment.current = readDraft(commentRetryKey, isRetryIntent);
    setConflict(null);
    setLatestLoaded(false);
    setCommentPreview(false);
    setTagDraft('');
    setConfirmDelete(false);
    setShowRelation(false);
    setShowParent(false);
    setShowLink(false);
    api<Detail>(`/items/${id}`)
      .then((next) => {
        if (alive) {
          setDetail(next);
          const draft = readDraft(editKey, isEditDraft);
          const base = draft?.base || next.item;
          if (draft && hasDraftChanges(draft, base) && !next.item.source) {
            editBase.current = { title: base.title, description: base.description };
            setTitle(draft.title);
            setDescription(draft.description);
            setEditRevision(draft.revision);
            setEditing(true);
          } else clearDraft(editKey);
        }
      })
      .catch((err) => {
        if (alive) setError(message(err));
      });
    return () => {
      alive = false;
    };
  }, [id, editKey, commentKey, commentRetryKey]);
  useEffect(() => {
    if (editing && detail?.item.id === id) persistEditDraft();
  }, [editKey, id, editing, title, description, editRevision, detail?.item.id]);
  useEffect(() => {
    // Do not write a previous item's state during a modal navigation render.
    if (detail?.item.id !== id) return;
    if (comment) saveDraft(commentKey, { body: comment });
    else clearDraft(commentKey);
  }, [commentKey, id, comment, detail?.item.id]);
  async function update(changes: Partial<WorkItem>, expectedRevision = detail?.item.revision ?? 0) {
    if (saving) return false;
    setSaving(true);
    setError('');
    try {
      const { item } = await patch<{ item: WorkItem }>(`/items/${id}`, {
        ...changes,
        expectedRevision,
      });
      setDetail((current) => (current?.item.id === id ? { ...current, item } : current));
      applyItems([item]);
      // A property-only save from the editor's same base also advances that base safely.
      if (
        editing &&
        editRevision === (detail?.item.revision ?? 0) &&
        changes.title === undefined &&
        changes.description === undefined
      )
        setEditRevision(item.revision ?? 0);
      setConflict(null);
      // The write is complete. A failed activity refresh must not look like a failed save.
      void reload().catch(() =>
        toast('Saved. Activity could not refresh; reopen to retry.', 'error'),
      );
      if (
        changes.status !== undefined &&
        changes.status !== detail?.item.status &&
        detail?.item.recurrence
      )
        void refresh().catch(() => toast('Saved. Recurring work could not refresh.', 'error'));
      return true;
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        err.message.startsWith('Work item changed.')
      ) {
        setConflict(changes);
        setLatestLoaded(false);
        setError(
          'This work item changed elsewhere. Your changes are preserved. Reload the latest version to compare, or explicitly reapply your changes.',
        );
      } else setError(message(err));
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function mutate(action: () => Promise<unknown>, after?: () => void) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await action();
      after?.();
      const results = await Promise.allSettled([reload(), refresh()]);
      if (results.some((result) => result.status === 'rejected'))
        toast('Saved. Some activity could not refresh; reopen to retry.', 'error');
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  async function sendComment(e?: FormEvent) {
    e?.preventDefault();
    if (comment.trim() && !commentUploading)
      await mutate(
        () => {
          const body = { body: comment.trim() };
          pendingComment.current = retryIntent(body, pendingComment.current);
          saveDraft(commentRetryKey, pendingComment.current);
          return api(`/items/${id}/comments`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { 'Idempotency-Key': pendingComment.current.key },
          }).catch((err) => {
            if (err instanceof ApiError && err.status === 404) {
              pendingComment.current = null;
              clearDraft(commentRetryKey);
            }
            throw err;
          });
        },
        () => {
          clearDraft(commentKey);
          clearDraft(commentRetryKey);
          pendingComment.current = null;
          setComment('');
          setCommentPreview(false);
        },
      );
  }
  async function deleteItem() {
    setSaving(true);
    setError('');
    try {
      await remove(`/items/${id}`);
      clearDraft(editKey);
      clearDraft(commentKey);
      clearDraft(commentRetryKey);
      void refresh().catch(() => toast('Deleted. The list could not refresh.', 'error'));
      toast('Work item deleted');
      onClose();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }
  const item = detail?.item;
  async function saveTags(removeTag?: string) {
    if (!item || saving) return;
    const draft = tagDraft;
    const next = [...item.labels];
    for (const tag of draft
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (!next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    const labels = next.filter((tag) => tag !== removeTag);
    const unchanged =
      labels.length === item.labels.length &&
      labels.every((tag, index) => tag === item.labels[index]);
    if (unchanged || (await update({ labels }))) {
      setTagDraft((current) => (current === draft ? '' : current));
    }
  }
  const source = item?.source;
  const providerName = source?.provider === 'github' ? 'GitHub' : 'Gitea';
  const SourceIcon = source?.provider === 'github' ? GitHubIcon : GitFork;
  const project = data.projects.find((p) => p.id === item?.projectId);
  const parent = data.items.find((i) => i.id === item?.parentId);
  const subtasks = data.items.filter((i) => i.parentId === id);
  const creator = data.users.find((u) => u.id === item?.creatorId);
  function beginEditing(field: 'title' | 'description' = 'title') {
    if (!item || saving) return;
    if (editing) {
      setEditField(field);
      return;
    }
    const recovered = readDraft(editKey, isEditDraft);
    const base = recovered?.base || item;
    const draft = recovered && hasDraftChanges(recovered, base) ? recovered : null;
    if (!draft) clearDraft(editKey);
    editBase.current = draft
      ? { title: base.title, description: base.description }
      : { title: item.title, description: item.description };
    setTitle(draft?.title ?? item.title);
    setDescription(draft?.description ?? item.description);
    setEditRevision(draft?.revision ?? item.revision ?? 0);
    setEditField(field);
    setEditing(true);
  }
  function persistEditDraft() {
    if (hasDraftChanges({ title, description }, editBase.current))
      saveDraft(editKey, { title, description, revision: editRevision, base: editBase.current });
    else clearDraft(editKey);
  }
  function stopEditing(preserve: boolean) {
    if (preserve) persistEditDraft();
    else {
      clearDraft(editKey);
      setConflict(null);
      setError('');
    }
    setEditing(false);
  }
  function finishEditing() {
    clearDraft(editKey);
    setConflict(null);
    setError('');
    setEditing(false);
  }
  async function saveTextEdit() {
    if (!title.trim() || descriptionUploading || saving) return;
    const changes = draftTextChanges({ title, description }, editBase.current);
    if (!Object.keys(changes).length || (await update(changes, editRevision))) finishEditing();
  }
  async function reapplyChanges() {
    if (!conflict || saving) return;
    const textConflict =
      editing && (conflict.title !== undefined || conflict.description !== undefined);
    const changes = textConflict
      ? draftTextChanges({ title, description }, editBase.current)
      : conflict;
    if (textConflict && (!title.trim() || descriptionUploading)) return;
    try {
      const latest = await reload();
      applyItems([latest.item]);
      if (textConflict && !Object.keys(changes).length) {
        finishEditing();
        return;
      }
      if (await update(changes, latest.item.revision ?? 0)) {
        if (textConflict) finishEditing();
      }
    } catch (err) {
      setError(message(err));
    }
  }
  async function loadLatest() {
    if (saving) return;
    try {
      const latest = await reload();
      applyItems([latest.item]);
      setEditRevision(latest.item.revision ?? 0);
      setLatestLoaded(true);
      // Keep the user's text visible for comparison; applying it remains explicit.
      setError(
        'Latest version loaded. Your draft is still available above; review it before saving.',
      );
    } catch (err) {
      setError(message(err));
    }
  }
  function act(action: ItemAction) {
    if (!item || saving) return false;
    if (action === 'title' || action === 'description') {
      if (source) return false;
      beginEditing(action);
      return;
    }
    return activateItemControl(actionRoot.current, action);
  }
  function copy(identifier: boolean) {
    if (!item) return false;
    const url = new URL(location.href);
    url.hash = `/item/${id}`;
    void navigator.clipboard
      .writeText(identifier ? item.identifier : url.href)
      .then(() => toast(identifier ? 'Identifier copied' : 'Link copied'))
      .catch(() => toast('Could not access clipboard', 'error'));
  }
  useShortcuts(
    'item',
    {
      ...Object.fromEntries(itemActions.map((action) => [action, () => act(action)])),
      assignMe: () => {
        if (!item || saving) return false;
        if (item.assigneeId !== data.user.id) void update({ assigneeId: data.user.id });
      },
      subtask: () => {
        if (!item) return false;
        createItem(item.projectId, 'todo', id);
      },
      copyLink: () => copy(false),
      copyId: () => copy(true),
    },
    { root: actionRoot, enabled: !!item },
  );
  useEffect(() => {
    if (editing)
      actionRoot.current
        ?.querySelector<HTMLElement>(
          editField === 'title' ? '.item-edit-title' : '.item-inline-editor textarea',
        )
        ?.focus();
  }, [editing, editField]);
  useEffect(() => {
    if (item && initialAction) {
      act(initialAction);
      onActionHandled?.();
    }
  }, [item?.id, initialAction]);

  const frameTitle = item
    ? `${project?.name || 'Personal inbox'}  /  ${item.identifier}`
    : 'Work item';
  const close = () => {
    if (editing) persistEditDraft();
    onClose();
  };
  const body = (
    <>
      {!item ? (
        <div className="item-loading">
          {error ? (
            <div role="alert">
              <p>{error}</p>
              <button
                className="button"
                onClick={() => {
                  setError('');
                  void reload().catch((err) => setError(message(err)));
                }}
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <span className="item-loading-dot" />
              Loading work item…
            </>
          )}
        </div>
      ) : (
        <div ref={actionRoot} className="item-detail">
          <main className="item-conversation">
            {parent && (
              <button className="item-parent" onClick={() => openItem(parent.id)}>
                <span>{parent.identifier}</span>
                {parent.title}
                <ChevronRight size={13} />
              </button>
            )}
            <div className="item-detail-actions">
              <span className="badge">{types.find((t) => t.id === item.type)?.name}</span>
              {item.visibility === 'private' && (
                <span className="privacy-hint">
                  <Lock size={12} /> Private
                </span>
              )}
              <div className="item-action-spacer" />
              <HierarchyMenu
                item={item}
                disabled={saving}
                onParent={() => setShowParent(true)}
                onClear={() => void update({ parentId: null })}
              />
              <button
                className="icon-button"
                aria-label="Copy work item link"
                title="Copy work item link"
                onClick={() => {
                  const url = new URL(window.location.href);
                  url.hash = `/item/${id}`;
                  void navigator.clipboard
                    .writeText(url.href)
                    .then(() => toast('Link copied'))
                    .catch(() => toast('Could not copy link', 'error'));
                }}
              >
                <Link2 size={16} />
              </button>
              {!source && (
                <button
                  className="icon-button"
                  aria-label="Edit title and description"
                  title="Edit title and description (T / D)"
                  onClick={() => {
                    beginEditing();
                  }}
                >
                  <Pencil size={15} />
                </button>
              )}
            </div>
            {source && (
              <section className="item-source-panel" aria-label="Linked issue source">
                <div className="item-source-identity">
                  <SourceIcon size={17} aria-hidden="true" />
                  <div>
                    <span className="item-source-caption">Linked to {providerName}</span>
                    <a href={source.url} target="_blank" rel="noopener noreferrer">
                      {source.repository} #{source.number}
                    </a>
                  </div>
                  <a
                    className="button small ghost"
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in {providerName} <ArrowUpRight size={13} />
                  </a>
                </div>
                <div className="item-source-sync">
                  {!source.connected && (
                    <span className="item-source-disconnected">Disconnected · </span>
                  )}
                  {source.lastSyncedAt ? (
                    <>
                      Last synced{' '}
                      <time dateTime={source.lastSyncedAt}>
                        {new Date(source.lastSyncedAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </>
                  ) : (
                    'Not synced yet'
                  )}
                  {!source.connected && <span> · Showing the last imported content</span>}
                </div>
              </section>
            )}
            {editing && !source ? (
              <form
                className="item-inline-editor"
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.altKey &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!event.repeat && !saving && !descriptionUploading)
                      event.currentTarget.requestSubmit();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    stopEditing(true);
                    actionRoot.current
                      ?.closest<HTMLElement>('[role="dialog"], .item-page')
                      ?.focus();
                  }
                }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  await saveTextEdit();
                }}
              >
                <fieldset
                  disabled={saving}
                  style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                >
                  <input
                    className="input item-edit-title"
                    aria-label="Title"
                    value={title}
                    autoFocus
                    required
                    maxLength={240}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <ImageMarkdownTextarea
                    excludeItemId={id}
                    projectId={item.projectId}
                    className="input"
                    aria-label="Description"
                    value={description}
                    setValue={setDescription}
                    onBusyChange={setDescriptionUploading}
                    rows={8}
                  />
                  <div className="item-edit-buttons">
                    <span className="muted">Markdown supported</span>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => stopEditing(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="button primary"
                      type="submit"
                      disabled={saving || descriptionUploading || !title.trim()}
                      title="Save changes (Cmd+Enter / Ctrl+Enter)"
                      aria-keyshortcuts="Meta+Enter Control+Enter"
                    >
                      Save changes
                    </button>
                  </div>
                </fieldset>
              </form>
            ) : (
              <>
                <h1 className="item-detail-title">{item.title}</h1>
                {item.description ? (
                  <MarkdownBody
                    onChange={source ? undefined : (description) => void update({ description })}
                    saving={saving}
                  >
                    {item.description}
                  </MarkdownBody>
                ) : source ? (
                  <p className="item-section-empty">No description in {providerName}.</p>
                ) : (
                  <button
                    className="item-empty-description"
                    onClick={() => {
                      beginEditing('description');
                    }}
                  >
                    Add a description…
                  </button>
                )}
              </>
            )}
            {source && (
              <div className="item-source-ownership">
                <span>Title and description are managed in {providerName}.</span>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  Edit in {providerName} <ArrowUpRight size={12} />
                </a>
              </div>
            )}
            {source?.state === 'closed' && item.status !== 'done' && item.status !== 'canceled' && (
              <div className="item-source-notice" role="note">
                <CircleAlert size={15} aria-hidden="true" />
                <span>
                  Closed in {providerName}. Review the remaining local work before completing this
                  item.
                </span>
              </div>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error}
                {conflict && !editing && (
                  <p>
                    Pending changes:{' '}
                    {Object.entries(conflict)
                      .map(
                        ([field, value]) =>
                          `${field}: ${Array.isArray(value) ? value.join(', ') : (value ?? 'cleared')}`,
                      )
                      .join(' · ')}
                  </p>
                )}
                {conflict && latestLoaded && (
                  <section aria-label="Latest saved version">
                    <strong>Latest saved version</strong>
                    <p>{item.title}</p>
                    <MarkdownBody>{item.description || 'No description'}</MarkdownBody>
                  </section>
                )}
                {conflict && (
                  <div className="item-edit-buttons">
                    <button
                      className="button small"
                      disabled={saving}
                      onClick={() => void loadLatest()}
                    >
                      Reload latest
                    </button>
                    <button
                      className="button small"
                      disabled={saving}
                      onClick={() => void reapplyChanges()}
                    >
                      Reapply my changes
                    </button>
                    <button
                      className="button small ghost"
                      disabled={saving}
                      onClick={async () => {
                        try {
                          const latest = await reload();
                          applyItems([latest.item]);
                          finishEditing();
                          setConflict(null);
                          setError('');
                        } catch (err) {
                          setError(message(err));
                        }
                      }}
                    >
                      Discard my changes
                    </button>
                  </div>
                )}
                <button
                  className="icon-button"
                  aria-label="Dismiss error"
                  onClick={() => setError('')}
                >
                  <X size={13} />
                </button>
              </div>
            )}
            <section className="item-section">
              <div className="item-section-heading">
                <h3>
                  Subtasks{' '}
                  <span>
                    {subtasks.length
                      ? `${subtasks.filter((i) => i.status === 'done').length}/${subtasks.length}`
                      : ''}
                  </span>
                </h3>
                <button
                  className="button ghost small"
                  onClick={() => createItem(item.projectId, 'todo', id)}
                >
                  <Plus size={13} />
                  Add subtask
                </button>
              </div>
              {subtasks.length > 0 ? (
                <div className="item-subtasks">
                  {subtasks.map((child) => (
                    <button
                      key={child.id}
                      className="item-subtask"
                      onClick={() => openItem(child.id)}
                    >
                      <StatusIcon status={child.status} />
                      <span className="muted">{child.identifier}</span>
                      <span className={child.status === 'done' ? 'completed' : ''}>
                        {child.title}
                      </span>
                      <ChevronRight size={13} />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="item-section-empty">
                  Break this into smaller pieces when you need to.
                </p>
              )}
            </section>
            {(detail!.relations.length > 0 ||
              !!detail!.projectRelations?.length ||
              showRelation) && (
              <section className="item-section">
                <div className="item-section-heading">
                  <h3>Relationships</h3>
                </div>
                {detail!.projectRelations?.map((relation) => {
                  const project = data.projects.find((p) => p.id === relation.projectId);
                  return (
                    <div className="item-relation" key={relation.id}>
                      <span className="muted">Related to project</span>
                      <a href={`#/project/${relation.projectId}`}>
                        {project?.name || 'Unavailable project'}
                      </a>
                      <button
                        className="icon-button"
                        aria-label="Remove project relationship"
                        disabled={saving}
                        onClick={() =>
                          void mutate(() => remove(`/items/${id}/project-relations/${relation.id}`))
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
                {detail!.relations.map((relation) => {
                  const outward = relation.itemId === id;
                  const target = data.items.find(
                    (i) => i.id === (outward ? relation.targetId : relation.itemId),
                  );
                  return (
                    <div className="item-relation" key={relation.id}>
                      <span className="muted">
                        {relation.kind === 'related'
                          ? 'Related to'
                          : outward
                            ? 'Blocks'
                            : 'Blocked by'}
                      </span>
                      {target ? (
                        <button onClick={() => openItem(target.id)}>
                          <StatusIcon status={target.status} />
                          <span className="muted">{target.identifier}</span>
                          {target.title}
                        </button>
                      ) : (
                        <span>Unavailable item</span>
                      )}
                      <button
                        className="icon-button"
                        aria-label="Remove relationship"
                        disabled={saving}
                        onClick={() =>
                          void mutate(() => remove(`/items/${id}/relations/${relation.id}`))
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
                {showRelation && (
                  <form
                    className="item-link-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (relationTarget)
                        void mutate(
                          () =>
                            post(`/items/${id}/relations`, {
                              targetId: relationTarget,
                              kind: relationKind,
                            }),
                          () => {
                            setShowRelation(false);
                            setRelationTarget('');
                          },
                        );
                    }}
                  >
                    <Select
                      className="select"
                      aria-label="Relationship type"
                      value={relationKind}
                      onChange={(e) => setRelationKind(e.target.value)}
                    >
                      <option value="blocks">Blocks</option>
                      <option value="blocked_by">Blocked by</option>
                      <option value="related">Related to</option>
                    </Select>
                    <Select
                      className="select"
                      aria-label="Related work item"
                      value={relationTarget}
                      required
                      onChange={(e) => setRelationTarget(e.target.value)}
                    >
                      <option value="">Select a work item…</option>
                      {workItemOptions(data.items, data.projects, {
                        projectId: item.projectId,
                        excludeItemId: id,
                      }).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label} · {option.detail}
                        </option>
                      ))}
                    </Select>
                    <div className="item-edit-buttons">
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => setShowRelation(false)}
                      >
                        Cancel
                      </button>
                      <button className="button small" disabled={saving || !relationTarget}>
                        Add relationship
                      </button>
                    </div>
                  </form>
                )}
              </section>
            )}
            {(detail!.links.length > 0 || showLink || (item.externalUrl && !source)) && (
              <section className="item-section">
                <div className="item-section-heading">
                  <h3>Resources</h3>
                </div>
                {item.externalUrl && !source && (
                  <a
                    className="item-resource"
                    href={item.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ArrowUpRight size={15} />
                    <span>Original issue</span>
                  </a>
                )}
                {detail!.links.map((link) => (
                  <div className="item-resource-row" key={link.id}>
                    <a
                      className="item-resource"
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Link2 size={15} />
                      <span>{link.title}</span>
                      <span className="muted">
                        {link.kind === 'confluence'
                          ? 'Confluence'
                          : link.kind === 'repository'
                            ? 'Repository'
                            : ''}
                      </span>
                      <ArrowUpRight size={13} />
                    </a>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${link.title} link`}
                      disabled={saving}
                      onClick={() => void mutate(() => remove(`/links/${link.id}`))}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {showLink && (
                  <form
                    className="item-link-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (linkUrl.trim() && linkTitle.trim())
                        void mutate(
                          () =>
                            post('/links', {
                              projectId: null,
                              itemId: id,
                              title: linkTitle.trim(),
                              url: linkUrl.trim(),
                              kind: linkKind,
                            }),
                          () => {
                            setShowLink(false);
                            setLinkTitle('');
                            setLinkUrl('');
                          },
                        );
                    }}
                  >
                    <input
                      className="input"
                      aria-label="Resource title"
                      placeholder="Resource title"
                      required
                      value={linkTitle}
                      onChange={(e) => setLinkTitle(e.target.value)}
                    />
                    <input
                      className="input"
                      aria-label="Resource URL"
                      type="url"
                      placeholder="https://…"
                      required
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                    />
                    <div className="item-edit-buttons">
                      <Select
                        className="select"
                        aria-label="Resource type"
                        value={linkKind}
                        onChange={(e) => setLinkKind(e.target.value)}
                      >
                        <option value="link">Link</option>
                        <option value="confluence">Confluence</option>
                        <option value="repository">Repository</option>
                      </Select>
                      <button
                        type="button"
                        className="button ghost small"
                        onClick={() => setShowLink(false)}
                      >
                        Cancel
                      </button>
                      <button className="button small" disabled={saving}>
                        Add resource
                      </button>
                    </div>
                  </form>
                )}
              </section>
            )}
            <section className="item-activity">
              <div className="item-section-heading">
                <h3>Activity</h3>
                <span className="muted">
                  <MessageSquare size={16} aria-hidden="true" />
                  {detail!.activity.filter((a) => a.kind === 'comment').length}{' '}
                  {detail!.activity.filter((a) => a.kind === 'comment').length === 1
                    ? 'comment'
                    : 'comments'}
                </span>
              </div>
              <ol className="item-timeline" aria-label="Activity timeline">
                <li className="item-event">
                  <span className="item-event-icon">
                    <CircleDot size={16} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{item.importedFrom?.authorName || creator?.name || 'A member'}</strong>{' '}
                    created this work item{item.importedFrom && ' (imported)'}
                  </span>
                  <time title={new Date(item.createdAt).toLocaleString()} dateTime={item.createdAt}>
                    {shortDate(item.createdAt)}
                  </time>
                </li>
                {detail!.activity.map((entry) => {
                  const user = data.users.find((u) => u.id === entry.userId);
                  const commentProvider = entry.source?.provider === 'github' ? 'GitHub' : 'Gitea';
                  const CommentSourceIcon =
                    entry.source?.provider === 'github' ? GitHubIcon : GitFork;
                  return entry.kind === 'event' ? (
                    <li key={entry.id} className="item-event">
                      <span className="item-event-icon">
                        <ActivityIcon body={entry.body} />
                      </span>
                      <span>
                        <strong>
                          {entry.importedFrom?.authorName || user?.name || 'A member'}
                        </strong>{' '}
                        {activityText(entry.body, data)}
                        {entry.importedFrom && ' (imported)'}
                      </span>
                      <time
                        title={new Date(entry.createdAt).toLocaleString()}
                        dateTime={entry.createdAt}
                      >
                        {shortDate(entry.createdAt)}
                      </time>
                    </li>
                  ) : (
                    <li
                      key={entry.id}
                      id={`activity-${entry.id}`}
                      className={`item-comment ${entry.id === activityId ? 'notification-target' : ''}`}
                    >
                      {entry.importedFrom ? (
                        <span className="item-source-avatar">
                          <Download size={15} aria-hidden="true" />
                        </span>
                      ) : entry.source ? (
                        <span className="item-source-avatar">
                          <CommentSourceIcon size={15} aria-hidden="true" />
                        </span>
                      ) : (
                        <span className="item-timeline-avatar">
                          <Avatar user={user} size={36} />
                        </span>
                      )}
                      <article className="item-comment-content">
                        <header>
                          <strong>
                            {entry.importedFrom?.authorName ||
                              entry.source?.author ||
                              user?.name ||
                              'A member'}
                          </strong>
                          {entry.importedFrom ? (
                            <span className="item-comment-origin">Imported</span>
                          ) : entry.source ? (
                            <span className="item-comment-origin">{commentProvider}</span>
                          ) : source ? (
                            <span className="item-comment-origin">Internal note</span>
                          ) : null}
                          <time
                            title={new Date(entry.createdAt).toLocaleString()}
                            dateTime={entry.createdAt}
                          >
                            {new Date(entry.createdAt).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </header>
                        <MarkdownBody>{entry.body}</MarkdownBody>
                      </article>
                    </li>
                  );
                })}
              </ol>
              <h4 className="item-comment-heading">
                {source ? 'Add an internal note' : 'Add a comment'}
              </h4>
              <form className="item-comment-form" onSubmit={sendComment}>
                <Avatar user={data.user} size={36} />
                <div>
                  <fieldset
                    disabled={saving}
                    style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
                  >
                    <div
                      className="item-comment-toolbar"
                      role="group"
                      aria-label="Comment editor mode"
                    >
                      <button
                        type="button"
                        aria-pressed={!commentPreview}
                        onClick={() => setCommentPreview(false)}
                      >
                        Write
                      </button>
                      <button
                        type="button"
                        aria-pressed={commentPreview}
                        onClick={() => setCommentPreview(true)}
                      >
                        Preview
                      </button>
                    </div>
                    {commentPreview ? (
                      <div className="item-comment-preview" aria-label="Comment preview">
                        {comment.trim() ? (
                          <MarkdownBody>{comment}</MarkdownBody>
                        ) : (
                          <p className="muted">Nothing to preview yet.</p>
                        )}
                      </div>
                    ) : (
                      <ImageMarkdownTextarea
                        excludeItemId={id}
                        projectId={item.projectId}
                        className="input"
                        aria-label={source ? 'Internal note' : 'Comment'}
                        placeholder={
                          source ? 'Add an internal note…' : 'Leave a comment or an update…'
                        }
                        rows={3}
                        data-shortcut="m"
                        value={comment}
                        setValue={setComment}
                        onBusyChange={setCommentUploading}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                            e.preventDefault();
                            void sendComment();
                          }
                        }}
                      />
                    )}
                    {source && (
                      <p className="item-comment-scope">
                        Internal notes stay in Trestl and are never posted to {providerName}.
                      </p>
                    )}
                    <footer>
                      <span className="muted">Markdown supported · ⌘ / Ctrl ↵</span>
                      <button
                        type="submit"
                        className="button primary small"
                        disabled={saving || commentUploading || !comment.trim()}
                      >
                        <Send size={12} />
                        {saving ? 'Saving…' : source ? 'Add internal note' : 'Comment'}
                      </button>
                    </footer>
                  </fieldset>
                </div>
              </form>
            </section>
          </main>
          <aside className={`item-properties ${mobilePropertiesExpanded ? 'expanded' : ''}`}>
            {source && (
              <div className="item-repository-state">
                <h3>Repository state</h3>
                <span className={`item-source-state ${source.state}`}>
                  <SourceIcon size={13} aria-hidden="true" />{' '}
                  {source.state === 'closed' ? 'Closed' : 'Open'} in {providerName}
                </span>
                <p>Updated from the repository on sync.</p>
              </div>
            )}
            <h3>
              {source ? 'Local planning' : 'Properties'}{' '}
              {saving && <span className="muted">Saving…</span>}
            </h3>
            {source && <p className="item-property-note">These attributes stay in Trestl.</p>}
            <fieldset id={`item-properties-${id}`} disabled={saving}>
              <Property name={source ? 'Planning status' : 'Status'}>
                <Select
                  shortcut="s"
                  value={item.status}
                  onChange={(e) => void update({ status: e.target.value as Status })}
                >
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Property>
              <Property name="Priority">
                <Select
                  shortcut="p"
                  value={item.priority}
                  onChange={(e) => void update({ priority: e.target.value as Priority })}
                >
                  {priorities.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Property>
              <Property name="Assignee">
                <Select
                  shortcut="a"
                  value={item.assigneeId || ''}
                  onChange={(e) => void update({ assigneeId: e.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  {assigneeOptions(data.users, item.assigneeId).map((u) => (
                    <option key={u.id} value={u.id} disabled={u.disabled}>
                      {u.label}
                    </option>
                  ))}
                </Select>
              </Property>
              <Property name="Type">
                <Select
                  value={item.type}
                  onChange={(e) => void update({ type: e.target.value as ItemType })}
                >
                  {types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Property>
              <Property name="Parent">
                <ParentSelect
                  items={data.items}
                  movingIds={[id]}
                  value={item.parentId}
                  onChange={(parentId) => void update({ parentId })}
                  disabled={saving}
                />
              </Property>
              <Property name="Project">
                <Select
                  shortcut="shift+p"
                  value={item.projectId || ''}
                  onChange={(e) => void update({ projectId: e.target.value || null })}
                >
                  <option value="">Personal inbox</option>
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Property>
              <Property name="Milestone">
                <Select
                  aria-label="Milestone"
                  value={item.milestoneId || ''}
                  disabled={!item.projectId}
                  onChange={(e) => void update({ milestoneId: e.target.value || null })}
                >
                  <option value="">No milestone</option>
                  {data.milestones
                    .filter((m) => m.projectId === item.projectId)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title}
                      </option>
                    ))}
                </Select>
              </Property>
              <div className="item-property-divider" />
              <Property name="Start date">
                <DatePropertyInput
                  value={item.startDate || null}
                  onSave={(value) => void update({ startDate: value })}
                />
              </Property>
              <Property name="Due date">
                <DatePropertyInput
                  shortcut="shift+d"
                  value={item.dueDate}
                  onSave={(value) => void update({ dueDate: value })}
                />
              </Property>
              <Property name="Follow up">
                <DatePropertyInput
                  value={item.followUpDate}
                  onSave={(value) => void update({ followUpDate: value })}
                />
              </Property>
              <Property name="Repeat">
                <Select
                  value={item.recurrence || ''}
                  onChange={(e) =>
                    void update({ recurrence: (e.target.value || null) as WorkItem['recurrence'] })
                  }
                >
                  <option value="">Does not repeat</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </Select>
              </Property>
              {item.recurrence && (
                <p className="item-property-note">
                  Completing this item schedules the next occurrence.
                </p>
              )}
              <div className="item-property-divider" />
              <Property name="Visibility">
                <Select
                  value={item.visibility}
                  onChange={(e) => void update({ visibility: e.target.value as Visibility })}
                >
                  <option value="workspace">Workspace</option>
                  <option value="private">Private</option>
                </Select>
              </Property>
              <div
                className="item-tags"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) void saveTags();
                }}
              >
                <label className="item-tag-editor">
                  <span>Tags</span>
                  <input
                    data-shortcut="l"
                    placeholder="Add tags, separated by commas"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </label>
                <div className="item-tag-list">
                  {item.labels.map((tag) => (
                    <span className="item-tag" key={tag}>
                      <span className="item-tag-name">{tag}</span>
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag}`}
                        title={`Remove tag ${tag}`}
                        onClick={() => void saveTags(tag)}
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </fieldset>
            <button
              className="mobile-property-toggle text-button"
              aria-expanded={mobilePropertiesExpanded}
              aria-controls={`item-properties-${id}`}
              onClick={() => setMobilePropertiesExpanded((value) => !value)}
            >
              {mobilePropertiesExpanded ? 'Fewer properties' : 'More properties'}
            </button>
            <div className="item-property-divider" />
            <button className="item-rail-action" onClick={() => setShowRelation(true)}>
              <Plus size={14} />
              Add relationship
            </button>
            <button className="item-rail-action" onClick={() => setShowLink(true)}>
              <Link2 size={14} />
              Add resource
            </button>
            <p className="item-created-note">
              Created {shortDate(item.createdAt)}
              <br />
              Updated {shortDate(item.updatedAt)}
              {item.importedFrom?.identifier && (
                <>
                  <br />
                  Imported from {item.importedFrom.identifier}
                </>
              )}
            </p>
            {confirmDelete ? (
              <div className="item-delete-confirm" role="alert">
                <strong>Delete {item.identifier}?</strong>
                <p>This removes the item and its discussion. This cannot be undone.</p>
                <div>
                  <button
                    className="button small ghost"
                    disabled={saving}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="button small danger"
                    disabled={saving}
                    onClick={() => void deleteItem()}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="item-rail-action item-delete-action"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={13} />
                Delete work item
              </button>
            )}
          </aside>
        </div>
      )}
      {showParent && item && (
        <ParentPicker
          items={[item]}
          onClose={() => setShowParent(false)}
          onSave={(parentId) => update({ parentId })}
        />
      )}
    </>
  );
  return presentation === 'page' ? (
    <ItemPage title={frameTitle} onClose={close} className="item-detail-page">
      {body}
    </ItemPage>
  ) : (
    <Modal
      title={frameTitle}
      onClose={close}
      wide
      className={`item-detail-modal ${uiPreferences.itemLayout === 'centered' ? 'item-detail-centered' : ''}`}
      initialFocus="panel"
    >
      {body}
    </Modal>
  );
}
