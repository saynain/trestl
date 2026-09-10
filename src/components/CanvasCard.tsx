import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpRight,
  Copy,
  Download,
  Folder,
  MoreHorizontal,
  Pencil,
  PencilRuler,
  Trash2,
} from 'lucide-react';
import type { CanvasCollection, CanvasSummary, ProjectCanvas } from '../../shared/types';
import { api, ApiError, patch, post } from '../lib/api';
import { downloadCanvasImage, queueCanvasPreview, renderCanvasImage } from '../lib/canvas-images';
import { Modal } from './ui';

export default function CanvasCard({
  item,
  collections,
  onOpen,
  onChange,
}: {
  item: CanvasSummary;
  collections: CanvasCollection[];
  onOpen: () => void;
  onChange: () => void;
}) {
  const [preview, setPreview] = useState('');
  const [previewState, setPreviewState] = useState('Loading preview…');
  const [previewRetry, setPreviewRetry] = useState(0);
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete' | 'move'>();
  const [collectionId, setCollectionId] = useState(item.collectionId || '');
  const [title, setTitle] = useState(item.title);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const card = useRef<HTMLElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const actionId = useId();
  const base = `/projects/${item.projectId}/canvases`;
  const path = `${base}/${item.id}`;

  useEffect(() => {
    let active = true;
    let url = '';
    const abort = new AbortController();
    setPreview('');
    setPreviewState('Loading preview…');
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void queueCanvasPreview(async () => {
          if (!active) return;
          try {
            const canvas = await api<ProjectCanvas>(path, { signal: abort.signal });
            if (!active) return;
            if (!canvas.scene.elements.some((element) => !element.isDeleted)) {
              setPreviewState('Empty canvas');
              return;
            }
            const blob = await renderCanvasImage(canvas.scene, 'png', true);
            if (!active) return;
            url = URL.createObjectURL(blob);
            setPreview(url);
            setPreviewState('');
          } catch {
            if (active) setPreviewState('Preview unavailable');
          }
        });
      },
      { rootMargin: '200px' },
    );
    if (card.current) observer.observe(card.current);
    return () => {
      active = false;
      abort.abort();
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, item.revision, previewRetry]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMenu(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    menuRoot.current?.addEventListener('keydown', escape);
    const root = menuRoot.current;
    return () => {
      document.removeEventListener('pointerdown', outside);
      root?.removeEventListener('keydown', escape);
    };
  }, [menu]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setMenu(false);
    setBusy(true);
    setError('');
    setMessage('');
    setConflict(false);
    try {
      await action();
    } catch (e) {
      const stale = e instanceof ApiError && e.status === 409;
      setConflict(stale);
      setError(
        stale
          ? 'This canvas changed elsewhere. Refresh the overview before trying again.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  function exportImage(format: 'png' | 'svg', copy: boolean) {
    void run(async () => {
      if (copy && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')) {
        throw new Error('Clipboard access is unavailable. Use Download instead.');
      }
      const image = api<ProjectCanvas>(path).then((canvas) =>
        renderCanvasImage(canvas.scene, format),
      );
      if (copy) {
        // Pass a promise while the click still has user activation (required by Safari).
        // SVG source is text so it can be pasted into design/code tools across browsers.
        const type = format === 'png' ? 'image/png' : 'text/plain';
        const content =
          format === 'png'
            ? image
            : image.then(async (blob) => new Blob([await blob.text()], { type }));
        try {
          await navigator.clipboard.write([new ClipboardItem({ [type]: content })]);
        } catch {
          // Also consume the render promise if clipboard permission was denied first.
          await content.catch(() => undefined);
          throw new Error('Could not copy to the clipboard. Try again or use Download instead.');
        }
        setMessage(
          format === 'png' ? 'PNG copied to clipboard.' : 'SVG source copied to clipboard.',
        );
      } else {
        downloadCanvasImage(await image, item.title, format);
        setMessage(`${format.toUpperCase()} downloaded.`);
      }
    });
  }

  return (
    <article ref={card} className="canvas-card" aria-label={item.title} aria-busy={busy}>
      <button
        className="canvas-card-open"
        disabled={busy}
        onClick={onOpen}
        aria-label={`Open ${item.title}`}
      >
        <div className={`canvas-card-art${preview ? ' has-preview' : ''}`}>
          {preview ? (
            <img src={preview} alt={`Preview of ${item.title}`} />
          ) : (
            <span className="canvas-preview-placeholder">
              <PencilRuler size={28} strokeWidth={1.25} />
              <span>{previewState}</span>
            </span>
          )}
          <ArrowUpRight className="canvas-open-arrow" size={18} aria-hidden="true" />
        </div>
        <div className="canvas-card-label">
          <strong>{item.title}</strong>
          <span className="canvas-card-collection">
            <Folder size={12} />
            {collections.find((group) => group.id === item.collectionId)?.name || 'Unsorted'}
          </span>
          <span>
            Edited{' '}
            {new Date(item.updatedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        </div>
      </button>
      <div className="canvas-card-footer">
        <button
          className="canvas-quick-copy"
          disabled={busy}
          onClick={() => exportImage('png', true)}
        >
          <Copy size={14} />
          Copy PNG
        </button>
        <div
          className="canvas-card-menu"
          ref={menuRoot}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false);
          }}
        >
          <button
            ref={menuButton}
            className="icon-button"
            aria-label={`Actions for ${item.title}`}
            aria-expanded={menu}
            aria-controls={actionId}
            disabled={busy}
            onClick={() => setMenu(!menu)}
          >
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <div
              id={actionId}
              className="canvas-card-actions"
              role="group"
              aria-label="Canvas actions"
            >
              <button
                onClick={() => {
                  setMenu(false);
                  setError('');
                  setConflict(false);
                  setTitle(item.title);
                  setDialog('rename');
                }}
              >
                <Pencil size={15} />
                Rename
              </button>
              <button
                onClick={() =>
                  void run(async () => {
                    const original = await api<ProjectCanvas>(path);
                    await post<ProjectCanvas>(base, {
                      title: `${original.title.slice(0, 233)} (copy)`,
                      scene: original.scene,
                      collectionId: original.collectionId ?? null,
                    });
                    onChange();
                  })
                }
              >
                <Copy size={15} />
                Duplicate
              </button>
              <button
                onClick={() => {
                  setMenu(false);
                  setError('');
                  setConflict(false);
                  setCollectionId(item.collectionId || '');
                  setDialog('move');
                }}
              >
                <Folder size={15} />
                Move to collection
              </button>
              <hr />
              <button onClick={() => exportImage('png', true)}>
                <Copy size={15} />
                Copy PNG
              </button>
              <button onClick={() => exportImage('svg', true)}>
                <Copy size={15} />
                Copy SVG source
              </button>
              <button onClick={() => exportImage('png', false)}>
                <Download size={15} />
                Download PNG
              </button>
              <button onClick={() => exportImage('svg', false)}>
                <Download size={15} />
                Download SVG
              </button>
              <hr />
              <button
                className="canvas-action-danger"
                onClick={() => {
                  setMenu(false);
                  setError('');
                  setConflict(false);
                  setDialog('delete');
                }}
              >
                <Trash2 size={15} />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {previewState === 'Preview unavailable' && (
        <button className="canvas-preview-retry" onClick={() => setPreviewRetry((n) => n + 1)}>
          Retry preview
        </button>
      )}
      {(busy || message) && (
        <p className="canvas-card-feedback" role="status">
          {busy ? 'Working…' : message}
        </p>
      )}
      {error && !dialog && (
        <p className="canvas-card-feedback" role="alert">
          {error}
        </p>
      )}
      {dialog &&
        createPortal(
          <Modal
            title={
              dialog === 'rename'
                ? 'Rename canvas'
                : dialog === 'move'
                  ? 'Move to collection'
                  : 'Delete canvas'
            }
            onClose={() => {
              if (!busy) setDialog(undefined);
            }}
          >
            <form
              className="canvas-create"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  if (dialog === 'rename')
                    await patch(path, { title: title.trim(), expectedRevision: item.revision });
                  else if (dialog === 'move')
                    await patch(path, {
                      collectionId: collectionId || null,
                      expectedRevision: item.revision,
                    });
                  else
                    await api(path, {
                      method: 'DELETE',
                      body: JSON.stringify({ expectedRevision: item.revision }),
                    });
                  setDialog(undefined);
                  onChange();
                });
              }}
            >
              {dialog === 'move' ? (
                <label className="field">
                  Collection
                  <select
                    autoFocus
                    className="input"
                    aria-label="Collection"
                    value={collectionId}
                    onChange={(event) => setCollectionId(event.target.value)}
                  >
                    <option value="">Unsorted</option>
                    {collections.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : dialog === 'rename' ? (
                <label className="field">
                  Canvas name
                  <input
                    autoFocus
                    className="input"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={240}
                    required
                  />
                </label>
              ) : (
                <p>
                  Delete “{item.title}”? This permanently removes the diagram and its images. This
                  cannot be undone.
                </p>
              )}
              {error && <p role="alert">{error}</p>}
              <div className="canvas-form-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setDialog(undefined)}
                >
                  Cancel
                </button>
                {conflict ? (
                  <button type="button" className="button" onClick={onChange}>
                    Refresh overview
                  </button>
                ) : (
                  <button
                    className={`button ${dialog === 'delete' ? 'danger' : 'primary'}`}
                    disabled={busy || (dialog === 'rename' && !title.trim())}
                  >
                    {busy
                      ? 'Saving…'
                      : dialog === 'rename'
                        ? 'Save name'
                        : dialog === 'move'
                          ? 'Move canvas'
                          : 'Delete canvas'}
                  </button>
                )}
              </div>
            </form>
          </Modal>,
          document.body,
        )}
    </article>
  );
}
