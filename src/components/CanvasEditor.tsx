import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  LoaderCircle,
  Moon,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  Excalidraw,
  MainMenu,
  exportToBlob,
  exportToSvg,
  serializeAsJSON,
} from '@excalidraw/excalidraw';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { CanvasScene, Project, ProjectCanvas } from '../../shared/types';
import { api, ApiError, patch, post } from '../lib/api';
import { CanvasSaveQueue } from '../lib/canvas-save';
import { useApp } from '../lib/context';
import {
  readCanvasTheme,
  saveCanvasTheme,
  subscribeAppearance,
  type CanvasTheme,
} from '../lib/preferences';
import { Modal } from './ui';
import { importCanvas, readCanvasImport } from '../lib/canvas-import';
import CanvasSwitcher from './CanvasSwitcher';
import '@excalidraw/excalidraw/index.css';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function sceneFrom(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): CanvasScene {
  const data = JSON.parse(serializeAsJSON(elements, appState, files, 'local'));
  return {
    elements: data.elements,
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor ?? '#ffffff',
      gridSize: appState.gridSize ?? null,
    },
    files: data.files ?? {},
  };
}

export default function CanvasEditor({
  canvas,
  project,
  onClose,
  onOpen,
  onReload,
}: {
  canvas: ProjectCanvas;
  project: Project;
  onClose: () => void;
  onOpen: (id: string) => void;
  onReload: () => void;
}) {
  const { data } = useApp();
  const [canvasTheme, setCanvasTheme] = useState(() => readCanvasTheme(data.user));
  useEffect(
    () => subscribeAppearance(() => setCanvasTheme(readCanvasTheme(data.user))),
    [data.user],
  );
  const changeCanvasTheme = (theme: CanvasTheme) => {
    setCanvasTheme(theme);
    saveCanvasTheme(data.user, theme);
  };
  const [, render] = useState(0);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const allowNavigation = useRef(false);
  const base = `/projects/${project.id}/canvases`;
  const [queue] = useState(
    () =>
      new CanvasSaveQueue(
        canvas,
        (draft, revision) =>
          patch<ProjectCanvas>(`${base}/${canvas.id}`, { ...draft, expectedRevision: revision }),
        () => {
          if (mounted.current) render((n) => n + 1);
        },
      ),
  );
  const [initialData] = useState(
    () => ({ ...canvas.scene, scrollToContent: true }) as unknown as ExcalidrawInitialDataState,
  );
  useEffect(() => {
    mounted.current = true;
    // Keep keyboard focus and assistive technology within the full-page editor.
    const outside: { element: HTMLElement; inert: boolean }[] = [];
    let node: HTMLElement | null = root.current;
    while (node?.parentElement && node !== document.body) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling !== node && sibling instanceof HTMLElement) {
          outside.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      node = node.parentElement;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (queue.dirty || queue.status === 'saving') {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const beforeNavigate = (event: Event) => {
      if (
        !allowNavigation.current &&
        (queue.dirty || queue.status === 'saving' || busyRef.current)
      ) {
        event.preventDefault();
        setNotice('Your canvas has unsaved changes. Save them or download a copy before leaving.');
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('trestl:before-navigate', beforeNavigate);
    return () => {
      mounted.current = false;
      outside.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      queue.dispose();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('trestl:before-navigate', beforeNavigate);
    };
  }, [queue]);
  const filename = (queue.draft.title.trim() || 'Untitled canvas').replace(/[/\\:*?"<>|]/g, '-');
  const exportJson = () =>
    download(
      new Blob(
        [
          JSON.stringify({
            type: 'excalidraw',
            version: 2,
            source: window.location.origin,
            ...queue.draft.scene,
          }),
        ],
        { type: 'application/vnd.excalidraw+json' },
      ),
      `${filename}.excalidraw`,
    );
  const error = queue.error instanceof Error ? queue.error.message : 'Unable to save this canvas.';
  const conflict = queue.error instanceof ApiError && queue.error.status === 409;
  async function switchCanvas(id?: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (await queue.flush()) {
        allowNavigation.current = true;
        if (id) onOpen(id);
        else onClose();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveCopy() {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      // A collection can be removed while this editor has unsaved work.
      // Keep recovery copies usable by falling back to Unsorted in that case.
      let collectionId = canvas.collectionId ?? null;
      if (collectionId) {
        const groups = await api<{ data: { id: string }[] }>(
          `/projects/${project.id}/canvas-collections`,
        );
        if (!groups.data.some((group) => group.id === collectionId)) collectionId = null;
      }
      const result = await post<ProjectCanvas>(base, {
        ...queue.draft,
        collectionId,
        title: `${queue.draft.title.trim().slice(0, 233) || 'Untitled'} (copy)`,
      });
      allowNavigation.current = true;
      onOpen(result.id);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportImage(format: 'png' | 'svg') {
    if (!editor || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const options = {
        elements: editor.getSceneElements(),
        appState: { ...editor.getAppState(), exportBackground: true, exportEmbedScene: true },
        files: editor.getFiles(),
      };
      const blob =
        format === 'png'
          ? await exportToBlob({ ...options, mimeType: 'image/png', maxWidthOrHeight: 4096 })
          : new Blob([(await exportToSvg(options)).outerHTML], { type: 'image/svg+xml' });
      download(blob, `${filename}.${format}`);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section ref={root} className="canvas-editor" aria-label="Canvas editor">
      <header className="canvas-editor-header">
        <button
          className="button"
          aria-label="Canvases"
          disabled={busy}
          onClick={() => void switchCanvas()}
        >
          <ArrowLeft size={16} />
          <span>Canvases</span>
        </button>
        <div className="canvas-title">
          <CanvasSwitcher
            project={project}
            canvasId={canvas.id}
            title={queue.draft.title}
            disabled={busy}
            onSelect={switchCanvas}
          />
          <input
            aria-label="Canvas name"
            maxLength={240}
            value={queue.draft.title}
            onChange={(e) => queue.update({ ...queue.draft, title: e.target.value })}
          />
        </div>
        <span className={`canvas-save-status ${queue.status}`} role="status">
          {queue.status === 'saved' ? (
            <Check size={14} />
          ) : queue.status === 'saving' ? (
            <LoaderCircle className="canvas-spin" size={14} />
          ) : null}
          {
            { saved: 'Saved', pending: 'Unsaved changes', saving: 'Saving…', error: 'Not saved' }[
              queue.status
            ]
          }
        </span>
        <div className="canvas-theme-switch" role="group" aria-label="Canvas appearance">
          <button
            type="button"
            aria-label="Light canvas"
            aria-pressed={canvasTheme === 'light'}
            title="Light canvas — independent of app appearance"
            onClick={() => changeCanvasTheme('light')}
          >
            <Sun size={15} />
            <span>Light</span>
          </button>
          <button
            type="button"
            aria-label="Dark canvas"
            aria-pressed={canvasTheme === 'dark'}
            title="Dark canvas — independent of app appearance"
            onClick={() => changeCanvasTheme('dark')}
          >
            <Moon size={15} />
            <span>Dark</span>
          </button>
        </div>
        <button
          className="button"
          disabled={busy || queue.status === 'saving'}
          onClick={saveCopy}
          title="Save as a new canvas"
          aria-label="Save a copy"
        >
          <Copy size={15} />
          <span>Save a copy</span>
        </button>
      </header>
      {(notice || queue.status === 'error') && (
        <div className="canvas-notice" role="alert">
          <span>{queue.status === 'error' ? error : notice}</span>
          {queue.status === 'error' && !conflict && (
            <button className="button" onClick={() => void queue.flush()}>
              Retry save
            </button>
          )}
          {conflict && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Discard your unsaved changes and load the latest canvas? Download a copy first if you want to keep them.',
                  )
                ) {
                  allowNavigation.current = true;
                  onReload();
                }
              }}
            >
              Reload latest
            </button>
          )}
          <button className="button" onClick={exportJson}>
            Download my copy
          </button>
          {queue.status === 'error' && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Leave without saving your changes? Download a copy first to keep them.',
                  )
                ) {
                  allowNavigation.current = true;
                  onClose();
                }
              }}
            >
              Leave without saving
            </button>
          )}
          {notice && queue.status !== 'error' && (
            <button className="button" onClick={() => setNotice('')}>
              Dismiss
            </button>
          )}
        </div>
      )}
      <div className="canvas-drawing">
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={setEditor}
          name={queue.draft.title}
          autoFocus
          handleKeyboardGlobally={false}
          theme={canvasTheme}
          validateEmbeddable={() => false}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false },
          }}
          onChange={(elements, appState, files) => {
            // An image can briefly exist before Excalidraw finishes processing its file.
            if (
              appState.isLoading ||
              elements.some(
                (element) =>
                  element.type === 'image' &&
                  !element.isDeleted &&
                  (!element.fileId || !files[element.fileId]),
              )
            )
              return;
            queue.update({ title: queue.draft.title, scene: sceneFrom(elements, appState, files) });
          }}
        >
          <MainMenu>
            <MainMenu.Item icon={<Upload size={16} />} onSelect={() => input.current?.click()}>
              Import .excalidraw
            </MainMenu.Item>
            <MainMenu.Item icon={<Download size={16} />} onSelect={exportJson}>
              Download .excalidraw
            </MainMenu.Item>
            <MainMenu.Item onSelect={() => void exportImage('png')}>Export PNG</MainMenu.Item>
            <MainMenu.Item onSelect={() => void exportImage('svg')}>Export SVG</MainMenu.Item>
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.Separator />
            <MainMenu.Item icon={<Trash2 size={16} />} onSelect={() => setConfirmDelete(true)}>
              Delete canvas
            </MainMenu.Item>
          </MainMenu>
        </Excalidraw>
      </div>
      <input
        ref={input}
        type="file"
        accept=".excalidraw,application/vnd.excalidraw+json"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file || !editor || busy) return;
          setBusy(true);
          setNotice('');
          try {
            const document = await readCanvasImport(file);
            // Preserve pending changes before opening the imported canvas.
            if (!(await queue.flush())) return;
            const result = await importCanvas(base, file, document, canvas.collectionId);
            allowNavigation.current = true;
            onOpen(result.id);
          } catch (e) {
            setNotice(`Import failed: ${(e as Error).message}`);
          } finally {
            setBusy(false);
          }
        }}
      />
      {confirmDelete && (
        <Modal
          title="Delete canvas?"
          onClose={() => {
            if (!busy) setConfirmDelete(false);
          }}
        >
          <div className="canvas-create">
            <p>“{queue.draft.title}” will be permanently deleted, including any unsaved changes.</p>
            <div className="canvas-form-actions">
              <button className="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                className="button danger"
                disabled={busy || queue.status === 'saving'}
                onClick={async () => {
                  setBusy(true);
                  queue.dispose();
                  try {
                    await api(`${base}/${canvas.id}`, {
                      method: 'DELETE',
                      body: JSON.stringify({ expectedRevision: queue.revision }),
                    });
                    allowNavigation.current = true;
                    onClose();
                  } catch (e) {
                    setNotice((e as Error).message);
                    setConfirmDelete(false);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Delete canvas
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
