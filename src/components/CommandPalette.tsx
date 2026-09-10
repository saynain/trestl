import { useEffect, useRef, useState } from 'react';
import {
  Home,
  Users,
  Keyboard,
  SlidersHorizontal,
  Search,
  Plus,
  FolderPlus,
  Settings,
  Inbox,
  CircleCheck,
  ArrowUpRight,
  CornerDownLeft,
  ArrowLeft,
} from 'lucide-react';
import type { User } from '../../shared/types';
import { api, post } from '../lib/api';
import { openAccount, readLabel } from '../lib/profiles';
import { useApp } from '../lib/context';
import { itemActions, shortcuts, formatShortcut } from '../lib/shortcuts';
import { navigate, itemSearchText, readRoute } from '../lib/model';
import { Avatar, Modal, ProjectIcon, StatusIcon } from './ui';
export default function CommandPalette({
  onClose,
  onHelp,
  mode = 'all',
  itemId,
}: {
  onClose: () => void;
  onHelp: () => void;
  mode?: 'all' | 'items' | 'projects' | 'accounts';
  itemId?: string;
}) {
  const { data, openItem, createItem, createProject } = useApp();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [view, setView] = useState(mode);
  const [profiles, setProfiles] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const changeView = (next: typeof view) => {
    setView(next);
    setQuery('');
    setIndex(0);
    setError('');
    setLoading(false);
    input.current?.focus();
  };
  useEffect(() => {
    if (view !== 'accounts') return;
    let active = true;
    setLoading(true);
    setProfiles([]);
    void api<{ data: User[] }>('/auth/profiles')
      .then((result) => {
        if (active) setProfiles(result.data);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view]);
  async function switchAccount(user: User) {
    if (busy) return;
    if (user.id === data.user.id) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/auth/switch', { userId: user.id });
      openAccount();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const currentItem = data.items.find((item) => item.id === itemId);
  const actions = [
    ...(currentItem
      ? itemActions
          .filter((action) => !currentItem.source || !['title', 'description'].includes(action))
          .map((action) => ({
            id: `item-${action}`,
            label: `${shortcuts[action].label} · ${currentItem.identifier}`,
            hint: formatShortcut(shortcuts[action].keys[0]),
            icon: <SlidersHorizontal size={16} />,
            run: () => openItem(currentItem.id, action),
          }))
      : []),
    {
      id: 'new',
      label: 'Create a work item',
      hint: 'C',
      icon: <Plus size={17} />,
      run: () => {
        const route = readRoute();
        createItem(route.page === 'project' ? route.id : undefined);
      },
    },
    {
      id: 'project',
      label: 'Create a project',
      hint: '',
      icon: <FolderPlus size={17} />,
      run: () => createProject(),
    },
    {
      id: 'home',
      label: 'Go to Home',
      hint: '',
      icon: <Home size={17} />,
      run: () => navigate('home'),
    },
    {
      id: 'my',
      label: 'Go to My work',
      hint: 'G then M',
      icon: <CircleCheck size={17} />,
      run: () => navigate('my-work'),
    },
    {
      id: 'inbox',
      label: 'Go to Inbox',
      hint: 'G then I',
      icon: <Inbox size={17} />,
      run: () => navigate('inbox'),
    },
    {
      id: 'settings',
      label: 'Open settings',
      hint: 'G then S',
      icon: <Settings size={17} />,
      run: () => navigate('settings'),
    },
    {
      id: 'workspace',
      label: shortcuts.switchWorkspace.label,
      hint: formatShortcut(shortcuts.switchWorkspace.keys[0]),
      icon: <Users size={17} />,
      keepOpen: true,
      run: () => changeView('accounts'),
    },
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      hint: '?',
      icon: <Keyboard size={17} />,
      run: onHelp,
    },
  ];
  const q = query.toLowerCase();
  const commands = (view === 'all' ? actions : []).filter((a) => a.label.toLowerCase().includes(q));
  const accounts = (view === 'accounts' ? profiles : [])
    .filter((user) => `${readLabel(user.id)} ${user.name} ${user.email}`.toLowerCase().includes(q))
    .map((user) => ({
      id: user.id,
      label: `${readLabel(user.id)} · ${user.name} · ${user.email}`,
      hint: user.id === data.user.id ? 'Current' : '',
      icon: <Avatar user={user} size={24} />,
      keepOpen: true,
      run: () => void switchAccount(user),
    }));
  const projects = (view === 'items' || view === 'accounts' ? [] : data.projects)
    .filter((p) => (p.name + ' ' + p.key).toLowerCase().includes(q))
    .slice(0, 6)
    .map((p) => ({
      id: p.id,
      label: p.name,
      hint: p.key,
      icon: <ProjectIcon project={p} />,
      run: () => navigate('project', p.id),
    }));
  const items = (view === 'projects' || view === 'accounts' ? [] : data.items)
    .filter((i) => itemSearchText(i).includes(q))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 15)
    .map((i) => ({
      id: i.id,
      label: i.title,
      hint: i.source
        ? `${i.source.provider === 'github' ? 'GitHub' : 'Gitea'} #${i.source.number} · ${i.identifier}`
        : i.identifier,
      icon: <StatusIcon status={i.status} />,
      run: () => openItem(i.id),
    }));
  const all = [...commands, ...projects, ...items, ...accounts];
  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  const select = (i: number) => {
    const action = all[i];
    if (action && !busy) {
      if (!('keepOpen' in action && action.keepOpen)) onClose();
      action.run();
    }
  };
  return (
    <Modal
      title={view === 'accounts' ? 'Switch account' : 'Command palette'}
      onClose={onClose}
      className="command-modal"
    >
      <div className="command-search">
        {view === 'accounts' ? (
          <button
            className="icon-button"
            aria-label="Back to commands"
            disabled={busy}
            onClick={() => changeView('all')}
          >
            <ArrowLeft size={20} />
          </button>
        ) : (
          <Search size={20} />
        )}
        <input
          ref={input}
          autoFocus
          placeholder={
            view === 'accounts'
              ? 'Find accounts…'
              : view === 'items'
                ? 'Find work items…'
                : view === 'projects'
                  ? 'Find projects…'
                  : 'Search projects, items, or commands…'
          }
          aria-label="Command search"
          value={query}
          readOnly={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (busy) return;
            if (e.key === 'Backspace' && !query && view === 'accounts') {
              e.preventDefault();
              changeView('all');
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.max(0, Math.min(i + 1, all.length - 1)));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              select(index);
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="command-results" ref={list} role="listbox" aria-label="Search results">
        {[
          { name: 'Switch account', entries: accounts, offset: 0 },
          { name: 'Commands', entries: commands, offset: 0 },
          { name: 'Projects', entries: projects, offset: commands.length },
          {
            name: query ? 'Work items' : 'Recent work',
            entries: items,
            offset: commands.length + projects.length,
          },
        ].map(
          (section) =>
            section.entries.length > 0 && (
              <section key={section.name}>
                <div className="command-section-label">{section.name}</div>
                {section.entries.map((entry, i) => (
                  <button
                    key={entry.id}
                    role="option"
                    aria-selected={index === section.offset + i}
                    className={`command-option ${index === section.offset + i ? 'selected' : ''}`}
                    disabled={busy}
                    onMouseMove={() => setIndex(section.offset + i)}
                    onClick={() => select(section.offset + i)}
                  >
                    {entry.icon}
                    <span title={entry.label}>{entry.label}</span>
                    <small>{entry.hint}</small>
                    {index === section.offset + i && <CornerDownLeft size={13} />}
                  </button>
                ))}
              </section>
            ),
        )}
        {loading && view === 'accounts' && (
          <div className="command-empty" role="status">
            Loading accounts…
          </div>
        )}
        {error && (
          <div className="command-empty" role="alert">
            {error}
          </div>
        )}
        {busy && (
          <div className="command-empty" role="status">
            Switching account…
          </div>
        )}
        {!loading && !error && all.length === 0 && (
          <div className="command-empty">No results for “{query}”</div>
        )}
      </div>
      <div className="command-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>↵</kbd> {view === 'accounts' ? 'switch' : 'open'}
        </span>
        <ArrowUpRight size={14} />
        <span>Everything, a few keystrokes away.</span>
      </div>
    </Modal>
  );
}
