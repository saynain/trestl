import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectCanvas } from '../../shared/types';
import { api, createDemoApi } from './api';
import { CanvasCollaboration } from './canvas-collaboration';

test('demo canvas editing saves in the frame without opening a network connection', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Demo canvas editing must not make HTTP requests');
  });
  t.mock.method(globalThis, 'WebSocket', () => {
    throw new Error('Demo canvas editing must not open WebSockets');
  });
  const path = '/projects/studio/canvases/launch-map';
  const canvas = await api<ProjectCanvas>(path);
  const queue = new CanvasCollaboration(
    canvas,
    () => {},
    () => {},
  );
  t.after(() => queue.dispose());
  queue.start();
  queue.updatePresence({ pointer: { x: 20, y: 10, tool: 'pointer' } });
  queue.update({ ...queue.draft, title: 'Local demo edit' });
  assert.equal(await queue.flush(), true);
  assert.equal(queue.isShared, false);
  assert.equal(queue.status, 'saved');
  assert.equal((await api<ProjectCanvas>(path)).title, 'Local demo edit');
  assert.notEqual((await createDemoApi()<ProjectCanvas>(path)).title, 'Local demo edit');
});
