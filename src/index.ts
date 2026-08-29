#!/usr/bin/env node
/**
 * PiKVM MCP Server
 *
 * Provides MCP tools for controlling remote machines via PiKVM.
 *
 * Transport selection: PIKVM_MCP_PORT set -> Streamable HTTP (bearer auth,
 * HID arm-gate); otherwise stdio (default — PC-Control and other local MCP
 * clients spawn it directly and gate HID on their own side).
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
    const { port, bearerToken, armHid } = config.http;
    // Fail closed: an unauthenticated network listener on a HID server would
    // let anyone type on the remote machine.
    if (!bearerToken) {
      console.error('Fatal: PIKVM_MCP_BEARER must be set when PIKVM_MCP_PORT is set (HTTP mode requires bearer auth).');
      process.exit(1);
    }
    const armGateEnforced = !armHid;
    await startHttpServer({
      port,
      bearerToken,
      createServer: () => createMcpServer({ pikvm, lock, calibrationConfig, armGateEnforced }),
    });
    console.error(`PiKVM MCP Server running (HTTP on port ${port}, HID ${armHid ? 'ARMED' : 'DISARMED'})`);
    return;
  }

  // stdio mode: behavior unchanged from pre-HTTP releases (no arm-gate).
  const server = createMcpServer({ pikvm, lock, calibrationConfig, armGateEnforced: false });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PiKVM MCP Server running');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
