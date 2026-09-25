import { useEffect, useState } from 'react';
import { Check, Terminal } from 'lucide-react';
import { api, post } from '../lib/api';
import { Brand } from './ui';

type Pending = { code: string; name: string; scope: 'read' | 'write'; expiresAt: string };
export default function CliLoginApproval({ email }: { email: string }) {
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  const [pending, setPending] = useState<Pending>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  useEffect(() => {
    if (!/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)) {
      setError('Invalid sign-in code. Start again from your terminal.');
      return;
    }
    let current = true;
    api<Pending>(`/auth/cli/${code}`)
      .then((value) => {
        if (current) setPending(value);
      })
      .catch((e: Error) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [code]);
  async function approve() {
    setBusy(true);
    setError('');
    try {
      await post('/auth/cli/approve', { code });
      setApproved(true);
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
      <main className="auth-card" aria-labelledby="cli-login-title">
        <div className="auth-symbol">{approved ? <Check size={23} /> : <Terminal size={23} />}</div>
        <h1 id="cli-login-title">{approved ? 'CLI approved' : 'Connect your terminal'}</h1>
        {approved ? (
          <>
            <p>
              Return to your terminal to finish signing in. You can revoke this token in Settings →
              API tokens.
            </p>
            <a className="button primary auth-submit" href="/">
              Open Trestl
            </a>
          </>
        ) : (
          <>
            <p>
              Signed in as <strong>{email}</strong>.
            </p>
            {pending ? (
              <>
                <p>Check that this code matches the one in your terminal:</p>
                <p
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 28,
                    letterSpacing: '0.12em',
                    textAlign: 'center',
                  }}
                >
                  <strong>{pending.code}</strong>
                </p>
                <p>
                  <strong>{pending.name}</strong> is requesting{' '}
                  {pending.scope === 'read'
                    ? 'read-only access to your accessible work.'
                    : 'permission to read and change your accessible work.'}
                </p>
                <p>
                  Only approve a sign-in you started. This access stays active until you revoke the
                  token or your account is disabled.
                </p>
                <button
                  className="button primary auth-submit"
                  disabled={busy}
                  onClick={() => void approve()}
                >
                  {busy ? 'Approving…' : 'Approve CLI access'}
                </button>
              </>
            ) : (
              !error && <p>Checking your sign-in request…</p>
            )}
            {error && <p role="alert">{error}</p>}
            <a className="button auth-submit" href="/">
              Cancel
            </a>
          </>
        )}
      </main>
    </div>
  );
}
