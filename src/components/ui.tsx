import logoUrl from '../../public/trestl-mark.svg?url';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  Box,
  Check,
  Circle,
  CircleDashed,
  Layers,
  X,
  Users,
  Wrench,
  Minus,
  AlertCircle,
  createLucideIcon,
} from 'lucide-react';
import type { Priority, Project, Status, User } from '../../shared/types';
import { initials, priorities, statuses } from '../lib/model';
// Lucide 1.0 removed brand icons; this keeps its former GitHub outline.
export const GitHubIcon = createLucideIcon('Github', [
  [
    'path',
    {
      d: 'M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4',
      key: 'tonef',
    },
  ],
  ['path', { d: 'M9 18c-4.51 2-5-2-7-2', key: '9comsn' }],
]);
export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? 'small' : ''}`} aria-hidden="true">
      <img src={logoUrl} width="40" height="32" alt="" />
    </span>
  );
}
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-lockup ${small ? 'small' : ''}`} aria-label="Trestl">
      <Logo small={small} />
      <span className="brand-wordmark" aria-hidden="true">
        trestl
      </span>
    </span>
  );
}
/** Progress through first-run setup: installation, first project, next steps. */
export function SetupSteps({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="setup-steps" role="img" aria-label={`Setup step ${current} of 3`}>
      {[1, 2, 3].map((step) => (
        <span key={step} className={step <= current ? 'done' : undefined} />
      ))}
    </div>
  );
}
export function Avatar({ user, size = 24 }: { user?: User | null; size?: number }) {
  return (
    <span
      className="avatar"
      title={user?.name || 'Unassigned'}
      style={{
        width: size,
        height: size,
        background: user?.color ? `${user.color}20` : 'var(--surface)',
        color: user?.color || 'var(--muted)',
        fontSize: Math.max(9, size * 0.36),
      }}
    >
      {user ? initials(user.name) : <Users size={size * 0.52} />}
    </span>
  );
}
export function ProjectIcon({
  project,
  size = 18,
}: {
  project?: Pick<Project, 'icon' | 'color'>;
  size?: number;
}) {
  const Icon =
    project?.icon === 'users'
      ? Users
      : project?.icon === 'wrench'
        ? Wrench
        : project?.icon === 'layers'
          ? Layers
          : Box;
  return (
    <Icon size={size} strokeWidth={1.65} style={{ color: project?.color || 'var(--accent)' }} />
  );
}
export function StatusIcon({ status }: { status: Status }) {
  const color = statuses.find((s) => s.id === status)?.color;
  return (
    <span
      className={`status-icon ${status}`}
      style={{ color }}
      title={statuses.find((s) => s.id === status)?.name}
    >
      {status === 'done' ? (
        <span className="status-filled">
          <Check size={11} strokeWidth={3} />
        </span>
      ) : status === 'canceled' ? (
        <span className="status-filled canceled">
          <X size={10} />
        </span>
      ) : status === 'backlog' ? (
        <CircleDashed size={16} strokeWidth={1.6} />
      ) : status === 'in_progress' ? (
        <span className="status-progress" />
      ) : status === 'in_review' ? (
        <span className="status-review" />
      ) : (
        <Circle size={16} strokeWidth={1.6} />
      )}
    </span>
  );
}
export function PriorityIcon({ priority }: { priority: Priority }) {
  return (
    <span
      title={priorities.find((p) => p.id === priority)?.name}
      className={`priority-icon priority-${priority}`}
      style={{ color: priorities.find((p) => p.id === priority)?.color }}
    >
      {priority === 'urgent' ? (
        <AlertCircle size={15} />
      ) : priority === 'none' ? (
        <Minus size={15} />
      ) : (
        <svg width="15" height="15" viewBox="0 0 15 15" fill="currentColor">
          <rect x="1" y="8" width="3" height="6" rx=".7" />
          <rect x="6" y="5" width="3" height="9" rx=".7" opacity={priority === 'low' ? '.23' : 1} />
          <rect
            x="11"
            y="1"
            width="3"
            height="13"
            rx=".7"
            opacity={priority === 'high' ? 1 : '.23'}
          />
        </svg>
      )}
    </span>
  );
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
  className = '',
  initialFocus = 'auto',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  initialFocus?: 'auto' | 'panel';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const focus = () => {
      if (panel.current?.contains(document.activeElement)) return;
      if (initialFocus === 'panel') {
        panel.current?.focus();
        return;
      }
      const first =
        panel.current?.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ||
        panel.current?.querySelector<HTMLElement>('input:not([type=hidden]),textarea') ||
        panel.current?.querySelector<HTMLElement>('select,button,[tabindex="0"]');
      first?.focus();
    };
    const timer = window.setTimeout(focus, 30);
    const handler = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const els = Array.from(
          panel.current?.querySelectorAll<HTMLElement>(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
          ) || [],
        ).filter((el) => el.offsetParent !== null);
        const first = els[0],
          last = els[els.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = old;
      prev?.focus();
    };
  }, []);
  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className={`modal-panel ${wide ? 'modal-wide' : ''} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Work item'}
      >
        <div className="modal-header">
          {title ? <h2>{title}</h2> : <span />}
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <Layers size={26} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
