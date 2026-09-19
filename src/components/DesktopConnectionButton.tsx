import { useState } from 'react';
import { ChevronsUpDown, Monitor, Globe } from 'lucide-react';
import { isDesktop, remoteDesktop, openConnections } from '../lib/desktop';
export default function DesktopConnectionButton() {
  const [error, setError] = useState('');
  if (!isDesktop) return null;
  const name = remoteDesktop?.name || 'Local';
  return (
    <div className="desktop-connection-control">
      <button
        className="desktop-connection-button"
        title="Switch connection (⌘/Ctrl Shift K)"
        aria-label={`Switch connection: ${name}`}
        onClick={() => {
          setError('');
          void openConnections().catch(() =>
            setError('Use Connections → Switch Connection in the app menu.'),
          );
        }}
      >
        {remoteDesktop ? <Globe size={14} /> : <Monitor size={14} />}
        <span>{name}</span>
        <ChevronsUpDown size={13} />
      </button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
