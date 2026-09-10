import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasSaveQueue } from '../src/lib/canvas-save.ts';
import type { ProjectCanvas } from '../shared/types.ts';
const canvas: ProjectCanvas = {
  id: 'canvas',
  projectId: 'project',
  workspaceId: 'workspace',
  title: 'Initial',
  revision: 1,
  scene: { elements: [], appState: {}, files: {} },
  createdBy: 'user',
  updatedBy: 'user',
  createdAt: '',
  updatedAt: '',
};
test('autosave serializes requests and saves changes made during an in-flight save', async () => {
  const writes: { title: string; revision: number }[] = [];
  let finish!: () => void;
  const queue = new CanvasSaveQueue(
    canvas,
    async (draft, revision) => {
      writes.push({ title: draft.title, revision });
      if (writes.length === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return { ...canvas, ...draft, revision: revision + 1 };
    },
    () => {},
  );
  queue.update({ ...queue.draft, title: 'First edit' });
  const saving = queue.flush();
  queue.update({ ...queue.draft, title: 'Second edit' });
  assert.equal(queue.flush(), saving);
  assert.equal(writes.length, 1);
  finish();
  assert.equal(await saving, true);
  assert.deepEqual(writes, [
    { title: 'First edit', revision: 1 },
    { title: 'Second edit', revision: 2 },
  ]);
  assert.equal(queue.dirty, false);
  assert.equal(queue.status, 'saved');
  queue.dispose();
});
test('failed saves preserve unsaved work and revision until an explicit retry succeeds', async () => {
  let failed = true;
  const queue = new CanvasSaveQueue(
    canvas,
    async (draft, revision) => {
      if (failed) throw new Error('Connection lost');
      return { ...canvas, ...draft, revision: revision + 1 };
    },
    () => {},
  );
  queue.update({ ...queue.draft, title: 'Keep me' });
  assert.equal(await queue.flush(), false);
  assert.equal(queue.dirty, true);
  assert.equal(queue.revision, 1);
  assert.equal(queue.status, 'error');
  queue.update({ ...queue.draft, title: 'Keep this too' });
  assert.equal(queue.status, 'error');
  failed = false;
  assert.equal(await queue.flush(), true);
  assert.equal(queue.draft.title, 'Keep this too');
  assert.equal(queue.revision, 2);
  queue.dispose();
});

test('database JSON key ordering does not mark an unchanged canvas dirty', () => {
  const scene = {
    elements: [{ id: 'box', type: 'rectangle', x: 1, y: 2, width: 30, height: 40 }],
    appState: { gridSize: null, viewBackgroundColor: '#fff' },
    files: {},
  };
  const queue = new CanvasSaveQueue(
    { ...canvas, scene },
    async () => {
      throw new Error('No save should be needed');
    },
    () => {},
  );
  queue.update({
    title: canvas.title,
    scene: {
      files: {},
      appState: { viewBackgroundColor: '#fff', gridSize: null },
      elements: [{ height: 40, width: 30, y: 2, x: 1, type: 'rectangle', id: 'box' }],
    },
  });
  assert.equal(queue.dirty, false);
  assert.equal(queue.status, 'saved');
  queue.dispose();
});
