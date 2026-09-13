import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  ExternalLink,
  Github,
  GitPullRequest,
  Loader2,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { api, patch, post, remove } from '../lib/api';
import { useApp } from '../lib/context';
import { statuses } from '../lib/model';
import {
  githubEventLabels,
  type GitHubEvent,
  type GitHubRepository,
  type GitHubRules,
} from '../../shared/github';
import type { GitConnection } from './GitSettings';
import './github.css';

interface ManagedApp {
  id: string;
  name: string;
  owner: string;
  mode: 'webhook' | 'polling';
  origin: string;
  installUrl: string;
  settingsUrl: string;
  lastWebhookAt: string | null;
}
interface Setup {
  origin: string;
  problem: string | null;
  apps: ManagedApp[];
}
type AvailableRepo = { id: number; repository: string; defaultBranch: string; private: boolean };
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please retry.';

export default function GitHubSettings({
  onChange,
  connectionsKey,
}: {
  onChange: () => void;
  connectionsKey: string;
}) {
  const { data, toast, refresh } = useApp();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [installations, setInstallations] = useState<
    Record<string, { id: string; account: string; suspended: boolean }[]>
  >({});
  const [selectedConnection, setSelectedConnection] = useState('');
  const [available, setAvailable] = useState<AvailableRepo[]>([]);
  const [adding, setAdding] = useState(false);
  const [removeApp, setRemoveApp] = useState('');
  async function load() {
    const [next, git, repos] = await Promise.all([
      api<Setup>('/admin/github-apps'),
      api<GitConnection[]>('/git/connections'),
      api<GitHubRepository[]>('/github/repositories'),
    ]);
    setSetup(next);
    setConnections(git.filter((c) => c.development));
    setRepositories(repos);
  }
  useEffect(() => {
    void load().catch((e) => setError(errorText(e)));
  }, [connectionsKey]);
  async function action(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await action('create', async () => {
      const result = await post<{ action: string; manifest: object }>('/admin/github-apps/start', {
        name: values.get('name'),
        owner: values.get('owner'),
        ownerType: values.get('ownerType'),
        mode: values.get('mode'),
        issueWrite: values.get('issueWrite') === 'on',
        multipleOwners: values.get('multipleOwners') === 'on',
      });
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = result.action;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = JSON.stringify(result.manifest);
      form.append(input);
      document.body.append(form);
      form.submit();
      form.remove();
    });
  }
  async function chooseConnection(id: string) {
    setSelectedConnection(id);
    setAvailable([]);
    if (!id) return;
    await action('repositories', async () =>
      setAvailable(await api<AvailableRepo[]>(`/github/connections/${id}/repositories`)),
    );
  }
  async function connectRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await action('connect-repository', async () => {
      await post('/github/repositories', {
        connectionId: selectedConnection,
        repository: values.get('repository'),
        projectId: values.get('projectId'),
      });
      setAdding(false);
      await load();
      toast('Repository connected. Development activity will sync automatically.');
    });
  }
  return (
    <section className="settings-section github-settings" aria-label="GitHub integration">
      <div className="settings-section-header">
        <div className="github-heading">
          <span className="github-logo">
            <Github size={26} />
          </span>
          <div>
            <h2>GitHub</h2>
            <p>From the first branch to the merged pull request.</p>
          </div>
        </div>
        <button className="button" onClick={() => setCreating(!creating)} disabled={!!busy}>
          {creating ? (
            'Cancel setup'
          ) : (
            <>
              <Plus size={14} />
              {setup?.apps.length ? 'Create another app' : 'Connect GitHub'}
            </>
          )}
        </button>
      </div>
      <p className="settings-helper">
        Create a GitHub App owned by you, connected directly to this Trestl installation. Your
        team’s tasks stay in step with development.
      </p>
      {error && (
        <div role="alert" className="settings-error">
          {error}
        </div>
      )}
      {!setup && !error && (
        <p role="status">
          <Loader2 size={16} className="settings-spin" /> Loading GitHub settings…
        </p>
      )}
      {setup?.problem && (
        <p className="settings-error" role="alert">
          {setup.problem}
        </p>
      )}
      {creating && setup && (
        <form className="github-wizard" onSubmit={start}>
          <ol className="github-steps" aria-label="Connection steps">
            <li aria-current="step">
              <span>1</span>Create your app
            </li>
            <li>
              <span>2</span>Choose repositories
            </li>
            <li>
              <span>3</span>Connect projects
            </li>
          </ol>
          <h3>A GitHub App for {data.workspace?.name ?? 'your workspace'}</h3>
          <p>
            We’ll prepare the settings. You’ll confirm the app on GitHub, then return here to finish
            connecting.
          </p>
          <div className="settings-form-grid">
            <label className="field">
              App belongs to
              <select className="input" name="ownerType" defaultValue="organization">
                <option value="organization">A GitHub organization</option>
                <option value="personal">My personal GitHub account</option>
              </select>
            </label>
            <label className="field">
              GitHub owner
              <input
                className="input"
                name="owner"
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9-]*"
                maxLength={39}
                placeholder="your-organization"
                autoComplete="off"
              />
            </label>
          </div>
          <label className="field">
            App name
            <input
              className="input"
              name="name"
              required
              maxLength={34}
              defaultValue={`Trestl - ${data.workspace?.name ?? 'My workspace'}`.slice(0, 34)}
            />
            <small>GitHub requires a unique app name. You can adjust it on the next screen.</small>
          </label>
          <fieldset className="github-delivery">
            <legend>How should updates arrive?</legend>
            <label>
              <input
                type="radio"
                name="mode"
                value="webhook"
                defaultChecked={setup.origin.startsWith('https:')}
              />
              <span>
                <strong>As activity happens</strong>
                <small>
                  GitHub sends events directly to your server. The webhook endpoint must be
                  reachable from GitHub.
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                value="polling"
                defaultChecked={!setup.origin.startsWith('https:')}
              />
              <span>
                <strong>Check periodically</strong>
                <small>
                  For a private network, VPN, or local installation. Trestl checks GitHub every five
                  minutes.
                </small>
              </span>
            </label>
          </fieldset>
          <label className="settings-checkbox">
            <input type="checkbox" name="issueWrite" />
            <span>Allow two-way issue updates and posting comments to GitHub</span>
          </label>
          <div className="github-permissions">
            <strong>Access this app requests</strong>
            <p>
              Read issues, pull requests, branches, commits, and check results in the repositories
              you select. The option above additionally requests issue write access; two-way sync is
              enabled separately for each import. Repository access is shared with everyone in this
              Trestl installation.
            </p>
            <small>
              Connects to <code>{setup.origin || 'your Trestl address'}</code>
            </small>
          </div>
          <label className="settings-checkbox">
            <input type="checkbox" name="multipleOwners" />
            <span>Allow installing this app on other GitHub accounts or organizations</span>
          </label>
          <div className="settings-form-actions">
            <button className="button" type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="button primary" disabled={!!busy || !!setup.problem}>
              {busy === 'create' ? (
                <Loader2 size={14} className="settings-spin" />
              ) : (
                <Github size={15} />
              )}
              Create app on GitHub
              <ExternalLink size={13} />
            </button>
          </div>
        </form>
      )}
      {!creating && setup && !setup.apps.length && !setup.problem && (
        <div className="github-empty">
          <GitPullRequest size={28} />
          <div>
            <strong>Connect code to the work it belongs to</strong>
            <p>
              Link pull requests using task IDs, see reviews and checks, and move tasks forward
              automatically.
            </p>
            <code>fixes APP-123</code>
          </div>
        </div>
      )}
      {setup?.apps.map((saved) => {
        const connected = connections.filter(
          (c) => c.githubInstallation?.managedAppId === saved.id,
        );
        return (
          <div className="github-app-card" key={saved.id}>
            <div className="github-card-heading">
              <div>
                <strong>{saved.name}</strong>
                <p>
                  Owned by {saved.owner} ·{' '}
                  {saved.mode === 'webhook'
                    ? 'Webhooks + periodic reconciliation'
                    : 'Periodic updates'}
                </p>
              </div>
              <span className="settings-badge">
                {connected.length ? (
                  <>
                    <Check size={12} /> Connected
                  </>
                ) : (
                  'App created'
                )}
              </span>
            </div>
            {saved.mode === 'webhook' && (
              <p className="settings-helper">
                {saved.lastWebhookAt
                  ? `Last event received ${new Date(saved.lastWebhookAt).toLocaleString()}`
                  : 'Waiting for the first GitHub event. Periodic updates keep your connection working.'}
              </p>
            )}
            {!connected.length && (
              <p>
                Your app is ready. Install it on GitHub and choose the repositories Trestl can
                access.
              </p>
            )}
            <div className="github-actions">
              <a className="button" href={saved.installUrl}>
                Install / choose repositories
                <ExternalLink size={13} />
              </a>
              <button
                className="button"
                disabled={!!busy}
                onClick={() =>
                  void action(saved.id, async () => {
                    const result = await api<{ id: string; account: string; suspended: boolean }[]>(
                      `/admin/github-apps/${saved.id}/installations`,
                    );
                    setInstallations((previous) => ({ ...previous, [saved.id]: result }));
                  })
                }
              >
                {busy === saved.id ? (
                  <Loader2 size={14} className="settings-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                Check installation
              </button>
              <a href={saved.settingsUrl} className="button ghost" target="_blank" rel="noreferrer">
                App settings
                <ExternalLink size={12} />
              </a>
              {!connected.length && (
                <button
                  className="button ghost"
                  disabled={!!busy}
                  onClick={() => setRemoveApp(saved.id)}
                >
                  Remove saved app
                </button>
              )}
            </div>
            {removeApp === saved.id && (
              <div className="settings-confirm">
                <span>Remove the saved credentials? The app remains in your GitHub account.</span>
                <button className="button" onClick={() => setRemoveApp('')}>
                  Cancel
                </button>
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    void action('remove-app', async () => {
                      await remove(`/admin/github-apps/${saved.id}`);
                      setRemoveApp('');
                      await load();
                    })
                  }
                >
                  Remove credentials
                </button>
              </div>
            )}
            {installations[saved.id]?.length === 0 && (
              <p role="status" className="settings-helper">
                No installations yet. Complete installation on GitHub, then check again. Your
                organization may need to approve it.
              </p>
            )}
            {installations[saved.id]?.map((installation) => (
              <div className="github-install-row" key={installation.id}>
                <span>
                  <Github size={14} />
                  {installation.account}
                  {installation.suspended ? ' · Suspended on GitHub' : ''}
                </span>
                <button
                  className="button primary"
                  disabled={!!busy || installation.suspended}
                  onClick={() =>
                    void action(`connect-${installation.id}`, async () => {
                      await post(`/admin/github-apps/${saved.id}/connect`, {
                        installationId: installation.id,
                      });
                      await load();
                      onChange();
                      setAdding(true);
                      toast('GitHub connected. Choose a repository and project.');
                    })
                  }
                >
                  {connected.some((c) => c.githubInstallation?.account === installation.account)
                    ? 'Refresh connection'
                    : 'Connect installation'}
                </button>
              </div>
            ))}
          </div>
        );
      })}
      {!!connections.length && (
        <div className="github-projects">
          <div className="settings-section-header">
            <div>
              <h3>Repositories & workflows</h3>
              <p>
                One project can use several repositories. Task IDs determine which work is linked.
              </p>
            </div>
            <button className="button" disabled={!!busy} onClick={() => setAdding(!adding)}>
              {adding ? (
                'Cancel'
              ) : (
                <>
                  <Plus size={14} />
                  Connect repository
                </>
              )}
            </button>
          </div>
          {adding && (
            <form className="settings-form" onSubmit={connectRepository}>
              <label className="field">
                GitHub connection
                <select
                  className="input"
                  required
                  value={selectedConnection}
                  onChange={(e) => void chooseConnection(e.target.value)}
                  disabled={!!busy}
                >
                  <option value="">Choose a connection</option>
                  {connections.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {busy === 'repositories' && <p role="status">Loading repositories…</p>}
              <div className="settings-form-grid">
                <label className="field">
                  Repository
                  <select
                    className="input"
                    name="repository"
                    required
                    disabled={!available.length || !!busy}
                  >
                    <option value="">Choose a repository</option>
                    {available.map((r) => (
                      <option key={r.id} value={r.repository}>
                        {r.repository}
                        {r.private ? ' · Private' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Trestl project
                  <select className="input" name="projectId" required>
                    <option value="">Choose a project</option>
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.key})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {selectedConnection && !available.length && !busy && (
                <p className="settings-helper">
                  No repositories found. Update repository access on GitHub and select the
                  connection again.
                </p>
              )}
              {!data.projects.length && (
                <p className="settings-helper">
                  Create a Trestl project before connecting a repository.
                </p>
              )}
              <button
                className="button primary"
                disabled={!!busy || !available.length || !data.projects.length}
              >
                Connect repository
              </button>
            </form>
          )}
          {repositories.map((repo) => (
            <RepositoryCard
              key={repo.id}
              repo={repo}
              projectName={data.projects.find((p) => p.id === repo.projectId)?.name ?? 'Project'}
              disabled={!!busy}
              save={(changes) =>
                action(repo.id, async () => {
                  await patch(`/github/repositories/${repo.id}`, changes);
                  await load();
                  toast('GitHub workflow updated');
                })
              }
              sync={() =>
                action(repo.id, async () => {
                  await post(`/github/repositories/${repo.id}/sync`, {});
                  await Promise.all([load(), refresh()]);
                  toast('GitHub activity synchronized');
                })
              }
              disconnect={() =>
                action(repo.id, async () => {
                  await remove(`/github/repositories/${repo.id}`);
                  await load();
                  toast('Repository disconnected');
                })
              }
            />
          ))}
          {!repositories.length && !adding && (
            <p className="settings-helper">
              Connect a repository to start linking pull requests to tasks.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function RepositoryCard({
  repo,
  projectName,
  disabled,
  save,
  sync,
  disconnect,
}: {
  repo: GitHubRepository;
  projectName: string;
  disabled: boolean;
  save: (changes: Pick<GitHubRepository, 'branches' | 'rules' | 'enabled'>) => Promise<void>;
  sync: () => Promise<void>;
  disconnect: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rules = Object.fromEntries(
      Object.keys(githubEventLabels).map((key) => [key, form.get(key) || null]),
    ) as GitHubRules;
    await save({
      branches: String(form.get('branches')),
      rules,
      enabled: form.get('enabled') === 'on',
    });
  }
  return (
    <div className="github-repo-card">
      <div className="github-card-heading">
        <div>
          <strong>{repo.repository}</strong>
          <p>
            {projectName} · {repo.enabled ? 'Active' : 'Paused'}
          </p>
        </div>
        <div className="github-actions">
          <button
            className="button"
            disabled={disabled || !repo.enabled}
            onClick={() => void sync()}
          >
            <RefreshCw size={13} />
            Sync now
          </button>
          <button className="button" onClick={() => setEditing(!editing)}>
            {editing ? 'Close workflow' : 'Workflow'}
          </button>
        </div>
      </div>
      <p className="settings-helper">
        {repo.lastSyncedAt
          ? `Last synced ${new Date(repo.lastSyncedAt).toLocaleString()}`
          : 'Waiting for the first sync'}
      </p>
      {repo.lastError && (
        <p role="alert" className="settings-error">
          {repo.lastError}
        </p>
      )}
      {editing && (
        <form
          className="github-workflow"
          onSubmit={submit}
          key={JSON.stringify(repo.rules) + repo.branches + repo.enabled}
        >
          <label className="settings-checkbox">
            <input name="enabled" type="checkbox" defaultChecked={repo.enabled} />
            Enable synchronization and status automation
          </label>
          <label className="field">
            Target branches
            <input
              className="input"
              name="branches"
              required
              maxLength={500}
              defaultValue={repo.branches}
            />
            <small>
              Use * for all branches, or comma-separated patterns such as main, release/*.
            </small>
          </label>
          <div className="github-rules">
            {(Object.keys(githubEventLabels) as GitHubEvent[]).map((event) => (
              <label key={event}>
                <span>{githubEventLabels[event]}</span>
                <span aria-hidden="true">→</span>
                <select
                  className="input"
                  name={event}
                  defaultValue={repo.rules[event] ?? ''}
                  aria-label={`${githubEventLabels[event]} status`}
                >
                  <option value="">No status change</option>
                  {statuses.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="settings-helper">
            A merged PR can complete a task once no other linked closing PR is open. Related
            references never change status. Approval means a reviewer approved; repository merge
            requirements are still enforced by GitHub.
          </p>
          <div className="settings-form-actions">
            <button className="button ghost" type="button" onClick={() => setConfirm(true)}>
              Disconnect repository
            </button>
            <button className="button primary" disabled={disabled}>
              Save workflow
            </button>
          </div>
        </form>
      )}
      {confirm && (
        <div className="settings-confirm">
          <span>Stop synchronization for {repo.repository}? Tasks and activity remain.</span>
          <button className="button" onClick={() => setConfirm(false)}>
            Cancel
          </button>
          <button className="button" disabled={disabled} onClick={() => void disconnect()}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
