// Modified 2026-10 by PLN: graceful shutdown (GPL-3.0; see NOTICE).

/**
 * One shutdown for stdio and HTTP. Signal handlers call this; tests call
 * it in-process and pass their own exit function.
 *
 * The first signal starts shutdown. A second SIGTERM or SIGINT while that
 * shutdown is still running does not start another one. It exits
 * immediately with code 1. Stdin EOF is not a second signal: if shutdown
 * is already running, EOF is ignored.
 *
 * A finished shutdown exits 0. Eight seconds after the first signal, an
 * unref'd timer exits 1 if shutdown has not finished. The timer does not
 * keep the process alive by itself.
 *
 * HTTP mode stops accepting, closes idle connections, aborts uploads and
 * fetch-URL jobs, destroys kvmd dispatchers, kills OCR children, then
 * closes any sockets that are still open. Stdio mode aborts, destroys,
 * and kills the same way, then closes the transport. Uploads are aborted,
 * not drained. The process stores nothing that has to be saved.
 */

export const SHUTDOWN_DEADLINE_MS = 8000;

export interface ShutdownServer {
  close(callback?: () => void): void;
  closeIdleConnections(): void;
  closeAllConnections(): void;
}

export interface ShutdownTransport {
  close(): Promise<void> | void;
}

export interface ShutdownTargets {
  httpServer?: ShutdownServer;
  stdioTransport?: ShutdownTransport;
  abortTransfers: () => void;
  destroyDispatchers: () => void;
  killOcrChildren: () => void;
  /** Defaults to process.exit. Tests pass a function that records the code. */
  exit?: (code: number) => void;
  /** Defaults to 8 seconds. Tests inject a short deadline. */
  deadlineMs?: number;
}

type Phase = 'idle' | 'running' | 'done';

let phase: Phase = 'idle';
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let exitFn: (code: number) => void = (code) => {
  process.exit(code);
};
let releaseWait: (() => void) | undefined;

function finish(code: number, token: number): void {
  if (token !== generation) return;
  if (phase === 'done') return;
  phase = 'done';
  if (timer) clearTimeout(timer);
  timer = undefined;
  exitFn(code);
}

async function run(targets: ShutdownTargets): Promise<void> {
  if (targets.httpServer) {
    const httpServer = targets.httpServer;
    const closed = new Promise<void>((resolve) => {
      releaseWait = resolve;
      httpServer.close(() => resolve());
    });
    httpServer.closeIdleConnections();
    targets.abortTransfers();
    targets.destroyDispatchers();
    targets.killOcrChildren();
    httpServer.closeAllConnections();
    await closed;
    return;
  }
  targets.abortTransfers();
  targets.destroyDispatchers();
  targets.killOcrChildren();
  if (targets.stdioTransport) await targets.stdioTransport.close();
}

/**
 * Start shutdown, or force code 1 when a signal arrives during shutdown.
 * `reason` `eof` is stdin EOF. It starts shutdown only when none is running.
 */
export function requestShutdown(targets: ShutdownTargets, reason: 'signal' | 'eof' = 'signal'): void {
  if (phase === 'running') {
    if (reason === 'signal') finish(1, generation);
    return;
  }
  if (phase === 'done') return;
  const token = generation;
  phase = 'running';
  exitFn = targets.exit ?? ((code) => {
    process.exit(code);
  });
  const deadlineMs = targets.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  timer = setTimeout(() => finish(1, token), deadlineMs);
  timer.unref();
  void run(targets).then(() => {
    finish(0, token);
  }, () => {
    finish(1, token);
  });
}

/** Test-only. Drops the in-process shutdown state so the next call can start. */
export function resetShutdownForTests(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = undefined;
  phase = 'idle';
  exitFn = (code) => {
    process.exit(code);
  };
  const release = releaseWait;
  releaseWait = undefined;
  release?.();
}

/** Test-only. False when the deadline timer is unref'd. Undefined when none is armed. */
export function shutdownTimerHasRefForTests(): boolean | undefined {
  return timer?.hasRef();
}
