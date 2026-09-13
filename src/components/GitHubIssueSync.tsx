import { useState } from 'react';
import type { WorkItem } from '../../shared/types';
import { api, post } from '../lib/api';
import { useApp } from '../lib/context';

interface Conflict {
  local: { title: string; description: string; labels: string[]; state: string };
  remote: Conflict['local'];
  fingerprint: string;
  revision: number;
}
export default function GitHubIssueSync({
  item,
  onChange,
}: {
  item: WorkItem;
  onChange: () => Promise<unknown>;
}) {
  const { toast, refresh } = useApp();
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  return (
    <>
      <button
        className="button ghost"
        disabled={busy || !item.source?.connected}
        onClick={() => setCommenting(!commenting)}
      >
        {commenting ? 'Cancel GitHub comment' : 'Comment on GitHub'}
      </button>
      {commenting && (
        <form
          className="github-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await post(`/github/items/${item.id}/issue-comments`, { body: comment, requestId });
              setComment('');
              setRequestId(crypto.randomUUID());
              setCommenting(false);
              await onChange();
              toast('Comment posted to GitHub');
            });
          }}
        >
          <label className="field">
            GitHub comment
            <textarea
              className="input"
              rows={4}
              value={comment}
              onChange={(event) => {
                setComment(event.target.value);
                setRequestId(crypto.randomUUID());
              }}
              required
              maxLength={40000}
            />
          </label>
          <p className="settings-helper">
            This comment will be posted to {item.source?.repository} #{item.source?.number} and
            visible to people with repository access.
          </p>
          <button className="button primary" disabled={busy}>
            Post comment to GitHub
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {item.source?.syncError && (
        <div className="github-conflict" role="status">
          <strong>GitHub sync needs your attention</strong>
          <p>{item.source.syncError}</p>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void act(async () =>
                setConflict(await api<Conflict>(`/github/items/${item.id}/issue-conflict`)),
              )
            }
          >
            Review both versions
          </button>
          {conflict && (
            <>
              <div className="github-conflict-versions">
                {(['local', 'remote'] as const).map((side) => (
                  <div key={side}>
                    <h4>{side === 'local' ? 'Trestl' : 'GitHub'}</h4>
                    <strong>{conflict[side].title}</strong>
                    <pre>{conflict[side].description || 'No description'}</pre>
                    <p>Labels: {conflict[side].labels.join(', ') || 'None'}</p>
                    <p>State: {conflict[side].state}</p>
                  </div>
                ))}
              </div>
              <p>
                Choosing Trestl publishes its version on the next sync. Choosing GitHub replaces
                these fields in Trestl.
              </p>
              <div className="github-actions">
                {(['local', 'remote'] as const).map((choice) => (
                  <button
                    key={choice}
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await post(`/github/items/${item.id}/issue-conflict`, {
                          choice,
                          fingerprint: conflict.fingerprint,
                          revision: conflict.revision,
                        });
                        setConflict(null);
                        await Promise.all([onChange(), refresh()]);
                        toast('Conflict resolved');
                      })
                    }
                  >
                    Use {choice === 'local' ? 'Trestl' : 'GitHub'} version
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
