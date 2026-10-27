// Modified 2026-10 by PLN: start idle capture with a kvmd stream session (GPL-3.0; see NOTICE).

/**
 * kvmd runs ustreamer only while a stream-enabled WebSocket client is
 * connected, or the snapshoter or stream_forever wants it (kvmd v4.227
 * kvmd/apps/kvmd/server.py, __stream_controller). Without one, a snapshot
 * is HTTP 503 and GET /api/streamer has `streamer: null`. A web viewer
 * starts capture by opening /api/ws, which defaults to stream=1.
 *
 * CaptureSession holds one /api/ws?stream=1 session per device while
 * captures need it. It closes CAPTURE_LINGER_MS after the last capture,
 * and kvmd stops ustreamer about 10 s after that (streamer.shutdown_delay).
 *
 * kvmd clears HID whenever any WebSocket session is added or removed
 * (server.py _on_ws_added and _on_ws_removed call hid.clear_events()):
 * queued input is dropped and held keys and buttons are released. HidGate
 * makes this client open and close its session only while its own HID
 * input is idle: no HID call in flight, the estimated queue drain over,
 * and nothing held. A web viewer that opens or closes does the same clear;
 * that is kvmd's behaviour and outside this client.
 */

import { performance } from 'node:perf_hooks';
import type { WebSocket } from 'undici';

/** kvmd answers within a second on hardware. */
const OPEN_TIMEOUT_MS = 10_000;

/** Wait for the server's close frame before dropping the socket. */
const CLOSE_TIMEOUT_MS = 2_000;

/**
 * The client sees the close handshake finish before kvmd runs
 * _on_ws_removed, so HID calls wait this much longer.
 */
const CLOSE_SETTLE_MS = 500;

export class HidBusyError extends Error {
  constructor(waitedMs: number) {
    super(`HID input did not settle within ${Math.round(waitedMs / 1000)}s`);
    this.name = 'HidBusyError';
  }
}

export class HeldInputError extends Error {
  readonly held: string[];

  constructor(held: string[]) {
    super(`held input: ${held.join(', ')}`);
    this.name = 'HeldInputError';
    this.held = held;
  }
}

/**
 * Orders this client's HID calls against stream session opens and closes.
 * HID calls wait while a session is opening or closing. An open or close
 * waits until no HID call is in flight and the last one's estimated drain
 * time has passed.
 */
export class HidGate {
  private inFlight = 0;
  private backlogEnd = 0;
  private quietAt = 0;
  private readonly held = new Set<string>();
  private transition: Promise<void> | null = null;
  private idleWaiters: Array<() => void> = [];

  /** Before a HID POST. */
  async enter(): Promise<void> {
    while (this.transition) await this.transition;
    this.inFlight += 1;
  }

  /**
   * After a HID POST, sent or not. kvmd writes the reports a call queued
   * after those of earlier calls, for about `queuedMs`, so backlogs add
   * up. `settleMs` is a margin after the last report.
   */
  leave(queuedMs: number, settleMs: number): void {
    this.inFlight -= 1;
    this.backlogEnd = Math.max(this.backlogEnd, performance.now()) + queuedMs;
    this.quietAt = Math.max(this.quietAt, this.backlogEnd + settleMs);
    if (this.inFlight === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const wake of waiters) wake();
    }
  }

  /** A key or button sent with state=true stays held until state=false. */
  setHeld(id: string, held: boolean): void {
    if (held) this.held.add(id);
    else this.held.delete(id);
  }

  heldInput(): string[] {
    return [...this.held];
  }

  /** Milliseconds until queued reports from every call are expected to be written. */
  drainRemainingMs(): number {
    return Math.max(0, this.backlogEnd - performance.now());
  }

  /** HID input in flight, its reports still draining, input held, or a session opening or closing. */
  busy(): boolean {
    return this.inFlight > 0 || performance.now() < this.quietAt || this.held.size > 0 || this.transition !== null;
  }

  /**
   * Run `fn` once HID is idle. HID calls that start meanwhile wait until
   * it settles. Throws HidBusyError when HID is not idle within `maxWaitMs`.
   */
  async exclusive<T>(fn: () => Promise<T>, maxWaitMs: number): Promise<T> {
    const started = performance.now();
    for (;;) {
      while (this.transition) await this.transition;
      const now = performance.now();
      if (this.inFlight === 0 && now >= this.quietAt) break;
      const left = started + maxWaitMs - now;
      if (left <= 0) throw new HidBusyError(maxWaitMs);
      if (this.inFlight > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, left);
          function done(): void {
            clearTimeout(timer);
            resolve();
          }
          this.idleWaiters.push(done);
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, Math.min(left, this.quietAt - now)));
      }
    }
    // No await between the idle check and setting `transition`, so a HID
    // call cannot start in between.
    const run = fn();
    const settled = run.then(() => undefined, () => undefined);
    this.transition = settled;
    try {
      return await run;
    } finally {
      if (this.transition === settled) this.transition = null;
    }
  }
}

export interface CaptureSessionOptions {
  /** Opens /api/ws?stream=1 with this client's dispatcher and credentials. */
  open: () => WebSocket;
  gate: HidGate;
  lingerMs: () => number;
  /** Longest wait for HID to go idle before an open or close. */
  hidWaitMs: number;
}

/**
 * One kvmd stream session, shared by concurrent captures on one device.
 * acquire() opens it when needed; the returned function releases it.
 */
export class CaptureSession {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private users = 0;
  private linger: NodeJS.Timeout | null = null;
  private shutDown = false;

  constructor(private readonly options: CaptureSessionOptions) {}

  /** True while a session is open or opening. */
  get isOpen(): boolean {
    return this.ready !== null;
  }

  /**
   * Hold the session open. Throws HeldInputError when it would have to
   * open while this client holds a key or button, HidBusyError when HID
   * does not go idle, or an Error when kvmd refuses the session.
   */
  async acquire(): Promise<() => void> {
    if (this.shutDown) throw new Error('the client is closed');
    this.users += 1;
    this.clearLinger();
    try {
      while (this.closing) await this.closing;
      if (!this.ready) {
        const ready = this.options.gate.exclusive(() => {
          const held = this.options.gate.heldInput();
          if (held.length > 0) return Promise.reject(new HeldInputError(held));
          return this.connect();
        }, this.options.hidWaitMs);
        this.ready = ready;
        ready.catch(() => {
          if (this.ready === ready) this.ready = null;
        });
      }
      await this.ready;
    } catch (err) {
      this.dropUser();
      throw err;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dropUser();
    };
  }

  /** Shutdown. Closes at once, without waiting for HID. */
  close(): void {
    this.shutDown = true;
    this.clearLinger();
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    if (ws) closeQuietly(ws);
  }

  private dropUser(): void {
    this.users -= 1;
    if (this.users === 0 && this.ready && !this.shutDown) this.armLinger();
  }

  private armLinger(): void {
    this.clearLinger();
    this.linger = setTimeout(() => {
      this.linger = null;
      void this.closeIdle();
    }, this.options.lingerMs());
    this.linger.unref();
  }

  private clearLinger(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
  }

  private async closeIdle(): Promise<void> {
    if (this.users > 0 || !this.ready || this.closing || this.shutDown) return;
    const closing = this.options.gate.exclusive(() => this.disconnect(), this.options.hidWaitMs)
      .catch(() => {
        // HID did not go idle. Try again after another linger period.
        if (this.users === 0 && this.ready && !this.shutDown) this.armLinger();
      });
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }

  private async disconnect(): Promise<void> {
    // A capture took the session while HID was settling.
    if (this.users > 0 || this.shutDown) return;
    // Closing would release what is held. Keep the session until it is not.
    if (this.options.gate.heldInput().length > 0) {
      this.armLinger();
      return;
    }
    const ws = this.ws;
    this.ws = null;
    this.ready = null;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, CLOSE_TIMEOUT_MS);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      ws.addEventListener('close', done, { once: true });
      closeQuietly(ws);
    });
    await new Promise((resolve) => setTimeout(resolve, CLOSE_SETTLE_MS));
  }

  /**
   * Ready on kvmd's first event. kvmd registers the session, which runs
   * the HID clear, before it sends anything.
   */
  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = this.options.open();
      } catch (err) {
        reject(err);
        return;
      }
      this.ws = ws;
      const timer = setTimeout(() => {
        fail(new Error(`no answer within ${OPEN_TIMEOUT_MS / 1000}s`));
      }, OPEN_TIMEOUT_MS);
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        closeQuietly(ws);
        reject(err);
      };
      ws.addEventListener('message', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', (event) => {
        const cause = (event as { error?: unknown }).error;
        fail(cause instanceof Error ? cause : new Error('the WebSocket failed'));
      });
      ws.addEventListener('close', (event) => {
        if (!settled) {
          fail(new Error(`kvmd closed the session (code ${event.code})`));
          return;
        }
        // kvmd restarted or the connection dropped. The next capture opens a new session.
        if (this.ws === ws) {
          this.ws = null;
          this.ready = null;
          this.clearLinger();
        }
      });
    });
  }
}

function closeQuietly(ws: WebSocket): void {
  try {
    ws.close(1000);
  } catch {
    // Already closing or closed.
  }
}
