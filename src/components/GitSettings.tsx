import { useEffect, useState, type FormEvent } from 'react';
import { api, post, remove } from '../lib/api';
import { useApp } from '../lib/context';

export interface GitConnection {
  id: string;
  name: string;
  provider: 'github' | 'gitea';
  baseUrl: string;
  authType?: 'token' | 'github-app' | 'github-installation';
  githubAccount?: string;
  reconnectRequired?: boolean;
  shared?: boolean;
  development?: boolean;
  issueWrite?: boolean;
  githubInstallation?: { managedAppId?: string; account?: string; settingsUrl?: string };
}
export default function GitSettings({
  onChange,
}: {
  onChange?: (connections: GitConnection[]) => void;
}) {
  const { data, toast } = useApp();
  const admin = data.user.role === 'admin';
  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [provider, setProvider] = useState('gitea');
  const [editing, setEditing] = useState<GitConnection | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  async function load() {
    const result = await api<GitConnection[]>('/git/connections');
    setConnections(result);
    onChange?.(result);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
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
      } else if (provider === 'github-installation') {
        await post('/admin/github-installation', {
          name: values.get('name'),
          appId: values.get('appId'),
          installationId: values.get('installationId'),
          privateKey: values.get('privateKey'),
        });
      } else {
        await post('/git/connections', {
          provider,
          name: values.get('name'),
          baseUrl: values.get('baseUrl'),
          token: values.get('token'),
          shared: true,
        });
      }
      setEditing(null);
      await load();
      toast('Git connection saved');
    } catch (e) {
      setError((e as Error).message);
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
      toast('Connection removed');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <div>
          <h2>Existing apps & other Git connections</h2>
          <p>Connect an existing GitHub App manually, or add a Gitea server or access token.</p>
        </div>
        {admin && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              setEditing(editing ? null : 'new');
              setError('');
            }}
          >
            {editing ? 'Cancel' : 'Add connection'}
          </button>
        )}
      </div>
      <p className="settings-helper">
        Everyone can use the repositories allowed by these credentials. Choose repository access
        with that shared audience in mind. Credentials stay on the server.
      </p>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {editing && (
        <form
          className="settings-form"
          onSubmit={save}
          key={editing === 'new' ? provider : editing.id}
        >
          {editing === 'new' && (
            <label className="field">
              Provider
              <select
                className="input"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="gitea">Gitea</option>
                <option value="github-installation">GitHub App · organization</option>
                <option value="github">GitHub · access token</option>
              </select>
            </label>
          )}
          <label className="field">
            Connection name
            <input
              className="input"
              name="name"
              required
              maxLength={100}
              defaultValue={editing === 'new' ? '' : editing.name}
              placeholder="Team repositories"
            />
          </label>
          {editing === 'new' && provider === 'github-installation' ? (
            <>
              <p className="settings-helper">
                Register a GitHub App with read-only Issues and Metadata permissions, then install
                it on your organization. Select all repositories or specific repositories on GitHub.
                Enter the App ID, installation ID, and generated private key below.
              </p>
              <div className="settings-form-grid">
                <label className="field">
                  App ID
                  <input className="input" name="appId" required pattern="[0-9]+" />
                </label>
                <label className="field">
                  Installation ID
                  <input className="input" name="installationId" required pattern="[0-9]+" />
                </label>
              </div>
              <label className="field">
                Private key (PEM)
                <textarea
                  className="input"
                  name="privateKey"
                  required
                  rows={5}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <p className="settings-helper">
                The connection is verified with GitHub before it is saved. Repository access
                continues to follow the installation settings on GitHub.
              </p>
            </>
          ) : (
            <>
              {editing === 'new' && (
                <label className="field">
                  {provider === 'gitea' ? 'Gitea server URL' : 'GitHub API URL'}
                  <input
                    className="input"
                    type="url"
                    name="baseUrl"
                    required
                    defaultValue={provider === 'github' ? 'https://api.github.com' : ''}
                    placeholder="https://git.example.com"
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
                />
              </label>
              <p className="settings-helper">
                Use a service account or token with read access to the repositories and issues your
                team needs. The Trestl server must be able to reach this address.
              </p>
            </>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save connection'}
          </button>
        </form>
      )}
      {!connections.length && !editing && (
        <p className="settings-helper">
          {admin
            ? 'Add a connection to find and import Git issues.'
            : 'An administrator can add a shared Git connection.'}
        </p>
      )}
      <div className="settings-connections">
        {connections.map((c) => (
          <div className="settings-connection" key={c.id}>
            <div className="settings-connection-heading">
              <div>
                <strong>{c.name}</strong>
                <span>
                  {c.authType === 'github-installation' ? 'GitHub App installation' : c.baseUrl}
                </span>
              </div>
              <span className="settings-badge">
                {c.shared ? 'Shared with everyone' : 'Legacy personal connection'}
              </span>
              {(admin || !c.shared) && (
                <div className="settings-connection-actions">
                  {(!c.authType || c.authType === 'token') && (
                    <button className="button" disabled={busy} onClick={() => setEditing(c)}>
                      Update token
                    </button>
                  )}
                  <button
                    className="button ghost"
                    disabled={busy}
                    onClick={() => setConfirmDelete(c.id)}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
            {confirmDelete === c.id && (
              <div className="settings-confirm">
                <span>
                  Disconnect {c.name}? Repository imports will stop. Existing work and links will
                  remain.
                </span>
                <button className="button" onClick={() => setConfirmDelete('')}>
                  Cancel
                </button>
                <button
                  className="button settings-danger"
                  disabled={busy}
                  onClick={() => void disconnect(c.id)}
                >
                  Disconnect connection
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
