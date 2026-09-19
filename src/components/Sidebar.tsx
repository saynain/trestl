import DesktopConnectionButton from './DesktopConnectionButton';
import { desktopPlatform } from '../lib/desktop';
import { useEffect, useRef, useState } from 'react';
import {
  Home,
  Bell,
  Keyboard,
  Search,
  Inbox,
  CircleCheck,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  Settings,
  CalendarDays,
  Hourglass,
  Lightbulb,
  PanelLeftClose,
  Bookmark,
  ChevronsUpDown,
  LogOut,
  UserRound,
} from 'lucide-react';
import { useApp } from '../lib/context';
import { navigate, type Route, isDone } from '../lib/model';
import type { Project } from '../../shared/types';
import { Avatar, Brand, ProjectIcon } from './ui';
import { post } from '../lib/api';
export default function Sidebar({
  route,
  command,
  onDismiss,
  onShortcuts,
}: {
  route: Route;
  command: () => void;
  onDismiss: () => void;
  onShortcuts: () => void;
}) {
  const { data, createProject, toast } = useApp();
  const [accountMenu, setAccountMenu] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const accountRoot = useRef<HTMLDivElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const accountSettings = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!accountMenu) return;
    accountSettings.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!accountRoot.current?.contains(event.target as Node)) setAccountMenu(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setAccountMenu(false);
        accountTrigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape, true);
    };
  }, [accountMenu]);
  async function signOut() {
    setSigningOut(true);
    try {
      const result = await post<{ redirectUrl?: string }>('/auth/logout', {});
      if (result.redirectUrl) window.location.assign(result.redirectUrl);
      else window.location.reload();
    } catch (error) {
      toast(
        error instanceof Error ? error.message : 'Could not sign out. Please try again.',
        'error',
      );
      setSigningOut(false);
    }
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const go = (page: string, id?: string, tab = 'list') => {
    navigate(page, id, tab);
    onDismiss();
  };
  function tree(project: Project, depth = 0): React.ReactNode {
    const children = data.projects.filter(
      (p) => p.parentId === project.id && p.status !== 'archived',
    );
    return (
      <div key={project.id}>
        <div
          className={`project-nav nav-item ${route.page === 'project' && route.id === project.id ? 'active' : ''}`}
          style={{ paddingLeft: 12 + depth * 17 }}
        >
          <button className="project-nav-main" onClick={() => go('project', project.id)}>
            <ProjectIcon project={project} size={17} />
            <span>{project.name}</span>
          </button>
          {children.length > 0 && (
            <button
              className="tree-toggle"
              aria-label={`${collapsed.has(project.id) ? 'Expand' : 'Collapse'} ${project.name}`}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  next.has(project.id) ? next.delete(project.id) : next.add(project.id);
                  return next;
                })
              }
            >
              {collapsed.has(project.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
        </div>
        {!collapsed.has(project.id) && children.map((p) => tree(p, depth + 1))}
      </div>
    );
  }
  return (
    <aside className="sidebar">
      {desktopPlatform === 'macos' && (
        <div className="desktop-sidebar-drag-area" data-tauri-drag-region aria-hidden="true" />
      )}
      <div className="workspace-brand">
        <button className="brand-home" aria-label="Trestl Home" onClick={() => go('home')}>
          <Brand />
        </button>
        <button
          className="icon-button mobile-only"
          aria-label="Close navigation"
          onClick={onDismiss}
        >
          <PanelLeftClose size={17} />
        </button>
      </div>
      <DesktopConnectionButton />
      <div className="workspace-trigger">
        <span className="workspace-trigger-text">{data.workspace?.name}</span>
      </div>
      <button className="sidebar-search" onClick={command}>
        <Search size={15} />
        <span>Search anything</span>
        <kbd>⌘ K</kbd>
      </button>
      <nav className="main-nav">
        <button
          className={`nav-item ${route.page === 'home' ? 'active' : ''}`}
          onClick={() => go('home')}
        >
          <Home size={18} />
          <span>Home</span>
        </button>
        <button
          className={`nav-item ${route.page === 'inbox' ? 'active' : ''}`}
          onClick={() => go('inbox')}
          title="Inbox (G then I)"
        >
          <Inbox size={18} />
          <span>Inbox</span>
          {data.items.filter((i) => !i.projectId && i.creatorId === data.user.id && !isDone(i))
            .length > 0 && (
            <span className="nav-count">
              {
                data.items.filter((i) => !i.projectId && i.creatorId === data.user.id && !isDone(i))
                  .length
              }
            </span>
          )}
        </button>
        <button
          className={`nav-item ${route.page === 'notifications' ? 'active' : ''}`}
          onClick={() => go('notifications')}
        >
          <Bell size={18} />
          <span>Notifications</span>
          {!!data.notifications?.some((n) => !n.readAt) && (
            <span className="nav-count">{data.notifications.filter((n) => !n.readAt).length}</span>
          )}
        </button>
        <button
          className={`nav-item ${route.page === 'my-work' ? 'active' : ''}`}
          onClick={() => go('my-work')}
          title="My work (G then M)"
        >
          <CircleCheck size={18} />
          <span>My work</span>
        </button>
        <button
          className={`nav-item ${route.page === 'projects' ? 'active' : ''}`}
          onClick={() => go('projects')}
          title="All projects (G then P)"
        >
          <FolderOpen size={18} />
          <span>All projects</span>
        </button>
      </nav>
      <div className="sidebar-scroll">
        <div className="nav-section-title">
          <span>Projects</span>
          <button
            className="icon-button"
            onClick={() => createProject()}
            aria-label="Create project"
          >
            <Plus size={14} />
          </button>
        </div>
        <nav className="project-tree">
          {data.projects.filter((p) => !p.parentId && p.status !== 'archived').map((p) => tree(p))}
          {!data.projects.length && (
            <button className="nav-item subtle" onClick={() => createProject()}>
              <Plus size={16} />
              Create your first project
            </button>
          )}
        </nav>
        <div className="nav-section-title views-title">
          <span>Views</span>
          <Bookmark size={12} />
        </div>
        <nav>
          {data.views.map((view) => {
            const Icon = view.filters.due
              ? CalendarDays
              : view.filters.followUp
                ? Hourglass
                : view.filters.type === 'idea'
                  ? Lightbulb
                  : Bookmark;
            return (
              <button
                key={view.id}
                className={`nav-item ${route.page === 'view' && route.id === view.id ? 'active' : ''}`}
                onClick={() => go('view', view.id, view.layout === 'board' ? 'board' : 'list')}
              >
                <Icon size={17} />
                <span>{view.name}</span>
              </button>
            );
          })}
          {!data.views.length && (
            <p className="sidebar-help">Save a filtered work list to keep it here.</p>
          )}
        </nav>
      </div>
      <div className="sidebar-bottom">
        <button
          className="nav-item sidebar-shortcuts"
          onClick={onShortcuts}
          title="Keyboard shortcuts (?)"
        >
          <Keyboard size={17} />
          <span>Keyboard shortcuts</span>
          <kbd>?</kbd>
        </button>
        <button
          className={`nav-item ${route.page === 'settings' ? 'active' : ''}`}
          onClick={() => go('settings', undefined, 'general')}
        >
          <Settings size={18} />
          <span>Administration</span>
        </button>
        <div
          className="sidebar-account"
          ref={accountRoot}
          onBlur={(event) => {
            // WebKit blurs buttons to the page before a mouse click; the outside
            // pointer handler covers that case. Keep the menu alive for its click.
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget))
              setAccountMenu(false);
          }}
        >
          {accountMenu && (
            <div className="sidebar-account-popover" id="sidebar-account-options">
              <div className="sidebar-account-info">
                <strong>{data.user.name}</strong>
                <span>{data.user.email}</span>
              </div>
              <button
                ref={accountSettings}
                className="nav-item"
                onClick={() => {
                  setAccountMenu(false);
                  go('account-settings', undefined, 'profile');
                }}
              >
                <UserRound size={16} />
                Account settings
              </button>
              <button className="nav-item" disabled={signingOut} onClick={() => void signOut()}>
                <LogOut size={16} />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          )}
          <button
            ref={accountTrigger}
            className={`sidebar-user ${route.page === 'account-settings' ? 'active' : ''}`}
            aria-label={`Account menu for ${data.user.name}`}
            aria-expanded={accountMenu}
            aria-controls="sidebar-account-options"
            onClick={() => {
              setAccountMenu((open) => !open);
            }}
          >
            <Avatar user={data.user} size={30} />
            <div>
              <strong>{data.user.name}</strong>
              <small>{data.user.email}</small>
            </div>
            <ChevronsUpDown size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
