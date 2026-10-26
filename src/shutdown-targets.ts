// Modified 2026-10 by PLN: graceful shutdown (GPL-3.0; see NOTICE).

/**
 * Builds the shutdown target list the signal handler uses after listen.
 * Lives outside the process entry so a test can import it. Importing the
 * entry starts the server.
 */

import { abortInFlightTransfers } from './msd.js';
import { killOcrChildren } from './ocr.js';
import type { ShutdownServer, ShutdownTargets, ShutdownTransport } from './shutdown.js';

export interface ShutdownClient {
  destroyDispatcher(): void;
}

export function shutdownTargets(
  clients: readonly ShutdownClient[],
  httpServer?: ShutdownServer,
  stdioTransport?: ShutdownTransport,
): ShutdownTargets {
  return {
    httpServer,
    stdioTransport,
    abortTransfers: abortInFlightTransfers,
    destroyDispatchers() {
      for (const client of clients) client.destroyDispatcher();
    },
    killOcrChildren,
  };
}
