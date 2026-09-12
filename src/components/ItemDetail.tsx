import { useShortcuts, activateItemControl } from '../lib/keyboard';
import { itemActions, type ItemAction } from '../lib/shortcuts';
import { Select } from './Select';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Download,
  CircleAlert,
  CircleDot,
  Tag,
  UserRound,
  CalendarDays,
  ArrowRightLeft,
  GitFork,
  Github,
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
import { api, patch, post, remove } from '../lib/api';
import { useApp } from '../lib/context';
import { priorities, statuses, types, shortDate } from '../lib/model';
import { Avatar, Modal, StatusIcon } from './ui';
import './item.css';
function Property({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="item-property">
      <span>{name}</span>
      {children}
    </label>
  );
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
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
  onClose,
  initialAction,
  onActionHandled,
}: {
  id: string;
  onClose: () => void;
  initialAction?: ItemAction;
  onActionHandled?: () => void;
}) {
  const { data, refresh, toast, openItem, createItem, uiPreferences } = useApp();
  const actionRoot = useRef<HTMLDivElement>(null);
  const [editField, setEditField] = useState<'title' | 'description'>('title');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [comment, setComment] = useState('');
  const [commentPreview, setCommentPreview] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [linkTitle, setLinkTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [linkKind, setLinkKind] = useState('link');
  const [showRelation, setShowRelation] = useState(false);
  const [relationTarget, setRelationTarget] = useState('');
  const [relationKind, setRelationKind] = useState('blocks');
  const reload = useCallback(async () => {
    const next = await api<Detail>(`/items/${id}`);
    setDetail(next);
    return next;
  }, [id]);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setError('');
    setEditing(false);
    setComment('');
    setCommentPreview(false);
    setTagDraft('');
    setConfirmDelete(false);
    setShowRelation(false);
    setShowLink(false);
    api<Detail>(`/items/${id}`)
      .then((next) => {
        if (alive) {
          setDetail(next);
        }
      })
      .catch((err) => {
        if (alive) setError(message(err));
      });
    return () => {
      alive = false;
    };
  }, [id]);
  async function update(changes: Partial<WorkItem>) {
    if (saving) return false;
    setSaving(true);
    setError('');
    try {
      const item = await patch<WorkItem>(`/items/${id}`, changes);
      setDetail((current) => current && { ...current, item });
      await Promise.all([reload(), refresh()]);
      return true;
    } catch (err) {
      setError(message(err));
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
      await Promise.all([reload(), refresh()]);
      after?.();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  async function sendComment(e?: FormEvent) {
    e?.preventDefault();
    if (comment.trim())
      await mutate(
        () => post(`/items/${id}/comments`, { body: comment.trim() }),
        () => {
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
      await refresh();
      toast('Work item deleted');
      onClose();
    } catch (err) {
      setError(message(err));
      setSaving(false);
    }
  }
  const item = detail?.item;
  async function addTags() {
    if (!item || saving) return;
    const draft = tagDraft;
    const next = [...item.labels];
    for (const tag of draft
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (!next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    if (next.length === item.labels.length || (await update({ labels: next }))) {
      setTagDraft((current) => (current === draft ? '' : current));
    }
  }
  const source = item?.source;
  const providerName = source?.provider === 'github' ? 'GitHub' : 'Gitea';
  const SourceIcon = source?.provider === 'github' ? Github : GitFork;
  const project = data.projects.find((p) => p.id === item?.projectId);
  const parent = data.items.find((i) => i.id === item?.parentId);
  const subtasks = data.items.filter((i) => i.parentId === id);
  const creator = data.users.find((u) => u.id === item?.creatorId);
  function act(action: ItemAction) {
    if (!item || saving) return false;
    if (action === 'title' || action === 'description') {
      if (source) return false;
      setTitle(item.title);
      setDescription(item.description);
      setEditField(action);
      setEditing(true);
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

  return (
    <Modal
      title={item ? `${project?.name || 'Personal inbox'}  /  ${item.identifier}` : 'Work item'}
      onClose={onClose}
      wide
      className={`item-detail-modal ${uiPreferences.itemLayout === 'centered' ? 'item-detail-centered' : ''}`}
      initialFocus="panel"
    >
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
                    setTitle(item.title);
                    setDescription(item.description);
                    setEditing(true);
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
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditing(false);
                    actionRoot.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
                  }
                }}
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (title.trim() && (await update({ title: title.trim(), description })))
                    setEditing(false);
                }}
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
                <textarea
                  className="input"
                  aria-label="Description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={8}
                />
                <div className="item-edit-buttons">
                  <span className="muted">Markdown supported</span>
                  <button type="button" className="button ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button
                    className="button primary"
                    type="submit"
                    disabled={saving || !title.trim()}
                  >
                    Save changes
                  </button>
                </div>
              </form>
            ) : (
              <>
                <h1 className="item-detail-title">{item.title}</h1>
                {item.description ? (
                  <MarkdownBody>{item.description}</MarkdownBody>
                ) : source ? (
                  <p className="item-section-empty">No description in {providerName}.</p>
                ) : (
                  <button
                    className="item-empty-description"
                    onClick={() => {
                      setTitle(item.title);
                      setDescription('');
                      setEditing(true);
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
            {(detail!.relations.length > 0 || showRelation) && (
              <section className="item-section">
                <div className="item-section-heading">
                  <h3>Relationships</h3>
                </div>
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
                      {data.items
                        .filter((i) => i.id !== id)
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.identifier} · {i.title}
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
                  const CommentSourceIcon = entry.source?.provider === 'github' ? Github : GitFork;
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
                    <li key={entry.id} className="item-comment">
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
                    <textarea
                      className="input"
                      aria-label={source ? 'Internal note' : 'Comment'}
                      placeholder={
                        source ? 'Add an internal note…' : 'Leave a comment or an update…'
                      }
                      rows={3}
                      data-shortcut="m"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
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
                      disabled={saving || !comment.trim()}
                    >
                      <Send size={12} />
                      {saving ? 'Saving…' : source ? 'Add internal note' : 'Comment'}
                    </button>
                  </footer>
                </div>
              </form>
            </section>
          </main>
          <aside className="item-properties">
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
            <fieldset disabled={saving}>
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
                  {data.users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
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
              <label className="item-tag-editor">
                <span>Tags</span>
                <input
                  data-shortcut="l"
                  placeholder="Add tags, separated by commas"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onBlur={() => void addTags()}
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
                  <span className="badge" key={tag}>
                    {tag}
                    <button
                      type="button"
                      aria-label={`Remove tag ${tag}`}
                      onClick={() =>
                        void update({ labels: item.labels.filter((value) => value !== tag) })
                      }
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </fieldset>
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
    </Modal>
  );
}
