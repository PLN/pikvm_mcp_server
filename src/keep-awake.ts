// Modified 2026-10 by PLN: keep a device awake with harmless input (GPL-3.0; see NOTICE).

/**
 * Keeps the computer behind one PiKVM awake until it is stopped. Every
 * poll it reads kvmd's HID inactivity (GET /api/hid/inactivity, all
 * sources: people in the web viewer, this server, kvmd's jiggler). Once
 * nobody has given input for `intervalSeconds`, it sends one harmless
 * input:
 *
 * - mouse: an absolute move near the centre of a screen quadrant, never
 *   the screen centre and never near an edge, alternating between two
 *   points so the pointer really moves. With a relative mouse, a small
 *   move there and back.
 * - keyboard: F15, which normal applications ignore.
 * - mixed: mouse and keyboard in turn.
 *
 * Any other tool call on the device suspends it while the call runs and
 * for `suspendSeconds` after the call ends; then it resumes by itself.
 * Input is also skipped while this server's own HID input is in flight,
 * draining or held, and while auto-calibration holds the device. Every
 * poll also reads the video signal, which keeps the screen on-time in
 * pikvm_status current.
 * State is in memory: a server restart stops it.
 */

export type KeepAwakeMode = 'mouse' | 'keyboard' | 'mixed';
export type KeepAwakeQuadrant = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['mouse', 'keyboard', 'mixed'];
export const KEEP_AWAKE_QUADRANTS: readonly KeepAwakeQuadrant[] = [
  'top-left', 'top-right', 'bottom-left', 'bottom-right',
];

export const KEEP_AWAKE_INTERVAL = { default: 60, min: 10, max: 3600 } as const;
export const KEEP_AWAKE_SUSPEND = { default: 30, min: 5, max: 600 } as const;

/** The key for keyboard mode. kvmd maps it; applications ignore it. */
export const KEEP_AWAKE_KEY = 'F15';

/** How often the inactivity is read while keep-awake is on. */
const POLL_MS = 5_000;

/** Half the distance between the two pointer points, as a share of the screen. */
const POINT_OFFSET = 0.01;

export interface KeepAwakeOptions {
  mode: KeepAwakeMode;
  quadrant: KeepAwakeQuadrant;
  intervalSeconds: number;
  suspendSeconds: number;
}

export type KeepAwakeInput =
  | { kind: 'mouse'; x: number; y: number }
  | { kind: 'key'; key: string };

/** What keep-awake needs from the device client. */
export interface KeepAwakeTarget {
  /** Seconds since any HID input, or null when kvmd does not say. */
  hidInactivitySeconds(): Promise<number | null>;
  /** True while this client's HID input is in flight, draining or held. */
  hidBusy(): boolean;
  /** Read the video signal, for the screen on-time in pikvm_status. Never throws. */
  observeSignal(): Promise<void>;
  /**
   * Send one input. Mouse x and y are shares of the screen, 0 to 1.
   * `mayPost` is checked synchronously right before every POST; when it
   * is false the rest is not sent and KeepAwakeCancelled is thrown.
   * Returns how it was sent: an absolute move, a relative one, or a key.
   */
  sendKeepAwake(input: KeepAwakeInput, mayPost: () => boolean): Promise<'absolute' | 'relative' | 'key'>;
}

/** A tool call started, or keep-awake stopped, before keep-awake's input was sent. */
export class KeepAwakeCancelled extends Error {
  constructor() {
    super('cancelled before sending');
    this.name = 'KeepAwakeCancelled';
  }
}

export interface KeepAwakeAction {
  at: string;
  input: string;
  ok: boolean;
  error?: string;
}

export interface KeepAwakeState {
  enabled: boolean;
  mode?: KeepAwakeMode;
  quadrant?: KeepAwakeQuadrant;
  intervalSeconds?: number;
  suspendSeconds?: number;
  startedAt?: string;
  /** Set while a tool call runs or its suspension lasts. */
  suspendedUntil?: string | 'while a tool call runs';
  actions: number;
  lastAction: KeepAwakeAction | null;
  lastSkip?: string;
}

interface Timing {
  pollMs: number;
  /** Milliseconds per configured second. 1000 except in tests. */
  secondMs: number;
}

/** Centre of a quadrant, as shares of the screen. */
export function quadrantCentre(quadrant: KeepAwakeQuadrant): { x: number; y: number } {
  return {
    x: quadrant.endsWith('left') ? 0.25 : 0.75,
    y: quadrant.startsWith('top') ? 0.25 : 0.75,
  };
}

export class KeepAwake {
  private options: KeepAwakeOptions | null = null;
  private startedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private activeCalls = 0;
  private suspendedUntil = 0;
  private actions = 0;
  private lastAction: KeepAwakeAction | null = null;
  private lastSkip: string | undefined;
  /** Alternates the input kind in mixed mode. */
  private turn = false;
  /** Alternates the two pointer points, on every mouse input. */
  private point = false;
  /** Bumped by start and stop; an action from an older run sends and records nothing. */
  private generation = 0;
  /** When this server last saw input it knows of: its own keep-awake input and tool calls. Epoch ms. */
  private lastKnownInput = 0;
  private polling = false;
  private isBusy: () => boolean = () => false;

  constructor(
    private readonly target: KeepAwakeTarget,
    private readonly timing: () => Timing = () => ({ pollMs: POLL_MS, secondMs: 1000 }),
  ) {}

  /** Start, or restart with new options. `isBusy` reports auto-calibration. */
  start(options: KeepAwakeOptions, isBusy: () => boolean): KeepAwakeState {
    this.stopTimer();
    this.generation += 1;
    this.options = { ...options };
    this.isBusy = isBusy;
    this.startedAt = new Date().toISOString();
    this.actions = 0;
    this.lastAction = null;
    this.lastSkip = undefined;
    this.turn = false;
    this.point = false;
    this.schedule();
    return this.state();
  }

  stop(): KeepAwakeState {
    this.stopTimer();
    this.generation += 1;
    const state = this.state();
    this.options = null;
    this.startedAt = null;
    return { ...state, enabled: false };
  }

  get enabled(): boolean {
    return this.options !== null;
  }

  /** A tool call on this device started. */
  callStarted(): void {
    this.activeCalls += 1;
  }

  /** That call ended. Suspension runs `suspendSeconds` from now. */
  callEnded(): void {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
    this.lastKnownInput = Date.now();
    if (!this.options) return;
    const until = Date.now() + this.options.suspendSeconds * this.timing().secondMs;
    this.suspendedUntil = Math.max(this.suspendedUntil, until);
  }

  state(): KeepAwakeState {
    if (!this.options) return { enabled: false, actions: this.actions, lastAction: this.lastAction };
    const state: KeepAwakeState = {
      enabled: true,
      ...this.options,
      startedAt: this.startedAt ?? undefined,
      actions: this.actions,
      lastAction: this.lastAction,
    };
    if (this.activeCalls > 0) state.suspendedUntil = 'while a tool call runs';
    else if (this.suspendedUntil > Date.now()) state.suspendedUntil = new Date(this.suspendedUntil).toISOString();
    if (this.lastSkip) state.lastSkip = this.lastSkip;
    return state;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => {
        if (this.options && !this.timer) this.schedule();
      });
    }, this.timing().pollMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const options = this.options;
    if (!options || this.polling) return;
    // Captured before the first await: a stop or restart during a read ends this poll.
    const generation = this.generation;
    this.polling = true;
    try {
      await this.target.observeSignal();
      if (generation !== this.generation) return;
      const skip = this.skipReason();
      if (skip) {
        this.lastSkip = skip;
        return;
      }
      const kvmdIdle = await this.target.hidInactivitySeconds();
      if (generation !== this.generation) return;
      // Without kvmd's timer, fall back to the input this server knows of:
      // at most one input per interval, though a web viewer's input is unseen.
      const idle = kvmdIdle ?? (Date.now() - this.lastKnownInput) / this.timing().secondMs;
      if (idle < options.intervalSeconds) {
        this.lastSkip = kvmdIdle === null ? 'kvmd does not report inactivity; using this server\'s own input times' : undefined;
        return;
      }
      // Checked again: a tool call may have started during the read.
      const late = this.skipReason();
      if (late || generation !== this.generation) {
        if (late) this.lastSkip = late;
        return;
      }
      await this.act(options, generation, kvmdIdle === null);
    } catch (err) {
      this.lastAction = {
        at: new Date().toISOString(),
        input: 'inactivity read',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.polling = false;
    }
  }

  private skipReason(): string | undefined {
    if (this.activeCalls > 0) return 'a tool call is running';
    if (Date.now() < this.suspendedUntil) return 'suspended after a tool call';
    if (this.isBusy()) return 'auto-calibration holds the device';
    if (this.target.hidBusy()) return 'this server\'s input is in flight, draining or held';
    return undefined;
  }

  private async act(options: KeepAwakeOptions, generation: number, ownTimes: boolean): Promise<void> {
    this.turn = !this.turn;
    const useKey = options.mode === 'keyboard' || (options.mode === 'mixed' && this.turn);
    let input: KeepAwakeInput;
    if (useKey) {
      input = { kind: 'key', key: KEEP_AWAKE_KEY };
    } else {
      this.point = !this.point;
      const centre = quadrantCentre(options.quadrant);
      const offset = this.point ? POINT_OFFSET : -POINT_OFFSET;
      input = { kind: 'mouse', x: centre.x + offset, y: centre.y + offset };
    }
    const at = new Date().toISOString();
    // Right before each POST: no tool call started, no suspension, same run.
    const mayPost = () => generation === this.generation
      && this.activeCalls === 0
      && Date.now() >= this.suspendedUntil
      && !this.isBusy();
    try {
      const sent = await this.target.sendKeepAwake(input, mayPost);
      if (generation !== this.generation) return;
      this.actions += 1;
      this.lastKnownInput = Date.now();
      this.lastSkip = ownTimes ? 'kvmd does not report inactivity; using this server\'s own input times' : undefined;
      this.lastAction = {
        at,
        input: input.kind === 'key'
          ? `key ${input.key}`
          : sent === 'relative'
            ? 'relative mouse move and back'
            : `mouse to (${input.x.toFixed(2)}, ${input.y.toFixed(2)}) of the screen`,
        ok: true,
      };
    } catch (err) {
      if (generation !== this.generation) return;
      if (err instanceof KeepAwakeCancelled) {
        this.lastSkip = 'a tool call started before the input was sent';
        return;
      }
      this.lastAction = {
        at,
        input: input.kind === 'key' ? `key ${input.key}` : 'mouse move',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
