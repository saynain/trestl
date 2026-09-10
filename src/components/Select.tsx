import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Bug,
  Check,
  CheckSquare,
  ChevronDown,
  Inbox,
  Lightbulb,
  Lock,
  Repeat2,
  Search,
  Users,
} from 'lucide-react';
import { useApp } from '../lib/context';
import { priorities, statuses } from '../lib/model';
import { Avatar, PriorityIcon, ProjectIcon, StatusIcon } from './ui';
import './select.css';
import { formatShortcut } from '../lib/shortcuts';

type Option = { value: string; label: string; disabled?: boolean; group?: string };
function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? textContent(child.props.children)
        : String(child),
    )
    .join('');
}
function readOptions(children: ReactNode, group?: string, disabled = false): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        value?: string | number;
        label?: string;
        disabled?: boolean;
        children?: ReactNode;
      }>(child)
    )
      return [];
    const props = child.props;
    if (child.type === 'option')
      return [
        {
          value: String(props.value ?? textContent(props.children)),
          label: props.label ?? textContent(props.children),
          disabled: disabled || props.disabled,
          group,
        },
      ];
    return readOptions(props.children, props.label ?? group, disabled || props.disabled);
  });
}

function OptionIcon({ option }: { option: Option }) {
  const { data } = useApp();
  const status = statuses.find((entry) => entry.id === option.value && entry.name === option.label);
  const priority = priorities.find(
    (entry) => entry.id === option.value && entry.name === option.label,
  );
  const project = data.projects.find((entry) => entry.id === option.value);
  const user = data.users.find((entry) => entry.id === option.value);
  const TypeIcon = { task: CheckSquare, bug: Bug, idea: Lightbulb, followup: Repeat2 }[
    option.value
  ];
  const icon = status ? (
    <StatusIcon status={status.id} />
  ) : priority ? (
    <PriorityIcon priority={priority.id} />
  ) : project ? (
    <ProjectIcon project={project} size={16} />
  ) : user ? (
    <Avatar user={user} size={20} />
  ) : TypeIcon ? (
    <TypeIcon size={16} />
  ) : option.value === 'private' ? (
    <Lock size={15} />
  ) : option.value === 'workspace' || /Unassigned|Anyone|Assigned to me/.test(option.label) ? (
    <Users size={16} />
  ) : option.label === 'Personal inbox' ? (
    <Inbox size={16} />
  ) : null;
  return icon ? (
    <span className="picker-icon" aria-hidden="true">
      {icon}
    </span>
  ) : null;
}

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> & {
  searchable?: boolean;
  shortcut?: string;
  shortcutHint?: string;
};

/** A single-value picker that keeps native form values, validation and change events. */
export function Select({
  children,
  className = '',
  value,
  defaultValue,
  onChange,
  searchable,
  shortcut,
  shortcutHint,
  id: suppliedId,
  autoFocus,
  ...props
}: Props) {
  const uid = useId();
  const id = suppliedId || `picker-${uid}`;
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const options = readOptions(children);
  const [localValue, setLocalValue] = useState(String(defaultValue ?? options[0]?.value ?? ''));
  const selectedValue = String(value ?? localValue);
  const selected = options.find((option) => option.value === selectedValue) ?? options[0];
  const [inferredLabel, setInferredLabel] = useState(props.title || 'Choose option');
  const label = props['aria-label'] || inferredLabel;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const filtered = options.filter((option) =>
    `${option.label} ${option.group || ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const canSearch =
    searchable ?? (options.length > 6 || /project|assignee|repository/i.test(label));
  const activeOption = filtered[active];

  useLayoutEffect(() => {
    const parentLabel = trigger.current?.labels?.[0];
    if (!props['aria-label'] && parentLabel) {
      const text = Array.from(parentLabel.childNodes)
        .filter((node) => node !== root.current)
        .map((node) => node.textContent)
        .join('')
        .trim();
      if (text) setInferredLabel(text);
    }
  }, [props['aria-label']]);

  useEffect(() => {
    const form = native.current?.form;
    const reset = () => {
      setLocalValue(String(defaultValue ?? options[0]?.value ?? ''));
      setOpen(false);
    };
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, [defaultValue, options[0]?.value]);

  function close(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function show() {
    if (trigger.current?.matches(':disabled')) return;
    setQuery('');
    const selectedIndex = options.findIndex(
      (option) => option.value === selectedValue && !option.disabled,
    );
    setActive(
      selectedIndex >= 0
        ? selectedIndex
        : Math.max(
            0,
            options.findIndex((option) => !option.disabled),
          ),
    );
    setOpen(true);
  }
  function choose(option?: Option) {
    if (!option || option.disabled || !native.current || native.current.matches(':disabled'))
      return;
    close();
    // Dispatch through the real select so existing React onChange handlers and FormData keep working.
    native.current.value = option.value;
    native.current.dispatchEvent(new Event('change', { bubbles: true }));
  }

  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const popup = panel.current;
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const offsetTop = viewport?.offsetTop ?? 0;
      const offsetLeft = viewport?.offsetLeft ?? 0;
      const popupWidth = Math.min(Math.max(rect.width, 244), width - 16);
      popup.style.width = `${popupWidth}px`;
      const below = height + offsetTop - rect.bottom - 14;
      const above = rect.top - offsetTop - 14;
      const upwards = below < Math.min(popup.scrollHeight || 320, 320) && above > below;
      popup.style.maxHeight = `${Math.max(80, upwards ? above : below)}px`;
      popup.style.left = `${Math.max(offsetLeft + 8, Math.min(rect.left, width + offsetLeft - popupWidth - 8))}px`;
      popup.style.top = `${upwards ? Math.max(offsetTop + 8, rect.top - popup.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
    };
    // The top layer avoids clipping inside scrollable dialogs, sidebars and filter panels.
    popup.showPopover();
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popup);
    (search.current || list.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!popup.contains(event.target as Node) && !root.current?.contains(event.target as Node))
        close(false);
    };
    const scroll = (event: Event) => {
      if (!popup.contains(event.target as Node)) position();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', scroll, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer.disconnect();
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', scroll, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      if (popup.isConnected) popup.hidePopover();
    };
  }, [open]);

  useEffect(() => {
    if (open)
      document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id]);

  function onMenuKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      // Restore the trigger before the browser advances to the next form control.
      close();
    } else if (event.key === 'Enter' || (event.key === ' ' && !canSearch)) {
      event.preventDefault();
      choose(activeOption);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (canSearch && (event.key === 'Home' || event.key === 'End')) return;
      event.preventDefault();
      const enabled = filtered
        .map((option, index) => (option.disabled ? -1 : index))
        .filter((index) => index >= 0);
      const index = enabled.indexOf(active);
      const next =
        event.key === 'Home'
          ? enabled[0]
          : event.key === 'End'
            ? enabled.at(-1)
            : enabled[
                (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
              ];
      if (next !== undefined) setActive(next);
    } else if (!canSearch && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      const rotated = [...filtered.slice(active + 1), ...filtered.slice(0, active + 1)];
      const match = rotated.find(
        (option) =>
          !option.disabled && option.label.toLowerCase().startsWith(event.key.toLowerCase()),
      );
      if (match) {
        event.preventDefault();
        setActive(filtered.indexOf(match));
      }
    }
  }

  return (
    <span className="picker" ref={root}>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={`picker-trigger ${className}`}
        disabled={props.disabled}
        autoFocus={autoFocus}
        title={
          props.title ||
          `${selected?.label || label}${shortcut ? ` (${formatShortcut(shortcutHint || shortcut)})` : ''}`
        }
        data-shortcut={shortcut}
        aria-label={`${label}: ${selected?.label || 'Choose an option'}`}
        aria-labelledby={props['aria-labelledby']}
        aria-describedby={props['aria-describedby']}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-description={props.required ? 'Required' : undefined}
        aria-invalid={props['aria-invalid']}
        onClick={(event) => {
          event.stopPropagation();
          if (open) close();
          else show();
        }}
        onKeyDown={(event) => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
            show();
          }
        }}
      >
        {selected && <OptionIcon option={selected} />}
        <span className="picker-value">{selected?.label || 'Choose…'}</span>
        <ChevronDown className="picker-chevron" size={13} aria-hidden="true" />
      </button>
      <select
        {...props}
        ref={native}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        value={value}
        defaultValue={defaultValue}
        onInvalid={(event) => {
          event.preventDefault();
          trigger.current?.focus();
          show();
        }}
        onChange={(event) => {
          setLocalValue(event.target.value);
          onChange?.(event);
        }}
      >
        {children}
      </select>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            className="picker-panel"
            onKeyDown={onMenuKeyDown}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {canSearch ? (
              <div className="picker-search">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={search}
                  placeholder={`Search ${label.toLowerCase()}…`}
                  aria-label={`Search ${label.toLowerCase()}`}
                  role="combobox"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-controls={`${id}-list`}
                  aria-activedescendant={activeOption ? `${id}-option-${active}` : undefined}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    const next = options.filter((option) =>
                      `${option.label} ${option.group || ''}`
                        .toLowerCase()
                        .includes(event.target.value.trim().toLowerCase()),
                    );
                    setActive(
                      Math.max(
                        0,
                        next.findIndex((option) => !option.disabled),
                      ),
                    );
                  }}
                />
              </div>
            ) : (
              <div className="picker-heading">
                {label}
                <kbd>{shortcut ? formatShortcut(shortcutHint || shortcut) : 'esc'}</kbd>
              </div>
            )}
            <div
              className="picker-options"
              ref={list}
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              tabIndex={canSearch ? undefined : 0}
              aria-activedescendant={
                !canSearch && activeOption ? `${id}-option-${active}` : undefined
              }
            >
              {filtered.map((option, index) => (
                <div key={option.value}>
                  {option.group && filtered[index - 1]?.group !== option.group && (
                    <div className="picker-group">{option.group}</div>
                  )}
                  <div
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={option.value === selectedValue}
                    aria-disabled={option.disabled || undefined}
                    className={`picker-option ${index === active ? 'is-active' : ''}`}
                    onPointerMove={() => {
                      if (!option.disabled) setActive(index);
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(option)}
                  >
                    <OptionIcon option={option} />
                    <span className="picker-option-label">{option.label}</span>
                    {option.value === selectedValue && (
                      <Check className="picker-check" size={15} aria-hidden="true" />
                    )}
                  </div>
                </div>
              ))}
              {!filtered.length && (
                <div className="picker-empty" role="status">
                  No results for “{query}”
                </div>
              )}
            </div>
          </div>,
          trigger.current?.closest('[role="dialog"], .popover, .profile-popover') || document.body,
        )}
    </span>
  );
}
