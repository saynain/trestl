import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { Project } from '../../shared/types';
import { useApp } from '../lib/context';
import { favoriteEntries, hasFavorite } from '../lib/navigation';
import { navigate } from '../lib/model';
import { Modal, ProjectIcon } from './ui';

export function ProjectSwitcher({ project }: { project: Project }) {
  const { data, uiPreferences } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const projects = data.projects.filter(
    (candidate) =>
      candidate.status !== 'archived' &&
      `${candidate.name} ${candidate.key}`.toLowerCase().includes(query.toLowerCase().trim()),
  );
  const favorites = favoriteEntries(data, uiPreferences.favorites).flatMap((entry) =>
    entry.project && projects.some((project) => project.id === entry.id) ? [entry.project] : [],
  );
  const others = projects
    .filter(
      (candidate) => !hasFavorite(uiPreferences.favorites, { kind: 'project', id: candidate.id }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <button
        className="project-switcher"
        aria-label={`Switch project, current project ${project.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setOpen(true);
        }}
      >
        <span>{project.name}</span>
        <ChevronDown size={18} />
      </button>
      {open &&
        createPortal(
          <Modal
            title="Switch project"
            onClose={() => setOpen(false)}
            className="navigation-dialog"
          >
            <label className="navigation-search">
              <Search size={16} />
              <input
                aria-label="Find a project"
                placeholder="Find a project…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="navigation-results">
              {[
                { label: 'Favorites', projects: favorites },
                { label: 'All projects', projects: others },
              ].map(
                (group) =>
                  group.projects.length > 0 && (
                    <section key={group.label}>
                      <h3 className="navigation-group-title">{group.label}</h3>
                      {group.projects.map((candidate) => (
                        <button
                          key={candidate.id}
                          className="navigation-entry navigation-entry-main"
                          aria-current={candidate.id === project.id ? 'page' : undefined}
                          onClick={() => {
                            navigate('project', candidate.id, 'overview');
                            setOpen(false);
                          }}
                        >
                          <ProjectIcon project={candidate} size={19} />
                          <span>
                            <strong>{candidate.name}</strong>
                            <small>
                              {data.projects.find((parent) => parent.id === candidate.parentId)
                                ?.name || candidate.key}
                            </small>
                          </span>
                          {candidate.id === project.id && <Check size={17} />}
                        </button>
                      ))}
                    </section>
                  ),
              )}
              {!projects.length && <p className="navigation-empty">No projects match “{query}”.</p>}
            </div>
            <div className="navigation-dialog-footer">
              <button
                className="text-button"
                onClick={() => {
                  navigate('projects');
                  setOpen(false);
                }}
              >
                Browse all projects <ChevronRight size={14} />
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}

export function SubprojectNavigation({ project }: { project: Project }) {
  const { data } = useApp();
  const children = data.projects.filter(
    (candidate) => candidate.parentId === project.id && candidate.status !== 'archived',
  );
  if (!children.length) return null;
  return (
    <nav className="subproject-navigation" aria-label={`Subprojects of ${project.name}`}>
      <span>Subprojects</span>
      {children.map((child) => (
        <button key={child.id} onClick={() => navigate('project', child.id, 'overview')}>
          <ProjectIcon project={child} size={14} />
          <span>{child.name}</span>
          <ChevronRight size={12} />
        </button>
      ))}
    </nav>
  );
}
