import { useRef } from 'react';
import {
  Bookmark,
  ChartGantt,
  ChevronsUpDown,
  LayoutDashboard,
  Link2,
  List,
  ListChecks,
  LockKeyhole,
  Map as MapIcon,
  Shapes,
  SquareKanban,
} from 'lucide-react';
import type { Project } from '../../shared/types';
import { useApp } from '../lib/context';
import { navigate, type Route } from '../lib/model';
import { projectAncestors } from '../lib/navigation';
import { navVariants, projectSection, type NavVariant } from '../lib/nav-variant';
import { readProjectHistory } from '../lib/project-picker';
import { ProjectIcon } from './ui';
import './project-sidebar.css';

const sections = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, tab: 'overview' },
  { id: 'work', label: 'Work', icon: ListChecks, tab: 'list' },
  { id: 'roadmap', label: 'Roadmap', icon: MapIcon, tab: 'roadmap' },
  { id: 'canvases', label: 'Canvases', icon: Shapes, tab: 'canvases' },
  { id: 'resources', label: 'Resources', icon: Link2, tab: 'resources' },
] as const;

/** Work opens in the layout last used for the project. */
function workTab(userId: string, projectId: string) {
  const tab = readProjectHistory(userId).views[projectId];
  return tab === 'board' || tab === 'gantt' ? tab : 'list';
}

/** The project the sidebar shows: the one on screen, else the most recently opened. */
export function sidebarProject(
  data: ReturnType<typeof useApp>['data'],
  route: Route,
): Project | undefined {
  const accessible = (id?: string | null) =>
    id ? data.projects.find((p) => p.id === id && p.status !== 'archived') : undefined;
  if (route.page === 'project') return data.projects.find((p) => p.id === route.id);
  if (route.page === 'view') {
    const view = data.views.find((v) => v.id === route.id);
    const project = accessible(view?.filters.projectId);
    if (project) return project;
  }
  for (const id of readProjectHistory(data.user.id).recent) {
    const project = accessible(id);
    if (project) return project;
  }
  return undefined;
}

export function SidebarProjectPicker({
  project,
  placement,
}: {
  project?: Project;
  placement: 'top' | 'section';
}) {
  const { data, projectPickerAnchor, openProjectPicker } = useApp();
  const trigger = useRef<HTMLButtonElement>(null);
  const open = !!trigger.current && projectPickerAnchor === trigger.current;
  const path = project ? projectAncestors(data.projects, project).map((p) => p.name) : [];
  return (
    <button
      ref={trigger}
      className={`sidebar-project-picker ${placement}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? 'project-picker' : undefined}
      aria-label={project ? `Project: ${project.name}. Switch project` : 'Choose a project'}
      title="Switch project (O then P)"
      onClick={() => openProjectPicker(trigger.current)}
    >
      <span
        className="sidebar-project-icon"
        style={project ? { background: `${project.color}1f` } : undefined}
      >
        <ProjectIcon project={project} size={16} />
      </span>
      <span className="sidebar-project-text">
        {placement === 'top' && <small>{path.length ? path.join(' / ') : 'Project'}</small>}
        <strong>{project?.name ?? 'Choose a project'}</strong>
        {placement === 'section' && path.length > 0 && <small>{path.join(' / ')}</small>}
      </span>
      {project?.visibility === 'private' && <LockKeyhole size={13} aria-hidden="true" />}
      <ChevronsUpDown size={14} aria-hidden="true" />
    </button>
  );
}

export function ProjectSidebarSections({
  project,
  route,
  sections: showSections,
  onNavigate,
}: {
  project: Project;
  route: Route;
  /** False keeps only the project's saved views, for variants with in-page tabs. */
  sections: boolean;
  onNavigate: () => void;
}) {
  const { data } = useApp();
  const here = route.page === 'project' && route.id === project.id;
  const current = here ? projectSection(route.tab) : undefined;
  const views = data.views.filter((view) => view.filters.projectId === project.id);
  return (
    <>
      {showSections && (
        <nav className="project-sections" aria-label={`${project.name} sections`}>
          {sections.map((section) => {
            const active = current === section.id;
            return (
              <button
                key={section.id}
                className={`nav-item project-section-item ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  navigate(
                    'project',
                    project.id,
                    section.id === 'work' ? workTab(data.user.id, project.id) : section.tab,
                  );
                  onNavigate();
                }}
              >
                <section.icon size={16} />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>
      )}
      {views.length > 0 && (
        <nav className="project-sections" aria-label={`${project.name} saved views`}>
          <div className="project-sections-label">Views</div>
          {views.map((view) => {
            const active = route.page === 'view' && route.id === view.id;
            return (
              <button
                key={view.id}
                className={`nav-item project-section-item ${active ? 'active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  navigate('view', view.id, view.layout);
                  onNavigate();
                }}
              >
                <Bookmark size={15} />
                <span>{view.name}</span>
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}

const layouts = [
  { tab: 'list', label: 'List', icon: List },
  { tab: 'board', label: 'Board', icon: SquareKanban },
  { tab: 'gantt', label: 'Gantt', icon: ChartGantt },
] as const;

/** Work's list, board and Gantt layouts, replacing three of the seven page tabs. */
export function WorkLayoutSwitch({ project, tab }: { project: Project; tab: string }) {
  return (
    <div className="work-layout-switch" role="group" aria-label="Work layout">
      {layouts.map((layout) => (
        <button
          key={layout.tab}
          aria-pressed={tab === layout.tab}
          onClick={() => navigate('project', project.id, layout.tab)}
        >
          <layout.icon size={14} aria-hidden="true" />
          {layout.label}
        </button>
      ))}
    </div>
  );
}

/** Variant C: five project tabs, with Work's layouts beside them. */
export function SlimProjectTabs({ project, route }: { project: Project; route: Route }) {
  const { data } = useApp();
  const current = projectSection(route.tab);
  return (
    <nav className="page-tabs slim-project-tabs" aria-label={`${project.name} sections`}>
      {sections.map((section) => (
        <button
          key={section.id}
          className={current === section.id ? 'active' : ''}
          aria-current={current === section.id ? 'page' : undefined}
          onClick={() =>
            navigate(
              'project',
              project.id,
              section.id === 'work' ? workTab(data.user.id, project.id) : section.tab,
            )
          }
        >
          {section.label}
        </button>
      ))}
      {current === 'work' && <WorkLayoutSwitch project={project} tab={route.tab} />}
    </nav>
  );
}

/** Development-only control for comparing navigation variants. */
export function NavVariantSwitch({
  value,
  onChange,
}: {
  value: NavVariant;
  onChange: (variant: NavVariant) => void;
}) {
  return (
    <div className="nav-variant-switch" role="radiogroup" aria-label="Navigation variant (dev)">
      <span>Nav</span>
      {navVariants.map((variant) => (
        <button
          key={variant.id}
          role="radio"
          aria-checked={value === variant.id}
          title={variant.description}
          onClick={() => onChange(variant.id)}
        >
          {variant.label}
        </button>
      ))}
    </div>
  );
}
