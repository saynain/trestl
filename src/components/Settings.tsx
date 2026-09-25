import { downloadFile } from '../lib/download';
import AuthenticationSettings from './AuthenticationSettings';
import WorkspacePeople from './WorkspacePeople';
import WorkspaceGeneral from './WorkspaceGeneral';
import ServerVersionSettings from './ServerVersionSettings';
import { Select } from './Select';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Github,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../lib/context';
import { api, patch, post, remove } from '../lib/api';
import { Avatar } from './ui';
import { navigate } from '../lib/model';
import './settings.css';
import GitSettings, { type GitConnection } from './GitSettings';
import AppearanceSettings from './AppearanceSettings';

type Tab =
  | 'version'
  | 'authentication'
  | 'tokens'
  | 'profile'
  | 'appearance'
  | 'general'
  | 'people'
  | 'integrations'
  | 'api';
type Integration = {
  id: string;
  provider: string;
  name: string;
  repository: string;
  baseUrl: string;
  projectId: string;
  lastSyncedAt?: string | null;
  lastError?: string | null;
};
type AccessToken = {
  workspaceId?: string;
  id: string;
  name: string;
  scope: string;
  createdAt: string;
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const formatDate = (date?: string | null) =>
  date
    ? new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never';
const rows = <T,>(result: { data: T[] } | T[]): T[] =>
  Array.isArray(result) ? result : result.data;

export default function Settings({
  section,
  scope = 'workspace',
}: {
  section?: string;
  scope?: 'account' | 'workspace';
}) {
  const { data, toast, uiPreferences, updateUiPreferences } = useApp();
  const [signingOut, setSigningOut] = useState(false);
  const personal = data.workspace?.kind === 'personal';
  const accountTabs: { id: Tab; label: string }[] = [
    { id: 'profile', label: 'Profile' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'tokens', label: 'API tokens' },
  ];
  const workspaceTabs: { id: Tab; label: string }[] = [
    { id: 'general', label: 'General' },
    ...(data.user.role === 'admin'
      ? [
          { id: 'authentication' as const, label: 'Authentication' },
          { id: 'version' as const, label: 'Server version' },
        ]
      : []),
    ...(!personal ? [{ id: 'people' as const, label: 'People' }] : []),
    { id: 'integrations', label: 'Integrations' },
    { id: 'api', label: 'Export' },
  ];
  const legacyAccount =
    scope === 'workspace' && (section === 'profile' || section === 'appearance');
  const accountScope = scope === 'account' || legacyAccount;
  const tabs = accountScope ? accountTabs : workspaceTabs;
  const requested =
    section === 'connections' ||
    section === 'documentation' ||
    new URLSearchParams(location.hash.split('?')[1]).has('github')
      ? 'integrations'
      : section;
  const tab =
    tabs.find((item) => item.id === requested)?.id ?? (accountScope ? 'profile' : 'general');
  useEffect(() => {
    if (legacyAccount) navigate('account-settings', undefined, section);
  }, [legacyAccount, section]);
  async function signOut() {
    setSigningOut(true);
    try {
      const result = await post<{ redirectUrl?: string }>('/auth/logout', {});
      if (result.redirectUrl) window.location.assign(result.redirectUrl);
      else window.location.reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
      setSigningOut(false);
    }
  }
  return (
    <div className="settings-page">
      <header className="settings-heading">
        <h1>{accountScope ? 'Account settings' : 'Administration'}</h1>
        <p>
          {accountScope
            ? 'Your profile, preferences, and API access.'
            : `Manage ${data.workspace?.name ?? 'your installation'} and how your team works together.`}
        </p>
      </header>
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Settings sections">
          {[
            accountScope
              ? { label: 'Your account', detail: data.user.email, tabs: accountTabs }
              : {
                  label: 'Installation',
                  detail: data.workspace?.name ?? 'Workspace',
                  tabs: workspaceTabs,
                },
          ].map((group) => (
            <div className="settings-navigation-group" key={group.label}>
              <div className="settings-navigation-heading">
                <span>{group.label}</span>
                <strong title={group.detail}>{group.detail}</strong>
              </div>
              <div className="settings-navigation-links">
                {group.tabs.map((item) => (
                  <a
                    key={item.id}
                    href={`#/${accountScope ? 'account-settings' : 'settings'}?tab=${item.id}`}
                    aria-current={tab === item.id ? 'page' : undefined}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="settings-content" key={`${data.user.id}:${data.user.workspaceId}:${tab}`}>
          {tab === 'profile' && (
            <AccountSettings signingOut={signingOut} onSignOut={() => void signOut()} />
          )}
          {tab === 'appearance' && (
            <>
              <AppearanceSettings key={data.user.id} />
              <section className="settings-section">
                <h2>Work item view</h2>
                <p>
                  Choose how work items open. This preference is saved for your profile{' '}
                  {import.meta.env.VITE_TRESTL_DESKTOP === 'true'
                    ? 'on this computer'
                    : 'in this browser'}
                  .
                </p>
                <div className="settings-item-layout" role="group" aria-label="Work item view">
                  {[
                    {
                      id: 'side-panel',
                      label: 'Side panel',
                      description: 'Open along the right edge.',
                    },
                    {
                      id: 'centered',
                      label: 'Centered box',
                      description: 'Open in the middle of the screen.',
                    },
                  ].map(({ id, label, description }) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={uiPreferences.itemLayout === id}
                      className={`settings-layout-option ${uiPreferences.itemLayout === id ? 'selected' : ''}`}
                      onClick={() =>
                        updateUiPreferences({ itemLayout: id as 'side-panel' | 'centered' })
                      }
                    >
                      <strong>{label}</strong>
                      <span>{description}</span>
                    </button>
                  ))}
                </div>
                <p className="settings-helper">On small screens, work items use the full screen.</p>
              </section>
            </>
          )}
          {tab === 'authentication' && <AuthenticationSettings />}
          {tab === 'version' && <ServerVersionSettings />}
          {tab === 'general' && <WorkspaceGeneral />}
          {tab === 'people' && <WorkspacePeople />}
          {tab === 'integrations' && <WorkspaceIntegrations />}
          {tab === 'api' && <ApiSettings mode="export" />}
          {tab === 'tokens' && <ApiSettings mode="tokens" />}
        </div>
      </div>
      <footer className="settings-footer">
        Trestl <span>·</span> A steady place for work.
      </footer>
    </div>
  );
}

function WorkspaceIntegrations() {
  const { data } = useApp();
  const [connections, setConnections] = useState<GitConnection[]>([]);
  return (
    <>
      <p className="settings-context-note">
        Repository imports share issues with people who can access the destination project. New Git
        connections are shared with everyone in this installation. Confluence search uses your
        personal account and its permissions.
      </p>
      <GitSettings onChange={setConnections} />
      {data.user.role === 'admin' ? (
        <Integrations connections={connections} />
      ) : (
        <section className="settings-section">
          <h2>Repository imports</h2>
          <p>A workspace administrator can manage repository imports for {data.workspace?.name}.</p>
        </section>
      )}
      <DocumentationSettings />
    </>
  );
}

function Integrations({ connections }: { connections: GitConnection[] }) {
  const { data, toast, refresh } = useApp();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  const admin = data.user.role === 'admin';
  async function load() {
    if (!admin) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setIntegrations(rows(await api<{ data: Integration[] }>('/integrations')));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy('create');
    setError('');
    try {
      await post('/integrations', {
        name: values.get('name'),
        connectionId: values.get('connectionId'),
        repository: values.get('repository'),
        projectId: values.get('projectId'),
      });
      setAdding(false);
      await load();
      toast('Repository connected. Sync to import its issues.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function sync(id: string) {
    setBusy(id);
    setError('');
    try {
      const result = await post<{
        imported?: number;
        updated?: number;
        comments?: number;
        skipped?: number;
      }>(`/integrations/${id}/sync`, {});
      await load();
      await refresh();
      toast(
        `Sync complete${result.imported !== undefined ? ` · ${result.imported} imported` : ''}${result.updated !== undefined ? ` · ${result.updated} updated` : ''}${result.comments !== undefined ? ` · ${result.comments} comments` : ''}`,
      );
    } catch (e) {
      setError(errorMessage(e));
      await load();
    } finally {
      setBusy('');
    }
  }
  async function disconnect(id: string) {
    setBusy(id);
    setError('');
    try {
      await remove(`/integrations/${id}`);
      setConfirmDelete('');
      await load();
      toast('Repository disconnected');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <section className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>Repository imports</h2>
            <p>
              Optionally sync a repository into a project using one of your saved Git connections.
            </p>
          </div>
          {admin && (
            <button
              className="button primary"
              onClick={() => {
                setAdding(!adding);
                setError('');
              }}
            >
              {adding ? <X size={15} /> : <Plus size={15} />}
              {adding ? 'Cancel' : 'Add repository import'}
            </button>
          )}
        </div>
        {error && (
          <div className="settings-error" role="alert">
            {error}
          </div>
        )}
        {adding && (
          <form className="settings-form" onSubmit={create}>
            <div className="settings-form-grid">
              <label className="field">
                Saved Git connection
                <Select className="select" name="connectionId" required defaultValue="">
                  <option value="" disabled>
                    Select a connection
                  </option>
                  {connections.map((connection) => (
                    <option value={connection.id} key={connection.id}>
                      {connection.name} · {connection.provider === 'github' ? 'GitHub' : 'Gitea'}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="field">
                Connection name
                <input
                  className="input"
                  name="name"
                  required
                  placeholder="Platform engineering"
                  maxLength={100}
                />
              </label>
            </div>
            <div className="settings-form-grid">
              <label className="field">
                Repository
                <input
                  className="input"
                  name="repository"
                  required
                  placeholder="organization/repository"
                />
              </label>
              <label className="field">
                Import into project
                <Select className="select" name="projectId" required defaultValue="">
                  <option value="" disabled>
                    Select a project
                  </option>
                  {data.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <p className="settings-helper">
              The project is the destination for imported work. Your saved connection remains
              available from every project.
            </p>
            <div className="settings-form-actions">
              <button
                className="button primary"
                disabled={!!busy || !data.projects.length || !connections.length}
              >
                {busy === 'create' && <Loader2 size={14} className="settings-spin" />}Add repository
                import
              </button>
            </div>
            {!connections.length && (
              <p className="settings-helper">Save a Git connection above to add an import.</p>
            )}
            {!data.projects.length && (
              <p className="settings-helper">Create a project to choose an import destination.</p>
            )}
          </form>
        )}
        {loading && (
          <div className="settings-loading">
            <Loader2 className="settings-spin" size={16} />
            Loading connections…
          </div>
        )}
        {!loading && !error && !integrations.length && (
          <div className="settings-empty">
            <Github size={27} strokeWidth={1.3} />
            <strong>Your projects, connected</strong>
            <p>
              Import repository issues while keeping planning, deadlines, and internal discussion in
              your workspace.
            </p>
            {!admin && <p>Ask an administrator to connect a repository.</p>}
          </div>
        )}
        <div className="settings-connections">
          {integrations.map((integration) => (
            <div className="settings-connection" key={integration.id}>
              <div className="settings-connection-heading">
                <span className="settings-provider-icon">
                  {integration.provider === 'github' ? <Github size={19} /> : <Link2 size={19} />}
                </span>
                <div>
                  <strong>{integration.name}</strong>
                  <span>
                    {integration.repository} <span>→</span>{' '}
                    {data.projects.find((project) => project.id === integration.projectId)?.name ||
                      'Project unavailable'}
                  </span>
                </div>
                {admin && (
                  <div className="settings-connection-actions">
                    <button
                      className="button"
                      disabled={!!busy}
                      onClick={() => void sync(integration.id)}
                    >
                      <RefreshCw
                        size={14}
                        className={busy === integration.id ? 'settings-spin' : ''}
                      />
                      Sync
                    </button>
                    <button
                      className="button ghost"
                      title="Disconnect repository"
                      aria-label={`Disconnect ${integration.name}`}
                      onClick={() => setConfirmDelete(integration.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>
              <p className="settings-sync-status">
                {integration.lastError ? 'Last sync failed' : 'Last synced'} ·{' '}
                {formatDate(integration.lastSyncedAt)}
              </p>
              {integration.lastError && (
                <div className="settings-error">{integration.lastError}</div>
              )}
              {confirmDelete === integration.id && (
                <div className="settings-confirm">
                  <span>Disconnect this repository? Imported work items are kept.</span>
                  <button className="button" onClick={() => setConfirmDelete('')}>
                    Cancel
                  </button>
                  <button
                    className="button settings-danger"
                    disabled={!!busy}
                    onClick={() => void disconnect(integration.id)}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="settings-helper">
          Sync brings repository changes into Trestl. It does not post comments or modify the source
          repository.
        </p>
      </section>
    </>
  );
}

function ApiSettings({ mode = 'both' }: { mode?: 'tokens' | 'export' | 'both' }) {
  const { data, toast } = useApp();
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  async function load() {
    try {
      setTokens(
        rows(await api<{ data: AccessToken[] }>('/tokens')).filter(
          (token) => token.workspaceId === data.user.workspaceId,
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (mode !== 'export') void load();
  }, [mode]);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy('create');
    setError('');
    try {
      const result = await post<{ token: string }>('/tokens', {
        name: values.get('name'),
        scope: values.get('write') ? 'write' : 'read',
      });
      setSecret(result.token);
      setCopied(false);
      setAdding(false);
      await load();
      toast('API token created');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    setError('');
    try {
      await remove(`/tokens/${id}`);
      setConfirmDelete('');
      await load();
      toast('Token revoked');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function download() {
    setBusy('export');
    setError('');
    try {
      const exported = await api<unknown>('/export');
      const saved = await downloadFile(
        new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }),
        `trestl-export-${new Date().toISOString().slice(0, 10)}.json`,
      );
      if (!saved) return;
      toast('Export downloaded');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy('');
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      toast('Could not access clipboard. Select and copy the token manually.', 'error');
    }
  }
  return (
    <>
      {mode !== 'export' && (
        <section className="settings-section">
          <div className="settings-section-header">
            <div>
              <h2>{'Your API tokens'}</h2>
              <p>
                Connect CLI, Raycast, and other tools to {data.workspace?.name} using your account’s
                permissions.
              </p>
            </div>
            <button className="button primary" onClick={() => setAdding(!adding)}>
              {adding ? <X size={15} /> : <Plus size={15} />}
              {adding ? 'Cancel' : 'Create token'}
            </button>
          </div>
          {error && (
            <div className="settings-error" role="alert">
              {error}
            </div>
          )}
          {secret && (
            <div className="settings-secret" role="status">
              <div>
                <CheckCircle2 size={16} />
                <strong>Your new API token</strong>
                <button
                  className="button ghost"
                  onClick={() => setSecret('')}
                  aria-label="Dismiss new token"
                >
                  <X size={15} />
                </button>
              </div>
              <p>Copy this token now. You won't be able to see it again.</p>
              <div>
                <input
                  className="input"
                  readOnly
                  value={secret}
                  aria-label="New API token"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button className="button" onClick={() => void copy()}>
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}
          {adding && (
            <form className="settings-form" onSubmit={create}>
              <label className="field">
                Token name
                <input
                  className="input"
                  name="name"
                  required
                  autoFocus
                  maxLength={100}
                  placeholder="My CLI"
                />
              </label>
              <label className="settings-checkbox">
                <input type="checkbox" name="write" />
                Allow creating and updating work
              </label>
              <p className="settings-helper">
                This token accesses {data.workspace?.name} as you. Leave this unchecked for
                read-only access.
              </p>
              <div className="settings-form-actions">
                <button className="button primary" disabled={!!busy}>
                  {busy === 'create' && <Loader2 className="settings-spin" size={14} />}Create token
                </button>
              </div>
            </form>
          )}
          {loading ? (
            <div className="settings-loading">
              <Loader2 className="settings-spin" size={16} />
              Loading tokens…
            </div>
          ) : !error && !tokens.length ? (
            <div className="settings-empty">
              <KeyRound size={25} strokeWidth={1.3} />
              <strong>No API tokens yet</strong>
              <p>Create a personal token when you’re ready to connect another tool.</p>
            </div>
          ) : (
            <div className="settings-token-list">
              {tokens.map((token) => (
                <div key={token.id} className="settings-token">
                  <div className="settings-token-main">
                    <KeyRound size={16} />
                    <div>
                      <strong>{token.name}</strong>
                      <span>
                        {data.workspaces?.find((w) => w.id === token.workspaceId)?.name ??
                          'Previous installation'}{' '}
                        · Created {formatDate(token.createdAt)}
                      </span>
                    </div>
                    <span className="settings-badge">
                      {token.scope === 'admin'
                        ? 'Admin'
                        : token.scope === 'write'
                          ? 'Read & write'
                          : 'Read only'}
                    </span>
                    <button
                      className="button ghost"
                      aria-label={`Revoke ${token.name}`}
                      onClick={() => setConfirmDelete(token.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {confirmDelete === token.id && (
                    <div className="settings-confirm">
                      <span>Revoke this token? Connected tools will lose access immediately.</span>
                      <button className="button" onClick={() => setConfirmDelete('')}>
                        Cancel
                      </button>
                      <button
                        className="button settings-danger"
                        disabled={!!busy}
                        onClick={() => void revoke(token.id)}
                      >
                        Revoke token
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="settings-tip">
            <KeyRound size={18} />
            <div>
              <strong>One API for your whole workflow</strong>
              <p>
                Use <code>/api/v1</code> with an <code>Authorization: Bearer &lt;token&gt;</code>{' '}
                header. Tokens follow your account’s permissions for the selected installation.
              </p>
              <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
                Open API specification <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </section>
      )}
      {mode !== 'tokens' && (
        <section className="settings-section">
          <div className="settings-section-header">
            <div>
              <h2>Your data, always yours</h2>
              <p>Download the projects and work you have permission to access as JSON.</p>
            </div>
            <button className="button" disabled={!!busy} onClick={() => void download()}>
              {busy === 'export' ? (
                <Loader2 size={15} className="settings-spin" />
              ) : (
                <Download size={15} />
              )}
              Export data
            </button>
          </div>
          <p className="settings-helper">
            Includes accessible projects, work items, discussion, and supporting records.
            Credentials and API tokens are excluded.
          </p>
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </>
  );
}

function AccountSettings({
  signingOut,
  onSignOut,
}: {
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const { data, refresh, toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(data.user.name);
  const [email, setEmail] = useState(data.user.email);
  const [changePassword, setChangePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsPassword = changePassword || email.trim().toLowerCase() !== data.user.email;
  function beginEdit() {
    setName(data.user.name);
    setEmail(data.user.email);
    setChangePassword(false);
    setError('');
    setEditing(true);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setError('');
    if (changePassword && values.get('password') !== values.get('confirmPassword')) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await patch('/auth/account', {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        ...(needsPassword ? { currentPassword: values.get('currentPassword') } : {}),
        ...(changePassword ? { password: values.get('password') } : {}),
      });
      await refresh();
      setEditing(false);
      toast(
        changePassword
          ? 'Account updated. Other browser sessions have been signed out.'
          : 'Account updated',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>Your account</h2>
          <p>
            {data.authMode !== 'local'
              ? 'Your name and email are managed by your organization’s sign-in provider.'
              : 'Your profile in this installation.'}
          </p>
        </div>
        <div className="settings-inline-actions">
          {!editing && data.authMode === 'local' && (
            <button className="button" onClick={beginEdit}>
              Edit account
            </button>
          )}
          <button className="button ghost" disabled={signingOut || busy} onClick={onSignOut}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </div>
      <div className="settings-profile">
        <Avatar user={data.user} size={34} />
        <div>
          <strong>{data.user.name}</strong>
          <span>{data.user.email}</span>
        </div>
      </div>
      {editing && (
        <form className="settings-form" onSubmit={save}>
          <div className="settings-form-grid">
            <label className="field">
              Full name
              <input
                className="input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                name="name"
                autoComplete="name"
                required
                maxLength={200}
              />
            </label>
            <label className="field">
              Email address
              <input
                className="input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
              />
            </label>
          </div>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={changePassword}
              onChange={(event) => setChangePassword(event.target.checked)}
            />
            Change password
          </label>
          {needsPassword && (
            <label className="field">
              Current password
              <input
                className="input"
                type="password"
                name="currentPassword"
                autoComplete="current-password"
                maxLength={200}
                required
              />
              <span className="settings-helper">
                Required when changing your email address or password.
              </span>
            </label>
          )}
          {changePassword && (
            <>
              <div className="settings-form-grid">
                <label className="field">
                  New password
                  <input
                    className="input"
                    type="password"
                    name="password"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={200}
                    required
                    placeholder="At least 10 characters"
                  />
                </label>
                <label className="field">
                  Confirm new password
                  <input
                    className="input"
                    type="password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    minLength={10}
                    maxLength={200}
                    required
                  />
                </label>
              </div>
              <p className="settings-helper">
                Changing your password signs out other browser sessions. Your API tokens remain
                active until you revoke them.
              </p>
            </>
          )}
          {error && (
            <div className="settings-error" role="alert">
              {error}
            </div>
          )}
          <div className="settings-form-actions">
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={busy}>
              {busy && <Loader2 size={14} className="settings-spin" />}Save changes
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

type ConfluenceConnection = {
  deployment: 'cloud' | 'datacenter';
  baseUrl: string;
  username?: string | null;
  createdAt?: string;
  updatedAt?: string;
  configured?: boolean;
};
function DocumentationSettings() {
  const { toast } = useApp();
  const [connection, setConnection] = useState<ConfluenceConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [deployment, setDeployment] = useState<'cloud' | 'datacenter'>('cloud');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await api<ConfluenceConnection | null>('/confluence/connection');
      setConnection(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function beginEdit() {
    setDeployment(connection?.deployment || 'cloud');
    setEditing(true);
    setError('');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await post<ConfluenceConnection>('/confluence/connection', {
        deployment,
        baseUrl: values.get('baseUrl'),
        ...(deployment === 'cloud' ? { username: values.get('username') } : {}),
        token: values.get('token'),
      });
      setConnection(result);
      setEditing(false);
      toast('Your Confluence credentials have been saved');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await remove('/confluence/connection');
      setConnection(null);
      setConfirmDelete(false);
      toast('Your Confluence connection has been removed');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2>Confluence</h2>
            <p>Connect once and find documentation from any project.</p>
          </div>
          {!loading && !editing && (
            <button className="button primary" onClick={beginEdit}>
              <Link2 size={15} />
              {connection ? 'Update connection' : 'Connect Confluence'}
            </button>
          )}
        </div>
        <div className="settings-tip">
          <Link2 size={18} />
          <div>
            <strong>A personal connection to your documentation</strong>
            <p>
              Search uses your Confluence account and its permissions. Your credentials are private
              to you. Link search results from any project’s Resources.
            </p>
          </div>
        </div>
        {error && (
          <div className="settings-error" role="alert">
            {error}
            {!editing && (
              <button className="button ghost" onClick={() => void load()} disabled={loading}>
                Retry
              </button>
            )}
          </div>
        )}
        {loading && (
          <div className="settings-loading">
            <Loader2 className="settings-spin" size={16} />
            Loading your connection…
          </div>
        )}
        {editing && (
          <form className="settings-form" onSubmit={save}>
            <label className="field">
              Confluence deployment
              <Select
                className="select"
                value={deployment}
                onChange={(event) => setDeployment(event.target.value as 'cloud' | 'datacenter')}
              >
                <option value="cloud">Confluence Cloud</option>
                <option value="datacenter">Confluence Data Center</option>
              </Select>
            </label>
            <label className="field">
              Confluence base URL
              <input
                className="input"
                type="url"
                name="baseUrl"
                defaultValue={connection?.baseUrl || ''}
                placeholder={
                  deployment === 'cloud'
                    ? 'https://your-team.atlassian.net/wiki'
                    : 'https://confluence.company.com'
                }
                required
                maxLength={2000}
              />
            </label>
            {deployment === 'cloud' && (
              <label className="field">
                Atlassian account email
                <input
                  className="input"
                  type="email"
                  name="username"
                  autoComplete="email"
                  defaultValue={connection?.username || ''}
                  required
                  maxLength={254}
                />
              </label>
            )}
            <label className="field">
              {deployment === 'cloud' ? 'Atlassian API token' : 'Personal access token'}
              <input
                className="input"
                name="token"
                type="password"
                autoComplete="off"
                required
                maxLength={4096}
                placeholder={
                  connection
                    ? 'Enter a token to replace your saved credentials'
                    : 'Your personal token'
                }
              />
            </label>
            <p className="settings-helper">
              The server must have APP_SECRET set to at least 32 characters and your Confluence
              origin listed in CONFLUENCE_ALLOWED_ORIGINS. Credentials are encrypted on the server.
            </p>
            <div className="settings-form-actions">
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit" disabled={busy}>
                {busy && <Loader2 size={14} className="settings-spin" />}Save connection
              </button>
            </div>
          </form>
        )}
        {!loading && !error && !connection && !editing && (
          <div className="settings-empty">
            <Link2 size={25} strokeWidth={1.3} />
            <strong>Your knowledge, within reach</strong>
            <p>
              Connect your own Confluence account to search pages. You can always paste a
              documentation link directly into Resources.
            </p>
          </div>
        )}
        {!loading && connection && !editing && (
          <div className="settings-connection">
            <div className="settings-connection-heading">
              <span className="settings-provider-icon">
                <Link2 size={18} />
              </span>
              <div>
                <strong>
                  {connection.deployment === 'cloud'
                    ? 'Confluence Cloud'
                    : 'Confluence Data Center'}
                </strong>
                <span>{connection.baseUrl}</span>
                {connection.username && <span>{connection.username}</span>}
              </div>
              <span className="settings-badge">Credentials saved</span>
              <button
                className="button ghost"
                title="Disconnect Confluence"
                aria-label="Disconnect your Confluence account"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {confirmDelete && (
              <div className="settings-confirm">
                <span>Remove your saved connection? Existing documentation links are kept.</span>
                <button className="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button
                  className="button settings-danger"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        )}
      </section>
      <section className="settings-section">
        <h2>Keep documentation in Confluence</h2>
        <p>
          Pages stay in Confluence as the source of truth. Search results show pages your account
          can access. Sharing a page link in a workspace project makes its title and URL visible to
          people who can access that project.
        </p>
        <p className="settings-helper">
          Opening a linked page uses your browser's Confluence session. It never shares your saved
          API token.
        </p>
      </section>
    </>
  );
}
