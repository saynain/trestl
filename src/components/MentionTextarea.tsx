import { createPortal } from 'react-dom';
import { useId, useRef, useState, useLayoutEffect, type TextareaHTMLAttributes } from 'react';
import {
  mentionMarkdown,
  mentionQuery,
  mentionTriggers,
  type Mention,
  type MentionKind,
} from '../../shared/mentions';
import { useApp } from '../lib/context';
import { workItemOptions } from '../lib/work-item-options';
import './mentions.css';

type Option = Mention & { label: string; detail: string };

export function MentionTextarea({
  value,
  onChange,
  onKeyDown,
  excludeItemId,
  projectId,
  kinds,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value: string;
  excludeItemId?: string;
  projectId?: string | null;
  kinds?: MentionKind[];
}) {
  const { data } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0 });
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);
  const detected = focused && !dismissed ? mentionQuery(value, caret) : null;
  const query = detected && (!kinds || kinds.includes(detected.kind)) ? detected : null;
  const candidates: Option[] =
    query?.kind === 'user'
      ? data.users
          .filter((u) => !u.disabledAt)
          .map((u) => ({ kind: 'user', id: u.id, label: u.name, detail: u.email }))
      : query?.kind === 'project'
        ? data.projects.map((p) => ({ kind: 'project', id: p.id, label: p.name, detail: p.key }))
        : query?.kind === 'milestone'
          ? data.milestones.map((m) => ({
              kind: 'milestone',
              id: m.id,
              label: m.title,
              detail: data.projects.find((p) => p.id === m.projectId)?.name ?? '',
            }))
          : query?.kind === 'canvas'
            ? (data.canvases ?? []).map((c) => ({
                kind: 'canvas',
                id: c.id,
                label: c.title,
                detail: data.projects.find((p) => p.id === c.projectId)?.name ?? '',
              }))
            : query?.kind === 'item'
              ? workItemOptions(data.items, data.projects, {
                  projectId,
                  excludeItemId,
                  query: query.query,
                  limit: 8,
                }).map((option) => ({ ...option, kind: 'item' }))
              : [];
  const options = candidates
    .filter((o) =>
      `${o.label} ${o.detail}`.toLowerCase().includes(query?.query.toLowerCase() ?? ''),
    )
    .slice(0, 8);
  const active = Math.min(selected, Math.max(0, options.length - 1));
  const isOpen = !!query;
  useLayoutEffect(() => {
    if (!isOpen) return;
    const position = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const height = menuRef.current?.offsetHeight || 300;
      const below = rect.bottom + 6;
      const top =
        below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 6);
      const width = Math.min(440, rect.width, window.innerWidth - 24);
      setMenuPosition({
        top,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        width,
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [isOpen, options.length, caret]);
  useLayoutEffect(() => {
    if (isOpen)
      menuRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest' });
  }, [active, isOpen]);
  function choose(option: Option) {
    const element = ref.current;
    if (!query || !element) return;
    const insertion = mentionMarkdown(option, option.label) + ' ';
    const next = value.slice(0, query.start) + insertion + value.slice(query.end);
    // Dispatch a native input event so callers retain ordinary textarea onChange semantics.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      element,
      next,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
    setDismissed(true);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(query.start + insertion.length, query.start + insertion.length);
    });
  }
  return (
    <div className="mention-editor">
      <textarea
        {...props}
        ref={ref}
        value={value}
        onChange={(e) => {
          setCaret(e.currentTarget.selectionStart);
          setSelected(0);
          setDismissed(false);
          onChange?.(e);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
        aria-controls={query ? listId : undefined}
        aria-expanded={!!query}
        aria-autocomplete="list"
        aria-activedescendant={query && options.length ? `${listId}-${active}` : undefined}
        onKeyDown={(e) => {
          if (query && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setDismissed(true);
              return;
            }
            if (options.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'ArrowDown') setSelected((active + 1) % options.length);
              else if (e.key === 'ArrowUp')
                setSelected((active + options.length - 1) % options.length);
              else choose(options[active]);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />
      {query &&
        createPortal(
          <div className="mention-menu" ref={menuRef} style={menuPosition}>
            <div className="mention-menu-heading">
              {mentionTriggers[query.kind]}{' '}
              {query.kind === 'user'
                ? 'People'
                : query.kind === 'item'
                  ? 'Work items'
                  : query.kind === 'milestone'
                    ? 'Milestones'
                    : query.kind === 'canvas'
                      ? 'Canvases'
                      : 'Projects'}
            </div>
            <div id={listId} role="listbox" aria-label="Mention suggestions">
              {options.map((option, index) => (
                <button
                  key={option.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  tabIndex={-1}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  <small>{option.detail}</small>
                </button>
              ))}
              {!options.length && (
                <p className="muted" role="status">
                  No matches
                </p>
              )}
            </div>
            <div className="mention-menu-hint">
              ↑ ↓ to choose · Enter to insert · Esc to dismiss
            </div>
          </div>,
          document.body,
        )}
      <div className="mention-help">
        {kinds?.length === 1 && kinds[0] === 'canvas'
          ? '! canvases'
          : '@ people · / work items · $ projects · ! canvases · % milestones'}
      </div>
    </div>
  );
}
