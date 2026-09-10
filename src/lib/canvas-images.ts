import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import type { CanvasScene } from '../../shared/types';

export async function renderCanvasImage(
  scene: CanvasScene,
  format: 'png' | 'svg',
  preview = false,
) {
  const { exportToBlob, exportToSvg, restoreElements } = await import('@excalidraw/excalidraw');
  const options = {
    elements: restoreElements(scene.elements as unknown as ExcalidrawElement[], null),
    files: scene.files as BinaryFiles,
    appState: {
      ...scene.appState,
      viewBackgroundColor: scene.appState.viewBackgroundColor || '#ffffff',
      exportBackground: true,
      exportWithDarkMode: false,
      exportEmbedScene: !preview,
    },
  };
  return format === 'png'
    ? exportToBlob({ ...options, mimeType: 'image/png', maxWidthOrHeight: preview ? 640 : 4096 })
    : new Blob([(await exportToSvg(options)).outerHTML], { type: 'image/svg+xml' });
}

export function downloadCanvasImage(blob: Blob, title: string, format: 'png' | 'svg') {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^\p{L}\p{N} ._-]/gu, '-').trim() || 'canvas'}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Limit expensive scene loading/rendering when an overview contains many canvases.
let pendingPreview = Promise.resolve();
export function queueCanvasPreview<T>(render: () => Promise<T>): Promise<T> {
  const result = pendingPreview.then(render);
  pendingPreview = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
