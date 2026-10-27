// Modified 2026-10 by PLN: KvmdError, timeout, and GET retry tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: connect timeout and DNS unreachable tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_type delay is milliseconds (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: header and body timeouts stay timeouts (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a reply cut short after Connection: close (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: capture state is read before the snapshot (GPL-3.0; see NOTICE).

/**
 * KvmdError, request timeout, and bounded GET retry.
 * In-process MCP server against the mock. No real PiKVM is contacted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { MockAgent } from 'undici';
import { KvmdError, PiKVMClient, setDispatcherForTests, setHidDeadlineScaleForTests } from '../dist/pikvm/client.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';
const calibrationConfig = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };

function kvmdBody(error, errorMsg) {
  return { ok: false, result: { error, error_msg: errorMsg } };
}

function depsFactory(mock, armGateEnforced, options = {}) {
  const pikvm = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: options.password ?? 'testpw',
    verifySsl: false,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  if (options.deadlineScale !== undefined) {
    setHidDeadlineScaleForTests(pikvm, options.deadlineScale);
  }
  return () => createMcpServer({
    pikvm,
    lock: new BusyLock(),
    calibrationConfig,
    armGateEnforced,
  });
}

async function startServer(mock, armGateEnforced, options) {
  const httpServer = await startHttpServer({
    port: 0,
    bearerToken: TOKEN,
    createServer: depsFactory(mock, armGateEnforced, options),
  });
  const { port } = httpServer.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

function rpcHeaders(sessionId) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${TOKEN}`,
    'mcp-session-id': sessionId,
  };
}

async function rpc(base, sessionId, method, params) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: sessionId
      ? rpcHeaders(sessionId)
      : {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${TOKEN}`,
        },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function openSession(base) {
  const res = await rpc(base, undefined, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'errors-test', version: '1.0' },
  });
  const body = await res.json();
  assert.equal(res.status, 200, `initialize failed: ${JSON.stringify(body)}`);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize response must set mcp-session-id');
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(base, sessionId, name, args = {}) {
  const res = await rpc(base, sessionId, 'tools/call', { name, arguments: args });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.result;
}

function parseKvmdToolError(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  const text = result.content[0].text;
  const jsonLine = text.split('\n').at(-1);
  const details = JSON.parse(jsonLine);
  return { text, details };
}

function count(mock, method, path) {
  return mock.calls.filter((c) => c.method === method && c.path === path).length;
}

function clientOptions(value) {
  if (typeof value === 'number') return { requestTimeoutMs: value };
  return value ?? {};
}

async function withSession(routes, armGateEnforced, fn, options) {
  const mock = await startKvmdMock({ routes });
  const srv = await startServer(mock, armGateEnforced, clientOptions(options));
  try {
    const sessionId = await openSession(srv.base);
    await fn({ mock, srv, sessionId });
  } finally {
    await srv.close();
    await mock.close();
  }
}

test('kvmd error type and status pass through on a GET, and 400 is not retried', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 400,
      body: kvmdBody('MsdConnectedError', 'drive is connected'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { text, details } = parseKvmdToolError(result);
    assert.equal(text.split('\n')[0], 'Error [MsdConnectedError] GET /api/streamer (HTTP 400): drive is connected');
    assert.deepEqual(details, {
      status: 400,
      type: 'MsdConnectedError',
      message: 'drive is connected',
      endpoint: 'GET /api/streamer',
    });
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('kvmd error type and status pass through on a POST, and 409 is not retried', async () => {
  await withSession({
    'POST /api/hid/events/send_key': {
      status: 409,
      body: kvmdBody('MsdIsBusyError', 'msd is busy'),
    },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
    const { details } = parseKvmdToolError(result);
    assert.deepEqual(details, {
      status: 409,
      type: 'MsdIsBusyError',
      message: 'msd is busy',
      endpoint: 'POST /api/hid/events/send_key',
    });
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  });
});

test('HTTP 401 maps to PIKVM_AUTH_FAILED, keeps error_msg, and is not retried', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 401,
      body: kvmdBody('UnauthorizedError', 'bad login'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.deepEqual(details, {
      status: 401,
      type: 'PIKVM_AUTH_FAILED',
      message: 'bad login',
      endpoint: 'GET /api/streamer',
    });
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('HTTP 403 maps to PIKVM_AUTH_FAILED and is not retried', async () => {
  await withSession({
    'POST /api/hid/events/send_key': {
      status: 403,
      body: kvmdBody('ForbiddenError', 'not allowed'),
    },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_AUTH_FAILED');
    assert.equal(details.status, 403);
    assert.equal(details.message, 'not allowed');
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  });
});

test('a failing idempotent GET is attempted 3 times on HTTP 503', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 503,
      body: kvmdBody('UnavailableError', 'streamer down'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const started = Date.now();
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const elapsed = Date.now() - started;
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'UnavailableError');
    assert.equal(details.status, 503);
    assert.equal(details.message, 'streamer down');
    assert.equal(count(mock, 'GET', '/api/streamer'), 3);
    assert.ok(elapsed >= 600, `GET retry backoff too short: ${elapsed}ms`);
  });
});

test('a GET HTTP 502 succeeds on the third attempt', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 502,
      body: kvmdBody('BadGateway', 'proxy'),
      failTimes: 2,
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.match(result.content[0].text, /1920x1080/);
    assert.equal(count(mock, 'GET', '/api/streamer'), 3);
  });
});

test('POST HTTP 502 is not retried', async () => {
  await withSession({
    'POST /api/hid/events/send_key': {
      status: 502,
      body: kvmdBody('BadGateway', 'proxy'),
    },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.status, 502);
    assert.equal(details.type, 'BadGateway');
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  });
});

test('POST HTTP 503 is not retried', async () => {
  await withSession({
    'POST /api/hid/print': {
      status: 503,
      body: kvmdBody('UnavailableError', 'busy'),
    },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_type', { text: 'hi' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.status, 503);
    assert.equal(details.endpoint, 'POST /api/hid/print');
    assert.equal(count(mock, 'POST', '/api/hid/print'), 1);
  });
});

test('a dropped GET maps to PIKVM_UNREACHABLE and is attempted 3 times', async () => {
  await withSession({
    'GET /api/streamer': { drop: true },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.deepEqual(details, {
      status: 0,
      type: 'PIKVM_UNREACHABLE',
      message: 'kvmd network error',
      endpoint: 'GET /api/streamer',
    });
    assert.equal(count(mock, 'GET', '/api/streamer'), 3);
  });
});

test('a dropped HID POST maps to PIKVM_HID_STATE_UNKNOWN and is not retried', async () => {
  await withSession({
    'POST /api/hid/events/send_key': { drop: true },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_HID_STATE_UNKNOWN');
    assert.equal(details.message, 'input may still be applying; do not resend');
    assert.equal(details.status, 0);
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  });
});

test('a slow GET maps to PIKVM_TIMEOUT and is attempted 3 times', { timeout: 20000 }, async () => {
  await withSession({
    'GET /api/streamer': { delayMs: 30000, status: 200, body: { ok: true } },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_TIMEOUT');
    assert.equal(details.status, 0);
    assert.equal(details.message, 'kvmd request timed out');
    assert.equal(details.endpoint, 'GET /api/streamer');
    assert.equal(count(mock, 'GET', '/api/streamer'), 3);
  }, 200);
});

test('snapshot HTTP 503 is retried once after the grace period and can succeed', { timeout: 20000 }, async () => {
  await withSession({
    'GET /api/streamer/snapshot': {
      status: 503,
      body: kvmdBody('UnavailableError', 'streamer starting'),
      failTimes: 1,
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_screenshot', { maxWidth: 320 });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const snaps = mock.calls.filter((c) => c.path === '/api/streamer/snapshot');
    assert.equal(snaps.length, 2);
    assert.ok(snaps[1].at - snaps[0].at >= 1200, `snapshot grace too short: ${snaps[1].at - snaps[0].at}ms`);
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('persistent snapshot HTTP 503 stops after one grace retry', { timeout: 20000 }, async () => {
  await withSession({
    'GET /api/streamer/snapshot': {
      status: 503,
      body: kvmdBody('UnavailableError', 'streamer starting'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_screenshot');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'UnavailableError');
    assert.equal(details.status, 503);
    assert.equal(details.endpoint, 'GET /api/streamer/snapshot');
    const snaps = mock.calls.filter((c) => c.path === '/api/streamer/snapshot');
    assert.equal(snaps.length, 2);
    const gap = snaps[1].at - snaps[0].at;
    assert.ok(gap >= 1200, `snapshot grace too short: ${gap}ms`);
    // The capture state read comes first; capture runs, so 503 is transient.
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('POST /hid/print slower than the request timeout succeeds once', { timeout: 20000 }, async () => {
  await withSession({
    'POST /api/hid/print': { delayMs: 400, status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_type', { text: 'hello', slow: true });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.match(result.content[0].text, /Typed 5 character/);
    assert.equal(count(mock, 'POST', '/api/hid/print'), 1);
  }, 100);
});

test('POST /hid/events/send_key slower than the request timeout succeeds once', { timeout: 20000 }, async () => {
  await withSession({
    'POST /api/hid/events/send_key': { delayMs: 400, status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const key = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
    assert.equal(key.isError, undefined, JSON.stringify(key));
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  }, 100);
});

test('HTTP 500 is not retried', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 500,
      body: kvmdBody('InternalError', 'kvmd failed'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.status, 500);
    assert.equal(details.type, 'InternalError');
    assert.equal(details.message, 'kvmd failed');
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('HTTP 504 is not retried', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 504,
      body: kvmdBody('GatewayTimeout', 'upstream late'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.status, 504);
    assert.equal(details.type, 'GatewayTimeout');
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('a non-JSON error body falls back to PIKVM_HTTP_ERROR', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 500,
      body: '<html>plain failure</html>',
      contentType: 'text/html',
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_HTTP_ERROR');
    assert.equal(details.status, 500);
    assert.match(details.message, /plain failure/);
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('a body reset on GET maps to PIKVM_UNREACHABLE and is attempted 3 times', async () => {
  await withSession({
    'GET /api/streamer': { resetAfterHeaders: true },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_UNREACHABLE');
    assert.equal(details.status, 0);
    assert.equal(count(mock, 'GET', '/api/streamer'), 3);
  });
});

test('a body reset on a HID POST maps to PIKVM_HID_STATE_UNKNOWN and is not retried', async () => {
  await withSession({
    'POST /api/hid/events/send_key': { resetAfterHeaders: true },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_HID_STATE_UNKNOWN');
    assert.equal(details.message, 'input may still be applying; do not resend');
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  });
});

test('a HID reply cut short after Connection: close maps to PIKVM_HID_STATE_UNKNOWN and is not retried', async () => {
  for (const truncateBody of ['length', 'chunked']) {
    await withSession({
      'POST /api/hid/events/send_key': { truncateBody },
    }, false, async ({ mock, srv, sessionId }) => {
      const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'KeyA' });
      const { details } = parseKvmdToolError(result);
      assert.equal(details.type, 'PIKVM_HID_STATE_UNKNOWN', truncateBody);
      assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
    });
  }
});

test('a HID POST refused at connect stays PIKVM_UNREACHABLE and is not retried', async () => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const pikvm = new PiKVMClient({
    host: `http://127.0.0.1:${port}`,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
  });
  const started = Date.now();
  await assert.rejects(() => pikvm.sendKey('KeyA'), (err) => {
    assert.ok(err instanceof KvmdError);
    assert.equal(err.type, 'PIKVM_UNREACHABLE');
    assert.equal(err.message, 'kvmd network error');
    return true;
  });
  assert.ok(Date.now() - started < 250, 'connect refusal must not wait out a retry backoff');
});

test('a slow body on GET maps to PIKVM_TIMEOUT and is attempted 3 times', { timeout: 20000 }, async () => {
  await withSession({
    'GET /api/streamer': {
      delayAfterHeaders: true,
      delayMs: 30000,
      status: 200,
      body: { ok: true, result: { streamer: { source: { resolution: { width: 1, height: 1 } } } } },
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_TIMEOUT');
    assert.equal(details.message, 'kvmd request timed out');
    assert.equal(count(mock, 'GET', '/api/streamer'), 3);
  }, 200);
});

test('requestTimeoutMs 0 falls back to 5000, so a short GET succeeds', async () => {
  await withSession({
    'GET /api/streamer': {
      delayMs: 200,
      status: 200,
      body: {
        ok: true,
        result: { streamer: { source: { resolution: { width: 1920, height: 1080 } } } },
      },
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /1920x1080/);
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  }, 0);
});

test('snapshot timeouts use the 3-attempt schedule', { timeout: 20000 }, async () => {
  await withSession({
    'GET /api/streamer/snapshot': { delayMs: 30000, status: 503, body: kvmdBody('UnavailableError', 'late') },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_screenshot');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_TIMEOUT');
    assert.equal(count(mock, 'GET', '/api/streamer/snapshot'), 3);
  }, 150);
});

test('snapshot 503 plus later timeouts stops at 4 attempts', { timeout: 20000 }, async () => {
  await withSession({
    'GET /api/streamer/snapshot': {
      status: 503,
      body: kvmdBody('UnavailableError', 'streamer starting'),
      failTimes: 1,
      then: { delayMs: 30000, status: 200, body: '' },
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_screenshot');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_TIMEOUT');
    const snaps = mock.calls.filter((c) => c.path === '/api/streamer/snapshot');
    assert.equal(snaps.length, 4);
    assert.ok(snaps[1].at - snaps[0].at >= 1200, `grace gap ${snaps[1].at - snaps[0].at}ms`);
  }, 150);
});

test('tool results redact the configured password and password forms', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 400,
      body: kvmdBody(
        'ValidatorError',
        'saw testpw then password: testpw and {"password":"testpw"}',
      ),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { text, details } = parseKvmdToolError(result);
    assert.doesNotMatch(text, /testpw/);
    assert.match(details.message, /\[REDACTED\]/);
    assert.match(details.message, /"password":"\[REDACTED\]"/);
    assert.equal(count(mock, 'GET', '/api/streamer'), 1);
  });
});

test('kvmd error type and error_msg are capped at 1024 characters', async () => {
  const big = 'A'.repeat(1500);
  await withSession({
    'GET /api/streamer': {
      status: 400,
      body: kvmdBody(big, big),
    },
  }, true, async ({ srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type.length, 1024);
    assert.equal(details.message.length, 1024);
    assert.equal(details.type, 'A'.repeat(1024));
    assert.equal(details.message, 'A'.repeat(1024));
  });
});

test('tool results redact secrets and omit the query string', async () => {
  await withSession({
    'GET /api/streamer/snapshot': {
      status: 400,
      body: kvmdBody('ValidatorError', 'rejected password=s3cret and X-KVMD-Passwd=hunter2'),
    },
  }, true, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_screenshot', { maxWidth: 320 });
    const { text, details } = parseKvmdToolError(result);
    assert.equal(details.endpoint, 'GET /api/streamer/snapshot');
    assert.equal(details.status, 400);
    assert.equal(details.type, 'ValidatorError');
    assert.doesNotMatch(text, /s3cret/);
    assert.doesNotMatch(text, /hunter2/);
    assert.doesNotMatch(text, /preview/);
    assert.match(text, /password=\[REDACTED\]/);
    assert.match(text, /X-KVMD-Passwd=\[REDACTED\]/);
    assert.equal(count(mock, 'GET', '/api/streamer/snapshot'), 1);
  });
});

test('a password shorter than 4 characters does not mangle ordinary text', async () => {
  await withSession({
    'GET /api/streamer': {
      status: 400,
      body: kvmdBody('ValidatorError', 'the category field stayed intact'),
    },
  }, true, async ({ srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
    const { text, details } = parseKvmdToolError(result);
    assert.equal(details.message, 'the category field stayed intact');
    assert.match(text, /category/);
    assert.doesNotMatch(text, /\[REDACTED\]/);
  }, { password: 'cat' });
});

const HID_UNKNOWN = 'input may still be applying; do not resend';

test('POST /hid/print ceiling expiry is PIKVM_HID_STATE_UNKNOWN and is sent once', async () => {
  // Scale 0.01 turns the 10s minimum print ceiling into 100ms.
  await withSession({
    'POST /api/hid/print': { delayMs: 400, status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_type', { text: 'hi' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_HID_STATE_UNKNOWN');
    assert.equal(details.message, HID_UNKNOWN);
    assert.equal(details.status, 0);
    assert.equal(count(mock, 'POST', '/api/hid/print'), 1);
  }, { deadlineScale: 0.01 });
});

test('other HID POSTs finish inside a scaled 30s ceiling', async () => {
  // Scale 0.1 turns 30s into 3s. A 200ms response is 15× under that.
  await withSession({
    'POST /api/hid/events/send_key': { delayMs: 200, status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'Enter' });
    assert.equal(result.isError, undefined);
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  }, { deadlineScale: 0.1 });
});

test('other HID POST ceiling expiry is PIKVM_HID_STATE_UNKNOWN and is sent once', async () => {
  // Scale 0.01 turns 30s into 300ms. 1200ms is 4× over that.
  await withSession({
    'POST /api/hid/events/send_key': { delayMs: 1200, status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_key', { key: 'Enter' });
    const { details } = parseKvmdToolError(result);
    assert.equal(details.type, 'PIKVM_HID_STATE_UNKNOWN');
    assert.equal(details.message, HID_UNKNOWN);
    assert.equal(count(mock, 'POST', '/api/hid/events/send_key'), 1);
  }, { deadlineScale: 0.01 });
});

test('a print whose ceiling is above 50s is refused with zero kvmd calls', async () => {
  // delay 200 is 0.2s per event. 33 characters estimate 50.2s.
  await withSession({
    'POST /api/hid/print': { status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_type', {
      text: 'a'.repeat(33),
      delay: 200,
    });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /Shorten the text/);
    assert.match(text, /lower the delay/);
    assert.equal(mock.calls.length, 0);
  });
});

test('pikvm_type sends delay 0, 50, and 200 as seconds', async () => {
  await withSession({
    'POST /api/hid/print': { status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    for (const [delay, sent] of [[0, '0'], [50, '0.05'], [200, '0.2']]) {
      mock.calls.length = 0;
      const result = await callTool(srv.base, sessionId, 'pikvm_type', {
        text: 'ab',
        delay,
      });
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      const call = mock.calls.find((item) => item.path === '/api/hid/print');
      assert.equal(new URLSearchParams(call.query).get('delay'), sent);
    }
  });
});

test('32 characters at delay 200 stay under the ceiling and send 0.2', async () => {
  await withSession({
    'POST /api/hid/print': { status: 204, body: '' },
  }, false, async ({ mock, srv, sessionId }) => {
    const result = await callTool(srv.base, sessionId, 'pikvm_type', {
      text: 'a'.repeat(32),
      delay: 200,
    });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    const call = mock.calls.find((item) => item.path === '/api/hid/print');
    assert.equal(new URLSearchParams(call.query).get('delay'), '0.2');
    assert.equal(mock.calls.filter((item) => item.path === '/api/hid/print').length, 1);
  });
});

function coded(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * undici fetch rejects with TypeError 'fetch failed' and the code on
 * `cause`. undici request() rejects the dispatcher error itself, so the
 * code is on that error. Both shapes are covered below.
 */
async function withDispatchError(error, method, run) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const origin = 'http://127.0.0.1:40123';
  const pool = agent.get(origin);
  let hits = 0;
  pool.intercept({
    path: () => {
      hits += 1;
      return true;
    },
    method,
  }).replyWithError(error).persist();
  const pikvm = new PiKVMClient({
    host: origin,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
    requestTimeoutMs: 1000,
  });
  setDispatcherForTests(pikvm, agent);
  try {
    await run(pikvm, () => hits);
  } finally {
    await agent.close();
  }
}

async function withCodedDispatch(code, method, run) {
  const error = code === 'UND_ERR_CONNECT_TIMEOUT'
    ? Object.assign(new Error('wrapped'), { cause: coded('Connect Timeout Error', code) })
    : coded(code, code);
  await withDispatchError(error, method, run);
}

function assertUnreachable(err) {
  assert.ok(err instanceof KvmdError);
  assert.equal(err.type, 'PIKVM_UNREACHABLE');
  assert.notEqual(err.type, 'PIKVM_TIMEOUT');
  assert.equal(err.message, 'kvmd network error');
  return true;
}

test('UND_ERR_CONNECT_TIMEOUT is unreachable and a GET is tried 3 times', async () => {
  await withCodedDispatch('UND_ERR_CONNECT_TIMEOUT', 'GET', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.getResolution(true), assertUnreachable);
    assert.equal(hits(), 3);
  });
  await withCodedDispatch('UND_ERR_CONNECT_TIMEOUT', 'POST', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.sendKey('KeyA'), (err) => {
      assert.ok(err instanceof KvmdError);
      assert.equal(err.type, 'PIKVM_UNREACHABLE');
      assert.notEqual(err.type, 'PIKVM_HID_STATE_UNKNOWN');
      return true;
    });
    assert.equal(hits(), 1);
  });
});

test('ENOTFOUND is unreachable and a GET is tried 3 times', async () => {
  await withCodedDispatch('ENOTFOUND', 'GET', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.getResolution(true), assertUnreachable);
    assert.equal(hits(), 3);
  });
  await withCodedDispatch('ENOTFOUND', 'POST', async (pikvm, hits) => {
    await assert.rejects(
      () => pikvm.msdWrite('disk.img', Readable.from(Buffer.from('abcd')), 4),
      assertUnreachable,
    );
    assert.equal(hits(), 1);
  });
});

function assertTimeout(err) {
  assert.ok(err instanceof KvmdError);
  assert.equal(err.type, 'PIKVM_TIMEOUT');
  assert.notEqual(err.type, 'PIKVM_UNREACHABLE');
  assert.equal(err.message, 'kvmd request timed out');
  return true;
}

test('header and body timeouts stay PIKVM_TIMEOUT', async () => {
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    await withCodedDispatch(code, 'GET', async (pikvm, hits) => {
      await assert.rejects(() => pikvm.getResolution(true), assertTimeout);
      assert.equal(hits(), 3);
    });
  }
});

test('a connect timeout nested under TimeoutError stays unreachable', async () => {
  const nested = () => Object.assign(new Error('The operation was aborted due to timeout'), {
    name: 'TimeoutError',
    cause: coded('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'),
  });
  await withDispatchError(nested(), 'GET', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.getResolution(true), assertUnreachable);
    assert.equal(hits(), 3);
  });
  await withDispatchError(nested(), 'POST', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.sendKey('KeyA'), (err) => {
      assert.ok(err instanceof KvmdError);
      assert.equal(err.type, 'PIKVM_UNREACHABLE');
      assert.notEqual(err.type, 'PIKVM_HID_STATE_UNKNOWN');
      assert.notEqual(err.type, 'PIKVM_TIMEOUT');
      return true;
    });
    assert.equal(hits(), 1);
  });
  await withDispatchError(nested(), 'POST', async (pikvm, hits) => {
    await assert.rejects(
      () => pikvm.msdWrite('disk.img', Readable.from(Buffer.from('abcd')), 4),
      assertUnreachable,
    );
    assert.equal(hits(), 1);
  });
});

test('EAI_AGAIN is unreachable, a GET is tried 3 times, and a HID POST is not', async () => {
  await withCodedDispatch('EAI_AGAIN', 'GET', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.getResolution(true), assertUnreachable);
    assert.equal(hits(), 3);
  });
  await withCodedDispatch('EAI_AGAIN', 'POST', async (pikvm, hits) => {
    await assert.rejects(() => pikvm.sendKey('KeyA'), assertUnreachable);
    assert.equal(hits(), 1);
  });
});
