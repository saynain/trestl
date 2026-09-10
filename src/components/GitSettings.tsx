import { Select } from './Select';
import { useEffect, useState, type FormEvent } from 'react';
import { ExternalLink, Github, Link2, Loader2, Plus, Trash2, X } from 'lucide-react';
import { api, post, remove } from '../lib/api';
import { useApp } from '../lib/context';

export interface GitConnection {
  id: string;
  name: string;
  provider: 'github' | 'gitea';
  baseUrl: string;
  authType?: 'token' | 'github-app';
  githubAccount?: string;
  reconnectRequired?: boolean;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not save connection.';
export default function GitSettings({
  onChange,
}: {
  onChange: (connections: GitConnection[]) => void;
}) {
  const { data, toast } = useApp();
  const [githubApp, setGithubApp] = useState<{ enabled: boolean; installUrl?: string } | null>(
    null,
  );
  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<GitConnection | 'new' | null>(null);
  const [provider, setProvider] = useState('github');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  async function load() {
    try {
      const [result, app] = await Promise.all([
        api<GitConnection[]>('/git/connections'),
        api<{ enabled: boolean; installUrl?: string }>('/git/github-app/status'),
      ]);
      setGithubApp(app);
      setConnections(result);
      onChange(result);
    } catch (error) {
      setError(message(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const [path, query] = window.location.hash.split('?');
    const params = new URLSearchParams(query);
    const result = params.get('github');
    if (result) {
      params.delete('github');
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${path}?${params}`,
      );
      if (result === 'connected') toast('GitHub connected for all your projects');
      else if (result !== 'installed')
        setError(
          result === 'denied'
            ? 'GitHub authorization was canceled. Your existing connections are unchanged.'
            : result === 'invalid_state'
              ? 'This GitHub sign-in expired or belongs to another session. Start again from this account.'
              : 'GitHub could not be connected. Try again with the same GitHub account, or check the app configuration.',
        );
    }
  }, []);
  async function connectGitHub(connectionId?: string) {
    setBusy(true);
    setError('');
    try {
      const result = await post<{ authorizationUrl: string }>(
        '/git/github-app/authorize',
        connectionId ? { connectionId } : {},
      );
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setError(message(error));
      setBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (editing && editing !== 'new') {
        await api(`/git/connections/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: values.get('name'), token: values.get('token') }),
        });
      } else {
        await post('/git/connections', {
          provider,
          name: values.get('name'),
          baseUrl: values.get('baseUrl'),
          token: values.get('token'),
        });
      }
      setEditing(null);
      await load();
      toast('Git connection saved for all your projects');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function disconnect(id: string) {
    setBusy(true);
    setError('');
    try {
      await remove(`/git/connections/${id}`);
      setConfirmDelete('');
      await load();
      toast('Git connection removed');
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>Your Git connections</h2>
          <p>
            Connect GitHub or Gitea once. Reference issues in any project, including new projects.
          </p>
        </div>
        <div className="settings-inline-actions">
          <button
            className="button primary"
            disabled={busy || loading || !githubApp?.enabled}
            onClick={() => void connectGitHub()}
          >
            {busy ? <Loader2 size={15} className="settings-spin" /> : <Github size={15} />}Connect
            GitHub
          </button>
          <button
            className="button"
            disabled={busy || loading}
            onClick={() => {
              setEditing(editing ? null : 'new');
              setError('');
            }}
          >
            {editing ? <X size={15} /> : <Plus size={15} />}
            {editing ? 'Cancel' : 'Use access token'}
          </button>
        </div>
      </div>
      <p className="settings-helper">
        Authorize GitHub in your browser, then choose which repositories the app can access.
        Connections stay personal and work across all your projects.
      </p>
      {!loading && githubApp && !githubApp.enabled && (
        <div className="settings-tip">
          <Github size={18} />
          <div>
            <strong>GitHub App setup is needed</strong>
            <p>
              This server hasn’t enabled GitHub App sign-in yet. You can still use a personal access
              token for GitHub or Gitea.
            </p>
            {data.user.role === 'admin' && (
              <p>
                Follow the self-hosting guide in <code>docs/github-app.md</code> to register your
                own GitHub App and configure this server.
              </p>
            )}
          </div>
        </div>
      )}
      {error && (
        <div className="settings-error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="settings-loading">
          <Loader2 size={16} className="settings-spin" />
          Loading your connections…
        </div>
      )}
      {editing && (
        <form
          className="settings-form"
          onSubmit={save}
          key={editing === 'new' ? 'new' : editing.id}
        >
          <div className="settings-form-grid">
            {editing === 'new' && (
              <label className="field">
                Provider
                <Select
                  className="select"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  <option value="github">GitHub</option>
                  <option value="gitea">Gitea</option>
                </Select>
              </label>
            )}
            <label className="field">
              Connection name
              <input
                autoFocus
                className="input"
                name="name"
                required
                maxLength={100}
                defaultValue={editing === 'new' ? '' : editing.name}
                placeholder="My GitHub account"
              />
            </label>
          </div>
          {editing === 'new' && (
            <label className="field">
              {provider === 'github' ? 'GitHub API URL' : 'Gitea instance URL'}
              <input
                className="input"
                name="baseUrl"
                type="url"
                required
                key={provider}
                defaultValue={provider === 'github' ? 'https://api.github.com' : ''}
                placeholder="https://gitea.company.com"
              />
            </label>
          )}
          <label className="field">
            {editing === 'new' ? 'Access token' : 'Replacement access token'}
            <input
              className="input"
              name="token"
              type="password"
              autoComplete="off"
              required
              maxLength={4096}
              placeholder="Token with permission to read issues"
            />
          </label>
          <p className="settings-helper">
            For GitHub, select the repositories you need and grant Issues read access. For Gitea,
            grant read access to the repositories and issues you need. You can replace the token
            here when its access changes.
          </p>
          <div className="settings-form-actions">
            <button className="button primary" disabled={busy}>
              {busy && <Loader2 size={14} className="settings-spin" />}Save connection
            </button>
          </div>
        </form>
      )}
      {!loading && !connections.length && !editing && !error && (
        <div className="settings-empty">
          <Github size={27} strokeWidth={1.3} />
          <strong>One connection, all your projects</strong>
          <p>Connect GitHub or add a token, then use Find Git issue in any project’s Resources.</p>
        </div>
      )}
      <div className="settings-connections">
        {connections.map((connection) => (
          <div className="settings-connection" key={connection.id}>
            <div className="settings-connection-heading">
              <span className="settings-provider-icon">
                {connection.provider === 'github' ? <Github size={19} /> : <Link2 size={19} />}
              </span>
              <div>
                <strong>{connection.name}</strong>
                <span>
                  {connection.authType === 'github-app'
                    ? `GitHub App · @${connection.githubAccount}`
                    : connection.baseUrl}
                </span>
              </div>
              <span className="settings-badge">All projects</span>
              <div className="settings-connection-actions">
                {connection.authType === 'github-app' ? (
                  <button
                    className="button"
                    disabled={busy || !githubApp?.enabled}
                    onClick={() => void connectGitHub(connection.id)}
                  >
                    Reconnect GitHub
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(connection);
                      setError('');
                    }}
                  >
                    Update token
                  </button>
                )}
                <button
                  className="button ghost"
                  disabled={busy}
                  aria-label={`Disconnect ${connection.name}`}
                  onClick={() => setConfirmDelete(connection.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            {connection.authType === 'github-app' && (
              <GitHubAccess connection={connection} installUrl={githubApp?.installUrl} />
            )}
            {confirmDelete === connection.id && (
              <div className="settings-confirm">
                <span>
                  Remove this connection? Its repository imports will stop. Imported work and
                  existing issue links are kept.{' '}
                  {connection.authType === 'github-app' &&
                    'You can also revoke the app’s authorization in GitHub Settings.'}
                </span>
                <button className="button" disabled={busy} onClick={() => setConfirmDelete('')}>
                  Cancel
                </button>
                <button
                  className="button settings-danger"
                  disabled={busy}
                  onClick={() => void disconnect(connection.id)}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

interface Installation {
  id: number;
  account: string;
  repositorySelection: string;
  suspended: boolean;
  issuesReadable: boolean;
  settingsUrl: string;
}
function GitHubAccess({
  connection,
  installUrl,
}: {
  connection: GitConnection;
  installUrl?: string;
}) {
  const [access, setAccess] = useState<{ data: Installation[]; hasMore: boolean } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{ data: Installation[]; hasMore: boolean }>(
      `/git/connections/${encodeURIComponent(connection.id)}/github-installations`,
      { signal: controller.signal },
    )
      .then(setAccess)
      .catch((error) => {
        if (!controller.signal.aborted) setError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [connection.id, attempt]);
  return (
    <div className="github-access">
      {connection.reconnectRequired && (
        <p className="settings-error">Reconnect GitHub to restore access.</p>
      )}
      {loading ? (
        <p className="settings-helper" role="status">
          Checking repository access…
        </p>
      ) : error ? (
        <div className="settings-error" role="alert">
          {error}
          <button className="button ghost small" onClick={() => setAttempt((value) => value + 1)}>
            Check again
          </button>
        </div>
      ) : (
        <>
          {!access?.data.length && (
            <p className="settings-helper">
              Choose repositories on GitHub to finish connecting. An organization owner may need to
              approve access.
            </p>
          )}
          {access?.data.map((installation) => (
            <div className="github-installation" key={installation.id}>
              <span>
                <strong>{installation.account}</strong> ·{' '}
                {installation.suspended
                  ? 'Access suspended'
                  : !installation.issuesReadable
                    ? 'Issue read permission needed'
                    : installation.repositorySelection === 'all'
                      ? 'All repositories allowed by your GitHub access'
                      : 'Selected repositories'}
              </span>
              <a
                className="button ghost small"
                href={installation.settingsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Manage access
                <ExternalLink size={12} />
              </a>
            </div>
          ))}
          {access?.hasMore && (
            <p className="settings-helper">
              More installations are available. Manage the full list on GitHub.
            </p>
          )}
        </>
      )}
      <div className="settings-inline-actions">
        {installUrl && (
          <a className="button small" href={installUrl}>
            Choose repositories
            <ExternalLink size={12} />
          </a>
        )}
        <button
          className="button ghost small"
          disabled={loading}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh access
        </button>
      </div>
    </div>
  );
}
