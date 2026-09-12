import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/context';
import { Select } from './Select';
type Settings = {
  mode: 'local' | 'google' | 'oidc' | 'proxy';
  origin: string;
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  linkExistingEmails: string[];
  clientSecretConfigured: boolean;
  proxySecretConfigured: boolean;
};
export default function AuthenticationSettings() {
  const { toast, refresh } = useApp();
  const [settings, setSettings] = useState<Settings | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Settings>('/admin/authentication')
      .then((s) => setSettings({ ...s, origin: s.origin || location.origin }))
      .catch((e) => setError(e.message));
  }, []);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!settings) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError('');
    try {
      const next = await api<Settings>('/admin/authentication', {
        method: 'PUT',
        body: JSON.stringify({
          mode: settings.mode,
          origin: settings.origin,
          issuer: settings.issuer,
          clientId: settings.clientId,
          allowedDomains: settings.allowedDomains.filter(Boolean),
          linkExistingEmails: settings.linkExistingEmails.filter(Boolean),
          ...(f.get('clientSecret') ? { clientSecret: f.get('clientSecret') } : {}),
          ...(f.get('proxySecret') ? { proxySecret: f.get('proxySecret') } : {}),
        }),
      });
      form.reset();
      setSettings(next);
      await refresh();
      toast('Authentication settings saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>Authentication</h2>
      <p>
        Choose how people sign in to this installation. The setup administrator keeps a local
        password for recovery.
      </p>
      {error && (
        <p role="alert" className="settings-error">
          {error}
        </p>
      )}
      {!settings ? (
        <p>Loading authentication settings…</p>
      ) : (
        <form className="settings-form" onSubmit={save}>
          <label className="field">
            Sign-in method
            <Select
              className="select"
              searchable={false}
              disabled={busy}
              value={settings.mode}
              onChange={(e) =>
                setSettings({ ...settings, mode: e.target.value as Settings['mode'] })
              }
            >
              <option value="local">Local accounts</option>
              <option value="google">Google</option>
              <option value="oidc">OpenID Connect (OIDC)</option>
              <option value="proxy">Trusted authentication proxy</option>
            </Select>
          </label>
          <label className="field">
            Installation URL
            <input
              className="input"
              type="url"
              required
              value={settings.origin}
              onChange={(e) => setSettings({ ...settings, origin: e.target.value })}
            />
          </label>
          {settings.mode === 'local' ? (
            <p>Create accounts in People. Each person signs in with their email and password.</p>
          ) : (
            <>
              <label className="field">
                Allowed email domains
                <input
                  className="input"
                  required
                  placeholder="example.com"
                  value={settings.allowedDomains.join(', ')}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      allowedDomains: e.target.value.split(',').map((s) => s.trim().toLowerCase()),
                    })
                  }
                />
              </label>
              <label className="field">
                Existing accounts approved for linking
                <input
                  className="input"
                  placeholder="Optional, comma-separated email addresses"
                  value={settings.linkExistingEmails.join(', ')}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      linkExistingEmails: e.target.value
                        .split(',')
                        .map((s) => s.trim().toLowerCase()),
                    })
                  }
                />
              </label>
              <p className="settings-helper">
                Only approve addresses whose existing account owners you have verified. New approved
                colleagues receive member access.
              </p>
              {settings.mode === 'proxy' ? (
                <>
                  <label className="field">
                    Shared proxy secret
                    <input
                      className="input"
                      name="proxySecret"
                      type="password"
                      autoComplete="new-password"
                      minLength={32}
                      required={!settings.proxySecretConfigured}
                      placeholder={
                        settings.proxySecretConfigured
                          ? 'Configured — leave blank to keep'
                          : 'At least 32 random characters'
                      }
                    />
                  </label>
                  <p className="settings-helper">
                    Configure the same secret in your proxy. It must replace incoming identity
                    headers and forward the authenticated user ID and email. See the deployment
                    guide for Traefik and oauth2-proxy.
                  </p>
                </>
              ) : (
                <>
                  {settings.mode === 'oidc' && (
                    <label className="field">
                      Issuer URL
                      <input
                        className="input"
                        type="url"
                        required
                        value={settings.issuer}
                        onChange={(e) => setSettings({ ...settings, issuer: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="field">
                    Client ID
                    <input
                      className="input"
                      required
                      value={settings.clientId}
                      onChange={(e) => setSettings({ ...settings, clientId: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    Client secret
                    <input
                      className="input"
                      type="password"
                      name="clientSecret"
                      autoComplete="new-password"
                      required={!settings.clientSecretConfigured}
                      placeholder={
                        settings.clientSecretConfigured
                          ? 'Configured — leave blank to keep'
                          : 'Provider client secret'
                      }
                    />
                  </label>
                  <label className="field">
                    Callback URL
                    <input
                      className="input"
                      readOnly
                      value={settings.origin + '/api/v1/auth/provider/callback'}
                    />
                  </label>
                  <p className="settings-helper">
                    Register this exact callback in your provider. Saving checks provider discovery;
                    use a separate browser session to test sign-in.
                  </p>
                </>
              )}
            </>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save authentication'}
          </button>
        </form>
      )}
    </section>
  );
}
