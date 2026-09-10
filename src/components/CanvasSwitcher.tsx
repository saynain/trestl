import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { CanvasCollection, CanvasSummary, Project } from '../../shared/types';
import { api } from '../lib/api';

export default function CanvasSwitcher({
  project,
  canvasId,
  title,
  disabled,
  onSelect,
}: {
  project: Project;
  canvasId: string;
  title: string;
  disabled: boolean;
  onSelect: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [collections, setCollections] = useState<CanvasCollection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      api<{ data: CanvasSummary[] }>(`/projects/${project.id}/canvases`, {
        signal: controller.signal,
      }),
      api<{ data: CanvasCollection[] }>(`/projects/${project.id}/canvas-collections`, {
        signal: controller.signal,
      }),
    ])
      .then(([canvases, groups]) => {
        if (!controller.signal.aborted) {
          setCanvases(canvases.data);
          setCollections(groups.data);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      controller.abort();
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, project.id, retry]);

  const names = canvases.map((canvas) =>
    canvas.id === canvasId ? { ...canvas, title: title || 'Untitled canvas' } : canvas,
  );
  const filtered = names.filter((canvas) =>
    canvas.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div
      ref={root}
      className="canvas-switcher"
      onKeyDown={(event) => {
        // Keep typing and navigation keys out of the drawing editor.
        event.stopPropagation();
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className="canvas-switcher-trigger"
        type="button"
        aria-label="Switch canvas"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={() => {
          setQuery('');
          setOpen(!open);
        }}
      >
        <span>{project.name}</span>
        <span className="canvas-switcher-hint">Switch canvas</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div
          id={panelId}
          className="canvas-switcher-panel"
          role="group"
          aria-label="Project canvases"
        >
          <label className="canvas-switcher-search">
            <Search size={15} />
            <input
              ref={search}
              type="search"
              aria-label="Find a canvas"
              placeholder="Find a canvas…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {loading ? (
            <p role="status">Loading canvases…</p>
          ) : error ? (
            <div className="canvas-switcher-error" role="alert">
              <p>{error}</p>
              <button className="button" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </button>
            </div>
          ) : (
            <div className="canvas-switcher-list">
              {[...collections, { id: 'unsorted', name: 'Unsorted' }].map((group) => {
                const members = filtered.filter(
                  (canvas) => (canvas.collectionId || 'unsorted') === group.id,
                );
                return members.length ? (
                  <section key={group.id} aria-label={group.name} className="canvas-switcher-group">
                    <h3>{group.name}</h3>
                    {members.map((canvas) => (
                      <button
                        key={canvas.id}
                        className="canvas-switcher-option"
                        disabled={disabled}
                        aria-current={canvas.id === canvasId ? 'true' : undefined}
                        onClick={async () => {
                          if (canvas.id !== canvasId) await onSelect(canvas.id);
                          setOpen(false);
                          trigger.current?.focus();
                        }}
                      >
                        <span>{canvas.title}</span>
                        {canvas.id === canvasId && <Check size={15} aria-label="Current canvas" />}
                      </button>
                    ))}
                  </section>
                ) : null;
              })}
              {!filtered.length && <p>No canvases match “{query}”.</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
