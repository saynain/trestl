import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { createApp } from '../server/app.ts';
import type { CanvasServerMessage } from '../shared/canvas-collaboration.ts';
import { canvasChanges, emptyChanges, mergeCanvas } from '../shared/canvas-collaboration.ts';
import type { ProjectCanvas } from '../shared/types.ts';
import { CanvasCollaboration } from '../src/lib/canvas-collaboration.ts';

const box = (id: string, version = 1, x = 0, versionNonce = 100) => ({
  id,
  type: 'rectangle',
  x,
  y: 10,
  width: 100,
  height: 60,
  version,
  versionNonce,
});
const blank: ProjectCanvas = {
  id: 'canvas',
  projectId: 'project',
  workspaceId: 'workspace',
  title: 'Shared canvas',
  scene: { elements: [], files: {}, appState: {} },
  revision: 1,
  createdBy: 'owner',
  updatedBy: 'owner',
  createdAt: '',
  updatedAt: '',
};
const delta = (...elements: ReturnType<typeof box>[]) => ({ ...emptyChanges(), elements });

test('element merging converges for concurrent edits and retains deletion tombstones', () => {
  const a = delta(box('a')),
    b = delta(box('b'));
  const merged = mergeCanvas(mergeCanvas(blank, a), b);
  assert.deepEqual(new Set(merged.scene.elements.map((e) => e.id)), new Set(['a', 'b']));
  const left = delta(box('a', 2, 20, 20)),
    right = delta(box('a', 2, 40, 10));
  assert.deepEqual(
    mergeCanvas(mergeCanvas(merged, left), right),
    mergeCanvas(mergeCanvas(merged, right), left),
  );
  assert.equal(mergeCanvas(mergeCanvas(merged, left), right).scene.elements[0].x, 40);
  const removed = canvasChanges(merged, {
    ...merged,
    scene: { ...merged.scene, elements: [box('b')] },
  });
  const deleted = mergeCanvas(merged, removed);
  assert.equal(deleted.scene.elements.find((e) => e.id === 'a')?.isDeleted, true);
  assert.equal(mergeCanvas(deleted, a).scene.elements.find((e) => e.id === 'a')?.isDeleted, true);
});

test('restored shape defaults do not create edits or a render/save echo loop', () => {
  const original = mergeCanvas(blank, delta(box('restored')));
  const restored = {
    ...original,
    scene: {
      ...original.scene,
      elements: [{ ...box('restored'), roundness: null, boundElements: [] }],
    },
  };
  assert.deepEqual(canvasChanges(original, restored), emptyChanges());
  const queue = new CanvasCollaboration(
    { ...blank, ...original },
    () => assert.fail('No re-render for restored defaults'),
    () => {},
  );
  queue.update(restored);
  assert.equal(queue.dirty, false);
  queue.dispose();
});

test('deleted image bytes are released and undo can restore the image with its file', () => {
  const file = {
    id: 'png',
    mimeType: 'image/png',
    dataURL: 'data:image/png;base64,AAAA',
    created: 1,
  };
  const image = { ...box('image'), type: 'image', fileId: 'png' };
  const original = mergeCanvas(blank, { ...delta(image), files: { png: file } });
  const deleted = mergeCanvas(
    original,
    delta({ ...image, version: 2, isDeleted: true } as typeof image),
  );
  assert.deepEqual(deleted.scene.files, {});
  const undo = {
    ...deleted,
    scene: { ...deleted.scene, elements: [{ ...image, version: 3 }], files: { png: file } },
  };
  const restored = mergeCanvas(deleted, canvasChanges(deleted, undo));
  assert.deepEqual(restored.scene.files.png, file);
  assert.notEqual(restored.scene.elements[0].isDeleted, true);
});

class FakeSocket {
  readyState = 1;
  sent: any[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  receive(message: CanvasServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

test('client keeps new edits during acknowledgement and merges a peer without echoing it', async () => {
  const socket = new FakeSocket();
  const queue = new CanvasCollaboration(
    blank,
    () => {},
    () => {},
    () => socket as unknown as WebSocket,
  );
  queue.start();
  try {
    socket.receive({ type: 'scene', canvas: blank, clientId: 'local' });
    queue.update(mergeCanvas(queue.draft, delta(box('local'))));
    const saved = queue.flush();
    assert.equal(queue.status, 'saving');
    const first = socket.sent[0];
    queue.update(mergeCanvas(queue.draft, delta(box('local', 2, 50))));
    const peerState = { ...blank, ...mergeCanvas(blank, delta(box('peer'))), revision: 2 };
    socket.receive({ type: 'scene', canvas: peerState });
    assert.equal(queue.draft.scene.elements.length, 2);
    assert.equal(queue.draft.scene.elements.find((e) => e.id === 'local')?.x, 50);
    const firstSaved = { ...peerState, ...mergeCanvas(peerState, first.changes), revision: 3 };
    socket.receive({ type: 'scene', canvas: firstSaved, ack: first.id });
    assert.equal(queue.dirty, true);
    const drained = queue.flush();
    const second = socket.sent[1];
    assert.deepEqual(
      second.changes.elements.map((e: { id: string }) => e.id),
      ['local'],
    );
    socket.receive({
      type: 'scene',
      canvas: { ...firstSaved, ...mergeCanvas(firstSaved, second.changes), revision: 4 },
      ack: second.id,
    });
    assert.equal(await saved, true);
    assert.equal(await drained, true);
    assert.equal(queue.dirty, false);
    assert.equal(queue.status, 'saved');
  } finally {
    queue.dispose();
  }
});

test('save failures retain the journal until retry, and revoked access cannot claim a save', async () => {
  const socket = new FakeSocket();
  const queue = new CanvasCollaboration(
    blank,
    () => {},
    () => {},
    () => socket as unknown as WebSocket,
  );
  queue.start();
  try {
    socket.receive({ type: 'scene', canvas: blank, clientId: 'local' });
    queue.update(mergeCanvas(queue.draft, delta(box('pending'))));
    const failed = queue.flush();
    socket.receive({ type: 'error', message: 'Storage unavailable', fatal: false });
    assert.equal(await failed, false);
    assert.equal(queue.dirty, true);
    assert.equal(queue.status, 'error');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(socket.sent.length, 1, 'A scheduled timer must not retry a rejected write');
    const retried = queue.flush();
    const flight = socket.sent[1];
    socket.receive({
      type: 'scene',
      canvas: { ...blank, ...mergeCanvas(blank, flight.changes), revision: 2 },
      ack: flight.id,
    });
    assert.equal(await retried, true);
    queue.update(mergeCanvas(queue.draft, delta(box('pending', 2, 50))));
    socket.receive({ type: 'error', message: 'Canvas access was removed', fatal: true });
    assert.equal(queue.connection, 'blocked');
    assert.equal(await queue.flush(), false);
    assert.equal(queue.draft.scene.elements[0].x, 50);
  } finally {
    queue.dispose();
  }
});

test('client reconnects with unacknowledged and offline edits, without resurrecting deleted elements', async () => {
  const sockets: FakeSocket[] = [];
  const queue = new CanvasCollaboration(
    blank,
    () => {},
    () => {},
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  );
  queue.start();
  try {
    sockets[0].receive({ type: 'scene', canvas: blank, clientId: 'first' });
    queue.update(mergeCanvas(queue.draft, delta(box('local'))));
    const saved = queue.flush();
    const first = sockets[0].sent[0];
    sockets[0].close();
    queue.update(mergeCanvas(queue.draft, delta(box('offline'))));
    assert.equal(queue.connection, 'offline');
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const deleted = { ...box('local', 2), isDeleted: true };
    const server = {
      ...blank,
      ...mergeCanvas(blank, { ...first.changes, elements: [deleted, box('peer')] }),
      revision: 3,
    };
    sockets[1].receive({ type: 'scene', canvas: server, clientId: 'second' });
    assert.equal(queue.draft.scene.elements.find((e) => e.id === 'local')?.isDeleted, true);
    assert.ok(queue.draft.scene.elements.some((e) => e.id === 'offline'));
    const flushed = queue.flush();
    const resent = sockets[1].sent[0];
    sockets[1].receive({
      type: 'scene',
      canvas: { ...server, ...mergeCanvas(server, resent.changes), revision: 4 },
      ack: resent.id,
    });
    assert.equal(await saved, true);
    assert.equal(await flushed, true);
    assert.equal(queue.dirty, false);
  } finally {
    queue.dispose();
  }
});

test(
  'live canvas sessions synchronize two users, persist, and enforce access boundaries',
  { timeout: 30000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'trestl-live-test-'));
    let app = await createApp({ dataDir, integrations: false });
    const connections: Awaited<ReturnType<typeof app.injectWS>>[] = [];
    // Injected sockets have no peer address, which rate limiting needs as its key.
    const injectWS: typeof app.injectWS = (url, context = {}, options) =>
      app.injectWS(url, { socket: { remoteAddress: '127.0.0.1' } as Socket, ...context }, options);
    try {
      const setup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/setup',
        payload: {
          name: 'Alice',
          email: 'alice@canvas.test',
          password: 'canvas-password',
          seedDemo: false,
        },
      });
      assert.equal(setup.statusCode, 201, setup.body);
      const cookieOf = (response: typeof setup) =>
        `trestl_session=${response.cookies.find((c) => c.name === 'trestl_session')!.value}`;
      const owner = cookieOf(setup);
      const call = (
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        payload?: unknown,
        cookie = owner,
      ) =>
        app.inject({
          method,
          url: `/api/v1${path}`,
          headers: { cookie },
          ...(payload ? { payload } : {}),
        });
      const member = (
        await call('POST', '/users', {
          name: 'Bob',
          email: 'bob@canvas.test',
          password: 'canvas-password',
        })
      ).json();
      const bob = cookieOf(
        await call('POST', '/auth/login', {
          email: 'bob@canvas.test',
          password: 'canvas-password',
        }),
      );
      const project = (
        await call('POST', '/projects', { key: 'LIVE', name: 'Live canvas' })
      ).json();
      const path = `/projects/${project.id}/canvases`;
      const canvas: ProjectCanvas = (await call('POST', path, { title: 'Together' })).json();
      const endpoint = `/api/v1${path}/${canvas.id}/live`;
      const connect = async (cookie = owner, url = endpoint) => {
        const messages: CanvasServerMessage[] = [];
        const socket = await injectWS(
          url,
          { headers: { cookie } },
          {
            onInit: (ws) => ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()))),
          },
        );
        connections.push(socket);
        const wait = async <T extends CanvasServerMessage>(
          predicate: (message: CanvasServerMessage) => message is T,
        ) => {
          const deadline = Date.now() + 4000;
          while (Date.now() < deadline) {
            const found = messages.find(predicate);
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail(`No matching message: ${JSON.stringify(messages)}`);
        };
        await wait(
          (m): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
            m.type === 'scene' && !!m.clientId,
        );
        return {
          socket,
          wait,
          messages,
          send: (id: number, changes: unknown) =>
            socket.send(JSON.stringify({ type: 'changes', id, changes })),
        };
      };
      const alice = await connect(),
        colleague = await connect(bob);
      const sceneAt =
        (revision: number) =>
        (m: CanvasServerMessage): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
          m.type === 'scene' && m.canvas.revision >= revision;
      await t.test(
        'two clients concurrently add shapes, see cursors, and resolve competing moves',
        async () => {
          alice.send(1, delta(box('a')));
          colleague.send(1, delta(box('b')));
          const [a, b] = await Promise.all([alice.wait(sceneAt(3)), colleague.wait(sceneAt(3))]);
          assert.deepEqual(a.canvas.scene, b.canvas.scene);
          assert.equal(a.canvas.scene.elements.length, 2);
          alice.socket.send(
            JSON.stringify({
              type: 'presence',
              presence: {
                pointer: { x: 42, y: 80, tool: 'pointer' },
                selectedElementIds: { a: true },
              },
            }),
          );
          const presence = await colleague.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'presence' }> =>
              m.type === 'presence' &&
              m.peers.some((p) => p.name === 'Alice' && p.pointer?.x === 42),
          );
          assert.equal(presence.peers.find((p) => p.name === 'Alice')?.selectedElementIds?.a, true);
          alice.send(2, delta(box('a', 2, 20, 20)));
          colleague.send(2, delta(box('a', 2, 40, 10)));
          await colleague.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
              m.type === 'scene' && m.ack === 2,
          );
          const saved = (await call('GET', `${path}/${canvas.id}`)).json();
          assert.equal(saved.scene.elements.find((e: { id: string }) => e.id === 'a').x, 40);
        },
      );
      await t.test(
        'deletes survive stale retries, images persist, and late joiners get the latest scene',
        async () => {
          alice.send(3, {
            ...delta({ ...box('a', 3, 40), isDeleted: true } as ReturnType<typeof box>),
            title: 'Working together',
          });
          await alice.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
              m.type === 'scene' && m.ack === 3,
          );
          colleague.send(3, delta(box('a', 2, 20, 20)));
          await colleague.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
              m.type === 'scene' && m.ack === 3,
          );
          const dataURL =
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=';
          alice.send(4, {
            ...delta({ ...box('image'), type: 'image', fileId: 'png' } as ReturnType<typeof box>),
            files: { png: { id: 'png', mimeType: 'image/png', dataURL, created: 1 } },
          });
          await alice.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
              m.type === 'scene' && m.ack === 4,
          );
          const late = await connect();
          const latest = await late.wait(sceneAt(1));
          assert.equal(latest.canvas.title, 'Working together');
          assert.equal(latest.canvas.scene.elements.find((e) => e.id === 'a')?.isDeleted, true);
          assert.equal(latest.canvas.scene.files.png.dataURL, dataURL);
          late.socket.terminate();
        },
      );
      await t.test(
        'unauthenticated, cross-origin, private-project and read-only connections are rejected',
        async () => {
          await assert.rejects(injectWS(endpoint), /401/);
          await assert.rejects(
            injectWS(endpoint, { headers: { cookie: owner, origin: 'https://evil.test' } }),
            /403/,
          );
          const token = (await call('POST', '/tokens', { name: 'Read', scope: 'read' })).json()
            .token;
          await assert.rejects(
            injectWS(endpoint, { headers: { authorization: `Bearer ${token}` } }),
            /403/,
          );
          const secret = (
            await call('POST', '/projects', {
              key: 'SECRET',
              name: 'Secret',
              visibility: 'private',
            })
          ).json();
          const hidden = (
            await call('POST', `/projects/${secret.id}/canvases`, { title: 'Hidden' })
          ).json();
          await assert.rejects(
            injectWS(`/api/v1/projects/${secret.id}/canvases/${hidden.id}/live`, {
              headers: { cookie: bob },
            }),
            /404/,
          );
          await assert.rejects(
            injectWS(`/api/v1/projects/${secret.id}/canvases/${canvas.id}/live`, {
              headers: { cookie: owner },
            }),
            /404/,
          );
        },
      );
      await t.test(
        'REST edits reach live editors and revoked members stop receiving updates',
        async () => {
          const current = (await call('GET', `${path}/${canvas.id}`)).json();
          await call('PATCH', `${path}/${canvas.id}`, {
            title: 'REST rename',
            expectedRevision: current.revision,
          });
          await colleague.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'scene' }> =>
              m.type === 'scene' && m.canvas.title === 'REST rename',
          );
          await call('PATCH', `/projects/${project.id}`, { visibility: 'private', memberIds: [] });
          const removed = await colleague.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'error' }> =>
              m.type === 'error' && m.fatal,
          );
          assert.match(removed.message, /no longer available/);
          await assert.rejects(injectWS(endpoint, { headers: { cookie: bob } }), /404/);
          await call('PATCH', `/projects/${project.id}`, { memberIds: [member.id] });
        },
      );
      await t.test('invalid updates cannot alter the saved scene', async () => {
        const invalid = await connect();
        const before = (await call('GET', `${path}/${canvas.id}`)).json();
        invalid.send(
          1,
          delta({ ...box('unsafe'), link: 'javascript:alert(1)' } as ReturnType<typeof box>),
        );
        await invalid.wait(
          (m): m is Extract<CanvasServerMessage, { type: 'error' }> =>
            m.type === 'error' && m.fatal,
        );
        assert.deepEqual((await call('GET', `${path}/${canvas.id}`)).json(), before);
      });
      await t.test(
        'logout ends an open session and committed data survives a server restart',
        async () => {
          const bobAgain = await connect(bob);
          await call('POST', '/auth/logout', {}, bob);
          await bobAgain.wait(
            (m): m is Extract<CanvasServerMessage, { type: 'error' }> =>
              m.type === 'error' && m.fatal,
          );
          const before = (await call('GET', `${path}/${canvas.id}`)).json();
          connections.forEach((socket) => socket.terminate());
          await app.close();
          app = await createApp({ dataDir, integrations: false });
          assert.deepEqual((await call('GET', `${path}/${canvas.id}`)).json(), before);
        },
      );
    } finally {
      connections.forEach((socket) => socket.terminate());
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
