import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { watchAppearance } from './lib/themes';
import CliLoginApproval from './components/CliLoginApproval';
const WeeklyReview = lazy(() =>
  import('./components/ProjectUpdates').then((module) => ({ default: module.WeeklyReview })),
);
import Notifications, { NotificationBell } from './components/Notifications';
const Canvases = lazy(() => import('./components/Canvases'));
const GanttView = lazy(() => import('./components/GanttView'));
import ShortcutHelp from './components/ShortcutHelp';
import Home from './components/Home';
import { useShortcuts } from './lib/keyboard';
import { formatShortcut, shortcuts, type ItemAction } from './lib/shortcuts';
const RoadmapView = lazy(() => import('./components/Roadmap'));
import ErrorBoundary from './components/ErrorBoundary';
import { FavoriteButton } from './components/Favorites';
import {
  ProjectPicker,
  ProjectSwitcher,
  SubprojectNavigation,
} from './components/ProjectNavigation';
import { projectAncestors } from './lib/navigation';
import {
  openProject,
  projectDestination,
  readProjectHistory,
  recordProjectVisit,
  saveProjectHistory,
} from './lib/project-picker';
import { applyBootstrapItems } from './lib/bootstrap';
import {
  ArrowRight,
  Box,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Download,
  Inbox,
  Layers,
  Lightbulb,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
  X,
  AlertCircle,
  Hourglass,
  Pencil,
  Trash2,
  Archive,
  RefreshCw,
} from 'lucide-react';
import type { Bootstrap, Project, Status, User, WorkItem } from '../shared/types';
import { api, ApiError, fetchBootstrap, patch, remove } from './lib/api';
import {
  readUiPreferences,
  saveUiPreferences,
  defaultUiPreferences,
  type UiPreferences,
} from './lib/preferences';
import { AppContext, type ToastAction } from './lib/context';
import {
  filterWorkItems,
  filteredItems,
  hashWithoutItem,
  isDone,
  itemPageHash,
  navigate,
  readRoute,
  shortDate,
  type Route,
} from './lib/model';
import { Avatar, EmptyState, Logo, Modal, ProjectIcon } from './components/ui';
import Auth from './components/Auth';
import Sidebar from './components/Sidebar';
import CommandPalette from './components/CommandPalette';
import WorkList from './components/WorkList';
const AllProjects = lazy(() =>
  import('./components/ProjectViews').then((module) => ({ default: module.AllProjects })),
);
const Overview = lazy(() =>
  import('./components/ProjectViews').then((module) => ({ default: module.Overview })),
);
const Resources = lazy(() =>
  import('./components/ProjectViews').then((module) => ({ default: module.Resources })),
);
const ItemDetail = lazy(() => import('./components/ItemDetail'));
const ItemForm = lazy(() => import('./components/ItemForm'));
const ProjectForm = lazy(() => import('./components/ProjectForm'));
import ProjectAccess from './components/ProjectAccess';
import { ExportProject, ImportProject } from './components/ProjectTransfer';
const Settings = lazy(() => import('./components/Settings'));
const People = lazy(() => import('./components/People'));
export default function App() {
  const [auth, setAuth] = useState<{
    needsSetup: boolean;
    authenticated: boolean;
    authMode?: 'local' | 'google' | 'oidc' | 'proxy';
    installationName?: string;
  } | null>(null);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState<Route>(readRoute);
  const [command, setCommand] = useState(false);
  const [commandMode, setCommandMode] = useState<'all' | 'items'>('all');
  const [commandItemId, setCommandItemId] = useState<string>();
  const [help, setHelp] = useState(false);
  const [itemAction, setItemAction] = useState<ItemAction>();
  const [mobileNav, setMobileNav] = useState(false);
  const [profilePreferences, setProfilePreferences] = useState<{
    userId: string;
    value: UiPreferences;
  } | null>(null);
  const uiPreferences = profilePreferences?.value ?? defaultUiPreferences;
  const updateUiPreferences = (changes: Partial<UiPreferences>) => {
    if (!data) return;
    const value = { ...uiPreferences, ...changes };
    saveUiPreferences(data.user, value);
    setProfilePreferences({ userId: data.user.id, value });
  };
  const toggleSidebar = () => {
    if (window.matchMedia('(max-width: 760px)').matches) {
      setMobileNav((open) => !open);
    } else {
      updateUiPreferences({ zenMode: !uiPreferences.zenMode });
      setMobileNav(false);
      // Keep keyboard focus reachable when hiding a focused navigation control.
      if (document.activeElement?.closest('.sidebar')) {
        document.querySelector<HTMLButtonElement>('.sidebar-toggle')?.focus();
      }
    }
  };
  const [newItem, setNewItem] = useState<{
    projectId?: string | null;
    status?: Status;
    parentId?: string;
  } | null>(null);
  const [newProject, setNewProject] = useState<{ parentId?: string; project?: Project } | null>(
    null,
  );
  const [message, setMessage] = useState<{
    text: string;
    kind: string;
    action?: ToastAction;
  } | null>(null);
  const [projectMenu, setProjectMenu] = useState(false);
  const [projectPicker, setProjectPicker] = useState<{
    anchor: HTMLElement | null;
    returnFocus: HTMLElement | null;
  } | null>(null);
  // Where focus lands once a project chosen in the picker has rendered.
  const focusAfterNavigation = useRef<HTMLElement | null>(null);
  const [exportProject, setExportProject] = useState<Project | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const loadSequence = useRef(0);
  const bootstrapEtag = useRef<string>(undefined);
  const applyItems = useCallback((items: WorkItem[]) => {
    loadSequence.current++;
    setData((current) => current && applyBootstrapItems(current, items));
  }, []);
  const removeItems = useCallback((ids: string[]) => {
    loadSequence.current++;
    setData((current) => current && applyBootstrapItems(current, [], ids));
  }, []);
  useEffect(() => {
    if (data?.user) return watchAppearance(data.user);
  }, [data?.user.id]);
  const toast = useCallback((text: string, kind = 'success') => {
    setMessage({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setMessage(null), 5000);
  }, []);
  const toastAction = useCallback(
    (text: string, action: ToastAction, kind: 'success' | 'error' = 'success') => {
      setMessage({ text, kind, action });
      clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setMessage(null), 10000);
    },
    [],
  );
  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const response = await fetchBootstrap(bootstrapEtag.current);
      if (sequence !== loadSequence.current) return;
      bootstrapEtag.current = response.etag;
      const next = response.data;
      if (!next) return;
      if (sequence === loadSequence.current) {
        setProfilePreferences((current) =>
          current?.userId === next.user.id
            ? current
            : { userId: next.user.id, value: readUiPreferences(next.user) },
        );
        setData(next);
        setError('');
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        bootstrapEtag.current = undefined;
        setData(null);
        setAuth((current) => ({
          needsSetup: false,
          authenticated: false,
          authMode: current?.authMode,
          installationName: current?.installationName,
        }));
      } else throw e;
    }
  }, []);
  const checkAuth = useCallback(async () => {
    try {
      setError('');
      const state = await api<{
        needsSetup: boolean;
        authenticated: boolean;
        authMode?: 'local' | 'google' | 'oidc' | 'proxy';
        installationName?: string;
      }>('/auth/status');
      setAuth(state);
      if (state.authenticated) await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // A proxy session can expire between page navigation and bootstrap.
        // Reload through the page router so it can start the sign-in flow.
        window.location.reload();
        return;
      }
      setError((e as Error).message);
    }
  }, [refresh]);
  useEffect(() => {
    void checkAuth();
    let acceptedHash = window.location.hash;
    const fn = () => {
      if (
        window.location.hash !== acceptedHash &&
        !window.dispatchEvent(new Event('trestl:before-navigate', { cancelable: true }))
      ) {
        window.history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search + acceptedHash,
        );
        focusAfterNavigation.current?.focus({ preventScroll: true });
        focusAfterNavigation.current = null;
        return;
      }
      acceptedHash = window.location.hash;
      setRoute(readRoute());
      setProjectMenu(false);
      setProjectPicker(null);
    };
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, [checkAuth]);
  useEffect(() => {
    if (!data) return;
    if (route.page === 'home') {
      const url = new URL(location.href);
      const requested = url.searchParams.get('item');
      if (requested) {
        url.searchParams.delete('item');
        history.replaceState(null, '', url);
        navigate('item', requested);
      }
    }
  }, [data, route.page]);
  useEffect(() => {
    if (!auth?.authenticated) return;
    const check = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    };
    const interval = window.setInterval(check, 30000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [auth?.authenticated, refresh]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [route.page, route.id, route.tab]);
  const visitedProject =
    route.page === 'project' && !!data?.projects.some((project) => project.id === route.id);
  useEffect(() => {
    if (!data || !visitedProject || !route.id) return;
    const history = readProjectHistory(data.user.id);
    saveProjectHistory(data.user.id, recordProjectVisit(history, route.id, route.tab));
  }, [data?.user.id, visitedProject, route.id, route.tab]);
  useEffect(() => {
    const target = focusAfterNavigation.current;
    if (!target) return;
    focusAfterNavigation.current = null;
    let frame = 0;
    // A switched project page remounts its header, so fall back to the new switcher.
    const focus = (attempts: number) => {
      const next = target.isConnected
        ? target
        : document.querySelector<HTMLElement>('.project-switcher');
      if (next) next.focus({ preventScroll: true });
      else if (attempts) frame = requestAnimationFrame(() => focus(attempts - 1));
    };
    focus(30);
    return () => cancelAnimationFrame(frame);
  }, [route.page, route.id, route.tab]);
  useEffect(() => {
    const active = document.querySelector<HTMLElement>('.page-tabs .active');
    if (active?.parentElement) {
      const parent = active.parentElement;
      const left = active.offsetLeft - parent.offsetLeft;
      if (
        left < parent.scrollLeft ||
        left + active.offsetWidth > parent.scrollLeft + parent.clientWidth
      )
        parent.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
    }
  }, [route.page, route.id, route.tab]);
  const createItem = useCallback(
    (projectId?: string | null, status?: Status, parentId?: string) => {
      setNewItem({ projectId, status, parentId });
    },
    [],
  );
  const createProject = useCallback((parentId?: string) => setNewProject({ parentId }), []);
  const editProject = useCallback((project: Project) => setNewProject({ project }), []);
  // Where a full-page work item returns to: the list or view it was opened from.
  const itemReturn = useRef<string | null>(null);
  useEffect(() => {
    if (uiPreferences.itemLayout !== 'page' || !route.itemId || route.page === 'item') return;
    itemReturn.current = hashWithoutItem(location.hash);
    location.replace(itemPageHash(route.itemId, route.activityId));
  }, [uiPreferences.itemLayout, route.page, route.itemId, route.activityId]);
  const openItem = useCallback(
    (id: string, action?: ItemAction) => {
      setItemAction(action);
      if (uiPreferences.itemLayout === 'page') {
        itemReturn.current = hashWithoutItem(location.hash) ?? itemReturn.current;
        location.hash = itemPageHash(id);
        return;
      }
      const current = readRoute();
      const saved = data?.views.find((v) => v.id === current.id);
      const effectiveTab =
        current.page === 'view' &&
        saved &&
        !new URLSearchParams(location.hash.split('?')[1] || '').has('tab')
          ? saved.layout
          : current.tab;
      navigate(
        current.page === 'item' ? 'my-work' : current.page,
        current.page === 'item' ? undefined : current.id,
        effectiveTab,
        id,
      );
    },
    [data?.views, uiPreferences.itemLayout],
  );
  const showProjectPicker = (anchor: HTMLElement | null, returnFocus: HTMLElement | null) =>
    setProjectPicker((current) =>
      current && anchor && current.anchor === anchor ? null : { anchor, returnFocus },
    );
  const showCommands = (mode: 'all' | 'items' = 'all') => {
    setCommandMode(mode);
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-item-id]',
    );
    const hovered = document.querySelector<HTMLElement>('[data-item-id]:hover');
    setCommandItemId(route.itemId || focused?.dataset.itemId || hovered?.dataset.itemId);
    setCommand(true);
  };
  useShortcuts(
    'global',
    {
      command: () => {
        if (command) setCommand(false);
        else showCommands();
      },
      search: () => showCommands(),

      sidebar: toggleSidebar,
      dismiss: () => {
        setMobileNav(false);
        if (projectMenu) {
          setProjectMenu(false);
          document.querySelector<HTMLButtonElement>('[aria-label="Project options"]')?.focus();
        }
      },
      help: () => setHelp((value) => !value),
      create: () => createItem(route.page === 'project' ? route.id : undefined),
      home: () => {
        setMobileNav(false);
        navigate('home');
      },
      inbox: () => {
        setMobileNav(false);
        navigate('inbox');
      },
      myWork: () => {
        setMobileNav(false);
        navigate('my-work');
      },
      projects: () => {
        setMobileNav(false);
        navigate('projects');
      },
      settings: () => {
        setMobileNav(false);
        navigate('settings');
      },
      findItem: () => showCommands('items'),
      findProject: () => {
        const onScreen = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          const rect = element?.getBoundingClientRect();
          return rect && rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth
            ? element
            : null;
        };
        showProjectPicker(
          onScreen('.project-switcher') ?? onScreen('.sidebar [data-nav="projects"]'),
          document.activeElement instanceof HTMLElement ? document.activeElement : null,
        );
      },
    },
    { enabled: !!data && route.tab !== 'roadmap-present' },
  );
  if (error && !data)
    return (
      <div className="loading-screen">
        <Logo />
        <h2>Couldn’t connect to your workspace</h2>
        <p>{error}</p>
        <button className="button primary" onClick={() => checkAuth()}>
          Try again
        </button>
      </div>
    );
  if (!auth || (auth.authenticated && !data))
    return (
      <div className="loading-screen">
        <Logo />
        <LoaderCircle className="spin" size={22} />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!auth.authenticated)
    return (
      <Auth
        setup={auth.needsSetup}
        proxy={auth.authMode === 'proxy'}
        mode={auth.authMode}
        installationName={auth.installationName}
        onSuccess={() => void checkAuth()}
      />
    );
  if (!data) return null;
  if (route.page === 'cli-login') return <CliLoginApproval email={data.user.email} />;
  const project =
    route.page === 'project' ? data.projects.find((p) => p.id === route.id) : undefined;
  const view = route.page === 'view' ? data.views.find((v) => v.id === route.id) : undefined;
  const itemPage = uiPreferences.itemLayout === 'page' && route.page === 'item' && !!route.itemId;
  const pageItem = itemPage ? data.items.find((i) => i.id === route.itemId) : undefined;
  const itemProject = pageItem?.projectId
    ? data.projects.find((p) => p.id === pageItem.projectId)
    : undefined;
  const items = filteredItems(data, route);
  const headingItems = view ? filterWorkItems(items, data.user.id, view.filters) : items;
  const title =
    project?.name ||
    view?.name ||
    (itemPage && (pageItem?.identifier ?? 'Work item')) ||
    (route.page === 'people'
      ? 'People'
      : route.page === 'notifications'
        ? 'Notifications'
        : route.page === 'home'
          ? 'Home'
          : route.page === 'projects'
            ? 'All projects'
            : route.page === 'my-work'
              ? 'My work'
              : route.page === 'settings'
                ? 'Administration'
                : route.page === 'account-settings'
                  ? 'Account settings'
                  : route.page === 'inbox'
                    ? 'Inbox'
                    : 'Work items');
  const description =
    route.page === 'projects'
      ? 'A little structure for everything you’re moving forward.'
      : route.page === 'my-work'
        ? 'Your work, across projects and your personal inbox.'
        : route.page === 'inbox'
          ? 'Tasks, ideas, and follow-ups. No project needed.'
          : view
            ? 'A saved perspective on your work.'
            : '';
  const ancestors = project
    ? projectAncestors(data.projects, project)
    : itemProject
      ? [...projectAncestors(data.projects, itemProject), itemProject]
      : [];
  const closeItem = () => {
    if (itemPage) {
      const back = itemReturn.current;
      itemReturn.current = null;
      if (back) location.hash = back;
      else navigate('my-work');
      return;
    }
    navigate(
      route.page === 'item' ? 'my-work' : route.page,
      route.page === 'item' ? undefined : route.id,
      isBoard ? 'board' : route.tab,
    );
  };
  const presentingRoadmap = !!project && route.tab === 'roadmap-present';
  const isBoard =
    route.tab === 'board' ||
    (view?.layout === 'board' &&
      !new URLSearchParams(location.hash.split('?')[1] || '').has('tab'));
  const closeProjectPicker = (restoreFocus: boolean) => {
    setProjectPicker(null);
    if (restoreFocus) projectPicker?.returnFocus?.focus({ preventScroll: true });
  };
  const chooseProject = (projectId: string) => {
    const returnFocus = projectPicker?.returnFocus ?? null;
    setProjectPicker(null);
    setMobileNav(false);
    const before = window.location.hash;
    focusAfterNavigation.current = returnFocus;
    navigate(
      'project',
      projectId,
      projectDestination(data, readProjectHistory(data.user.id), projectId),
    );
    if (window.location.hash === before) {
      focusAfterNavigation.current = null;
      returnFocus?.focus({ preventScroll: true });
    }
  };
  async function deleteProject() {
    if (!project) return;
    setDeleteBusy(true);
    try {
      await remove(`/projects/${project.id}`);
      await refresh();
      setConfirmDelete(false);
      navigate('projects');
      toast('Project deleted');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setDeleteBusy(false);
    }
  }
  return (
    <AppContext.Provider
      value={{
        data,
        refresh,
        toast,
        toastAction,
        applyItems,
        removeItems,
        openItem,
        createItem,
        createProject,
        editProject,
        uiPreferences,
        updateUiPreferences,
        projectPickerAnchor: projectPicker?.anchor,
        openProjectPicker: (anchor = null) => showProjectPicker(anchor, anchor),
      }}
    >
      <div
        className={`app-shell ${mobileNav ? 'nav-open' : ''} ${uiPreferences.zenMode ? 'zen-mode' : ''} ${presentingRoadmap ? 'roadmap-presenting' : ''}`}
      >
        <Sidebar
          route={route}
          command={() => showCommands()}
          onShortcuts={() => setHelp(true)}
          onDismiss={() => setMobileNav(false)}
        />
        {mobileNav && (
          <button
            className="nav-scrim"
            aria-label="Close navigation"
            onClick={() => setMobileNav(false)}
          />
        )}
        <main className="main-area">
          <header
            className="topbar"
            data-tauri-drag-region={
              import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM === 'darwin' ? 'deep' : undefined
            }
          >
            <button
              className="icon-button sidebar-toggle"
              aria-label={uiPreferences.zenMode ? 'Show sidebar' : 'Hide sidebar'}
              aria-expanded={!uiPreferences.zenMode}
              title={`${uiPreferences.zenMode ? 'Show sidebar' : 'Hide sidebar'} (${formatShortcut(shortcuts.sidebar.keys[0])})`}
              onClick={toggleSidebar}
            >
              <PanelLeft size={19} />
            </button>
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <PanelLeft size={19} />
            </button>
            <div className="breadcrumbs">
              {route.page === 'account-settings' ? (
                <span>{data.user.name}</span>
              ) : (
                <button onClick={() => navigate('projects')}>
                  {data.workspace?.name ?? 'Workspace'}
                </button>
              )}
              <ChevronRight size={12} />
              {ancestors.map((parent) => (
                <span className="breadcrumb-ancestor" key={parent.id}>
                  <button onClick={() => openProject(data, parent.id)}>{parent.name}</button>
                  <ChevronRight size={12} />
                </span>
              ))}
              <span>{title}</span>
            </div>
            <div className="topbar-actions">
              <NotificationBell />
              {route.page !== 'account-settings' && (
                <div className="member-stack">
                  {data.users.slice(0, 3).map((u) => (
                    <Avatar key={u.id} user={u} size={25} />
                  ))}
                </div>
              )}
              {route.page === 'settings' || route.page === 'account-settings' ? (
                <button
                  className="icon-button"
                  aria-label="Search workspace"
                  onClick={() => showCommands()}
                >
                  <Search size={17} />
                </button>
              ) : (
                <div className="topbar-create-actions">
                  {route.page === 'projects' && <ImportProject />}
                  <button
                    className="button primary new-item-button"
                    onClick={() =>
                      route.page === 'projects' ? createProject() : createItem(project?.id)
                    }
                  >
                    <Plus size={15} />
                    {route.page === 'projects' ? 'New project' : 'New item'}
                    <kbd>{route.page === 'projects' ? '+' : 'C'}</kbd>
                  </button>
                </div>
              )}
            </div>
          </header>
          <ErrorBoundary
            key={`${route.page}:${route.id}`}
            resetKey={route.tab}
            onRecover={() => void refresh().catch((e: Error) => toast(e.message, 'error'))}
          >
            <Suspense fallback={<div className="empty-state">Opening view…</div>}>
              {route.page === 'settings' || route.page === 'account-settings' ? (
                <Settings
                  key={`${data.user.id}:${route.page}`}
                  section={route.tab}
                  scope={route.page === 'account-settings' ? 'account' : 'workspace'}
                />
              ) : route.page === 'people' ? (
                <People userId={route.id} />
              ) : route.page === 'notifications' ? (
                <Notifications key={`${data.user.id}:${data.workspace?.id}`} tab={route.tab} />
              ) : route.page === 'home' ? (
                <Home tab={route.tab} />
              ) : itemPage ? (
                <ItemDetail
                  key={route.itemId}
                  id={route.itemId!}
                  activityId={route.activityId}
                  presentation="page"
                  onClose={closeItem}
                  initialAction={itemAction}
                  onActionHandled={() => setItemAction(undefined)}
                />
              ) : (
                <>
                  <div className="page-heading">
                    <div
                      className={`page-project-icon ${!project ? 'generic-icon' : ''}`}
                      style={project ? { background: project.color } : undefined}
                    >
                      {project ? (
                        <ProjectIcon project={project} size={29} />
                      ) : route.page === 'inbox' ? (
                        <Inbox size={28} />
                      ) : route.page === 'projects' ? (
                        <FolderOpen size={28} />
                      ) : view?.filters.type === 'idea' ? (
                        <Lightbulb size={28} />
                      ) : view?.filters.followUp ? (
                        <Hourglass size={28} />
                      ) : (
                        <Layers size={28} />
                      )}
                    </div>
                    <div className="page-title-block">
                      <h1>
                        {project ? <ProjectSwitcher project={project} /> : title}
                        {project?.visibility === 'private' && <LockKeyhole size={16} />}
                      </h1>
                      {description && <p>{description}</p>}
                      <div className="page-meta">
                        {project && (
                          <>
                            <span className="lifecycle-meta">
                              <span className="tiny-dot" />
                              {project.lifecycle === 'ongoing'
                                ? 'Ongoing'
                                : project.status === 'completed'
                                  ? 'Completed'
                                  : 'Time-bound'}
                            </span>
                            <span>·</span>
                            <ProjectAccess key={project.id} project={project} />
                            <span>·</span>
                          </>
                        )}
                        <span>
                          {route.page === 'projects'
                            ? `${data.projects.filter((p) => p.status === 'active').length} active projects`
                            : `${headingItems.filter((i) => !isDone(i)).length} active items`}
                        </span>
                        {project?.dueDate && (
                          <>
                            <span>·</span>
                            <span>
                              <CalendarDays size={12} />
                              {shortDate(project.dueDate)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {((project && project.status !== 'archived') || view) && (
                      <div className="page-favorite">
                        <FavoriteButton
                          entry={{ kind: project ? 'project' : 'view', id: (project || view)!.id }}
                          name={title}
                        />
                      </div>
                    )}
                    {project && (
                      <div className="popover-parent project-menu">
                        <button
                          className="icon-button"
                          aria-label="Project options"
                          onClick={() => setProjectMenu(!projectMenu)}
                        >
                          <MoreHorizontal size={20} />
                        </button>
                        {projectMenu && (
                          <>
                            <button
                              className="popover-dismiss"
                              aria-label="Close project options"
                              onClick={() => setProjectMenu(false)}
                            />
                            <div className="popover menu-popover">
                              <button
                                onClick={() => {
                                  editProject(project);
                                  setProjectMenu(false);
                                }}
                              >
                                <Pencil size={15} />
                                Edit project
                              </button>
                              <button
                                onClick={() => {
                                  createProject(project.id);
                                  setProjectMenu(false);
                                }}
                              >
                                <Plus size={15} />
                                Add subproject
                              </button>
                              <button
                                onClick={() => {
                                  setExportProject(project);
                                  setProjectMenu(false);
                                }}
                              >
                                <Download size={15} />
                                Export project
                              </button>
                              <button
                                onClick={async () => {
                                  try {
                                    await patch(`/projects/${project.id}`, {
                                      status: project.status === 'archived' ? 'active' : 'archived',
                                    });
                                    await refresh();
                                    setProjectMenu(false);
                                    toast(
                                      project.status === 'archived'
                                        ? 'Project restored'
                                        : 'Project archived',
                                    );
                                  } catch (e) {
                                    toast((e as Error).message, 'error');
                                  }
                                }}
                              >
                                <Archive size={15} />
                                {project.status === 'archived'
                                  ? 'Restore project'
                                  : 'Archive project'}
                              </button>
                              <button
                                className="danger-text"
                                onClick={() => {
                                  setConfirmDelete(true);
                                  setProjectMenu(false);
                                }}
                              >
                                <Trash2 size={15} />
                                Delete project
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {project && <SubprojectNavigation project={project} />}
                  {route.page === 'projects' && (
                    <nav className="page-tabs" aria-label="Project views">
                      <button
                        className={route.tab !== 'weekly' ? 'active' : ''}
                        aria-current={route.tab !== 'weekly' ? 'page' : undefined}
                        onClick={() => navigate('projects')}
                      >
                        All projects
                      </button>
                      <button
                        className={route.tab === 'weekly' ? 'active' : ''}
                        aria-current={route.tab === 'weekly' ? 'page' : undefined}
                        onClick={() => navigate('projects', undefined, 'weekly')}
                      >
                        Weekly review
                      </button>
                    </nav>
                  )}
                  {route.page !== 'projects' && (
                    <nav className="page-tabs">
                      {project && (
                        <button
                          className={
                            route.tab === 'overview' || route.tab.startsWith('overview/')
                              ? 'active'
                              : ''
                          }
                          onClick={() => navigate(route.page, route.id, 'overview')}
                        >
                          Overview
                        </button>
                      )}
                      <button
                        className={route.tab === 'list' && !isBoard ? 'active' : ''}
                        aria-current={route.tab === 'list' && !isBoard ? 'page' : undefined}
                        onClick={() => navigate(route.page, route.id, 'list')}
                      >
                        Work items
                      </button>
                      <button
                        className={isBoard ? 'active' : ''}
                        onClick={() => navigate(route.page, route.id, 'board')}
                      >
                        Board
                      </button>
                      {project && (
                        <button
                          className={route.tab === 'gantt' ? 'active' : ''}
                          aria-current={route.tab === 'gantt' ? 'page' : undefined}
                          onClick={() => navigate(route.page, route.id, 'gantt')}
                        >
                          Gantt
                        </button>
                      )}
                      {project && (
                        <button
                          className={route.tab === 'resources' ? 'active' : ''}
                          aria-current={route.tab === 'resources' ? 'page' : undefined}
                          onClick={() => navigate(route.page, route.id, 'resources')}
                        >
                          Resources
                        </button>
                      )}
                      {project && (
                        <button
                          className={route.tab.startsWith('canvases') ? 'active' : ''}
                          aria-current={route.tab.startsWith('canvases') ? 'page' : undefined}
                          onClick={() => navigate(route.page, route.id, 'canvases')}
                        >
                          Canvases
                        </button>
                      )}
                      {project && (
                        <button
                          className={route.tab.startsWith('roadmap') ? 'active' : ''}
                          aria-current={route.tab.startsWith('roadmap') ? 'page' : undefined}
                          onClick={() => navigate(route.page, route.id, 'roadmap')}
                        >
                          Roadmap
                        </button>
                      )}
                      {view && (
                        <button
                          className="delete-view"
                          title="Remove saved view"
                          onClick={async () => {
                            try {
                              await remove(`/views/${view.id}`);
                              await refresh();
                              navigate('my-work');
                              toast('View removed');
                            } catch (e) {
                              toast((e as Error).message, 'error');
                            }
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </nav>
                  )}
                  <div className="page-body">
                    {route.page === 'projects' ? (
                      route.tab === 'weekly' ? (
                        <WeeklyReview />
                      ) : (
                        <AllProjects />
                      )
                    ) : project && route.tab === 'gantt' ? (
                      <GanttView key={project.id} project={project} items={items} />
                    ) : project &&
                      (route.tab === 'overview' || route.tab.startsWith('overview/')) ? (
                      <Overview
                        key={`${project.id}:${route.tab}`}
                        project={project}
                        items={items}
                        milestoneId={route.tab.split('/')[1]}
                      />
                    ) : project && (route.tab === 'roadmap' || presentingRoadmap) ? (
                      <RoadmapView
                        key={project.id}
                        project={project}
                        presenting={presentingRoadmap}
                      />
                    ) : project &&
                      (route.tab === 'canvases' || route.tab.startsWith('canvases/')) ? (
                      <Canvases
                        key={`${data.user.id}:${project.id}`}
                        project={project}
                        canvasId={route.tab.split('/')[1]}
                      />
                    ) : project && route.tab === 'resources' ? (
                      <Resources project={project} />
                    ) : route.page === 'project' && !project ? (
                      <EmptyState
                        title="Project not found"
                        description="It may have been removed, or you may not have access."
                        action={
                          <button className="button" onClick={() => navigate('projects')}>
                            All projects
                          </button>
                        }
                      />
                    ) : (
                      <WorkList
                        key={`${data.user.id}-${data.user.workspaceId}-${route.page}-${route.id}-${isBoard}`}
                        items={items}
                        projectId={project?.id}
                        board={isBoard}
                        initialFilters={view?.filters}
                        baseFilters={
                          route.page === 'my-work'
                            ? { scope: 'my-work' }
                            : route.page === 'inbox'
                              ? { scope: 'inbox' }
                              : {}
                        }
                      />
                    )}
                  </div>
                </>
              )}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <Suspense
        fallback={
          <div className="toast" role="status">
            Opening editor…
          </div>
        }
      >
        {route.itemId && uiPreferences.itemLayout !== 'page' && (
          <ErrorBoundary key={route.itemId} onRecover={closeItem}>
            <ItemDetail
              key={route.itemId}
              id={route.itemId}
              activityId={route.activityId}
              onClose={closeItem}
              initialAction={itemAction}
              onActionHandled={() => setItemAction(undefined)}
            />
          </ErrorBoundary>
        )}
        {exportProject && (
          <ExportProject project={exportProject} onClose={() => setExportProject(null)} />
        )}
        {newItem && <ItemForm {...newItem} onClose={() => setNewItem(null)} />}
        {newProject && <ProjectForm {...newProject} onClose={() => setNewProject(null)} />}
        {command && (
          <CommandPalette
            mode={commandMode}
            itemId={commandItemId}
            onHelp={() => setHelp(true)}
            onClose={() => setCommand(false)}
          />
        )}
        {help && <ShortcutHelp onClose={() => setHelp(false)} />}
        {projectPicker && (
          <ProjectPicker
            anchor={projectPicker.anchor}
            currentId={project?.id}
            onSelect={chooseProject}
            onBrowse={() => {
              setProjectPicker(null);
              setMobileNav(false);
              navigate('projects');
            }}
            onCreate={() => {
              closeProjectPicker(true);
              createProject();
            }}
            onDismiss={closeProjectPicker}
          />
        )}
        {confirmDelete && project && (
          <Modal title="Delete project?" onClose={() => setConfirmDelete(false)}>
            <div className="simple-form">
              <p>
                This permanently removes <strong>{project.name}</strong>. Move or delete its work
                items and subprojects first.
              </p>
              <div className="form-actions">
                <button className="button" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button className="button danger" disabled={deleteBusy} onClick={deleteProject}>
                  Delete project
                </button>
              </div>
            </div>
          </Modal>
        )}
      </Suspense>
      {message && (
        <div
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`toast ${message.kind}`}
        >
          {message.kind === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{message.text}</span>
          {message.action && (
            <button
              className="button small"
              onClick={() => {
                const action = message.action!;
                setMessage(null);
                void Promise.resolve()
                  .then(action.onClick)
                  .catch((e: Error) => toast(e.message, 'error'));
              }}
            >
              {message.action.label}
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setMessage(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </AppContext.Provider>
  );
}
