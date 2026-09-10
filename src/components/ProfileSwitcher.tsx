import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BriefcaseBusiness,
  Check,
  ChevronDown,
  House,
  Layers,
  LoaderCircle,
  Plus,
} from 'lucide-react';
import type { User } from '../../shared/types';
import { api, post } from '../lib/api';
import { useApp } from '../lib/context';
import { Avatar, Modal } from './ui';
import { formatShortcut, shortcuts } from '../lib/shortcuts';
import { labelKey, maxLabelLength, openAccount, readLabel, saveLabel } from '../lib/profiles';

export default function ProfileSwitcher({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const { data } = useApp();
  const [adding, setAdding] = useState(false);
  const [profiles, setProfiles] = useState<User[]>([data.user]);
  const [label, setLabel] = useState(() => readLabel(data.user.id));
  const [draftLabel, setDraftLabel] = useState(label);
  const [loading, setLoading] = useState(false);
  const focusAccount = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'trestl.account-change') openAccountFromTab();
      if (event.key === labelKey(data.user.id)) setLabel(readLabel(data.user.id));
    };
    function openAccountFromTab() {
      history.replaceState(null, '', `${location.pathname}#/home`);
      location.reload();
    }
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [data.user.id]);
  useEffect(() => {
    if (!open) return;
    setDraftLabel(readLabel(data.user.id));
    focusAccount.current = false;
    let active = true;
    setLoading(true);
    setError('');
    void api<{ data: User[] }>('/auth/profiles')
      .then((result) => {
        if (active) setProfiles(result.data);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) {
          focusAccount.current = true;
          setLoading(false);
        }
      });
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      active = false;
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, setOpen, data.user.id]);
  useEffect(() => {
    if (open && !loading && focusAccount.current) {
      const frame = requestAnimationFrame(() => {
        const account =
          root.current?.querySelector<HTMLButtonElement>('.profile-option[aria-current="true"]') ||
          root.current?.querySelector<HTMLButtonElement>('.profile-option');
        if (account) {
          account.focus();
          focusAccount.current = false;
        }
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [open, loading]);
  const WorkspaceIcon =
    label === 'Work' ? BriefcaseBusiness : label === 'Personal' ? House : Layers;
  async function switchAccount(user: User) {
    if (user.id === data.user.id) {
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/auth/switch', { userId: user.id });
      openAccount();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="profile-switcher" ref={root}>
      <button
        ref={trigger}
        className="workspace-trigger"
        aria-label={`Workspace menu, ${label} workspace`}
        title={`Switch account / workspace (${formatShortcut(shortcuts.switchWorkspace.keys[0])})`}
        aria-expanded={open}
        aria-controls="workspace-profiles"
        onClick={() => setOpen(!open)}
      >
        <WorkspaceIcon size={15} />
        <span className="workspace-trigger-text">{label} workspace</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="profile-popover" id="workspace-profiles" aria-label="Account profiles">
          <div className="profile-menu-heading">
            Switch account <kbd>{formatShortcut(shortcuts.switchWorkspace.keys[0])}</kbd>
          </div>
          {loading ? (
            <p className="profile-hint">Loading accounts…</p>
          ) : (
            profiles.map((user) => {
              const active = user.id === data.user.id;
              const kind = active ? label : readLabel(user.id);
              const Icon =
                kind === 'Work' ? BriefcaseBusiness : kind === 'Personal' ? House : Layers;
              return (
                <button
                  key={user.id}
                  className={`profile-option ${active ? 'selected' : ''}`}
                  disabled={busy}
                  aria-current={active ? 'true' : undefined}
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const options = Array.from(
                      root.current?.querySelectorAll<HTMLButtonElement>(
                        '.profile-option:not(:disabled)',
                      ) || [],
                    );
                    const index = options.indexOf(event.currentTarget);
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? options.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                            options.length;
                    options[next]?.focus();
                  }}
                  onClick={() => void switchAccount(user)}
                >
                  <Avatar user={user} size={32} />
                  <span className="profile-option-text">
                    <strong>
                      <span title={kind}>{kind}</span> <Icon size={12} />
                    </strong>
                    <span>{user.name}</span>
                    <small>{user.email}</small>
                  </span>
                  {active && <Check size={16} className="profile-check" />}
                </button>
              );
            })
          )}
          <form
            className="profile-label-field"
            onSubmit={(event) => {
              event.preventDefault();
              const next = draftLabel.trim();
              if (!next || busy) return;
              saveLabel(data.user.id, next);
              setLabel(next);
              setDraftLabel(next);
            }}
          >
            <label htmlFor="workspace-label">Workspace label</label>
            <div className="profile-label-editor">
              <input
                id="workspace-label"
                className="input"
                value={draftLabel}
                required
                maxLength={maxLabelLength}
                disabled={busy}
                placeholder="e.g. Studio, Personal, Client name"
                onChange={(event) => setDraftLabel(event.target.value)}
              />
              <button
                className="button"
                disabled={busy || !draftLabel.trim() || draftLabel.trim() === label}
              >
                Save
              </button>
            </div>
            <small>Saved for this account in this browser.</small>
          </form>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button
            className="profile-add"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
          >
            <Plus size={16} /> Add account
          </button>
          {busy && (
            <p role="status" className="profile-hint">
              Switching account…
            </p>
          )}
        </div>
      )}
      {adding && (
        <AddAccount
          defaultLabel={label === 'Work' ? 'Personal' : 'Work'}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}
function AddAccount({ defaultLabel, onClose }: { defaultLabel: string; onClose: () => void }) {
  const [create, setCreate] = useState(false);
  const [label, setLabel] = useState(defaultLabel);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!label.trim()) {
      setError('Enter a workspace label.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const user = create
        ? await post<User>('/auth/profiles', { name, email: email.trim(), password })
        : await post<User>('/auth/login', { email: email.trim(), password });
      saveLabel(user.id, label);
      openAccount();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={create ? 'Create an account' : 'Add an account'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="simple-form" onSubmit={submit}>
        <p>
          {create
            ? 'Create a separate workspace for work or personal projects. You’ll be its admin, starting with no projects or other members.'
            : 'Sign in to an existing account and its workspace. To start with a separate, empty workspace, choose Create one below.'}
        </p>
        <label className="field">
          Workspace label
          <input
            className="input"
            value={label}
            required
            maxLength={maxLabelLength}
            disabled={busy}
            placeholder="e.g. Studio, Personal, Client name"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        {create && (
          <label className="field">
            Your name
            <input
              className="input"
              required
              maxLength={240}
              value={name}
              disabled={busy}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label className="field">
          Email address
          <input
            className="input"
            type="email"
            required
            maxLength={254}
            value={email}
            disabled={busy}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
            placeholder={label === 'Work' ? 'you@company.com' : 'you@example.com'}
          />
        </label>
        <label className="field">
          Password
          <input
            className="input"
            type="password"
            required
            minLength={create ? 10 : 1}
            maxLength={200}
            value={password}
            disabled={busy}
            autoComplete={create ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="profile-mode"
          disabled={busy}
          onClick={() => {
            setCreate(!create);
            setError('');
          }}
        >
          {create ? 'Already have an account? Sign in' : 'Need another account? Create one'}
        </button>
        <div className="form-actions">
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle className="spin" size={15} />}
            {create ? 'Create and switch' : 'Sign in and switch'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
