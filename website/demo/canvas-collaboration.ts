import type { ProjectCanvas } from '../../shared/types';
import type { CanvasDraft, CanvasPresence } from '../../shared/canvas-collaboration';
import { CanvasSaveQueue } from '../../src/lib/canvas-save';
import { patch } from './api';

/** The public demo saves only in this frame's sample workspace, with no sockets. */
export class CanvasCollaboration extends CanvasSaveQueue {
  readonly isShared = false;
  readonly connection = 'live';
  readonly peers: CanvasPresence[] = [];

  constructor(canvas: ProjectCanvas, notify: () => void, _apply: (draft: CanvasDraft) => void) {
    super(
      canvas,
      (draft, revision) =>
        patch<ProjectCanvas>(`/projects/${canvas.projectId}/canvases/${canvas.id}`, {
          ...draft,
          expectedRevision: revision,
        }),
      notify,
    );
  }

  start() {}
  updatePresence(_presence: Omit<CanvasPresence, 'id' | 'userId' | 'name' | 'color'>) {}
}
