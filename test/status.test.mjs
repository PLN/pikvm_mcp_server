// Modified 2026-10 by PLN: pikvm_status verdicts, timers and keep-awake state (GPL-3.0; see NOTICE).

/**
 * pikvm_status is read-only. It reports each device's situation from
 * kvmd's streamer, HID and inactivity reads, and this server's own state.
 * The situations mirror three real PiKVMs: one ready, one with its display
 * asleep (USB online), one unplugged (USB offline). No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../dist/config.js';
import { buildFleet, closeFleet } from '../dist/devices.js';
import { startHttpServer } from '../dist/http.js';
import { setKeepAwakeTimingForTests } from '../dist/pikvm/client.js';
import { createMcpServer } from '../dist/server.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';
const ENV_KEYS = [
  'PIKVM_HOST', 'PIKVM_USERNAME', 'PIKVM_PASSWORD', 'PIKVM_PASSWORD_FILE', 'PIKVM_TLS_MODE', 'PIKVM_VERIFY_SSL',
  'PIKVM_DEVICES', 'PIKVM_DEVICES_FILE', 'PIKVM_MCP_PORT', 'PIKVM_MCP_BEARER', 'PIKVM_SCREENSHOT_MAX_WIDTH',
  'PIKVM_SCREENSHOT_MAX_HEIGHT', 'PIKVM_SCREENSHOT_QUALITY', 'PIKVM_OCR_TIMEOUT_MS', 'PIKVM_OCR_ENGINE',
  'PIKVM_OCR_TESSERACT_BIN', 'PIKVM_OCR_TESSDATA_DIR', 'PIKVM_OCR_LANGS', 'PIKVM_OCR_MAX_CONCURRENCY',
  'PIKVM_OCR_MAX_PIXELS', 'PIKVM_OCR_ALLOW_FULL_FRAME', 'PIKVM_OCR_MIN_CONF', 'CREDENTIALS_DIRECTORY',
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withEnv(extra, fn) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, extra);
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function headers(id) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
    ...(id ? { 'mcp-session-id': id } : {}),
  };
}

async function session(base) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'status-test', version: '1' } },
    }),
  });
  const id = res.headers.get('mcp-session-id');
  await res.text();
  return id;
}

async function call(base, id, name, args = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(id),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
}

test('pikvm_status: verdicts, screen on-time, idle timers and keep-awake, without side effects', async () => {
  const ready = await startKvmdMock({ capture: { running: true, signal: true }, inactivitySecondMs: 10 });
  const asleep = await startKvmdMock({ capture: { running: true, signal: false } });
  const unplugged = await startKvmdMock({ capture: { running: true, signal: false }, hidOnline: false });
  const stopped = await startKvmdMock({ capture: { running: false } });
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-status-'));
  let fleet;
  let httpServer;
  try {
    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const device = (url) => ({ host: url, username: 'admin', passwordFile, tls: { mode: 'insecure' } });
    const config = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'lab1',
        devices: {
          lab1: device(ready.url),
          lab2: device(asleep.url),
          lab3: device(unplugged.url),
          lab4: device(stopped.url),
        },
      }),
    }, () => loadConfig());
    fleet = buildFleet(config, { hid: true, msd: true });
    const lab1 = fleet.devices.get('lab1').client;
    setKeepAwakeTimingForTests(lab1, { pollMs: 20, secondMs: 10 });
    httpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      bearerToken: TOKEN,
      createServer: () => createMcpServer({
        pikvm: lab1,
        lock: fleet.devices.get('lab1').lock,
        fleet,
        calibrationConfig: {},
        armGateEnforced: true,
      }),
    });
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const id = await session(base);

    const typed = await call(base, id, 'pikvm_key', { device: 'lab1', key: 'KeyA' });
    assert.notEqual(typed.isError, true, typed.content[0].text);
    const on = await call(base, id, 'pikvm_keep_awake', { device: 'lab1', enabled: true, intervalSeconds: 10, suspendSeconds: 5 });
    assert.notEqual(on.isError, true, on.content[0].text);
    // Keep-awake moves the mouse once the tool call's suspension ends.
    await sleep(400);
    assert.ok(ready.calls.some((c) => c.path === '/api/hid/events/send_mouse_move'));

    const status = await call(base, id, 'pikvm_status');
    assert.notEqual(status.isError, true, status.content[0].text);
    const byName = Object.fromEntries(status.structuredContent.devices.map((d) => [d.device, d]));
    assert.deepEqual(Object.keys(byName), ['lab1', 'lab2', 'lab3', 'lab4']);

    const one = byName.lab1;
    assert.equal(one.verdict, 'ready');
    assert.deepEqual(one.picture, { state: 'visible', width: 1920, height: 1080 });
    assert.equal(one.screen.state, 'on');
    assert.equal(one.input.mouse, 'absolute');
    assert.notEqual(one.idle.lastToolKeyboardInput, null, 'the key from pikvm_key');
    assert.equal(one.idle.lastToolMouseInput, null, 'keep-awake moves are not tool input');
    assert.equal(typeof one.idle.anyInputSeconds, 'number');
    assert.equal(one.keepAwake.enabled, true);
    assert.equal(one.keepAwake.quadrant, 'bottom-right');
    assert.ok(one.keepAwake.actions >= 1);
    assert.equal(one.keepAwake.suspendedUntil, undefined, 'a status call does not pause keep-awake');
    assert.match(status.content[0].text, /^lab1: ready\.\n {2}Screen: on, 1920x1080/);
    assert.match(status.content[0].text, /Keep-awake: on, mouse in the bottom-right quadrant/);

    assert.equal(byName.lab2.picture.state, 'display_asleep');
    assert.match(byName.lab2.verdict, /^display asleep: pikvm_screenshot with wake: true wakes it/);
    assert.equal(byName.lab3.picture.state, 'usb_offline');
    assert.match(byName.lab3.verdict, /^no computer: its USB keyboard and mouse are offline/);
    assert.equal(byName.lab4.picture.state, 'capture_stopped');
    assert.equal(byName.lab4.verdict, 'ready; capture is stopped and starts on the next screenshot');
    assert.equal(stopped.wsEvents.length, 0, 'status starts no capture');
    for (const mock of [asleep, unplugged, stopped]) {
      assert.equal(mock.calls.some((c) => c.method === 'POST' || c.path === '/api/streamer/snapshot'), false);
    }

    const single = await call(base, id, 'pikvm_status', { device: 'lab2' });
    assert.deepEqual(single.structuredContent.devices.map((d) => d.device), ['lab2']);
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    if (fleet) await closeFleet(fleet);
    rmSync(dir, { recursive: true, force: true });
    for (const mock of [ready, asleep, unplugged, stopped]) await mock.close();
  }
});

test('pikvm_status reports an unreachable device without failing the others', async () => {
  const ready = await startKvmdMock();
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-status-'));
  let fleet;
  let httpServer;
  try {
    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const config = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'lab1',
        devices: {
          lab1: { host: ready.url, username: 'admin', passwordFile, tls: { mode: 'insecure' } },
          gone: { host: 'http://127.0.0.1:9', username: 'admin', passwordFile, tls: { mode: 'insecure' } },
        },
      }),
    }, () => loadConfig());
    fleet = buildFleet(config, { hid: true, msd: true });
    httpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      bearerToken: TOKEN,
      createServer: () => createMcpServer({
        pikvm: fleet.devices.get('lab1').client,
        lock: fleet.devices.get('lab1').lock,
        fleet,
        calibrationConfig: {},
        armGateEnforced: true,
      }),
    });
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const status = await call(base, await session(base), 'pikvm_status');
    const byName = Object.fromEntries(status.structuredContent.devices.map((d) => [d.device, d]));
    assert.equal(byName.gone.reachable, false);
    assert.equal(byName.gone.verdict, 'unreachable: PIKVM_UNREACHABLE');
    assert.equal(byName.lab1.verdict, 'ready');
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    if (fleet) await closeFleet(fleet);
    rmSync(dir, { recursive: true, force: true });
    await ready.close();
  }
});

test('pikvm_status: other devices\' passwords, unknown USB, a picture without USB, and rejected input', async () => {
  const leaky = await startKvmdMock({
    routes: {
      'GET /api/streamer': { status: 400, body: { ok: false, result: { error: 'MockError', error_msg: 'saw other"pw\\x here' } } },
      'GET /api/msd': { status: 500, body: { ok: false, result: { error: 'MockError', error_msg: 'msd saw other"pw\\x too' } } },
    },
  });
  const unknownUsb = await startKvmdMock({
    capture: { running: true, signal: false },
    routes: { 'GET /api/hid': { status: 500, body: { ok: false, result: { error: 'MockError', error_msg: 'hid down' } } } },
  });
  const noUsb = await startKvmdMock({ capture: { running: true, signal: true }, hidOnline: false });
  const rejecting = await startKvmdMock({
    routes: { 'POST /api/hid/events/send_key': { status: 400, body: { ok: false, result: { error: 'ValidatorError', error_msg: 'bad key' } } } },
  });
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-status-'));
  let fleet;
  let httpServer;
  try {
    const one = join(dir, 'pw1');
    const two = join(dir, 'pw2');
    writeFileSync(one, 'testpw\n', { mode: 0o600 });
    writeFileSync(two, 'other"pw\\x\n', { mode: 0o600 });
    const device = (url, passwordFile) => ({ host: url, username: 'admin', passwordFile, tls: { mode: 'insecure' } });
    const config = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'leaky',
        devices: {
          leaky: device(leaky.url, one),
          other: device(rejecting.url, two),
          dark: device(unknownUsb.url, one),
          nousb: device(noUsb.url, one),
        },
      }),
    }, () => loadConfig());
    fleet = buildFleet(config, { hid: true, msd: true });
    httpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      bearerToken: TOKEN,
      createServer: () => createMcpServer({
        pikvm: fleet.devices.get('leaky').client,
        lock: fleet.devices.get('leaky').lock,
        fleet,
        calibrationConfig: {},
        armGateEnforced: true,
      }),
    });
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const id = await session(base);
    const refused = await call(base, id, 'pikvm_key', { device: 'other', key: 'NoSuchKey' });
    assert.equal(refused.isError, true);
    // Refused locally, above the 50 s print ceiling: nothing is sent.
    const tooLong = await call(base, id, 'pikvm_type', { device: 'other', text: 'a'.repeat(400), slow: true });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.content[0].text, /Refusing \/hid\/print/);
    assert.equal(rejecting.calls.some((c) => c.path === '/api/hid/print'), false);

    const status = await call(base, id, 'pikvm_status');
    const whole = JSON.stringify(status);
    assert.equal(whole.includes('other\\"pw'), false, 'escaped password in the JSON');
    assert.equal(status.content[0].text.includes('other"pw'), false, 'password in the prose');
    const byName = Object.fromEntries(status.structuredContent.devices.map((d) => [d.device, d]));
    assert.equal(byName.leaky.reachable, false);
    assert.equal(byName.dark.picture.state, 'no_signal');
    assert.equal(byName.dark.verdict, 'no picture, and the USB state could not be read');
    assert.equal(byName.nousb.picture.state, 'visible');
    assert.match(byName.nousb.verdict, /^picture visible, but its USB keyboard and mouse are offline/);
    assert.equal(byName.other.idle.lastToolKeyboardInput, null, 'a rejected key is not input');
  } finally {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    if (fleet) await closeFleet(fleet);
    rmSync(dir, { recursive: true, force: true });
    for (const mock of [leaky, unknownUsb, noUsb, rejecting]) await mock.close();
  }
});
