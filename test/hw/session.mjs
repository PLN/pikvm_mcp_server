// Modified 2026-10 by PLN: hardware suite tool session (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: password via resolveSecret (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: TLS dispatcher shared with the client (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: kvmd GET does not follow redirects (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hardware session uses the registry device (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hardware logs go through redactUrl (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: probe OCR before the hardware session (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hardware session uses the resolved OCR engine (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).

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
import { redactError, redactUrl } from '../../dist/url-policy.js';
import { createMcpServer } from '../../dist/server.js';
import { ocrUsesKvmdProbe, resolveOcr } from '../../dist/ocr.js';
import { resolveDevice } from '../../dist/msd.js';
import { hwDeviceRequest } from './gate.mjs';
import { bounded, boundedFetch, closed, runBounded } from '../msd-bounds.mjs';

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

async function rpc(base, token, { sessionId, method, params, fetchTimeoutMs }) {
  const init = {
    method: 'POST',
    headers: rpcHeaders(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  };
  if (fetchTimeoutMs == null) return fetch(`${base}/mcp`, init);
  return boundedFetch(`${base}/mcp`, init, `mcp ${method}`, fetchTimeoutMs);
}

async function openSession(base, token, fetchTimeoutMs) {
  const res = await rpc(base, token, {
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hw-suite', version: '1.0' },
    },
    fetchTimeoutMs,
  });
  const body = await res.json();
  if (res.status !== 200) {
    throw new Error(`initialize failed: ${JSON.stringify(body)}`);
  }
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('initialize response has no mcp-session-id');
  const note = {
    method: 'POST',
    headers: rpcHeaders(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  };
  if (fetchTimeoutMs == null) await fetch(`${base}/mcp`, note);
  else await boundedFetch(`${base}/mcp`, note, 'mcp notifications/initialized', fetchTimeoutMs);
  return sessionId;
}

export async function openToolSession({
  pikvm, msd, armHid, armMsd, calibration, fleet, screenshot, ocr, fetchTimeoutMs,
}) {
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
      screenshot,
      ocr,
    }),
  });
  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const sessionId = await openSession(base, token, fetchTimeoutMs);
  return {
    async call(name, args) {
      const res = await rpc(base, token, {
        sessionId,
        method: 'tools/call',
        params: { name, arguments: args },
        fetchTimeoutMs,
      });
      const body = await res.json();
      if (res.status !== 200) {
        throw new Error(redactUrl(`${name}: ${JSON.stringify(body)}`));
      }
      return body.result;
    },
    async close() {
      await runBounded([
        () => closed(httpServer, 'tool session http server close'),
        () => bounded('tool session client close', pikvm.close()),
      ]);
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
  const ocr = await resolveOcr(config.ocr);
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
    if (ocrUsesKvmdProbe(ocr, fleet.devices.values())) {
      for (const device of fleet.devices.values()) {
        if (ocr.engine === 'kvmd' || device.ocr?.engine === 'kvmd') {
          await device.client.probeOcr(device.name);
        }
      }
    }
    const spec = config.registry.devices.get(requested.name);
    const session = await openToolSession({
      pikvm: ctx.client,
      fleet,
      msd: { ...config.msd, ...overrides.msd },
      armHid: ceilingHid,
      armMsd: ceilingMsd,
      calibration: config.calibration,
      screenshot: config.screenshot,
      ocr,
      fetchTimeoutMs: overrides.fetchTimeoutMs,
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
        const others = [];
        for (const other of fleet.devices.values()) {
          if (other.client !== ctx.client) others.push(other);
        }
        await runBounded([
          () => session.close(),
          ...others.map((other) => () => bounded('tool session client close', other.client.close())),
        ]);
      },
      config: deviceConfig,
      pikvm: ctx.client,
      device: ctx.name,
      armHid: ctx.armHid,
      armMsd: ctx.armMsd,
      ocr,
    };
  }
  const pikvm = new PiKVMClient(config.pikvm);
  const resolved = resolveDevice({ device: requested.name }, pikvm);
  if (resolved.name !== 'default' || resolved.client !== pikvm) {
    throw new Error(
      `resolveDevice returned ${JSON.stringify(resolved.name)}; only the legacy default device is supported`,
    );
  }
  if (ocrUsesKvmdProbe(ocr, [])) await pikvm.probeOcr(resolved.name);
  const session = await openToolSession({
    pikvm: resolved.client,
    msd: { ...config.msd, ...overrides.msd },
    armHid: ceilingHid,
    armMsd: ceilingMsd,
    calibration: config.calibration,
    screenshot: config.screenshot,
    ocr,
    fetchTimeoutMs: overrides.fetchTimeoutMs,
  });
  return {
    ...session,
    config,
    pikvm: resolved.client,
    device: resolved.name,
    armHid: ceilingHid,
    armMsd: ceilingMsd,
    ocr,
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
      throw redactError(err);
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
