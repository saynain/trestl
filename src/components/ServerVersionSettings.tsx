import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { ServerVersion } from '../../shared/server-version';
import { api } from '../lib/api';

const labels: Record<ServerVersion['status'], string> = {
  'up-to-date': 'Up to date',
  'update-available': 'Update available',
  unreleased: 'Development or unreleased build',
  unknown: 'Update status unknown',
};
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Not available');

export default function ServerVersionSettings() {
  const [version, setVersion] = useState<ServerVersion | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<ServerVersion>('/admin/version')
      .then((result) => {
        if (active) setVersion(result);
      })
      .catch(() => {
        if (active) setError('Could not load the server version. Try again.');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      setVersion(await api<ServerVersion>('/admin/version?refresh=true'));
    } catch {
      setError('Could not refresh the server version. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-busy={busy}>
      <h2>Server version</h2>
      <p>The version running on this webserver, compared with the latest stable Trestl release.</p>
      {version && (
        <>
          <dl className="settings-workspace-details">
            <div>
              <dt>Running version</dt>
              <dd>{version.running.version}</dd>
            </div>
            <div>
              <dt>Build</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>
                {version.running.buildId ?? 'Not available'}
              </dd>
            </div>
            <div>
              <dt>Commit</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>
                {version.running.commit ?? 'Not available'}
              </dd>
            </div>
            <div>
              <dt>Built</dt>
              <dd>{date(version.running.builtAt)}</dd>
            </div>
            <div>
              <dt>Latest stable version</dt>
              <dd>{version.latest?.version ?? 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd role="status">{labels[version.status]}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{date(version.checkedAt)}</dd>
            </div>
          </dl>
          {version.message && (
            <p className="settings-helper" role="status">
              {version.message}
            </p>
          )}
          {version.latest && (
            <p>
              <a href={version.latest.url} target="_blank" rel="noreferrer">
                Release notes <ExternalLink size={14} aria-hidden="true" />
              </a>
            </p>
          )}
          {version.status === 'unreleased' && (
            <p className="settings-helper">
              This build is newer than the latest stable release or is not identified as an official
              release build.
            </p>
          )}
        </>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-form-actions">
        <button className="button" disabled={busy} onClick={() => void refresh()}>
          <RefreshCw size={15} aria-hidden="true" /> {busy ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      <p className="settings-helper">
        Checks GitHub Releases. Results are cached for 15 minutes; manual checks refresh at most
        once per minute. Updates are installed by your administrator.
      </p>
    </section>
  );
}
