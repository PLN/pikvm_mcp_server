// Modified 2026-10 by PLN: hardware suite tool session (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: password via resolveSecret (GPL-3.0; see NOTICE).

/**
 * In-process MCP HTTP session aimed at one PiKVMClient.
 * The hardware files use openHardwareSession(), which accepts only
 * the legacy device name "default" and the PIKVM_HOST credentials.
 * The mock dry run uses openToolSession() and never reads those variables.
 */

import { randomBytes } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import { loadConfig } from '../../dist/config.js';
import { startHttpServer } from '../../dist/http.js';
import { BusyLock } from '../../dist/pikvm/lock.js';
import { PiKVMClient } from '../../dist/pikvm/client.js';
import { redactSecrets } from '../../dist/redact.js';
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

export async function openToolSession({ pikvm, msd, armHid, armMsd, calibration }) {
  const token = randomBytes(24).toString('hex');
  const httpServer = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    bearerToken: token,
    createServer: () => createMcpServer({
      pikvm,
      lock: new BusyLock(),
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
        throw new Error(`${name}: ${JSON.stringify(body)}`);
      }
      return body.result;
    },
    async close() {
      await new Promise((resolve) => httpServer.close(resolve));
      pikvm.close();
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
    armHid: process.env.PIKVM_MCP_ARM_HID === '1',
    armMsd: process.env.PIKVM_MCP_ARM_MSD === '1',
    calibration: config.calibration,
  });
  return { ...session, config, pikvm: resolved.client, device: resolved.name };
}

export function redactForLog(value, secret) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return redactSecrets(text, secret);
}

/** One GET. Does not use the client's retry loop. */
export async function kvmdGet(pikvmConfig, pathAndQuery) {
  const agent = new Agent({
    connect: { rejectUnauthorized: pikvmConfig.verifySsl },
    headersTimeout: pikvmConfig.requestTimeoutMs,
    bodyTimeout: pikvmConfig.requestTimeoutMs,
  });
  try {
    const url = new URL(pathAndQuery, pikvmConfig.host);
    const response = await undiciFetch(url, {
      method: 'GET',
      headers: {
        'X-KVMD-User': pikvmConfig.username,
        'X-KVMD-Passwd': pikvmConfig.password,
      },
      dispatcher: agent,
      signal: AbortSignal.timeout(pikvmConfig.requestTimeoutMs),
    });
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    await agent.close();
  }
}
