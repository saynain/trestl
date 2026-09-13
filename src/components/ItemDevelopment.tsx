import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Plus,
  RefreshCw,
  Unlink,
} from 'lucide-react';
import type { WorkItem } from '../../shared/types';
import type { DevelopmentLink } from '../../shared/github';
import { api, patch, post, remove } from '../lib/api';
import { useApp } from '../lib/context';
import './github.css';

interface Development {
  branchName: string;
  repositories: { id: string; repository: string }[];
  links: DevelopmentLink[];
}
export default function ItemDevelopment({
  item,
  onChange,
}: {
  item: WorkItem;
  onChange: () => Promise<unknown>;
}) {
  const { data, toast, refresh } = useApp();
  const [publishOptions, setPublishOptions] = useState<{ id: string; repository: string }[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [development, setDevelopment] = useState<Development | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  async function load() {
    setDevelopment(await api<Development>(`/github/items/${item.id}`));
  }
  useEffect(() => {
    let active = true;
    setDevelopment(null);
    setError('');
    setAdding(false);
    Promise.all([
      api<Development>(`/github/items/${item.id}`),
      api<{ id: string; repository: string }[]>(`/github/items/${item.id}/publish-options`),
    ])
      .then(([value, options]) => {
        if (active) {
          setDevelopment(value);
          setPublishOptions(options);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [item.id, item.projectId, item.source?.integrationId]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await act(async () => {
      await post(`/github/items/${item.id}/pull-request`, {
        repositoryId: form.get('repositoryId'),
        number: Number(form.get('number')),
        closing: form.get('closing') === 'on',
      });
      setAdding(false);
      await Promise.all([load(), onChange(), refresh()]);
      toast('Pull request linked');
    });
  }
  if (!development || (!development.repositories.length && !publishOptions.length))
    return error ? (
      <p className="settings-error" role="alert">
        Development activity: {error}
      </p>
    ) : null;
  return (
    <section className="item-section github-development" aria-label="Development">
      <div className="item-section-heading">
        <h3>Development</h3>
        <div className="github-actions">
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => void act(load)}
            aria-label="Refresh development activity"
          >
            <RefreshCw size={13} />
          </button>
          <button
            className="button ghost"
            disabled={busy || !development.repositories.length}
            onClick={() => setAdding(!adding)}
          >
            <Plus size={13} />
            {adding ? 'Cancel' : 'Link PR'}
          </button>
        </div>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="github-branch">
        <GitBranch size={15} />
        <code>{development.branchName}</code>
        <button
          className="icon-button"
          aria-label="Copy branch name"
          onClick={() =>
            void act(async () => {
              await navigator.clipboard.writeText(development.branchName);
              setCopied(true);
              toast('Branch name copied');
            })
          }
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {['backlog', 'todo'].includes(item.status) && (
        <button
          className="button ghost"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await navigator.clipboard.writeText(development.branchName);
              await patch(`/items/${item.id}`, {
                status: 'in_progress',
                assigneeId: item.assigneeId ?? data.user.id,
                expectedRevision: item.revision ?? 0,
              });
              await Promise.all([onChange(), refresh()]);
              toast('Branch copied. Work started.');
            })
          }
        >
          Copy branch & start work
        </button>
      )}
      {!!publishOptions.length && (
        <button className="button ghost" disabled={busy} onClick={() => setPublishing(!publishing)}>
          {publishing ? 'Cancel publishing' : 'Publish as a GitHub issue'}
        </button>
      )}
      {publishing && (
        <form
          className="github-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void act(async () => {
              await post(`/github/items/${item.id}/publish`, {
                integrationId: form.get('integrationId'),
              });
              setPublishing(false);
              setPublishOptions([]);
              await Promise.all([onChange(), refresh()]);
              toast('Issue published to GitHub');
            });
          }}
        >
          <label className="field">
            Destination repository
            <select className="input" name="integrationId" required>
              {publishOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.repository}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-helper">
            Publish this task’s title, description, and labels to the selected repository. They will
            be visible to everyone with repository access and kept in sync. Internal discussions
            remain in Trestl.
          </p>
          <button className="button primary" disabled={busy}>
            Publish issue to GitHub
          </button>
        </form>
      )}
      {adding && (
        <form className="github-link-form" onSubmit={link}>
          <label className="field">
            Repository
            <select className="input" name="repositoryId" required>
              {development.repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.repository}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Pull request number
            <input
              className="input"
              name="number"
              type="number"
              min="1"
              max="2147483647"
              required
              placeholder="123"
            />
          </label>
          <label className="settings-checkbox">
            <input type="checkbox" name="closing" defaultChecked />
            Use this PR to move the task through its workflow
          </label>
          <button className="button primary" disabled={busy}>
            Link pull request
          </button>
        </form>
      )}
      <div className="github-development-links">
        {development.links.map((link) => {
          const Icon =
            link.kind === 'branch'
              ? GitBranch
              : link.kind === 'commit'
                ? GitCommitHorizontal
                : link.state === 'merged'
                  ? GitMerge
                  : GitPullRequest;
          return (
            <div className="github-development-row" key={link.id}>
              <a
                className={`github-development-link ${link.state}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                <Icon size={17} />
                <div>
                  <strong>{link.title}</strong>
                  <small>
                    {development.repositories.find((r) => r.id === link.repositoryId)?.repository}{' '}
                    {link.number ? `#${link.number}` : link.sha.slice(0, 7)} · {link.author}
                    {!link.closing ? ' · Related' : ''}
                  </small>
                  <span className="github-development-meta">
                    <span>{link.state}</span>
                    {link.review && <span>{link.review}</span>}
                    {link.checks && <span>{link.checks}</span>}
                  </span>
                </div>
                <ExternalLink size={12} />
              </a>
              <button
                className="icon-button"
                disabled={busy}
                aria-label={`Unlink ${link.title}`}
                title="Unlink development activity"
                onClick={() =>
                  void act(async () => {
                    await remove(`/github/items/${item.id}/links/${encodeURIComponent(link.id)}`);
                    await Promise.all([load(), onChange()]);
                    toast('Development link removed');
                  })
                }
              >
                <Unlink size={13} />
              </button>
            </div>
          );
        })}
      </div>
      {!development.links.length && (
        <p className="item-section-empty">
          Use <code>{item.identifier}</code> in a branch name or PR title, or{' '}
          <code>fixes {item.identifier}</code> in its description. Linked activity will appear here.
        </p>
      )}
    </section>
  );
}
