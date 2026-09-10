import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, LoaderCircle, LockKeyhole } from 'lucide-react';
import { post } from '../lib/api';
import { Brand } from './ui';
export default function Auth({
  setup,
  proxy = false,
  mode = 'local',
  installationName,
  onSuccess,
  defaultEmail = '',
  invitationName,
}: {
  setup: boolean;
  proxy?: boolean;
  mode?: 'local' | 'google' | 'oidc' | 'proxy';
  installationName?: string;
  onSuccess: () => void;
  defaultEmail?: string;
  invitationName?: string;
}) {
  const [siteName, setSiteName] = useState('');
  const [recovery, setRecovery] = useState(false);
  const creating = setup;
  const [name, setName] = useState('');
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post(`/auth/${setup ? 'setup' : 'login'}`, {
        email,
        password,
        ...(creating ? { name } : {}),
        ...(setup ? { seedDemo: demo, installationName: siteName } : {}),
      });
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!setup && (proxy || mode !== 'local') && !recovery)
    return (
      <div className="auth-page">
        <div className="auth-brand">
          <Brand />
        </div>
        <main className="auth-card">
          <div className="auth-symbol">
            <LockKeyhole size={23} />
          </div>
          <h1>Sign in to {installationName || 'Trestl'}</h1>
          <p>Use your organization’s sign-in to access this installation.</p>
          <a
            className="button primary auth-submit"
            href={
              proxy || mode === 'proxy' ? '/oauth2/start?rd=%2F' : '/api/v1/auth/provider/start'
            }
          >
            {mode === 'google' ? 'Continue with Google' : 'Continue to sign in'}{' '}
            <ArrowRight size={16} />
          </a>
          <button className="profile-mode" onClick={() => setRecovery(true)}>
            Administrator recovery login
          </button>
        </main>
      </div>
    );
  return (
    <div className="auth-page">
      <div className="auth-brand">
        <Brand />
      </div>
      <main className="auth-card">
        <div className="auth-symbol">
          <LockKeyhole size={23} />
        </div>
        <h1>
          {invitationName
            ? `Join ${invitationName}`
            : creating
              ? 'Set up your installation.'
              : `Sign in to ${installationName || 'Trestl'}.`}
        </h1>
        <p>
          {creating
            ? 'Give your installation a name and create its administrator account.'
            : 'A calmer place to pick up where you left off.'}
        </p>
        <form onSubmit={submit}>
          {setup && (
            <label className="field">
              Installation name
              <input
                className="input"
                required
                maxLength={80}
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="Your team or workspace"
                autoFocus
              />
            </label>
          )}
          {creating && (
            <label className="field">
              Your name
              <input
                required
                autoFocus={!setup}
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
              />
            </label>
          )}
          <label className="field">
            Email address
            <input
              className="input"
              type="email"
              autoFocus={!creating}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
            />
          </label>
          <label className="field">
            Password
            <input
              className="input"
              type="password"
              required
              minLength={creating ? 10 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={creating ? 'At least 10 characters' : 'Your password'}
              autoComplete={creating ? 'new-password' : 'current-password'}
            />
          </label>
          {setup && (
            <label className="check-field">
              <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
              <span>
                Start with example projects
                <small>
                  Explore platform work and team leadership. You can remove them anytime.
                </small>
              </span>
            </label>
          )}
          {error && (
            <div role="alert" className="form-error">
              {error}
            </div>
          )}
          <button disabled={busy} className="button primary auth-submit">
            {busy ? <LoaderCircle size={17} className="spin" /> : null}
            {creating ? 'Create installation' : 'Sign in'}
            <ArrowRight size={16} />
          </button>
        </form>
        <div className="auth-note">
          <Check size={14} />
          {setup ? 'Self-hosted. Your data stays yours.' : 'Built for the way you work.'}
        </div>
      </main>
      <div className="auth-footer">A steady place for work.</div>
    </div>
  );
}
