import { useState } from 'react';
import { patch, post } from '../lib/api';
import { useApp } from '../lib/context';
import { Avatar } from './ui';

export default function WorkspacePeople() {
  const { data, refresh, toast } = useApp();
  const workspace = data.workspace;
  const external = data.authMode !== 'local';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const admin = data.user.role === 'admin';
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
      toast(message);
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
          <h2>People</h2>
          <p>
            {external
              ? 'Approved colleagues join through your organization’s sign-in. Manage their roles and access here.'
              : `People with access to ${workspace?.name}.`}
          </p>
        </div>
      </div>
      <h3>
        Members <span className="settings-count">{data.users.length}</span>
      </h3>
      <div className="settings-member-list">
        {data.users.map((user) => (
          <div className="settings-member" key={user.id}>
            <Avatar user={user} size={32} />
            <div>
              <strong>
                {user.name}
                {user.id === data.user.id && ' (you)'}
              </strong>
              <span>
                {user.email}
                {user.disabledAt ? ' · Disabled' : ''}
              </span>
            </div>
            {admin && user.id !== workspace?.ownerId ? (
              <>
                <select
                  aria-label={`Role for ${user.name}`}
                  className="input"
                  style={{ width: 'auto' }}
                  value={user.role}
                  disabled={busy}
                  onChange={(e) =>
                    void act(
                      () =>
                        patch(`/workspaces/current/members/${user.id}`, {
                          role: e.target.value,
                        }),
                      'Role updated',
                    )
                  }
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  className="button ghost"
                  disabled={busy}
                  onClick={() => {
                    if (user.disabledAt)
                      void act(
                        () => patch(`/users/${user.id}/access`, { disabled: false }),
                        'Account enabled',
                      );
                    else setRemoving(user.id);
                  }}
                >
                  {user.disabledAt ? 'Enable' : 'Disable'}
                </button>
              </>
            ) : (
              <span className="settings-badge">
                {user.id === workspace?.ownerId ? 'owner' : user.role}
              </span>
            )}
          </div>
        ))}
      </div>
      {removing && (
        <div className="settings-form">
          <p>
            Disable {data.users.find((u) => u.id === removing)?.name}? They will lose access and all
            their API tokens will be revoked. Their work will remain.
          </p>
          <button className="button" disabled={busy} onClick={() => setRemoving(null)}>
            Cancel
          </button>
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await patch(`/users/${removing}/access`, { disabled: true });
                setRemoving(null);
              }, 'Account disabled and tokens revoked')
            }
          >
            Disable account
          </button>
        </div>
      )}
      {admin && !external && (
        <>
          <h3>Add a person</h3>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const values = new FormData(form);
              void act(async () => {
                await post('/users', {
                  name: values.get('name'),
                  email: values.get('email'),
                  password: values.get('password'),
                  role: values.get('role'),
                });
                form.reset();
              }, 'Account created');
            }}
          >
            <div className="settings-form-grid">
              <label className="field">
                Name
                <input className="input" name="name" required maxLength={80} />
              </label>
              <label className="field">
                Email
                <input className="input" name="email" type="email" required />
              </label>
              <label className="field">
                Initial password
                <input
                  className="input"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={10}
                  maxLength={200}
                />
              </label>
              <label className="field">
                Role
                <select className="input" name="role">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <p className="settings-helper">
              Share the initial password privately. They can change it in Account settings after
              signing in.
            </p>
            <button className="button primary" disabled={busy}>
              Create account
            </button>
          </form>
        </>
      )}
      {!admin && (
        <p className="settings-helper">An administrator can manage people and their access.</p>
      )}
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </section>
  );
}
