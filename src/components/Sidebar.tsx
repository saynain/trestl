import { useEffect, useRef, useState } from 'react';
import {
  Home,
  Bell,
  Keyboard,
  Search,
  Inbox,
  CircleCheck,
  FolderOpen,
  Plus,
  Settings,
  PanelLeftClose,
  Bookmark,
  ChevronsUpDown,
  LogOut,
  UserRound,
  Users,
  Activity,
  CirclePlay,
  ScanEye,
} from 'lucide-react';
import type { Project } from '../../shared/types';
import type { NavVariant } from '../lib/nav-variant';
import { ProjectSidebarSections, SidebarProjectPicker } from './ProjectSidebar';
import { useApp } from '../lib/context';
import { navigate, type Route, isDone } from '../lib/model';
import { favoriteEntries } from '../lib/navigation';
import { openProject } from '../lib/project-picker';
import { FavoritesDialog } from './Favorites';
import { Avatar, Brand, ProjectIcon } from './ui';
import { post } from '../lib/api';
export default function Sidebar({
  route,
  command,
  onDismiss,
  onShortcuts,
  variant = 'current',
  project,
}: {
  route: Route;
  command: () => void;
  onDismiss: () => void;
  onShortcuts: () => void;
  variant?: NavVariant;
  project?: Project;
}) {
  const exploring = variant !== 'current';
  const { data, uiPreferences, toast } = useApp();
  const [managingFavorites, setManagingFavorites] = useState(false);
  const favoritesTrigger = useRef<HTMLButtonElement>(null);
  const favorites = favoriteEntries(data, uiPreferences.favorites);
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
  const go = (page: string, id?: string, tab = 'list') => {
    navigate(page, id, tab);
    onDismiss();
  };
  return (
    <>
      <aside className="sidebar">
        {import.meta.env.VITE_TRESTL_DESKTOP === 'true' && (
          <div className="desktop-sidebar-drag-area" data-tauri-drag-region aria-hidden="true" />
        )}
        <div className="workspace-brand">
          <a href="#/home" aria-label="Trestl home" onClick={onDismiss}>
            <Brand />
          </a>
          <button
            className="icon-button mobile-only"
            aria-label="Close navigation"
            onClick={onDismiss}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        {variant === 'a' && <SidebarProjectPicker project={project} placement="top" />}
        {/* The installation name is the breadcrumb root, so the variants drop this box. */}
        {!exploring && (
          <div className="workspace-trigger">
            <span className="workspace-trigger-text">{data.workspace?.name}</span>
          </div>
        )}
        <button className="sidebar-search" onClick={command}>
          <Search size={15} />
          <span>Search anything</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav className={`main-nav ${exploring ? 'compact' : ''}`} aria-label="Workspace navigation">
          <button
            className={`nav-item ${route.page === 'home' ? 'active' : ''}`}
            aria-current={route.page === 'home' ? 'page' : undefined}
            onClick={() => go('home')}
          >
            <Home size={18} />
            <span>Home</span>
          </button>
          <button
            className={`nav-item ${route.page === 'inbox' ? 'active' : ''}`}
            aria-current={route.page === 'inbox' ? 'page' : undefined}
            onClick={() => go('inbox')}
            title="Inbox (G then I)"
          >
            <Inbox size={18} />
            <span>Inbox</span>
            {data.items.filter((i) => !i.projectId && i.creatorId === data.user.id && !isDone(i))
              .length > 0 && (
              <span className="nav-count">
                {
                  data.items.filter(
                    (i) => !i.projectId && i.creatorId === data.user.id && !isDone(i),
                  ).length
                }
              </span>
            )}
          </button>
          <button
            className={`nav-item ${route.page === 'notifications' ? 'active' : ''}`}
            aria-current={route.page === 'notifications' ? 'page' : undefined}
            onClick={() => go('notifications')}
          >
            <Bell size={18} />
            <span>Notifications</span>
            {!!data.notifications?.some((n) => !n.readAt) && (
              <span className="nav-count">
                {data.notifications.filter((n) => !n.readAt).length}
              </span>
            )}
          </button>
          <button
            className={`nav-item ${route.page === 'my-work' ? 'active' : ''}`}
            aria-current={route.page === 'my-work' ? 'page' : undefined}
            onClick={() => go('my-work')}
            title="My work (G then M)"
          >
            <CircleCheck size={18} />
            <span>My work</span>
          </button>
          {exploring &&
            (
              [
                ['review', 'Review', ScanEye],
                ['ready', 'Ready', CirclePlay],
              ] as const
            ).map(([page, label, Icon]) => (
              <button
                key={page}
                className={`nav-item ${route.page === page ? 'active' : ''}`}
                aria-current={route.page === page ? 'page' : undefined}
                onClick={() => go(page)}
              >
                <Icon size={18} />
                <span>{label}</span>
              </button>
            ))}
          <button
            className={`nav-item ${route.page === 'projects' || (!exploring && route.page === 'project' && !favorites.some((favorite) => favorite.kind === 'project' && favorite.id === route.id)) ? 'active' : ''}`}
            aria-current={
              route.page === 'projects' ||
              (!exploring &&
                route.page === 'project' &&
                !favorites.some(
                  (favorite) => favorite.kind === 'project' && favorite.id === route.id,
                ))
                ? 'page'
                : undefined
            }
            onClick={() => go('projects')}
            data-nav="projects"
            title="All projects (G then P)"
          >
            <FolderOpen size={18} />
            <span>Projects</span>
          </button>
          {!exploring && (
            <button
              className={`nav-item ${route.page === 'people' ? 'active' : ''}`}
              aria-current={route.page === 'people' ? 'page' : undefined}
              onClick={() => go('people')}
            >
              <Users size={18} />
              <span>People</span>
            </button>
          )}
        </nav>
        <div className="sidebar-scroll">
          {exploring && (
            <section className={`sidebar-project variant-${variant}`} aria-label="Project">
              <div className="nav-section-title">
                <span>{variant === 'a' ? (project?.name ?? 'Project') : 'Project'}</span>
              </div>
              {variant !== 'a' && <SidebarProjectPicker project={project} placement="section" />}
              {project && (
                <ProjectSidebarSections
                  project={project}
                  route={route}
                  sections={variant !== 'c'}
                  onNavigate={onDismiss}
                />
              )}
            </section>
          )}
          <div className="nav-section-title">
            <span>Favorites</span>
            <button
              ref={favoritesTrigger}
              className="icon-button"
              onClick={() => setManagingFavorites(true)}
              aria-label="Manage favorites"
              title="Manage favorites"
            >
              <Plus size={14} />
            </button>
          </div>
          <nav aria-label="Favorites">
            {favorites.map((favorite) => (
              <button
                key={`${favorite.kind}:${favorite.id}`}
                className={`nav-item ${route.page === favorite.kind && route.id === favorite.id ? 'active' : ''}`}
                title={favorite.name}
                aria-current={
                  route.page === favorite.kind && route.id === favorite.id ? 'page' : undefined
                }
                onClick={() => {
                  if (favorite.view) go('view', favorite.id, favorite.view.layout);
                  else {
                    openProject(data, favorite.id);
                    onDismiss();
                  }
                }}
              >
                {favorite.project ? (
                  <ProjectIcon project={favorite.project} size={17} />
                ) : (
                  <Bookmark size={17} />
                )}
                <span>{favorite.name}</span>
              </button>
            ))}
          </nav>
          {!favorites.length && (
            <div className="sidebar-favorites-empty">
              <p>A little space for the work you return to.</p>
              <button className="text-button" onClick={() => setManagingFavorites(true)}>
                <Plus size={14} />
                Choose favorites
              </button>
            </div>
          )}
          {!!favorites.length && (
            <button className="sidebar-manage-favorites" onClick={() => setManagingFavorites(true)}>
              Edit favorites
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          {!exploring && (
            <>
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
                aria-current={route.page === 'settings' ? 'page' : undefined}
                onClick={() => go('settings', undefined, 'general')}
              >
                <Settings size={18} />
                <span>Administration</span>
              </button>
            </>
          )}
          <div
            className={`sidebar-account ${exploring ? 'with-admin' : ''}`}
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
                <button
                  className="nav-item"
                  onClick={() => {
                    setAccountMenu(false);
                    go('people', data.user.id);
                  }}
                >
                  <Activity size={16} />
                  My activity
                </button>
                {exploring && (
                  <>
                    <button
                      className="nav-item"
                      onClick={() => {
                        setAccountMenu(false);
                        go('people');
                      }}
                    >
                      <Users size={16} />
                      People
                    </button>
                    <button
                      className="nav-item"
                      onClick={() => {
                        setAccountMenu(false);
                        onShortcuts();
                      }}
                    >
                      <Keyboard size={16} />
                      Keyboard shortcuts
                    </button>
                  </>
                )}
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
            {exploring && (
              <button
                className={`icon-button sidebar-admin ${route.page === 'settings' ? 'active' : ''}`}
                aria-label="Administration"
                aria-current={route.page === 'settings' ? 'page' : undefined}
                title="Administration (G then S)"
                onClick={() => go('settings', undefined, 'general')}
              >
                <Settings size={17} />
              </button>
            )}
          </div>
        </div>
      </aside>
      {managingFavorites && (
        <FavoritesDialog
          onClose={() => {
            setManagingFavorites(false);
            window.requestAnimationFrame(() => favoritesTrigger.current?.focus());
          }}
        />
      )}
    </>
  );
}
