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
 * draining or held, and while auto-calibration holds the device.
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
  /**
   * Send one input. Mouse x and y are shares of the screen, 0 to 1.
   * Returns how it was sent: an absolute move, a relative one, or a key.
   */
  sendKeepAwake(input: KeepAwakeInput): Promise<'absolute' | 'relative' | 'key'>;
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
  private flip = false;
  private polling = false;
  private isBusy: () => boolean = () => false;

  constructor(
    private readonly target: KeepAwakeTarget,
    private readonly timing: () => Timing = () => ({ pollMs: POLL_MS, secondMs: 1000 }),
  ) {}

  /** Start, or restart with new options. `isBusy` reports auto-calibration. */
  start(options: KeepAwakeOptions, isBusy: () => boolean): KeepAwakeState {
    this.stopTimer();
    this.options = { ...options };
    this.isBusy = isBusy;
    this.startedAt = new Date().toISOString();
    this.actions = 0;
    this.lastAction = null;
    this.lastSkip = undefined;
    this.flip = false;
    this.schedule();
    return this.state();
  }

  stop(): KeepAwakeState {
    this.stopTimer();
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
    this.polling = true;
    try {
      const skip = this.skipReason();
      if (skip) {
        this.lastSkip = skip;
        return;
      }
      const idle = await this.target.hidInactivitySeconds();
      // Somebody gave input within the interval: nothing to do yet.
      if (idle !== null && idle < options.intervalSeconds) {
        this.lastSkip = undefined;
        return;
      }
      // Checked again: a tool call may have started during the read.
      const late = this.skipReason();
      if (late || this.options !== options) {
        if (late) this.lastSkip = late;
        return;
      }
      await this.act(options);
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

  private async act(options: KeepAwakeOptions): Promise<void> {
    this.flip = !this.flip;
    const useKey = options.mode === 'keyboard' || (options.mode === 'mixed' && this.flip);
    let input: KeepAwakeInput;
    if (useKey) {
      input = { kind: 'key', key: KEEP_AWAKE_KEY };
    } else {
      const centre = quadrantCentre(options.quadrant);
      const offset = this.flip ? POINT_OFFSET : -POINT_OFFSET;
      input = { kind: 'mouse', x: centre.x + offset, y: centre.y + offset };
    }
    const at = new Date().toISOString();
    try {
      const sent = await this.target.sendKeepAwake(input);
      this.actions += 1;
      this.lastSkip = undefined;
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
      this.lastAction = {
        at,
        input: input.kind === 'key' ? `key ${input.key}` : 'mouse move',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
