import { useState, type FormEvent } from 'react';
import { patch } from '../lib/api';
import { useApp } from '../lib/context';

export default function WorkspaceGeneral() {
  const { data, refresh, toast } = useApp();
  const workspace = data.workspace;
  const canRename = data.user.role === 'admin';
  const [name, setName] = useState(workspace?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function rename(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await patch('/workspaces/current', { name: name.trim() });
      await refresh();
      toast('Installation renamed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename workspace');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>General</h2>
      <p>The name and details shared with your team.</p>
      {canRename ? (
        <form className="settings-form" onSubmit={rename}>
          <label className="field">
            Installation name
            <input
              className="input"
              value={name}
              required
              maxLength={80}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="settings-helper">Changing this name updates it for everyone.</p>
          <div className="settings-form-actions">
            <button
              className="button primary"
              disabled={busy || !name.trim() || name.trim() === workspace?.name}
            >
              {busy ? 'Saving…' : 'Save name'}
            </button>
          </div>
        </form>
      ) : (
        <div className="settings-workspace-name">
          <strong>{workspace?.name}</strong>
          <span>An administrator can change this name.</span>
        </div>
      )}
      <dl className="settings-workspace-details">
        <>
          <div>
            <dt>Your role</dt>
            <dd>
              {workspace?.ownerId === data.user.id
                ? 'Owner'
                : data.user.role === 'admin'
                  ? 'Administrator'
                  : 'Member'}
            </dd>
          </div>
          <div>
            <dt>Members</dt>
            <dd>
              <a href="#/settings?tab=people">
                {data.users.length} {data.users.length === 1 ? 'member' : 'members'}
              </a>
            </dd>
          </div>
        </>
      </dl>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
