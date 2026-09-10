import { useState } from 'react';
import {
  Home,
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
} from 'lucide-react';
import { useApp } from '../lib/context';
import { navigate, type Route, isDone } from '../lib/model';
import type { Project } from '../../shared/types';
import { Avatar, Brand, ProjectIcon } from './ui';
import ProfileSwitcher from './ProfileSwitcher';
export default function Sidebar({
  route,
  command,
  onDismiss,
  onShortcuts,
  workspaceMenu,
  setWorkspaceMenu,
}: {
  workspaceMenu: boolean;
  setWorkspaceMenu: (open: boolean) => void;
  route: Route;
  command: () => void;
  onDismiss: () => void;
  onShortcuts: () => void;
}) {
  const { data, createProject } = useApp();
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
      <div className="workspace-brand">
        <Brand />
        <button
          className="icon-button mobile-only"
          aria-label="Close navigation"
          onClick={onDismiss}
        >
          <PanelLeftClose size={17} />
        </button>
      </div>
      <ProfileSwitcher open={workspaceMenu} setOpen={setWorkspaceMenu} />
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
          <span>Workspace</span>
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
          onClick={() => go('settings')}
        >
          <Settings size={18} />
          <span>Settings</span>
        </button>
        <div className="sidebar-user">
          <Avatar user={data.user} size={30} />
          <div>
            <strong>{data.user.name}</strong>
            <small>{data.user.role === 'admin' ? 'Workspace admin' : 'Member'}</small>
          </div>
          <span className="online-dot" title="Signed in" />
        </div>
      </div>
    </aside>
  );
}
