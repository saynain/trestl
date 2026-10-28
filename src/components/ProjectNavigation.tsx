import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LockKeyhole,
  Plus,
  Search,
} from 'lucide-react';
import type { Project } from '../../shared/types';
import { useApp } from '../lib/context';
import { openProject, projectPickerSections, readProjectHistory } from '../lib/project-picker';
import { ProjectIcon } from './ui';
import './select.css';

export function ProjectSwitcher({ project }: { project: Project }) {
  const { projectPickerAnchor, openProjectPicker } = useApp();
  const trigger = useRef<HTMLButtonElement>(null);
  const open = !!trigger.current && projectPickerAnchor === trigger.current;
  return (
    <button
      ref={trigger}
      className="project-switcher"
      aria-label={`Switch project, current project ${project.name}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? 'project-picker' : undefined}
      onClick={() => openProjectPicker(trigger.current)}
    >
      <span>{project.name}</span>
      <ChevronDown size={18} />
    </button>
  );
}

/** An anchored project switcher: recent, favorite and all projects, filtered as you type. */
export function ProjectPicker({
  anchor,
  currentId,
  onSelect,
  onBrowse,
  onCreate,
  onDismiss,
}: {
  anchor: HTMLElement | null;
  currentId?: string;
  onSelect: (projectId: string) => void;
  onBrowse: () => void;
  onCreate: () => void;
  onDismiss: (restoreFocus: boolean) => void;
}) {
  const { data, uiPreferences } = useApp();
  const uid = useId();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent] = useState(() => readProjectHistory(data.user.id).recent);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const sections = projectPickerSections(data, uiPreferences.favorites, recent, currentId, query);
  const options = sections.flatMap((section) =>
    section.entries.map((entry) => ({ ...entry, key: `${section.id}-${entry.project.id}` })),
  );
  const activeIndex = Math.min(active, options.length - 1);
  const optionId = (key: string) => `${uid}-option-${key}`;

  useLayoutEffect(() => {
    const popup = panel.current;
    if (!popup) return;
    const position = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const popupWidth = Math.min(400, width - 16);
      const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
      // Without a visible trigger, open near the top like the command menu.
      const top = rect ? rect.bottom + 6 : offsetTop + Math.min(96, height * 0.12);
      const left = rect ? rect.left : offsetLeft + (width - popupWidth) / 2;
      popup.style.width = `${popupWidth}px`;
      popup.style.top = `${top}px`;
      popup.style.left = `${Math.max(offsetLeft + 8, Math.min(left, offsetLeft + width - popupWidth - 8))}px`;
      popup.style.maxHeight = `${Math.max(180, offsetTop + height - top - 12)}px`;
    };
    // The top layer keeps the picker above item panels and the mobile drawer.
    popup.showPopover();
    position();
    input.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popup.contains(target) && !anchor?.contains(target)) dismiss.current(false);
    };
    const scroll = (event: Event) => {
      if (!popup.contains(event.target as Node)) position();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', scroll, true);
    window.visualViewport?.addEventListener('resize', position);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', scroll, true);
      window.visualViewport?.removeEventListener('resize', position);
      if (popup.isConnected) popup.hidePopover();
    };
  }, [anchor]);

  useEffect(() => {
    const option = options[activeIndex];
    if (option) document.getElementById(optionId(option.key))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, options[activeIndex]?.key]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keep workspace shortcuts and dialogs underneath from reacting to picker keys.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss(true);
    } else if (event.key === 'Tab') {
      const focusable = Array.from(
        panel.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [],
      );
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
      event.preventDefault();
      focusable[next]?.focus();
    } else if (event.target !== input.current) {
      return;
    } else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) {
      event.preventDefault();
      if (!options.length) return;
      if (event.key === 'ArrowDown') setActive((activeIndex + 1) % options.length);
      if (event.key === 'ArrowUp') setActive((activeIndex - 1 + options.length) % options.length);
      if (event.key === 'PageDown') setActive(Math.min(options.length - 1, activeIndex + 8));
      if (event.key === 'PageUp') setActive(Math.max(0, activeIndex - 8));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) onSelect(option.project.id);
    }
  }

  return createPortal(
    <div
      ref={panel}
      id="project-picker"
      popover="manual"
      className="picker-panel project-picker"
      role="dialog"
      aria-label="Switch project"
      onKeyDown={onKeyDown}
    >
      <div className="picker-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          placeholder="Switch to project…"
          aria-label="Find a project"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${uid}-list`}
          aria-activedescendant={
            options[activeIndex] ? optionId(options[activeIndex].key) : undefined
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="picker-options" id={`${uid}-list`} role="listbox" aria-label="Projects">
        {sections.map((section) => (
          <div key={section.id} role="group" aria-labelledby={`${uid}-${section.id}`}>
            <div className="picker-group" id={`${uid}-${section.id}`}>
              {section.label}
            </div>
            {section.entries.map((entry) => {
              const key = `${section.id}-${entry.project.id}`;
              const index = options.findIndex((option) => option.key === key);
              const current = entry.project.id === currentId;
              const path = entry.path.join(' / ');
              return (
                <div
                  key={key}
                  id={optionId(key)}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-label={[
                    entry.project.name,
                    path && `in ${path}`,
                    entry.restricted && 'private',
                    current && 'current project',
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  title={path ? `${path} / ${entry.project.name}` : entry.project.name}
                  className={`picker-option project-picker-option ${index === activeIndex ? 'is-active' : ''}`}
                  onPointerMove={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(entry.project.id)}
                >
                  <span className="picker-icon" aria-hidden="true">
                    <ProjectIcon project={entry.project} size={16} />
                  </span>
                  <span className="project-picker-label">
                    <span className="project-picker-name">{entry.project.name}</span>
                    {path && <span className="project-picker-path">{path}</span>}
                  </span>
                  {entry.restricted && (
                    <LockKeyhole className="project-picker-private" size={13} aria-hidden="true" />
                  )}
                  {current && <Check className="picker-check" size={15} aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        ))}
        {!options.length && (
          <div className="picker-empty" role="status">
            {query ? `No projects match “${query}”` : 'No projects yet'}
          </div>
        )}
      </div>
      <div className="project-picker-footer">
        <button type="button" onClick={onBrowse}>
          <FolderOpen size={15} aria-hidden="true" />
          Browse all projects
        </button>
        <button type="button" onClick={onCreate}>
          <Plus size={15} aria-hidden="true" />
          New project
        </button>
      </div>
    </div>,
    document.body,
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
        <button key={child.id} onClick={() => openProject(data, child.id)}>
          <ProjectIcon project={child} size={14} />
          <span>{child.name}</span>
          <ChevronRight size={12} />
        </button>
      ))}
    </nav>
  );
}
