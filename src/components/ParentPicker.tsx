import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import type { WorkItem } from '../../shared/types';
import { parentCandidates } from '../lib/hierarchy';
import { useApp } from '../lib/context';
import { Select } from './Select';
import { Modal } from './ui';
import './hierarchy.css';

export function ParentSelect({
  items,
  movingIds,
  value,
  onChange,
  disabled = false,
}: {
  items: WorkItem[];
  movingIds: string[];
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const candidates = parentCandidates(items, movingIds);
  return (
    <Select
      aria-label="Parent"
      searchable
      value={value || ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">No parent · Top level</option>
      {value && !candidates.some((item) => item.id === value) && (
        <option value={value} disabled>
          Current parent (unavailable)
        </option>
      )}
      {candidates.map((item) => (
        <option key={item.id} value={item.id}>
          {item.identifier} · {item.title}
        </option>
      ))}
    </Select>
  );
}

export function ParentPicker({
  items,
  onSave,
  onClose,
}: {
  items: WorkItem[];
  onSave: (parentId: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const { data } = useApp();
  const [parentId, setParentId] = useState<string | null>(
    items.length === 1 ? items[0].parentId : null,
  );
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      title={items.length === 1 ? 'Convert to subtask of…' : 'Set parent'}
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form
        className="simple-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          setSaving(true);
          try {
            if (await onSave(parentId)) onClose();
          } finally {
            setSaving(false);
          }
        }}
      >
        <p className="muted">
          {items.length === 1
            ? `${items[0].identifier} · ${items[0].title}`
            : `${items.length} selected work items`}
        </p>
        <label className="field">
          Parent
          <ParentSelect
            items={data.items}
            movingIds={items.map((item) => item.id)}
            value={parentId}
            onChange={setParentId}
            disabled={saving}
          />
        </label>
        <p className="muted">
          Choose a parent, or select No parent to return to the top level. Selected items and their
          descendants cannot be parents.
        </p>
        <div className="form-actions">
          <button type="button" className="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? 'Saving…' : 'Set parent'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function HierarchyMenu({
  item,
  onParent,
  onClear,
  disabled = false,
}: {
  item: WorkItem;
  onParent: () => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useLayoutEffect(() => {
    const popup = panel.current;
    if (!open || !popup || !trigger.current) return;
    popup.showPopover();
    const rect = trigger.current.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.right - 260, window.innerWidth - 268))}px`;
    popup.style.top = `${rect.bottom + popup.offsetHeight + 8 < window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - popup.offsetHeight - 4)}px`;
    popup.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!popup.contains(event.target as Node) && !trigger.current?.contains(event.target as Node))
        setOpen(false);
    };
    const dismiss = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      if (popup.isConnected) popup.hidePopover();
    };
  }, [open]);
  return (
    <span className="hierarchy-menu" onClick={(event) => event.stopPropagation()}>
      <button
        ref={trigger}
        className="icon-button"
        aria-label={`Actions for ${item.identifier}`}
        title="Item actions"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <MoreHorizontal size={15} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            popover="manual"
            className="hierarchy-actions"
            role="menu"
            aria-label={`Actions for ${item.identifier}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
              if (event.key === 'Tab') {
                close();
              }
              if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
                );
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? buttons.length - 1
                      : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            <button
              role="menuitem"
              onClick={() => {
                close();
                onParent();
              }}
            >
              Convert to subtask of…
            </button>
            {item.parentId && (
              <button
                role="menuitem"
                onClick={() => {
                  close();
                  onClear();
                }}
              >
                Remove parent · Move to top level
              </button>
            )}
          </div>,
          trigger.current?.closest('[role="dialog"]') || document.body,
        )}
    </span>
  );
}
