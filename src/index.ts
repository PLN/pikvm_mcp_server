#!/usr/bin/env node
// Modified 2026-10 by PLN: MSD arm-gate (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD local upload directory (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: URL fetch allowlist (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: password and bearer secret files (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: empty secret vars are unset (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm-mcp-server pin (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: device registry (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: fatal errors go through redactUrl (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: probe OCR at startup (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: OCR probes start after listen (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: probe host tesseract before listen (GPL-3.0; see NOTICE).
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
import { loadConfig, type Config } from './config.js';
import { BusyLock } from './pikvm/lock.js';
import { buildFleet, startOcrProbes } from './devices.js';
import { ocrUsesKvmdProbe, resolveOcr } from './ocr.js';
import { createMcpServer, type McpServerDeps } from './server.js';
import { startHttpServer } from './http.js';
import { pinCommand } from './pin.js';
import { inspect } from 'node:util';
import { redactUrl } from './url-policy.js';

async function listen(config: Config, deps: McpServerDeps): Promise<void> {
  if (config.http) {
    const { port, host, bearerToken, armHid, armMsd } = config.http;
    // Fail closed: an unauthenticated network listener on a HID server would
    // let anyone type on the remote machine.
    if (!bearerToken) {
      console.error(
        'Fatal: PIKVM_MCP_BEARER must be set when PIKVM_MCP_PORT is set (HTTP mode requires bearer auth). '
        + 'Set PIKVM_MCP_BEARER, PIKVM_MCP_BEARER_FILE, or CREDENTIALS_DIRECTORY/pikvm-mcp-bearer.',
      );
      process.exit(1);
    }
    await startHttpServer({
      port,
      host,
      bearerToken,
      createServer: () => createMcpServer(deps),
    });
    console.error(
      `PiKVM MCP Server running (HTTP on ${host}:${port}, HID ${armHid ? 'ARMED' : 'DISARMED'}, MSD ${armMsd ? 'ARMED' : 'DISARMED'})`,
    );
    return;
  }

  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PiKVM MCP Server running');
}

// Start server
async function main() {
  // Load configuration (deferred to here for proper error handling)
  const config = loadConfig();
  // ENGINE=host fails here when the binary is missing. Unset with no
  // binary is off. kvmd is not selected as a fallback.
  const ocr = await resolveOcr(config.ocr);
  if (config.registry) {
    const ceilingHid = config.http ? config.http.armHid : true;
    const ceilingMsd = config.http ? config.http.armMsd : true;
    const fleet = buildFleet(config, { hid: ceilingHid, msd: ceilingMsd });
    for (const device of fleet.devices.values()) {
      const authOk = await device.client.checkAuth();
      if (!authOk) {
        console.error(`Warning: Could not authenticate with PiKVM device ${device.name}. Check credentials.`);
      }
    }
    const fallback = fleet.devices.get(fleet.defaultName);
    if (!fallback) {
      throw new Error(`registry default ${JSON.stringify(fleet.defaultName)} is not a device`);
    }
    await listen(config, {
      pikvm: fallback.client,
      lock: fallback.lock,
      fleet,
      calibrationConfig: config.calibration,
      armGateEnforced: config.http ? !config.http.armHid : false,
      msdArmGateEnforced: config.http ? !config.http.armMsd : false,
      msd: config.msd,
      screenshot: config.screenshot,
      ocr,
    });
    if (ocrUsesKvmdProbe(ocr, fleet.devices.values())) startOcrProbes(fleet.devices.values());
    return;
  }

  const pikvm = new PiKVMClient(config.pikvm);
  const lock = new BusyLock();
  const calibrationConfig = config.calibration;

  // Verify connection on startup
  const authOk = await pikvm.checkAuth();
  if (!authOk) {
    console.error('Warning: Could not authenticate with PiKVM. Check credentials.');
  }

  const armGateEnforced = config.http ? !config.http.armHid : false;
  const msdArmGateEnforced = config.http ? !config.http.armMsd : false;
  await listen(config, {
    pikvm,
    lock,
    calibrationConfig,
    armGateEnforced,
    msdArmGateEnforced,
    msd: config.msd,
    screenshot: config.screenshot,
    ocr,
  });
  if (ocrUsesKvmdProbe(ocr, [])) startOcrProbes([{ name: 'default', client: pikvm }]);
}

const started = process.argv[2] === 'pin'
  ? pinCommand(process.argv.slice(3))
  : main();

started.catch((error) => {
  const text = error instanceof Error ? inspect(error) : String(error);
  console.error('Fatal error:', redactUrl(text));
  process.exit(1);
});
