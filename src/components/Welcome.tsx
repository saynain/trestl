import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, FolderTree, GitBranch, LoaderCircle, Users } from 'lucide-react';
import type { Project } from '../../shared/types';
import { post } from '../lib/api';
import { navigate, projectKey } from '../lib/model';
import { Brand, SetupSteps } from './ui';

/**
 * The end of first-run setup: a first project, then optional links to existing settings.
 * The created project lives in the URL, so Back and reload return to the last step.
 */
export default function Welcome({
  project,
  refresh,
}: {
  project?: Project;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await post<Project>('/projects', { name: name.trim(), key });
      await refresh();
      window.location.replace(`#/welcome/${created.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-brand">
        <Brand />
      </div>
      <main className="auth-card">
        <SetupSteps current={project ? 3 : 2} />
        {project ? (
          <>
            <div className="auth-symbol">
              <Check size={23} />
            </div>
            <h1>{project.name} is ready.</h1>
            <p>Add work to it next. These can wait until you need them.</p>
            <nav className="setup-next" aria-label="Optional next steps">
              <a href="#/settings?tab=integrations">
                <GitBranch size={17} />
                <span>
                  Connect GitHub or Gitea
                  <small>Bring repository issues into your projects.</small>
                </span>
              </a>
              <a href="#/settings?tab=people">
                <Users size={17} />
                <span>
                  Add your team
                  <small>Create accounts for the people you work with.</small>
                </span>
              </a>
            </nav>
            <button
              className="button primary auth-submit"
              autoFocus
              onClick={() => navigate('project', project.id)}
            >
              Open {project.name}
              <ArrowRight size={16} />
            </button>
          </>
        ) : (
          <>
            <div className="auth-symbol">
              <FolderTree size={23} />
            </div>
            <h1>Create your first project.</h1>
            <p>A project holds the work for a product, a service or an ongoing responsibility.</p>
            <form onSubmit={submit}>
              <label className="field">
                Project name
                <input
                  className="input"
                  required
                  autoFocus
                  maxLength={160}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!keyEdited) setKey(projectKey(e.target.value));
                  }}
                  placeholder="e.g. Web app"
                />
              </label>
              <label className="field">
                Identifier prefix
                <input
                  className="input"
                  required
                  pattern="[A-Z][A-Z0-9]{1,9}"
                  title="2–10 letters or digits, starting with a letter"
                  maxLength={10}
                  value={key}
                  onChange={(e) => {
                    setKeyEdited(true);
                    setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
                  }}
                  placeholder="WEB"
                  aria-describedby="welcome-key-hint"
                />
                <small id="welcome-key-hint" className="muted">
                  Work items are numbered {key || 'WEB'}-01, {key || 'WEB'}-02 and so on.
                </small>
              </label>
              {error && (
                <div role="alert" className="form-error">
                  {error}
                </div>
              )}
              <button disabled={busy} className="button primary auth-submit">
                {busy ? <LoaderCircle size={17} className="spin" /> : null}
                Create project
                <ArrowRight size={16} />
              </button>
            </form>
            <button className="profile-mode setup-skip" onClick={() => navigate('home')}>
              Skip for now
            </button>
          </>
        )}
      </main>
    </div>
  );
}
