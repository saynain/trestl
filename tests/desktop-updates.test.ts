import test from 'node:test';
import assert from 'node:assert/strict';
import {
  watchDesktopUpdates,
  registerUpdateGuard,
  trackDesktopWrite,
} from '../src/lib/desktop-updates.ts';

test('native update preparation blocks forms, drains writes and cancels without freezing the workspace', async () => {
  class Events extends EventTarget {
    __TAURI__: unknown;
  }
  const win = new Events();
  const acknowledgements: { command: string; args: { request: number; error: string | null } }[] =
    [];
  win.__TAURI__ = {
    core: {
      invoke: async (command: string, args: { request: number; error: string | null }) => {
        acknowledgements.push({ command, args });
      },
    },
  };
  let formOpen = false;
  const doc = {
    body: { inert: false },
    documentElement: { dataset: {} as Record<string, string>, removeAttribute: () => {} },
    querySelector: () => (formOpen ? {} : null),
  };
  Object.assign(globalThis, { window: win, document: doc });
  const prepare = (id: number) =>
    win.dispatchEvent(new CustomEvent('trestl:prepare-update', { detail: id }));
  const wait = async () => {
    for (let i = 0; i < 100 && !acknowledgements.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  try {
    watchDesktopUpdates();
    formOpen = true;
    prepare(1);
    await wait();
    assert.match(acknowledgements.shift()!.args.error!, /Save and close/);
    assert.equal(doc.body.inert, false);
    formOpen = false;
    const removeGuard = registerUpdateGuard(async () => false);
    prepare(2);
    await wait();
    assert.match(acknowledgements.shift()!.args.error!, /could not be saved/);
    removeGuard();
    const done = trackDesktopWrite();
    prepare(3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(acknowledgements.length, 0);
    assert.equal(doc.body.inert, true);
    done();
    await wait();
    assert.deepEqual(acknowledgements.shift(), {
      command: 'update_prepared',
      args: { request: 3, error: null },
    });
    win.dispatchEvent(new Event('trestl:update-cancelled'));
    assert.equal(doc.body.inert, false);
    const complete = trackDesktopWrite();
    prepare(4);
    await new Promise((resolve) => setTimeout(resolve, 10));
    win.dispatchEvent(new Event('trestl:update-cancelled'));
    complete();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      acknowledgements.length,
      0,
      'A cancelled request must never acknowledge readiness',
    );
    prepare(5);
    await wait();
    assert.equal(acknowledgements.shift()!.args.request, 5);
    win.dispatchEvent(new Event('trestl:update-cancelled'));
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  }
});
