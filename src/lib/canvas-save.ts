import type { CanvasScene, ProjectCanvas } from '../../shared/types';

export type CanvasDraft = { title: string; scene: CanvasScene };
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'error';
// JSONB does not preserve object key order. Compare content consistently across
// database responses and Excalidraw's serialized scenes.
function snapshot(draft: CanvasDraft) {
  return JSON.stringify(draft, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}
/** Serializes writes and drains changes made during a request before reporting saved. */
export class CanvasSaveQueue {
  draft: CanvasDraft;
  revision: number;
  status: SaveStatus = 'saved';
  error: unknown;
  private saved: string;
  private current: string;
  private running?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    canvas: ProjectCanvas,
    private write: (draft: CanvasDraft, revision: number) => Promise<ProjectCanvas>,
    private notify: () => void,
  ) {
    this.draft = { title: canvas.title, scene: canvas.scene };
    this.revision = canvas.revision;
    this.saved = this.current = snapshot(this.draft);
  }
  get dirty() {
    return this.current !== this.saved;
  }
  update(draft: CanvasDraft) {
    const next = snapshot(draft);
    if (next === this.current) return;
    this.draft = draft;
    this.current = next;
    clearTimeout(this.timer);
    if (this.status !== 'error' && this.status !== 'saving') {
      this.status = this.dirty ? 'pending' : 'saved';
      if (this.dirty)
        this.timer = setTimeout(() => {
          void this.flush();
        }, 800);
    }
    this.notify();
  }
  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async drain() {
    try {
      while (this.dirty) {
        const snapshot = this.current;
        const draft = JSON.parse(snapshot) as CanvasDraft;
        if (!draft.title.trim()) throw new Error('Give this canvas a name before saving.');
        if (new Blob([snapshot]).size > 8 * 1024 * 1024 - 1024)
          throw new Error(
            'This canvas exceeds the 8 MB limit. Remove large images or download a copy.',
          );
        this.status = 'saving';
        this.error = undefined;
        this.notify();
        const result = await this.write(draft, this.revision);
        this.revision = result.revision;
        this.saved = snapshot;
      }
      this.status = 'saved';
      this.error = undefined;
      this.notify();
      return true;
    } catch (error) {
      this.error = error;
      this.status = 'error';
      this.notify();
      return false;
    }
  }
  dispose() {
    clearTimeout(this.timer);
  }
}
