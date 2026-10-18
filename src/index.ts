#!/usr/bin/env node
// Modified 2026-10 by PLN: MSD arm-gate (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD local upload directory (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: URL fetch allowlist (GPL-3.0; see NOTICE).
/**
 * PiKVM MCP Server
 *
 * Provides MCP tools for controlling remote machines via PiKVM.
 *
 * Transport selection: PIKVM_MCP_PORT set -> Streamable HTTP (bearer auth,
 * HID arm-gate and a separate MSD arm-gate); otherwise stdio (default —
 * PC-Control and other local MCP clients spawn it directly and gate HID
 * and MSD on their own side).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PiKVMClient } from './pikvm/client.js';
import { loadConfig } from './config.js';
import { BusyLock } from './pikvm/lock.js';
import { createMcpServer } from './server.js';
import { startHttpServer } from './http.js';

// Start server
async function main() {
  // Load configuration (deferred to here for proper error handling)
  const config = loadConfig();
  const pikvm = new PiKVMClient(config.pikvm);
  const lock = new BusyLock();
  const calibrationConfig = config.calibration;

  // Verify connection on startup
  const authOk = await pikvm.checkAuth();
  if (!authOk) {
    console.error('Warning: Could not authenticate with PiKVM. Check credentials.');
  }

  if (config.http) {
    const { port, host, bearerToken, armHid, armMsd } = config.http;
    // Fail closed: an unauthenticated network listener on a HID server would
    // let anyone type on the remote machine.
    if (!bearerToken) {
      console.error('Fatal: PIKVM_MCP_BEARER must be set when PIKVM_MCP_PORT is set (HTTP mode requires bearer auth).');
      process.exit(1);
    }
    const armGateEnforced = !armHid;
    const msdArmGateEnforced = !armMsd;
    await startHttpServer({
      port,
      host,
      bearerToken,
      createServer: () => createMcpServer({
        pikvm,
        lock,
        calibrationConfig,
        armGateEnforced,
        msdArmGateEnforced,
        msd: config.msd,
      }),
    });
    console.error(
      `PiKVM MCP Server running (HTTP on ${host}:${port}, HID ${armHid ? 'ARMED' : 'DISARMED'}, MSD ${armMsd ? 'ARMED' : 'DISARMED'})`,
    );
    return;
  }

  // stdio mode: HID and MSD stay ungated. Local callers gate on their own side.
  const server = createMcpServer({
    pikvm,
    lock,
    calibrationConfig,
    armGateEnforced: false,
    msdArmGateEnforced: false,
    msd: config.msd,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PiKVM MCP Server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
