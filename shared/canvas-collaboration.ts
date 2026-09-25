import type { CanvasScene, ProjectCanvas } from './types';

export type CanvasDraft = Pick<ProjectCanvas, 'title' | 'scene'>;
export type CanvasElement = CanvasScene['elements'][number];
export type CanvasChanges = {
  elements: CanvasElement[];
  files: CanvasScene['files'];
  appState: CanvasScene['appState'];
  title?: string;
};
export type CanvasPresence = {
  id: string;
  userId: string;
  name: string;
  color: string;
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' };
  button?: 'up' | 'down';
  selectedElementIds?: Record<string, boolean>;
};
export type CanvasServerMessage =
  | { type: 'scene'; canvas: ProjectCanvas; clientId?: string; ack?: number }
  | { type: 'presence'; peers: CanvasPresence[] }
  | { type: 'error'; message: string; fatal: boolean };

export const emptyChanges = (): CanvasChanges => ({ elements: [], files: {}, appState: {} });
export const hasChanges = (changes: CanvasChanges) =>
  changes.elements.length > 0 ||
  Object.keys(changes.files).length > 0 ||
  Object.keys(changes.appState).length > 0 ||
  changes.title !== undefined;

/** JSONB may reorder keys, so serialized property order must not create edits. */
export function canvasFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, v[key]]),
        )
      : v,
  );
}

/** Excalidraw versions order edits; the smaller nonce breaks concurrent ties. */
function newer(a: CanvasElement, b: CanvasElement): CanvasElement {
  const av = Number(a.version) || 0,
    bv = Number(b.version) || 0;
  if (av !== bv) return av > bv ? a : b;
  const an = Number(a.versionNonce) || 0,
    bn = Number(b.versionNonce) || 0;
  if (an !== bn) return an < bn ? a : b;
  // Deterministic fallback for legacy/imported elements with no version metadata.
  return canvasFingerprint(a) >= canvasFingerprint(b) ? a : b;
}

export function mergeCanvas(draft: CanvasDraft, changes: CanvasChanges): CanvasDraft {
  const elements = new Map(draft.scene.elements.map((element) => [element.id, element]));
  for (const element of changes.elements) {
    const previous = elements.get(element.id);
    elements.set(element.id, previous ? newer(previous, element) : element);
  }
  const ordered = [...elements.values()];
  const referencedFiles = new Set(
    ordered
      .filter((element) => element.type === 'image' && !element.isDeleted)
      .map((element) => element.fileId),
  );
  // Excalidraw 0.18 uses fractional indices for collaborative layer ordering.
  // Legacy scenes retain their order until the editor assigns indices.
  if (ordered.every((e) => typeof e.index === 'string'))
    ordered.sort((a, b) => {
      const ai = String(a.index),
        bi = String(b.index);
      return ai === bi ? (a.id < b.id ? -1 : a.id === b.id ? 0 : 1) : ai < bi ? -1 : 1;
    });
  return {
    title: changes.title ?? draft.title,
    scene: {
      elements: ordered,
      files: Object.fromEntries(
        Object.entries({ ...draft.scene.files, ...changes.files }).filter(([id]) =>
          referencedFiles.has(id),
        ),
      ),
      appState: { ...draft.scene.appState, ...changes.appState },
    },
  };
}

/** Only send locally changed elements: an old scene must not overwrite a peer. */
export function canvasChanges(before: CanvasDraft, after: CanvasDraft): CanvasChanges {
  const result = emptyChanges();
  const old = new Map(before.scene.elements.map((e) => [e.id, e]));
  const current = new Set(after.scene.elements.map((e) => e.id));
  for (const element of after.scene.elements) {
    const previous = old.get(element.id);
    // Restoring a scene fills defaults without advancing its element version.
    // Those normalizations are not user edits and must not create an echo loop.
    if (
      !previous ||
      previous.version !== element.version ||
      previous.versionNonce !== element.versionNonce
    )
      result.elements.push(element);
  }
  for (const element of before.scene.elements)
    if (!current.has(element.id) && !element.isDeleted)
      result.elements.push({
        ...element,
        isDeleted: true,
        version: (Number(element.version) || 0) + 1,
        versionNonce: 0,
      });
  const activeFiles = new Set(
    after.scene.elements
      .filter((element) => element.type === 'image' && !element.isDeleted)
      .map((element) => element.fileId),
  );
  for (const [id, file] of Object.entries(after.scene.files))
    if (activeFiles.has(id))
      if (canvasFingerprint(before.scene.files[id]) !== canvasFingerprint(file))
        result.files[id] = file;
  for (const key of ['gridSize', 'viewBackgroundColor'] as const)
    if (
      after.scene.appState[key] !== undefined &&
      before.scene.appState[key] !== after.scene.appState[key]
    )
      Object.assign(result.appState, { [key]: after.scene.appState[key] });
  if (before.title !== after.title) result.title = after.title;
  return result;
}

/** Combine successive unsent edits, retaining deletions across disconnects. */
export function combineChanges(first: CanvasChanges, second: CanvasChanges): CanvasChanges {
  const merged = mergeCanvas({ title: first.title ?? '', scene: first }, second);
  return {
    ...merged.scene,
    // A journal may contain a file change for an unchanged image in the base.
    // Only the complete scene can decide which image bytes are unreferenced.
    files: { ...first.files, ...second.files },
    ...(second.title !== undefined || first.title !== undefined ? { title: merged.title } : {}),
  };
}
