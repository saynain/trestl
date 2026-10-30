import { useEffect, useId, useState, type FormEvent } from 'react';
import { Check, GitFork, Loader2, Plus, RefreshCw, Settings2, ShieldAlert } from 'lucide-react';
import type { Project } from '../../shared/types';
import { api, patch, post, remove } from '../lib/api';
import { useApp } from '../lib/context';
import { navigate } from '../lib/model';
import { Select } from './Select';
import { GitHubIcon, Modal } from './ui';
import type { GitConnection } from './GitSettings';
import './repositories.css';

type Mode = 'reference' | 'inbound';
interface Access {
  checkedAt: string;
  private: boolean | null;
  issues: boolean;
  write: boolean;
  reason: string | null;
}
export interface Repository {
  id: string;
  projectId: string;
  provider: 'github' | 'gitea';
  repository: string;
  webUrl: string;
  mode: Mode;
  isDefault: boolean;
  connection: { id: string; name: string; shared: boolean } | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  syncing: boolean;
  access: Access | null;
}
interface Verification {
  provider: 'github' | 'gitea';
  repository: string;
  access: Access;
  conflicts: Record<Mode, string | null>;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const when = (date: string) =>
  new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const providerName = (provider: Repository['provider']) =>
  provider === 'github' ? 'GitHub' : 'Gitea';
const modeName: Record<Mode, string> = { reference: 'Reference', inbound: 'Inbound mirror' };

function health(repository: Repository) {
  if (repository.syncing) return 'Syncing…';
  if (repository.mode === 'reference') return 'Linked for reference';
  if (repository.lastError)
    return `Sync failed${repository.lastErrorAt ? ` ${when(repository.lastErrorAt)}` : ''}`;
  return repository.lastSyncedAt ? `Synced ${when(repository.lastSyncedAt)}` : 'Not synced yet';
}

function ModeChoice({
  value,
  onChange,
  access,
  provider,
  disabled = {},
}: {
  value: Mode;
  onChange: (mode: Mode) => void;
  access: Access | null;
  provider: Repository['provider'];
  disabled?: Partial<Record<Mode, string | null>>;
}) {
  const name = useId();
  const readOnly = access && !access.write ? access.reason : null;
  const options: { id: Mode | 'two_way'; title: string; detail: string; blocked: boolean }[] = [
    {
      id: 'reference',
      title: 'Reference',
      detail:
        disabled.reference ?? `Link the repository. Issues stay in ${providerName(provider)}.`,
      blocked: !!disabled.reference,
    },
    {
      id: 'inbound',
      title: 'Inbound mirror',
      detail:
        disabled.inbound ??
        'Import issues and comments. Title and description follow the repository; planning stays in Trestl.',
      blocked: !!disabled.inbound,
    },
    {
      id: 'two_way',
      title: 'Two-way',
      detail: readOnly
        ? 'Unavailable with this connection.'
        : 'Not available yet. Replies and status will flow back only when you opt in.',
      blocked: true,
    },
  ];
  return (
    <fieldset className="repository-modes">
      <legend>How it syncs</legend>
      {options.map((option) => (
        <label
          key={option.id}
          className={`repository-mode ${value === option.id ? 'selected' : ''} ${option.blocked ? 'disabled' : ''}`}
        >
          <input
            type="radio"
            name={name}
            value={option.id}
            checked={value === option.id}
            disabled={option.blocked}
            onChange={() => option.id !== 'two_way' && onChange(option.id)}
          />
          <span>
            <strong>{option.title}</strong>
            <small>{option.detail}</small>
            {option.id === 'two_way' && readOnly && (
              <small className="repository-mode-reason">
                <ShieldAlert size={13} />
                {readOnly}
              </small>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function AttachRepository({
  project,
  first,
  onClose,
  onAttached,
}: {
  project: Project;
  first: boolean;
  onClose: () => void;
  onAttached: (repository: Repository) => void;
}) {
  const { data } = useApp();
  const listId = useId();
  const [connections, setConnections] = useState<GitConnection[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [suggestions, setSuggestions] = useState<{ repository: string; private: boolean | null }[]>(
    [],
  );
  const [listError, setListError] = useState('');
  const [repository, setRepository] = useState('');
  const [verified, setVerified] = useState<Verification | null>(null);
  const [mode, setMode] = useState<Mode>('inbound');
  const [isDefault, setIsDefault] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api<GitConnection[]>('/git/connections', { signal: controller.signal })
      .then((result) => {
        setConnections(result);
        setConnectionId(result[0]?.id ?? '');
      })
      .catch((e) => !controller.signal.aborted && setError(message(e)));
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!connectionId) return;
    const controller = new AbortController();
    setSuggestions([]);
    setListError('');
    api<{ data: { repository: string; private: boolean | null }[] }>(
      `/git/connections/${encodeURIComponent(connectionId)}/repositories`,
      { signal: controller.signal },
    )
      .then((result) => setSuggestions(result.data))
      .catch(() => !controller.signal.aborted && setListError('Enter the owner/repository name.'));
    return () => controller.abort();
  }, [connectionId]);
  function reset() {
    setVerified(null);
    setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const target = { connectionId, repository: repository.trim() };
      if (!verified) {
        const result = await post<Verification>(
          `/projects/${project.id}/repositories/verify`,
          target,
        );
        setVerified(result);
        setRepository(result.repository);
        setMode(
          !result.conflicts.inbound && result.access.issues
            ? 'inbound'
            : !result.conflicts.reference
              ? 'reference'
              : 'inbound',
        );
      } else {
        onAttached(
          await post<Repository>(`/projects/${project.id}/repositories`, {
            ...target,
            mode,
            isDefault,
          }),
        );
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  // Only a repository already attached here blocks Reference; no mode is left to choose.
  const attachedHere = verified?.conflicts.reference ?? null;
  const blocked = verified && {
    reference: verified.conflicts.reference,
    inbound:
      verified.conflicts.inbound ??
      (verified.access.issues ? null : 'This connection cannot read issues in this repository.'),
  };
  return (
    <Modal title="Attach repository" onClose={onClose} className="repository-dialog">
      {connections === null && !error ? (
        <div className="repository-dialog-empty" role="status">
          <Loader2 className="spin" size={20} />
          Loading Git connections…
        </div>
      ) : connections && !connections.length ? (
        <div className="repository-dialog-empty">
          <GitHubIcon size={24} />
          <p>
            {data.user.role === 'admin'
              ? 'Add a Git connection in Administration first. Project owners then choose its repositories here.'
              : 'An administrator needs to add a Git connection before repositories can be attached.'}
          </p>
          {data.user.role === 'admin' && (
            <button
              className="button primary"
              onClick={() => {
                onClose();
                navigate('settings', undefined, 'integrations');
              }}
            >
              Open Administration
            </button>
          )}
        </div>
      ) : (
        <form className="simple-form" onSubmit={submit}>
          <label className="field">
            Git connection
            <Select
              className="select"
              value={connectionId}
              onChange={(e) => {
                reset();
                setConnectionId(e.target.value);
              }}
            >
              {(connections ?? []).map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name} · {providerName(connection.provider)}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            Repository
            <input
              className="input"
              required
              autoFocus
              maxLength={300}
              list={listId}
              placeholder="owner/repository"
              pattern="[\w.\-]+/[\w.\-]+"
              value={repository}
              onChange={(e) => {
                reset();
                setRepository(e.target.value);
              }}
            />
            <datalist id={listId}>
              {suggestions.map((row) => (
                <option key={row.repository} value={row.repository}>
                  {row.private ? 'Private' : row.private === false ? 'Public' : ''}
                </option>
              ))}
            </datalist>
            <small className="repository-hint">
              {listError ||
                (suggestions.length
                  ? 'Choose a repository this connection can read, or type owner/repository.'
                  : 'Use the owner/repository name.')}
            </small>
          </label>
          {verified && (
            <>
              <p className="repository-verified" role="status">
                <Check size={15} />
                <span>
                  Trestl can read <strong>{verified.repository}</strong>
                  {verified.access.private === null
                    ? ''
                    : verified.access.private
                      ? ' · Private'
                      : ' · Public'}
                  . It only reads from the repository.
                </span>
              </p>
              {attachedHere ? (
                <p className="form-error" role="alert">
                  {attachedHere}
                </p>
              ) : (
                <>
                  <ModeChoice
                    value={mode}
                    onChange={setMode}
                    access={verified.access}
                    provider={verified.provider}
                    disabled={blocked ?? {}}
                  />
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={isDefault}
                      disabled={first}
                      onChange={(e) => setIsDefault(e.target.checked)}
                    />
                    <span>
                      Default for new items
                      <small>
                        {first
                          ? 'The first repository is the project’s default.'
                          : 'Replaces the current default repository.'}
                      </small>
                    </span>
                  </label>
                </>
              )}
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy || !connectionId || !!(verified && (attachedHere || blocked?.[mode]))}
            >
              {busy && <Loader2 className="spin" size={14} />}
              {verified ? 'Attach repository' : 'Check access'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function RepositorySettings({
  project,
  repository,
  onChange,
  onDetached,
}: {
  project: Project;
  repository: Repository;
  onChange: (repository: Repository) => void;
  onDetached: () => void;
}) {
  const { toast } = useApp();
  const [mode, setMode] = useState<Mode>(repository.mode);
  const [confirm, setConfirm] = useState<'mode' | 'detach' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/projects/${project.id}/repositories/${repository.id}`;
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="repository-settings">
      <ModeChoice
        value={mode}
        onChange={(next) => {
          setMode(next);
          setConfirm(next === repository.mode ? null : 'mode');
        }}
        access={repository.access}
        provider={repository.provider}
      />
      {confirm === 'mode' && (
        <div className="repository-confirm">
          <span>
            {mode === 'reference'
              ? 'Stop importing? Existing items stay in this project and stop updating.'
              : 'Start importing issues and comments from this repository?'}
          </span>
          <button className="button" onClick={() => (setMode(repository.mode), setConfirm(null))}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onChange(await patch<Repository>(path, { mode }));
                setConfirm(null);
                toast(`${repository.repository} is now ${modeName[mode].toLowerCase()}`);
              })
            }
          >
            Change mode
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="repository-settings-actions">
        {!repository.isDefault && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                onChange(await patch<Repository>(path, { isDefault: true }));
                toast(`${repository.repository} is the default for new items`);
              })
            }
          >
            Make default
          </button>
        )}
        {confirm === 'detach' ? (
          <div className="repository-confirm">
            <span>
              Detach {repository.repository}? Imported items stay in this project and stop updating.
            </span>
            <button className="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await remove(path);
                  onDetached();
                })
              }
            >
              Detach
            </button>
          </div>
        ) : (
          <button className="button ghost" disabled={busy} onClick={() => setConfirm('detach')}>
            Detach repository
          </button>
        )}
      </div>
    </div>
  );
}

/** A project's attached repositories. Credentials stay in Administration. */
export default function ProjectRepositories({ project }: { project: Project }) {
  const { data, refresh, toast } = useApp();
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [error, setError] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [open, setOpen] = useState('');
  const [syncing, setSyncing] = useState('');
  const canManage = project.ownerId === data.user.id || data.user.role === 'admin';
  async function load() {
    try {
      setRepositories(
        (await api<{ data: Repository[] }>(`/projects/${project.id}/repositories`)).data,
      );
      setError('');
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    void load();
  }, [project.id]);
  async function sync(repository: Repository) {
    setSyncing(repository.id);
    try {
      const result = await post<{ imported: number; updated: number; comments: number }>(
        `/projects/${project.id}/repositories/${repository.id}/sync`,
        {},
      );
      await refresh();
      toast(
        `Synced ${repository.repository} · ${result.imported} imported · ${result.updated} updated`,
      );
    } catch (e) {
      toast(message(e), 'error');
    } finally {
      setSyncing('');
      await load();
    }
  }
  return (
    <section className="repository-panel" aria-labelledby={`repositories-${project.id}`}>
      <div className="resources-subheading">
        <div>
          <h3 id={`repositories-${project.id}`}>Repositories</h3>
          <p className="muted">
            Inbound mirrors bring issues into this project. Trestl only reads from repositories.
          </p>
        </div>
        {canManage && (
          <button className="button" onClick={() => setAttaching(true)}>
            <Plus size={15} />
            Attach repository
          </button>
        )}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : repositories === null ? (
        <p className="muted repository-loading" role="status">
          <Loader2 className="spin" size={15} />
          Loading repositories…
        </p>
      ) : repositories.length ? (
        <div className="resource-list">
          {repositories.map((repository) => (
            <div className="repository-entry" key={repository.id}>
              <div className="resource-row repository-row">
                <span className="resource-icon repository">
                  {repository.provider === 'github' ? (
                    <GitHubIcon size={20} />
                  ) : (
                    <GitFork size={20} />
                  )}
                </span>
                <div className="repository-row-main">
                  <a href={repository.webUrl} target="_blank" rel="noopener noreferrer">
                    <strong>{repository.repository}</strong>
                  </a>
                  <small>
                    {modeName[repository.mode]}
                    {repository.connection && <> · {repository.connection.name}</>} ·{' '}
                    <span className={repository.lastError ? 'danger-text' : ''}>
                      {syncing === repository.id ? 'Syncing…' : health(repository)}
                    </span>
                  </small>
                  {repository.lastError && repository.mode === 'inbound' && (
                    <p className="repository-error">{repository.lastError}</p>
                  )}
                </div>
                {repository.isDefault && <span className="repository-badge">Default</span>}
                {canManage && repository.mode === 'inbound' && (
                  <button
                    className="icon-button"
                    aria-label={`Sync ${repository.repository}`}
                    title="Sync now"
                    disabled={!!syncing}
                    onClick={() => void sync(repository)}
                  >
                    <RefreshCw size={15} className={syncing === repository.id ? 'spin' : ''} />
                  </button>
                )}
                {canManage && (
                  <button
                    className="icon-button"
                    aria-label={`Settings for ${repository.repository}`}
                    aria-expanded={open === repository.id}
                    title="Repository settings"
                    onClick={() => setOpen(open === repository.id ? '' : repository.id)}
                  >
                    <Settings2 size={15} />
                  </button>
                )}
              </div>
              {open === repository.id && (
                <RepositorySettings
                  project={project}
                  repository={repository}
                  onChange={() => void load()}
                  onDetached={() => {
                    setOpen('');
                    toast(`${repository.repository} detached`);
                    void load();
                    void refresh();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="repository-empty">
          <GitFork size={20} />
          <p>
            {canManage
              ? 'Attach a GitHub or Gitea repository to import its issues, or keep it one click away.'
              : 'No repositories yet. The project owner can attach one.'}
          </p>
        </div>
      )}
      {attaching && (
        <AttachRepository
          project={project}
          first={!repositories?.length}
          onClose={() => setAttaching(false)}
          onAttached={(repository) => {
            setAttaching(false);
            toast(`${repository.repository} attached`);
            void load().then(() => {
              if (repository.mode === 'inbound') void sync(repository);
            });
          }}
        />
      )}
    </section>
  );
}
