import { Select } from './Select';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Link2, Loader2, Search, Settings } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/context';
import { navigate } from '../lib/model';
import { GitHubIcon, Modal } from './ui';
import type { GitConnection } from './GitSettings';
import type { Repository } from './ProjectRepositories';
import './item.css';
interface Issue {
  title: string;
  description: string;
  externalUrl: string;
  repository: string;
  number: number;
  closed: boolean;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not look up this issue.';
export default function GitIssueSearch({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { data, refresh, toast } = useApp();
  const [connections, setConnections] = useState<GitConnection[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [reference, setReference] = useState('');
  const [issue, setIssue] = useState<Issue | null>(null);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkedUrl, setLinkedUrl] = useState('');
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    Promise.all([
      api<GitConnection[]>('/git/connections', { signal: controller.signal }),
      api<{ data: Repository[] }>(`/projects/${projectId}/repositories`, {
        signal: controller.signal,
      }).catch(() => ({ data: [] })),
    ])
      .then(([result, repositories]) => {
        if (!controller.signal.aborted) {
          // Start from the project's default repository when its connection is available.
          const preferred = repositories.data.find(
            (repository) =>
              repository.isDefault &&
              result.some((connection) => connection.id === repository.connection?.id),
          );
          setConnections(result);
          setConnectionId(preferred?.connection?.id ?? result[0]?.id ?? '');
          if (preferred) setReference((current) => current || `${preferred.repository}#`);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(message(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [attempt, projectId]);
  function reset() {
    request.current?.abort();
    setIssue(null);
    setBusy(false);
    setError('');
  }
  async function lookup(event: FormEvent) {
    event.preventDefault();
    reset();
    const match = reference.trim().match(/^([\w.-]+\/[\w.-]+)\s*#([1-9]\d*)$/);
    if (!match) {
      setError('Use owner/repository#123, including the issue number.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const result = await api<Issue>(
        `/git/connections/${encodeURIComponent(connectionId)}/issue?repository=${encodeURIComponent(match[1])}&number=${match[2]}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setIssue(result);
    } catch (error) {
      if (!controller.signal.aborted) setError(message(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function link() {
    if (!issue || linking) return;
    setLinking(true);
    setError('');
    try {
      await post('/links', {
        projectId,
        itemId: null,
        title: `${issue.repository}#${issue.number} · ${issue.title}`,
        url: issue.externalUrl,
        kind: 'repository',
      });
      setLinkedUrl(issue.externalUrl);
      await refresh();
      toast('Issue linked to project');
    } catch (error) {
      setError(message(error));
    } finally {
      setLinking(false);
    }
  }
  const linked =
    !!issue &&
    (linkedUrl === issue.externalUrl ||
      data.links.some((link) => link.projectId === projectId && link.url === issue.externalUrl));
  return (
    <Modal title="Find Git issue" onClose={onClose} wide className="confluence-search-modal">
      <div className="confluence-search-content">
        {loading ? (
          <div className="confluence-search-empty" role="status">
            <Loader2 className="spin" size={23} />
            <p>Loading your Git connections…</p>
          </div>
        ) : loadError ? (
          <div className="confluence-search-empty">
            <div className="form-error" role="alert">
              {loadError}
            </div>
            <button className="button" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : !connections.length ? (
          <div className="confluence-search-empty">
            <GitHubIcon size={25} />
            <h3>Connect your Git account</h3>
            <p>Save a GitHub or Gitea token once to reference issues in all your projects.</p>
            <button
              className="button primary"
              onClick={() => {
                onClose();
                navigate('settings', undefined, 'integrations');
              }}
            >
              <Settings size={14} />
              Connect in settings
            </button>
          </div>
        ) : (
          <>
            <form className="settings-form" onSubmit={lookup}>
              <label className="field">
                Git connection
                <Select
                  className="select"
                  value={connectionId}
                  disabled={linking}
                  onChange={(e) => {
                    reset();
                    setConnectionId(e.target.value);
                  }}
                >
                  {connections.map((connection) => (
                    <option value={connection.id} key={connection.id}>
                      {connection.name} · {connection.provider === 'github' ? 'GitHub' : 'Gitea'}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="field">
                Issue reference
                <input
                  autoFocus
                  className="input"
                  required
                  maxLength={320}
                  placeholder="owner/repository#123"
                  value={reference}
                  disabled={linking}
                  onChange={(e) => {
                    reset();
                    setReference(e.target.value);
                  }}
                />
              </label>
              <div className="settings-form-actions">
                <button className="button primary" disabled={busy || linking || !reference.trim()}>
                  {busy ? <Loader2 size={14} className="spin" /> : <Search size={14} />}Find issue
                </button>
              </div>
            </form>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {issue && (
              <article className="confluence-search-result">
                <div className="confluence-result-heading">
                  <GitHubIcon size={17} />
                  <a href={issue.externalUrl} target="_blank" rel="noopener noreferrer">
                    {issue.title}
                    <ArrowUpRight size={13} />
                  </a>
                </div>
                <p className="muted">
                  {issue.repository} #{issue.number} · {issue.closed ? 'Closed' : 'Open'}
                </p>
                <p className="confluence-result-excerpt">
                  {issue.description || 'No description.'}
                </p>
                <div className="confluence-result-actions">
                  <button
                    className="button"
                    disabled={linked || linking}
                    onClick={() => void link()}
                  >
                    {linked ? (
                      <Check size={14} />
                    ) : linking ? (
                      <Loader2 className="spin" size={14} />
                    ) : (
                      <Link2 size={14} />
                    )}
                    {linked ? 'Linked to project' : 'Link to project'}
                  </button>
                </div>
              </article>
            )}
            <footer className="confluence-search-footer">
              Your token controls which issues you can read. Linking shares the issue title and URL
              with project members. The issue stays in GitHub or Gitea.
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
