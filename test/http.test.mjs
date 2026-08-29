/**
 * HTTP transport tests — run the server in-process against a mock KVMD.
 * No real PiKVM is contacted; PIKVM_MCP_NO_DOTENV is irrelevant here because
 * nothing reads env (deps are constructed explicitly).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';

const calibrationConfig = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };

function depsFactory(mock, armGateEnforced) {
  const pikvm = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
  });
  return () => createMcpServer({ pikvm, lock: new BusyLock(), calibrationConfig, armGateEnforced });
}

async function startServer(mock, armGateEnforced) {
  const httpServer = await startHttpServer({
    port: 0,
    bearerToken: TOKEN,
    createServer: depsFactory(mock, armGateEnforced),
  });
  const { port } = httpServer.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

function rpcHeaders(token, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    // The SDK transport requires both types on POST (else 406).
    'Accept': 'application/json, text/event-stream',
  };
  if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

async function rpc(base, { token = TOKEN, noAuth = false, sessionId, method, params }) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(noAuth ? undefined : token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

/** initialize + notifications/initialized; returns the session id. */
async function openSession(base) {
  const res = await rpc(base, {
    token: TOKEN,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'wp1-test', version: '1.0' },
    },
  });
  const body = await res.json();
  assert.equal(res.status, 200, `initialize failed: ${JSON.stringify(body)}`);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize response must set mcp-session-id');
  // Spec: client must send initialized notification before requests.
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(TOKEN, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return { sessionId, initBody: body };
}

// ============================================================================
// Auth
// ============================================================================

test('HTTP: missing bearer -> 401 with WWW-Authenticate: Bearer', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true);
  try {
    const res = await rpc(srv.base, { noAuth: true, method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /bearer/i);
    const body = await res.json();
    assert.match(body.error.message, /bearer/i);
    assert.equal(mock.calls.length, 0, 'unauthenticated request must not reach KVMD mock');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: wrong bearer -> 401', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true);
  try {
    const res = await rpc(srv.base, { token: 'wrong-token', method: 'initialize', params: {} });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /bearer/i);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: correct bearer -> initialize returns 200 + server info + session id', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true);
  try {
    const { sessionId, initBody } = await openSession(srv.base);
    assert.equal(initBody.result.serverInfo.name, 'pikvm-mcp-server');
    assert.ok(initBody.result.protocolVersion, 'protocolVersion negotiated');
    assert.ok(sessionId.length > 0);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: unknown session id -> 404', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true);
  try {
    const res = await rpc(srv.base, {
      sessionId: 'bogus-session-id',
      method: 'tools/list',
      params: {},
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: DELETE terminates the session', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true);
  try {
    const { sessionId } = await openSession(srv.base);
    const del = await fetch(`${srv.base}/mcp`, {
      method: 'DELETE',
      headers: rpcHeaders(TOKEN, sessionId),
    });
    assert.equal(del.status, 200);
    const after = await rpc(srv.base, { sessionId, method: 'tools/list', params: {} });
    assert.equal(after.status, 404, 'session must be gone after DELETE');
  } finally {
    await srv.close();
    await mock.close();
  }
});

// ============================================================================
// Arm-gate
// ============================================================================

const GATED_TOOLS = [
  ['pikvm_type', { text: 'hello' }],
  ['pikvm_key', { key: 'KeyA' }],
  ['pikvm_shortcut', { keys: ['ControlLeft', 'AltLeft', 'Delete'] }],
  ['pikvm_mouse_click', { button: 'left' }],
  ['pikvm_calibrate', {}],
  ['pikvm_auto_calibrate', {}],
];

test('HTTP: disarmed (ARM unset) -> all HID tools return typed error, mock untouched', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true); // armGateEnforced
  try {
    const { sessionId } = await openSession(srv.base);
    for (const [tool, args] of GATED_TOOLS) {
      const res = await rpc(srv.base, {
        sessionId,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      });
      assert.equal(res.status, 200, tool);
      const body = await res.json();
      assert.equal(body.result.isError, true, `${tool} must be isError when disarmed`);
      const text = body.result.content[0].text;
      assert.match(text, /arm-gate/i, tool);
      assert.match(text, /PIKVM_MCP_ARM_HID=1/, `${tool} error must name the env var`);
    }
    const hidCalls = mock.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(hidCalls, [], 'no HID requests may reach KVMD while disarmed');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: read-only tools still work while disarmed', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, true);
  try {
    const { sessionId } = await openSession(srv.base);
    const res = await rpc(srv.base, {
      sessionId,
      method: 'tools/call',
      params: { name: 'pikvm_get_resolution', arguments: {} },
    });
    const body = await res.json();
    assert.equal(body.result.isError, undefined);
    assert.match(body.result.content[0].text, /Screen resolution: 1920x1080/);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: armed (PIKVM_MCP_ARM_HID=1) -> pikvm_mouse_click dispatches to KVMD mock', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, false); // armed
  try {
    const { sessionId } = await openSession(srv.base);
    const res = await rpc(srv.base, {
      sessionId,
      method: 'tools/call',
      params: { name: 'pikvm_mouse_click', arguments: { button: 'left' } },
    });
    const body = await res.json();
    assert.equal(body.result.isError, undefined, JSON.stringify(body));
    assert.equal(body.result.content[0].text, 'left click');
    const buttons = mock.calls.filter((c) => c.path === '/api/hid/events/send_mouse_button');
    assert.equal(buttons.length, 2, 'click = press + release');
    assert.match(buttons[0].query, /button=left/);
    assert.match(buttons[0].query, /state=true/);
    assert.match(buttons[1].query, /state=false/);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('HTTP: armed click with coordinates moves first (resolution + mouse_move + click)', async () => {
  const mock = await startKvmdMock();
  const srv = await startServer(mock, false);
  try {
    const { sessionId } = await openSession(srv.base);
    const res = await rpc(srv.base, {
      sessionId,
      method: 'tools/call',
      params: { name: 'pikvm_mouse_click', arguments: { button: 'left', x: 100, y: 50 } },
    });
    const body = await res.json();
    assert.equal(body.result.isError, undefined, JSON.stringify(body));
    const paths = mock.calls.map((c) => c.path);
    assert.ok(paths.includes('/api/streamer'), 'click with coords needs resolution');
    assert.ok(paths.includes('/api/hid/events/send_mouse_move'), 'move before click');
    assert.equal(
      mock.calls.filter((c) => c.path === '/api/hid/events/send_mouse_button').length, 2);
  } finally {
    await srv.close();
    await mock.close();
  }
});
