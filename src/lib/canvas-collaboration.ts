import type { ProjectCanvas } from '../../shared/types';
import {
  canvasChanges,
  canvasFingerprint,
  combineChanges,
  emptyChanges,
  hasChanges,
  mergeCanvas,
  type CanvasChanges,
  type CanvasDraft,
  type CanvasPresence,
  type CanvasServerMessage,
} from '../../shared/canvas-collaboration';
import type { SaveStatus } from './canvas-save';

type SocketFactory = (url: string) => WebSocket;
type Flight = { id: number; changes: CanvasChanges };

/** One acknowledged write at a time, plus an independent journal of newer edits. */
export class CanvasCollaboration {
  readonly isShared = true;
  draft: CanvasDraft;
  revision: number;
  status: SaveStatus = 'saved';
  connection: 'connecting' | 'live' | 'offline' | 'blocked' = 'connecting';
  error: Error | undefined;
  peers: CanvasPresence[] = [];
  private base: CanvasDraft;
  private pending = emptyChanges();
  private flight?: Flight;
  private sequence = 0;
  private clientId?: string;
  private socket?: WebSocket;
  private stopped = true;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private pointerTimer?: ReturnType<typeof setTimeout>;
  private latestPresence?: Omit<CanvasPresence, 'id' | 'userId' | 'name' | 'color'>;
  private waiters = new Set<(saved: boolean) => void>();

  constructor(
    private canvas: ProjectCanvas,
    private notify: () => void,
    private apply: (draft: CanvasDraft) => void,
    private makeSocket: SocketFactory = (url) => new WebSocket(url),
    private origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  ) {
    this.base = this.draft = { title: canvas.title, scene: canvas.scene };
    this.revision = canvas.revision;
  }
  get dirty() {
    return !!this.flight || hasChanges(this.pending);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  private connect() {
    if (this.stopped || this.connection === 'blocked') return;
    this.connection = this.retry ? 'offline' : 'connecting';
    const url = new URL(
      `/api/v1/projects/${this.canvas.projectId}/canvases/${this.canvas.id}/live`,
      this.origin,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.makeSocket(url.href);
    this.socket = socket;
    this.notify();
    this.watchdog = setTimeout(() => socket.close(), 12_000);
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        this.receive(JSON.parse(String(event.data)) as CanvasServerMessage);
      } catch {
        this.block('Unable to read the shared canvas. Download a copy before reloading.');
      }
    };
    socket.onerror = () => {
      /* onclose drives reconnect without losing the journal */
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return;
      clearTimeout(this.watchdog);
      this.requeue();
      this.socket = undefined;
      this.peers = [];
      if (event.code >= 4400 && event.code < 4500) {
        this.block(
          this.error?.message ?? 'Canvas access ended. Download a copy of any unsaved work.',
        );
        return;
      }
      if (this.connection !== 'blocked') {
        this.connection = 'offline';
        this.status = this.dirty ? 'pending' : 'saved';
        this.reconnect = setTimeout(
          () => this.connect(),
          Math.min(1000 * 2 ** this.retry++, 10_000),
        );
      }
      this.notify();
    };
  }
  private requeue() {
    if (this.flight) this.pending = combineChanges(this.flight.changes, this.pending);
    this.flight = undefined;
  }
  private block(message: string) {
    this.requeue();
    this.error = new Error(message);
    this.connection = 'blocked';
    this.status = 'error';
    this.peers = [];
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnect);
    this.socket?.close();
    this.settle(false);
    this.notify();
  }
  private receive(message: CanvasServerMessage) {
    if (message.type === 'error') {
      if (message.fatal) {
        this.block(message.message);
        return;
      }
      this.requeue();
      clearTimeout(this.watchdog);
      this.error = new Error(message.message);
      this.status = 'error';
      this.settle(false);
    } else if (message.type === 'presence') {
      this.peers = message.peers.filter((peer) => peer.id !== this.clientId);
    } else {
      if (message.clientId) {
        this.clientId = message.clientId;
        this.connection = 'live';
        this.retry = 0;
        clearTimeout(this.watchdog);
      }
      if (message.ack === this.flight?.id) {
        this.flight = undefined;
        clearTimeout(this.watchdog);
      }
      if (message.canvas.revision >= this.revision) {
        this.revision = message.canvas.revision;
        this.base = { title: message.canvas.title, scene: message.canvas.scene };
      }
      this.draft = mergeCanvas(
        mergeCanvas(this.base, this.flight?.changes ?? emptyChanges()),
        this.pending,
      );
      this.error = undefined;
      this.status = this.flight ? 'saving' : this.dirty ? 'pending' : 'saved';
      this.apply(this.draft);
      if (!this.dirty) this.settle(true);
      this.schedule();
      if (message.clientId && this.latestPresence) this.schedulePresence();
    }
    this.notify();
  }
  update(next: CanvasDraft) {
    const changes = canvasChanges(this.draft, next);
    if (!hasChanges(changes)) return;
    this.pending = combineChanges(this.pending, changes);
    this.draft = mergeCanvas(this.draft, changes);
    if (this.connection !== 'blocked') {
      this.error = undefined;
      this.status = this.flight ? 'saving' : 'pending';
      this.schedule();
    }
    this.notify();
  }
  private schedule() {
    if (this.timer || this.flight || !hasChanges(this.pending) || this.status === 'error') return;
    // Throttle, rather than debounce, so a continuous drag is visible remotely.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.send();
    }, 80);
  }
  private send() {
    if (
      this.stopped ||
      this.connection !== 'live' ||
      this.socket?.readyState !== 1 ||
      this.status === 'error' ||
      this.flight ||
      !hasChanges(this.pending)
    )
      return;
    if (!this.draft.title.trim()) {
      this.error = new Error('Give this canvas a name before saving.');
      this.status = 'error';
      this.settle(false);
      this.notify();
      return;
    }
    const flight = { id: ++this.sequence, changes: this.pending };
    const payload = JSON.stringify({ type: 'changes', ...flight });
    if (new Blob([payload]).size > 8 * 1024 * 1024 - 1024) {
      this.error = new Error(
        'This canvas exceeds the 8 MB limit. Remove large images or download a copy.',
      );
      this.status = 'error';
      this.settle(false);
      this.notify();
      return;
    }
    this.flight = flight;
    this.pending = emptyChanges();
    this.status = 'saving';
    this.socket.send(payload);
    clearTimeout(this.watchdog);
    // An uncertain acknowledgement is retried with the same element versions.
    this.watchdog = setTimeout(() => this.socket?.close(), 12_000);
    this.notify();
  }
  updatePresence(presence: Omit<CanvasPresence, 'id' | 'userId' | 'name' | 'color'>) {
    const next = { ...this.latestPresence, ...presence };
    if (canvasFingerprint(next) === canvasFingerprint(this.latestPresence)) return;
    this.latestPresence = next;
    this.schedulePresence();
  }
  private schedulePresence() {
    if (this.pointerTimer || this.connection !== 'live') return;
    this.pointerTimer = setTimeout(() => {
      this.pointerTimer = undefined;
      if (this.connection === 'live' && this.socket?.readyState === 1)
        this.socket.send(JSON.stringify({ type: 'presence', presence: this.latestPresence }));
    }, 50);
  }
  async flush(): Promise<boolean> {
    if (!this.dirty) return this.connection !== 'blocked';
    if (this.connection === 'blocked') return false;
    this.error = undefined;
    this.status = this.flight ? 'saving' : 'pending';
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(done);
        this.error = new Error(
          'Changes are still waiting to sync. Keep this tab open or download a copy.',
        );
        this.status = 'error';
        this.notify();
        resolve(false);
      }, 8000);
      const done = (saved: boolean) => {
        clearTimeout(timeout);
        this.waiters.delete(done);
        resolve(saved);
      };
      this.waiters.add(done);
      this.send();
    });
  }
  private settle(saved: boolean) {
    for (const done of [...this.waiters]) done(saved);
  }
  dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.reconnect);
    clearTimeout(this.watchdog);
    clearTimeout(this.pointerTimer);
    this.pointerTimer = undefined;
    this.requeue();
    this.socket?.close();
    this.socket = undefined;
    this.settle(false);
  }
}
