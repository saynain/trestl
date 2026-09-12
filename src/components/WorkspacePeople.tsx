import { useState } from 'react';
import { Plus } from 'lucide-react';
import { patch, post } from '../lib/api';
import { useApp } from '../lib/context';
import { Avatar, Modal } from './ui';
import { Select } from './Select';

export default function WorkspacePeople() {
  const { data, refresh, toast } = useApp();
  const workspace = data.workspace;
  const external = data.authMode !== 'local';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const disabledCount = data.users.filter((user) => user.disabledAt).length;
  const people = data.users
    .filter((user) =>
      status === 'all' ? true : status === 'disabled' ? !!user.disabledAt : !user.disabledAt,
    )
    .filter((user) =>
      `${user.name} ${user.email}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(!!a.disabledAt) - Number(!!b.disabledAt) ||
        a.name.localeCompare(b.name) ||
        a.email.localeCompare(b.email),
    );
  const removingUser = data.users.find((user) => user.id === removing);
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
        {admin && !external && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              setError('');
              setAdding(true);
            }}
          >
            <Plus size={15} aria-hidden="true" /> Add a person
          </button>
        )}
      </div>
      <div className="people-toolbar">
        <div className="people-filters" role="group" aria-label="Filter people by access">
          {(
            [
              ['all', 'All', data.users.length],
              ['active', 'Active', data.users.length - disabledCount],
              ['disabled', 'Disabled', disabledCount],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              className="button ghost"
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {label} <span className="settings-count">{count}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="input people-search"
          aria-label="Search people by name or email"
          placeholder="Search name or email…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="people-list-heading" aria-hidden="true">
        <span>Person</span>
        <span>Access</span>
        <span>Role</span>
        <span />
      </div>
      <div className="settings-member-list people-list">
        {people.map((user) => (
          <div className="settings-member people-member" key={user.id}>
            <Avatar user={user} size={32} />
            <div className="people-identity">
              <strong>
                {user.name}
                {user.id === data.user.id && <span className="settings-you"> (you)</span>}
              </strong>
              <span>{user.email}</span>
            </div>
            <span className={`people-access ${user.disabledAt ? 'is-disabled' : ''}`}>
              {user.disabledAt ? 'Disabled' : 'Active'}
            </span>
            {admin && user.id !== workspace?.ownerId ? (
              <Select
                aria-label={`Role for ${user.name} (${user.email})`}
                className="select people-role"
                searchable={false}
                value={user.role}
                disabled={busy || !!user.disabledAt}
                onChange={(e) =>
                  void act(
                    () => patch(`/workspaces/current/members/${user.id}`, { role: e.target.value }),
                    'Role updated',
                  )
                }
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            ) : (
              <span className="settings-badge people-role-badge">
                {user.id === workspace?.ownerId ? 'Owner' : user.role}
              </span>
            )}
            {admin && user.id !== workspace?.ownerId && user.id !== data.user.id ? (
              <button
                className="button ghost people-access-action"
                disabled={busy}
                aria-label={`${user.disabledAt ? 'Enable' : 'Disable'} ${user.name} (${user.email})`}
                onClick={() => {
                  if (user.disabledAt)
                    void act(
                      () => patch(`/users/${user.id}/access`, { disabled: false }),
                      'Account enabled',
                    );
                  else {
                    setError('');
                    setRemoving(user.id);
                  }
                }}
              >
                {user.disabledAt ? 'Enable' : 'Disable'}
              </button>
            ) : (
              <span className="people-protected">
                {user.id === workspace?.ownerId
                  ? 'Protected'
                  : user.id === data.user.id
                    ? 'Your account'
                    : ''}
              </span>
            )}
          </div>
        ))}
        {people.length === 0 && (
          <p className="people-empty" role="status">
            No people match your search or access filter.
          </p>
        )}
      </div>
      <p className="settings-helper">
        Disabled people cannot sign in or receive new assignments. Their existing work and
        assignments remain.
      </p>
      {removingUser && (
        <Modal
          title={`Disable ${removingUser.name}?`}
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
        >
          <div className="settings-form">
            <p>
              <strong>{removingUser.email}</strong> will lose access immediately. Their sessions
              will end and all their API tokens will be revoked.
            </p>
            <p>
              Existing work and assignments will remain, but they cannot receive new assignments.
              You can enable the account again later; revoked tokens will not be restored.
            </p>
            {error && (
              <p role="alert" className="settings-error">
                {error}
              </p>
            )}
            <div className="people-confirm-actions">
              <button className="button" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await patch(`/users/${removingUser.id}/access`, { disabled: true });
                    setRemoving(null);
                  }, 'Account disabled and tokens revoked')
                }
              >
                {busy ? 'Disabling…' : 'Disable account'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {admin && !external && adding && (
        <Modal
          title="Add a person"
          onClose={() => {
            if (!busy) setAdding(false);
          }}
        >
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
                setAdding(false);
                setQuery('');
                setStatus('all');
              }, 'Account created');
            }}
          >
            <div className="settings-form-grid">
              <label className="field">
                Name
                <input className="input" name="name" required maxLength={80} disabled={busy} />
              </label>
              <label className="field">
                Email
                <input className="input" name="email" type="email" required disabled={busy} />
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
                  disabled={busy}
                />
              </label>
              <label className="field">
                Role
                <Select
                  className="select"
                  name="role"
                  defaultValue="member"
                  searchable={false}
                  disabled={busy}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
              </label>
            </div>
            <p className="settings-helper">
              Share the initial password privately. They can change it in Account settings after
              signing in.
            </p>
            {error && (
              <p role="alert" className="settings-error">
                {error}
              </p>
            )}
            <div className="people-confirm-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? 'Creating…' : 'Create account'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {!admin && (
        <p className="settings-helper">An administrator can manage people and their access.</p>
      )}
      {error && !removing && !adding && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
    </section>
  );
}
