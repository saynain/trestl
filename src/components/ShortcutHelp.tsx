import { useState } from 'react';
import { Keyboard, Search } from 'lucide-react';
import { formatShortcut, shortcuts } from '../lib/shortcuts';
import { Modal } from './ui';
import './shortcuts.css';
export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const entries = Object.entries(shortcuts).filter(([, shortcut]) =>
    `${shortcut.label} ${shortcut.group} ${shortcut.keys.map((key) => formatShortcut(key)).join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} className="shortcut-help-modal">
      <div className="shortcut-help-intro">
        <Keyboard size={19} />
        <p>Move through your work without reaching for the mouse.</p>
      </div>
      <label className="shortcut-help-search">
        <Search size={16} />
        <input
          autoFocus
          placeholder="Find a shortcut…"
          aria-label="Find a shortcut"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="shortcut-help-sections">
        {[...new Set(entries.map(([, shortcut]) => shortcut.group))].map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            {entries
              .filter(([, shortcut]) => shortcut.group === group)
              .map(([id, shortcut]) => (
                <div className="shortcut-help-row" key={id}>
                  <span>{shortcut.label}</span>
                  <span className="shortcut-keys">
                    {shortcut.keys.map((keys, index) => (
                      <span key={keys}>
                        {index > 0 && <small>or</small>}
                        <kbd>{formatShortcut(keys)}</kbd>
                      </span>
                    ))}
                  </span>
                </div>
              ))}
          </section>
        ))}
        {!entries.length && <p className="shortcut-empty">No shortcuts match “{query}”.</p>}
      </div>
      <p className="shortcut-help-note">
        Work item actions use the focused or hovered item, or the item you have open. Single-letter
        shortcuts pause while you type. Press Escape to close a menu or dialog.
      </p>
    </Modal>
  );
}
