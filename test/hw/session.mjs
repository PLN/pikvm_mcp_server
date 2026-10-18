// Modified 2026-10 by PLN: hardware suite tool session (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: password via resolveSecret (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: TLS dispatcher shared with the client (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: kvmd GET does not follow redirects (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hardware session uses the registry device (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hardware logs go through redactUrl (GPL-3.0; see NOTICE).

/**
 * In-process MCP HTTP session aimed at one PiKVMClient.
 * openHardwareSession() uses the legacy default device, or a registry
 * device named by PIKVM_HW_TEST_DEVICE when that device has hwTest.
 * The mock dry run uses openToolSession() and never reads those variables.
 */

import { randomBytes } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { loadConfig } from '../../dist/config.js';
import { buildFleet } from '../../dist/devices.js';
import { createKvmdAgent } from '../../dist/tls.js';
import { startHttpServer } from '../../dist/http.js';
import { BusyLock } from '../../dist/pikvm/lock.js';
import { PiKVMClient, unexpectedRedirectMessage } from '../../dist/pikvm/client.js';
import { redactSecrets } from '../../dist/redact.js';
import { redactUrl } from '../../dist/url-policy.js';
import { createMcpServer } from '../../dist/server.js';
import { resolveDevice } from '../../dist/msd.js';
import { hwDeviceRequest } from './gate.mjs';

const CALIBRATION = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };

function rpcHeaders(token, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

async function rpc(base, token, { sessionId, method, params }) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function openSession(base, token) {
  const res = await rpc(base, token, {
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hw-suite', version: '1.0' },
    },
  });
  const body = await res.json();
  if (res.status !== 200) {
    throw new Error(`initialize failed: ${JSON.stringify(body)}`);
  }
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('initialize response has no mcp-session-id');
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

export async function openToolSession({ pikvm, msd, armHid, armMsd, calibration, fleet }) {
  const token = randomBytes(24).toString('hex');
  const lock = fleet ? fleet.devices.get(fleet.defaultName).lock : new BusyLock();
  const httpServer = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    bearerToken: token,
    createServer: () => createMcpServer({
      pikvm,
      lock,
      fleet,
      calibrationConfig: calibration ?? CALIBRATION,
      armGateEnforced: armHid !== true,
      msdArmGateEnforced: armMsd !== true,
      msd,
    }),
  });
  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const sessionId = await openSession(base, token);
  return {
    async call(name, args) {
      const res = await rpc(base, token, {
        sessionId,
        method: 'tools/call',
        params: { name, arguments: args },
      });
      const body = await res.json();
      if (res.status !== 200) {
        throw new Error(redactUrl(`${name}: ${JSON.stringify(body)}`));
      }
      return body.result;
    },
    async close() {
      await new Promise((resolve) => httpServer.close(resolve));
      await pikvm.close();
    },
  };
}

export async function openHardwareSession(overrides = {}) {
  const requested = hwDeviceRequest();
  if (requested.skip) {
    throw new Error('PIKVM_HW_TEST_DEVICE is unset');
  }
  // Password and, when HTTP is configured, the bearer come from loadConfig's
  // resolveSecret, so PIKVM_PASSWORD_FILE and CREDENTIALS_DIRECTORY work here.
  const config = loadConfig();
  const ceilingHid = process.env.PIKVM_MCP_ARM_HID === '1';
  const ceilingMsd = process.env.PIKVM_MCP_ARM_MSD === '1';
  if (config.registry) {
    const fleet = buildFleet(config, { hid: ceilingHid, msd: ceilingMsd });
    const ctx = fleet.devices.get(requested.name);
    if (!ctx) {
      throw new Error(
        `PIKVM_HW_TEST_DEVICE=${JSON.stringify(requested.name)} is not in the registry`,
      );
    }
    const spec = config.registry.devices.get(requested.name);
    const session = await openToolSession({
      pikvm: ctx.client,
      fleet,
      msd: { ...config.msd, ...overrides.msd },
      armHid: ceilingHid,
      armMsd: ceilingMsd,
      calibration: config.calibration,
    });
    const deviceConfig = {
      ...config,
      pikvm: {
        ...config.pikvm,
        host: spec.host,
        username: spec.username,
        password: spec.password,
        verifySsl: spec.tls.mode === 'verify',
        tls: { default: spec.tls },
      },
    };
    return {
      ...session,
      async call(name, args) {
        return session.call(name, { ...(args ?? {}), device: ctx.name });
      },
      async close() {
        await session.close();
        for (const other of fleet.devices.values()) {
          if (other.client !== ctx.client) await other.client.close();
        }
      },
      config: deviceConfig,
      pikvm: ctx.client,
      device: ctx.name,
      armHid: ctx.armHid,
      armMsd: ctx.armMsd,
    };
  }
  const pikvm = new PiKVMClient(config.pikvm);
  const resolved = resolveDevice({ device: requested.name }, pikvm);
  if (resolved.name !== 'default' || resolved.client !== pikvm) {
    throw new Error(
      `resolveDevice returned ${JSON.stringify(resolved.name)}; only the legacy default device is supported`,
    );
  }
  const session = await openToolSession({
    pikvm: resolved.client,
    msd: { ...config.msd, ...overrides.msd },
    armHid: ceilingHid,
    armMsd: ceilingMsd,
    calibration: config.calibration,
  });
  return {
    ...session,
    config,
    pikvm: resolved.client,
    device: resolved.name,
    armHid: ceilingHid,
    armMsd: ceilingMsd,
  };
}

export function redactForLog(value, secret) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return redactUrl(redactSecrets(text, secret));
}

/** One GET. Does not use the client's retry loop. Uses the same TLS agent as PiKVMClient. */
export async function kvmdGet(pikvmConfig, pathAndQuery) {
  const agent = createKvmdAgent(pikvmConfig, {
    headersTimeout: pikvmConfig.requestTimeoutMs,
    bodyTimeout: pikvmConfig.requestTimeoutMs,
  });
  try {
    const url = new URL(pathAndQuery, pikvmConfig.host);
    let response;
    try {
      response = await undiciFetch(url, {
        method: 'GET',
        headers: {
          'X-KVMD-User': pikvmConfig.username,
          'X-KVMD-Passwd': pikvmConfig.password,
        },
        dispatcher: agent,
        signal: AbortSignal.timeout(pikvmConfig.requestTimeoutMs),
        redirect: 'manual',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'kvmd GET failed';
      throw new Error(redactUrl(message));
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try {
        await response.body?.cancel();
      } catch {
        // The redirect body is already closed.
      }
      throw new Error(redactUrl(unexpectedRedirectMessage(response.status, location, url.toString())));
    }
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    await agent.close();
  }
}
