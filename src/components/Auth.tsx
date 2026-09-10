import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, LoaderCircle, LockKeyhole } from 'lucide-react';
import { post } from '../lib/api';
import { Brand } from './ui';
export default function Auth({ setup, onSuccess }: { setup: boolean; onSuccess: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [demo, setDemo] = useState(true);
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
        ...(setup ? { name, seedDemo: demo } : {}),
      });
      onSuccess();
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
        <div className="auth-symbol">
          <LockKeyhole size={23} />
        </div>
        <h1>{setup ? 'Make room for good work.' : 'Welcome back.'}</h1>
        <p>
          {setup
            ? 'Your projects, ideas, and everything in between. Set up your workspace to get started.'
            : 'A calmer place to pick up where you left off.'}
        </p>
        <form onSubmit={submit}>
          {setup && (
            <label className="field">
              Your name
              <input
                required
                autoFocus
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sindre"
                autoComplete="name"
              />
            </label>
          )}
          <label className="field">
            Email address
            <input
              className="input"
              type="email"
              autoFocus={!setup}
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
              minLength={setup ? 10 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={setup ? 'At least 10 characters' : 'Your password'}
              autoComplete={setup ? 'new-password' : 'current-password'}
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
            {setup ? 'Create workspace' : 'Sign in'}
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
