// Modified 2026-10 by PLN: keep-awake modes, quadrants, suspension and resume (GPL-3.0; see NOTICE).

/**
 * pikvm_keep_awake keeps the computer awake until stopped: harmless input
 * whenever kvmd reports no input for intervalSeconds. Other tool calls
 * pause it. A configured second is 10 ms here, in the client and in the
 * mock's GET /api/hid/inactivity. No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { PiKVMClient, setKeepAwakeTimingForTests } from '../dist/pikvm/client.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';
const SECOND_MS = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, ms = 3000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(10);
  }
}
const hid = (share) => Math.round(-32768 + share * 65535);

async function withClient(mockOptions, fn) {
  const mock = await startKvmdMock({ inactivitySecondMs: SECOND_MS, ...mockOptions });
  const client = new PiKVMClient({ host: mock.url, username: 'admin', password: 'testpw', verifySsl: false });
  setKeepAwakeTimingForTests(client, { pollMs: 20, secondMs: SECOND_MS });
  try {
    await fn({ mock, client });
  } finally {
    await client.close();
    await mock.close();
  }
}

const moves = (mock) => mock.calls.filter((c) => c.path === '/api/hid/events/send_mouse_move').map((c) => {
  const q = new URLSearchParams(c.query);
  return { x: Number(q.get('to_x')), y: Number(q.get('to_y')), at: c.at };
});
const keys = (mock) => mock.calls.filter((c) => c.path === '/api/hid/events/send_key')
  .map((c) => new URLSearchParams(c.query).get('key'));
const options = (extra) => ({ mode: 'mouse', quadrant: 'bottom-right', intervalSeconds: 10, suspendSeconds: 5, ...extra });

test('mouse mode moves near the centre of the chosen quadrant, once per idle interval, until stopped', async () => {
  await withClient({}, async ({ mock, client }) => {
    client.keepAwake.start(options(), () => false);
    await waitUntil(() => moves(mock).length >= 3);
    const seen = moves(mock);
    for (const move of seen) {
      for (const value of [move.x, move.y]) {
        assert.ok(value === hid(0.74) || value === hid(0.76), `move at ${value}, not near the bottom-right centre`);
      }
    }
    assert.notEqual(seen[0].x, seen[1].x, 'the pointer alternates between two points');
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i].at - seen[i - 1].at >= 90, 'kvmd reported recent input, so no move inside the interval');
    }
    const state = client.keepAwake.stop();
    assert.equal(state.enabled, false);
    const count = moves(mock).length;
    await sleep(200);
    assert.equal(moves(mock).length, count);
  });

  await withClient({}, async ({ mock, client }) => {
    client.keepAwake.start(options({ quadrant: 'top-left' }), () => false);
    await waitUntil(() => moves(mock).length >= 1);
    const [move] = moves(mock);
    assert.ok([hid(0.24), hid(0.26)].includes(move.x) && [hid(0.24), hid(0.26)].includes(move.y));
  });
});

test('keyboard mode sends F15, mixed alternates, a relative mouse moves there and back', async () => {
  await withClient({}, async ({ mock, client }) => {
    client.keepAwake.start(options({ mode: 'keyboard' }), () => false);
    await waitUntil(() => keys(mock).length >= 1);
    assert.deepEqual(keys(mock), ['F15']);
    assert.equal(moves(mock).length, 0);

    client.keepAwake.start(options({ mode: 'mixed' }), () => false);
    await waitUntil(() => keys(mock).length >= 2 && moves(mock).length >= 1);
  });

  await withClient({ mouseAbsolute: false }, async ({ mock, client }) => {
    client.keepAwake.start(options(), () => false);
    await waitUntil(() => mock.calls.some((c) => c.path === '/api/hid/events/send_mouse_relative'));
    await sleep(50);
    const relative = mock.calls.filter((c) => c.path === '/api/hid/events/send_mouse_relative').map((c) => c.query);
    assert.deepEqual(relative, ['?delta_x=5&delta_y=5', '?delta_x=-5&delta_y=-5']);
    assert.equal(moves(mock).length, 0);
  });
});

test('held input and auto-calibration pause it', async () => {
  await withClient({}, async ({ mock, client }) => {
    await client.sendKey('ShiftLeft', { state: true });
    let calibrating = true;
    client.keepAwake.start(options(), () => calibrating);
    await sleep(150);
    assert.equal(moves(mock).length, 0);
    assert.match(client.keepAwake.state().lastSkip, /auto-calibration/);
    calibrating = false;
    await sleep(150);
    assert.equal(moves(mock).length, 0);
    assert.match(client.keepAwake.state().lastSkip, /held/);
    await client.sendKey('ShiftLeft', { state: false });
    await waitUntil(() => moves(mock).length >= 1);
  });
});

test('keep-awake input never lands inside a tool call, and a stopped run sends nothing', async () => {
  // A tool call that starts while keep-awake reads the mouse mode stops its move.
  await withClient({ routes: { 'GET /api/hid': { delayMs: 150, status: 200, body: { ok: true, result: { online: true, keyboard: { online: true }, mouse: { absolute: true, online: true } } } } } }, async ({ mock, client }) => {
    client.keepAwake.start(options(), () => false);
    await waitUntil(() => mock.calls.some((c) => c.path === '/api/hid'));
    client.keepAwake.callStarted();
    await sleep(250);
    assert.equal(moves(mock).length, 0);
    // The move would have followed the slow read; later polls then see the running call.
    assert.match(client.keepAwake.state().lastSkip, /tool call/);
    client.keepAwake.callEnded();
  });

  // Stopping while the mouse mode is read: no move afterwards, nothing counted.
  await withClient({ routes: { 'GET /api/hid': { delayMs: 150, status: 200, body: { ok: true, result: { online: true, keyboard: { online: true }, mouse: { absolute: true, online: true } } } } } }, async ({ mock, client }) => {
    client.keepAwake.start(options(), () => false);
    await waitUntil(() => mock.calls.some((c) => c.path === '/api/hid'));
    client.keepAwake.stop();
    await sleep(250);
    assert.equal(moves(mock).length, 0);
    assert.equal(client.keepAwake.state().actions, 0);
  });

  // A relative move and its way back stay together: a click that comes in between waits.
  await withClient({
    mouseAbsolute: false,
    routes: { 'POST /api/hid/events/send_mouse_relative': { delayMs: 150, status: 200, body: { ok: true, result: {} }, failTimes: 1 } },
  }, async ({ mock, client }) => {
    client.keepAwake.start(options(), () => false);
    await waitUntil(() => mock.calls.some((c) => c.path === '/api/hid/events/send_mouse_relative'));
    await client.mouseClick('left');
    const order = mock.calls
      .filter((c) => c.path === '/api/hid/events/send_mouse_relative' || c.path === '/api/hid/events/send_mouse_button')
      .map((c) => c.path.split('_').at(-1));
    assert.deepEqual(order.slice(0, 4), ['relative', 'relative', 'button', 'button']);
  });
});

test('without kvmd inactivity it acts once per interval; mixed mode still alternates the points', async () => {
  await withClient({ routes: { 'GET /api/hid/inactivity': { status: 404, body: { ok: false } } } }, async ({ mock, client }) => {
    client.keepAwake.start(options(), () => false);
    await waitUntil(() => moves(mock).length >= 3);
    const seen = moves(mock);
    for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i].at - seen[i - 1].at >= 90, 'not every poll');
    assert.match(client.keepAwake.state().lastSkip, /kvmd does not report inactivity/);
  });

  await withClient({}, async ({ mock, client }) => {
    client.keepAwake.start(options({ mode: 'mixed' }), () => false);
    await waitUntil(() => moves(mock).length >= 2, 5000);
    const [a, b] = moves(mock);
    assert.notEqual(a.x, b.x, 'mouse turns in mixed mode alternate between the two points');
  });
});

test('through the server: a toggle, paused by another tool call, then resumed; disarmed is refused', async () => {
  const mock = await startKvmdMock({ inactivitySecondMs: SECOND_MS });
  const pikvm = new PiKVMClient({ host: mock.url, username: 'admin', password: 'testpw', verifySsl: false });
  setKeepAwakeTimingForTests(pikvm, { pollMs: 20, secondMs: SECOND_MS });
  const servers = [];
  const serve = async (armGateEnforced) => {
    const httpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      bearerToken: TOKEN,
      createServer: () => createMcpServer({ pikvm, lock: new BusyLock(), calibrationConfig: {}, armGateEnforced }),
    });
    servers.push(httpServer);
    return `http://127.0.0.1:${httpServer.address().port}`;
  };
  const headers = (id) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
    ...(id ? { 'mcp-session-id': id } : {}),
  });
  const session = async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'keep-awake-test', version: '1' } },
      }),
    });
    const id = res.headers.get('mcp-session-id');
    await res.text();
    return id;
  };
  const call = async (base, id, name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers(id),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json()).result;
  };
  try {
    const base = await serve(false);
    const id = await session(base);
    const on = await call(base, id, 'pikvm_keep_awake', { enabled: true, intervalSeconds: 10, suspendSeconds: 30 });
    assert.notEqual(on.isError, true, on.content[0].text);
    assert.match(on.content[0].text, /Keep-awake is on: a small mouse move near the centre of the bottom-right quadrant/);
    assert.equal(on.structuredContent.enabled, true);
    await waitUntil(() => moves(mock).length >= 1);
    assert.equal(moves(mock).length, 1, 'long idle: one move at once');

    // Another tool call pauses it for 30 configured seconds (300 ms) after it ends.
    await call(base, id, 'pikvm_screenshot', {});
    const ended = Date.now();
    await sleep(240);
    assert.equal(moves(mock).length, 1, 'no move while suspended');
    await waitUntil(() => moves(mock).length >= 2);
    assert.equal(moves(mock).length, 2, 'resumed after the suspension');
    assert.ok(moves(mock)[1].at - ended >= 290);

    const off = await call(base, id, 'pikvm_keep_awake', { enabled: false });
    assert.match(off.content[0].text, /Keep-awake is off\. It sent 2 input/);

    const bad = await call(base, id, 'pikvm_keep_awake', { enabled: true, intervalSeconds: 5 });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /intervalSeconds must be an integer from 10 to 3600/);

    const disarmedBase = await serve(true);
    const disarmedId = await session(disarmedBase);
    const refused = await call(disarmedBase, disarmedId, 'pikvm_keep_awake', { enabled: true });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /HID arm-gate/);
    assert.equal(pikvm.keepAwake.enabled, false);
  } finally {
    for (const httpServer of servers) await new Promise((resolve) => httpServer.close(resolve));
    await pikvm.close();
    await mock.close();
  }
});
