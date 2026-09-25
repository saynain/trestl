import { registerUpdateGuard } from '../lib/desktop-updates';
import { downloadFile as download } from '../lib/download';
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
  Users,
  Link,
} from 'lucide-react';
import {
  Excalidraw,
  CaptureUpdateAction,
  MainMenu,
  exportToBlob,
  exportToSvg,
} from '@excalidraw/excalidraw';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { CanvasScene, Project, ProjectCanvas } from '../../shared/types';
import { api, post } from '../lib/api';
import { CanvasCollaboration } from '../lib/canvas-collaboration';
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

function sceneFrom(
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): CanvasScene {
  return {
    // Keep version metadata and deleted elements for collaboration/reconnection.
    elements: JSON.parse(JSON.stringify(elements)),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor ?? '#ffffff',
      gridSize: appState.gridSize ?? null,
    },
    files: files as CanvasScene['files'],
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
  const { data, refresh } = useApp();
  const savedTitle = useRef(canvas.title);
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
  const editorRef = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const applyingRemote = useRef(false);
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
  const applyScene = (scene: CanvasScene) => {
    const currentEditor = editorRef.current;
    if (!currentEditor) return;
    applyingRemote.current = true;
    try {
      const knownFiles = currentEditor.getFiles();
      const missingFiles = Object.values(scene.files).filter((file) => !knownFiles[file.id]);
      if (missingFiles.length)
        currentEditor.addFiles(structuredClone(missingFiles) as BinaryFiles[string][]);
      currentEditor.updateScene({
        // Excalidraw mutates its elements while dragging. Keep its objects apart
        // from the acknowledged scene and the pending collaboration journal.
        elements: structuredClone(scene.elements) as unknown as ExcalidrawElement[],
        appState: {
          viewBackgroundColor: scene.appState.viewBackgroundColor ?? '#ffffff',
          gridSize: scene.appState.gridSize ?? 20,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } finally {
      applyingRemote.current = false;
    }
  };
  const [queue] = useState(
    () =>
      new CanvasCollaboration(
        canvas,
        () => {
          if (mounted.current) render((n) => n + 1);
        },
        (draft) => applyScene(draft.scene),
      ),
  );
  useEffect(() => {
    if (queue.status === 'saved' && queue.draft.title !== savedTitle.current) {
      savedTitle.current = queue.draft.title;
      void refresh();
    }
  }, [queue.status, queue.draft.title, refresh]);
  const [initialData] = useState(
    () =>
      ({
        ...structuredClone(canvas.scene),
        scrollToContent: true,
      }) as unknown as ExcalidrawInitialDataState,
  );
  useEffect(() => {
    mounted.current = true;
    queue.start();
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
    const removeUpdateGuard = registerUpdateGuard(() => queue.flush());
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('trestl:before-navigate', beforeNavigate);
    return () => {
      mounted.current = false;
      outside.forEach(({ element, inert }) => {
        element.inert = inert;
      });
      removeUpdateGuard();
      queue.dispose();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('trestl:before-navigate', beforeNavigate);
    };
  }, [queue]);
  useEffect(() => {
    editorRef.current = editor;
    if (editor) applyScene(queue.draft.scene);
  }, [editor]);
  useEffect(() => {
    editor?.updateScene({
      collaborators: new Map(
        queue.peers.map((peer) => [
          peer.id,
          {
            username: peer.name,
            pointer: peer.pointer,
            button: peer.button,
            selectedElementIds: peer.selectedElementIds as AppState['selectedElementIds'],
            color: { background: peer.color, stroke: peer.color },
          },
        ]),
      ) as AppState['collaborators'],
    });
  }, [editor, queue.peers]);
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
  const needsReload = queue.connection === 'blocked';
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
      await download(blob, `${filename}.${format}`);
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section ref={root} className="canvas-editor" aria-label="Canvas editor">
      <header
        className="canvas-editor-header"
        data-tauri-drag-region={
          import.meta.env.VITE_TRESTL_DESKTOP_PLATFORM === 'darwin' ? 'deep' : undefined
        }
      >
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
        <div
          className={`canvas-presence ${queue.connection}`}
          role="status"
          aria-label="Canvas collaboration"
        >
          <Users size={15} />
          <span>
            {!queue.isShared
              ? 'Local demo'
              : queue.connection === 'live'
                ? queue.peers.length
                  ? `${queue.peers.length + 1} editing`
                  : 'Live'
                : queue.connection === 'connecting'
                  ? 'Connecting…'
                  : queue.connection === 'blocked'
                    ? 'Disconnected'
                    : 'Reconnecting…'}
          </span>
          {queue.peers.slice(0, 3).map((peer) => (
            <span
              className="canvas-peer"
              key={peer.id}
              title={peer.name}
              aria-label={peer.name}
              style={{ borderColor: peer.color }}
            >
              {peer.name.trim().slice(0, 1).toUpperCase()}
            </span>
          ))}
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
        {queue.isShared && (
          <button
            className="button"
            aria-label="Copy canvas link"
            title="Copy link for people with access to this project"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(window.location.href);
                setNotice('Canvas link copied. People with project access can join you here.');
              } catch {
                setNotice('Copy the address from your browser to share this canvas.');
              }
            }}
          >
            <Link size={15} />
            <span>Share</span>
          </button>
        )}
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
          {queue.status === 'error' && !needsReload && (
            <button className="button" onClick={() => void queue.flush()}>
              Retry save
            </button>
          )}
          {needsReload && (
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
          <button
            className="button"
            onClick={() => void exportJson().catch((e) => setNotice(e.message))}
          >
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
          isCollaborating={queue.isShared && queue.connection === 'live'}
          onPointerUpdate={({ pointer, button }) => queue.updatePresence({ pointer, button })}
          name={queue.draft.title}
          autoFocus
          handleKeyboardGlobally={false}
          theme={canvasTheme}
          validateEmbeddable={() => false}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false },
          }}
          onChange={(elements, appState, files) => {
            if (applyingRemote.current) return;
            queue.updatePresence({ selectedElementIds: appState.selectedElementIds });
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
            <MainMenu.Item
              icon={<Download size={16} />}
              onSelect={() => void exportJson().catch((e) => setNotice(e.message))}
            >
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
                  try {
                    if (!(await queue.flush())) return;
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
