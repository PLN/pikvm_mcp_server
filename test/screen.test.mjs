// Modified 2026-10 by PLN: screenshot defaults, crop, metadata, and OCR (GPL-3.0; see NOTICE).

/**
 * Preview defaults, local crop, coordinate metadata, and optional OCR.
 * Hosts are the mock or documentation names. No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { loadConfig } from '../dist/config.js';
import { buildFleet, closeFleet, startOcrProbes } from '../dist/devices.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { PiKVMClient, pixelToNormalized } from '../dist/pikvm/client.js';
import { limitedSharp } from '../dist/screenshot.js';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';
const calibrationConfig = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };
const SECRET = 'https://admin:SECRETPW@127.0.0.1/kvm?token=TOK';

const ENV_KEYS = [
  'PIKVM_HOST',
  'PIKVM_USERNAME',
  'PIKVM_PASSWORD',
  'PIKVM_PASSWORD_FILE',
  'PIKVM_TLS_MODE',
  'PIKVM_VERIFY_SSL',
  'PIKVM_DEVICES',
  'PIKVM_DEVICES_FILE',
  'PIKVM_MCP_PORT',
  'PIKVM_MCP_BEARER',
  'PIKVM_SCREENSHOT_MAX_WIDTH',
  'PIKVM_SCREENSHOT_MAX_HEIGHT',
  'PIKVM_SCREENSHOT_QUALITY',
  'PIKVM_OCR_TIMEOUT_MS',
  'CREDENTIALS_DIRECTORY',
];

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

function rpcHeaders(sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

async function rpc(base, sessionId, method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

async function openSession(base) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'screen-test', version: '1.0' },
      },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const id = res.headers.get('mcp-session-id');
  assert.ok(id);
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(id),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return id;
}

async function listen(factory) {
  const httpServer = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    bearerToken: TOKEN,
    createServer: factory,
  });
  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

function lastSnapshot(mock) {
  const calls = mock.calls.filter((call) => call.path === '/api/streamer/snapshot');
  assert.ok(calls.length > 0);
  return calls[calls.length - 1];
}

function metadataOf(result) {
  const text = result.content[0].text;
  const line = text.split('\n').find((item) => item.startsWith('{'));
  assert.ok(line, text);
  return JSON.parse(line);
}

function hidMoves(mock) {
  return mock.calls.filter((call) => call.path === '/api/hid/events/send_mouse_move');
}

function hidButtons(mock) {
  return mock.calls.filter((call) => call.path === '/api/hid/events/send_mouse_button');
}

function moveTarget(call) {
  const query = new URLSearchParams(call.query);
  return { x: Number(query.get('to_x')), y: Number(query.get('to_y')) };
}

function crashText(err) {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

/** Records process crashes for this test and asserts there were none. */
function watchCrashes(t) {
  const crashes = [];
  const onException = (err) => { crashes.push(err); };
  const onRejection = (err) => { crashes.push(err); };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
    assert.equal(crashes.length, 0, crashes.map(crashText).join('\n\n'));
  });
}

async function waitUntil(fn, ms = 2000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startLegacy(mock, extraEnv = {}) {
  const config = withEnv({
    PIKVM_HOST: mock.url,
    PIKVM_PASSWORD: 'testpw',
    PIKVM_TLS_MODE: 'insecure',
    ...extraEnv,
  }, () => loadConfig());
  const pikvm = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
  });
  const srv = await listen(() => createMcpServer({
    pikvm,
    lock: new BusyLock(),
    calibrationConfig,
    armGateEnforced: false,
    screenshot: config.screenshot,
  }));
  const sessionId = await openSession(srv.base);
  return {
    srv,
    sessionId,
    pikvm,
    async close() {
      await srv.close();
      await pikvm.close();
    },
  };
}

test('screenshot defaults follow env, then the registry, then the call', async () => {
  const mock = await startKvmdMock();
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-screen-'));
  try {
    const plain = await startLegacy(mock);
    try {
      const result = await rpc(plain.srv.base, plain.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      assert.notEqual(result.result.isError, true);
      assert.equal(
        lastSnapshot(mock).query,
        '?preview=1&preview_max_width=960&preview_max_height=600&preview_quality=70',
      );
    } finally {
      await plain.close();
    }

    mock.calls.length = 0;
    const fromEnv = await startLegacy(mock, {
      PIKVM_SCREENSHOT_MAX_WIDTH: '800',
      PIKVM_SCREENSHOT_MAX_HEIGHT: '500',
      PIKVM_SCREENSHOT_QUALITY: '40',
    });
    try {
      await rpc(fromEnv.srv.base, fromEnv.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      assert.equal(
        lastSnapshot(mock).query,
        '?preview=1&preview_max_width=800&preview_max_height=500&preview_quality=40',
      );
    } finally {
      await fromEnv.close();
    }

    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const config = withEnv({
      PIKVM_SCREENSHOT_MAX_WIDTH: '800',
      PIKVM_SCREENSHOT_MAX_HEIGHT: '500',
      PIKVM_SCREENSHOT_QUALITY: '40',
      PIKVM_DEVICES: JSON.stringify({
        devices: {
          lab1: {
            host: mock.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
            screenshot: { maxWidth: 400 },
          },
        },
      }),
    }, () => loadConfig());
    assert.equal(config.screenshot.maxWidth, 800);
    assert.equal(config.registry.devices.get('lab1').screenshot.maxWidth, 400);
    assert.equal(config.registry.devices.get('lab1').screenshot.maxHeight, 500);
    assert.equal(config.registry.devices.get('lab1').screenshot.quality, 40);
    const fleet = buildFleet(config, { hid: true, msd: true });
    const lab1 = fleet.devices.get('lab1');
    mock.calls.length = 0;
    const srv = await listen(() => createMcpServer({
      pikvm: lab1.client,
      lock: lab1.lock,
      fleet,
      calibrationConfig,
      armGateEnforced: false,
      screenshot: config.screenshot,
    }));
    try {
      const sessionId = await openSession(srv.base);
      await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { maxHeight: 100 },
      });
      assert.equal(
        lastSnapshot(mock).query,
        '?preview=1&preview_max_width=400&preview_max_height=100&preview_quality=40',
      );
    } finally {
      await srv.close();
      await closeFleet(fleet);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await mock.close();
  }
});

test('screenshot settings reject a bad range and an unknown key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-screen-bad-'));
  try {
    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    assert.throws(
      () => withEnv({
        PIKVM_HOST: 'http://127.0.0.1:1',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'insecure',
        PIKVM_SCREENSHOT_QUALITY: '0',
      }, () => loadConfig()),
      /PIKVM_SCREENSHOT_QUALITY must be an integer from 1 to 100/,
    );
    assert.throws(
      () => withEnv({
        PIKVM_DEVICES: JSON.stringify({
          devices: {
            lab1: {
              host: 'https://pikvm.example.ts.net',
              username: 'admin',
              passwordFile,
              tls: { mode: 'insecure' },
              screenshot: { quality: 101 },
            },
          },
        }),
      }, () => loadConfig()),
      /screenshot\.quality/,
    );
    assert.throws(
      () => withEnv({
        PIKVM_DEVICES: JSON.stringify({
          devices: {
            lab1: {
              host: 'https://pikvm.example.ts.net',
              username: 'admin',
              passwordFile,
              tls: { mode: 'insecure' },
              screenshot: { extra: 1 },
            },
          },
        }),
      }, () => loadConfig()),
      /screenshot: unknown field "extra"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crop bounds and metadata match pixelToNormalized, with and without calibration', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock();
  try {
    const session = await startLegacy(mock);
    try {
      const plain = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      const meta = metadataOf(plain.result);
      assert.equal(meta.width, 960);
      assert.equal(meta.height, 540);
      assert.equal(meta.actualWidth, 1920);
      assert.equal(meta.actualHeight, 1080);
      assert.equal(meta.scaleX, 2);
      assert.equal(meta.scaleY, 2);
      assert.equal(meta.calibration, null);
      assert.deepEqual(meta.hid, { min: -32768, max: 32767 });
      assert.equal(meta.region, undefined);
      const uncropped = pixelToNormalized(
        Math.round(30 * meta.scaleX),
        Math.round(40 * meta.scaleY),
        { width: meta.actualWidth, height: meta.actualHeight },
        meta.calibration,
      );
      assert.deepEqual(
        uncropped,
        pixelToNormalized(60, 80, { width: 1920, height: 1080 }, null),
      );

      await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_set_calibration',
        arguments: { factorX: 1.1, factorY: 0.9 },
      });
      const cropped = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { region: { x: 10, y: 20, width: 100, height: 80 } },
      });
      assert.notEqual(cropped.result.isError, true, cropped.result.content[0].text);
      const regionMeta = metadataOf(cropped.result);
      assert.deepEqual(regionMeta.region, { x: 10, y: 20, width: 100, height: 80 });
      assert.equal(regionMeta.width, 100);
      assert.equal(regionMeta.height, 80);
      assert.deepEqual(regionMeta.calibration, { factorX: 1.1, factorY: 0.9 });
      assert.equal(regionMeta.scaleX, 2);
      assert.equal(regionMeta.scaleY, 2);
      const screenX = Math.round((30 + regionMeta.region.x) * regionMeta.scaleX);
      const screenY = Math.round((40 + regionMeta.region.y) * regionMeta.scaleY);
      assert.equal(screenX, 80);
      assert.equal(screenY, 120);
      assert.deepEqual(
        pixelToNormalized(screenX, screenY, {
          width: regionMeta.actualWidth,
          height: regionMeta.actualHeight,
        }, regionMeta.calibration),
        { x: -29763, y: -26209 },
      );
      assert.deepEqual(
        pixelToNormalized(80, 120, { width: 1920, height: 1080 }, null),
        { x: -30036, y: -25480 },
      );
      const image = cropped.result.content.find((part) => part.type === 'image');
      const decoded = await sharp(Buffer.from(image.data, 'base64')).metadata();
      assert.equal(decoded.width, 100);
      assert.equal(decoded.height, 80);

      const before = mock.calls.filter((call) => call.path === '/api/streamer/snapshot').length;
      const outside = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { region: { x: 900, y: 500, width: 100, height: 100 } },
      });
      assert.equal(outside.result.isError, true);
      assert.match(outside.result.content[0].text, /outside the captured image \(960x540\)/);
      assert.equal(outside.result.content.some((part) => part.type === 'image'), false);
      assert.equal(
        mock.calls.filter((call) => call.path === '/api/streamer/snapshot').length,
        before + 1,
      );

      const calls = mock.calls.filter((call) => call.path === '/api/streamer/snapshot').length;
      const bad = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { region: { x: 1.5, y: 0, width: 10, height: 10 } },
      });
      assert.equal(bad.result.isError, true);
      assert.match(bad.result.content[0].text, /region\.x/);
      assert.equal(bad.result.content.some((part) => part.type === 'image'), false);
      assert.equal(
        mock.calls.filter((call) => call.path === '/api/streamer/snapshot').length,
        calls,
      );
    } finally {
      await session.close();
    }
  } finally {
    await mock.close();
  }
});

test('OCR is hidden when every device is disabled, and a disabled device does not fetch', async (t) => {
  watchCrashes(t);
  const off = await startKvmdMock({ ocr: { enabled: false, langs: [] } });
  const on = await startKvmdMock({ ocr: { enabled: true, langs: ['eng'] } });
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-ocr-'));
  try {
    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const disabled = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'lab1',
        devices: {
          lab1: {
            host: off.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
        },
      }),
    }, () => loadConfig());
    const quiet = buildFleet(disabled, { hid: true, msd: true });
    const lines = [];
    const orig = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      await quiet.devices.get('lab1').client.probeOcr('lab1');
    } finally {
      console.error = orig;
    }
    assert.equal(lines.join('\n').includes('SECRETPW'), false);
    assert.equal(quiet.devices.get('lab1').client.ocrState().status, 'disabled');
    const hiddenSrv = await listen(() => createMcpServer({
      pikvm: quiet.devices.get('lab1').client,
      lock: quiet.devices.get('lab1').lock,
      fleet: quiet,
      calibrationConfig,
      armGateEnforced: false,
    }));
    try {
      const sessionId = await openSession(hiddenSrv.base);
      const listed = await rpc(hiddenSrv.base, sessionId, 'tools/list', {});
      const names = listed.result.tools.map((tool) => tool.name);
      assert.equal(names.includes('pikvm_read_text'), false);
      const refused = await rpc(hiddenSrv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { device: 'lab1' },
      });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /PIKVM_OCR_UNAVAILABLE/);
      assert.match(refused.result.content[0].text, /lab1/);
      assert.equal(off.calls.some((call) => call.path === '/api/streamer/snapshot'), false);
    } finally {
      await hiddenSrv.close();
      await closeFleet(quiet);
    }

    const mixed = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'lab1',
        devices: {
          lab1: {
            host: off.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
          lab2: {
            host: on.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
        },
      }),
    }, () => loadConfig());
    const fleet = buildFleet(mixed, { hid: true, msd: true });
    await fleet.devices.get('lab1').client.probeOcr('lab1');
    await fleet.devices.get('lab2').client.probeOcr('lab2');
    const srv = await listen(() => createMcpServer({
      pikvm: fleet.devices.get('lab1').client,
      lock: fleet.devices.get('lab1').lock,
      fleet,
      calibrationConfig,
      armGateEnforced: false,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const listed = await rpc(srv.base, sessionId, 'tools/list', {});
      const names = listed.result.tools.map((tool) => tool.name);
      assert.equal(names.includes('pikvm_read_text'), true);
      off.calls.length = 0;
      const blocked = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { device: 'lab1', langs: 'eng' },
      });
      assert.equal(blocked.result.isError, true);
      assert.match(blocked.result.content[0].text, /PIKVM_OCR_UNAVAILABLE/);
      assert.match(blocked.result.content[0].text, /"lab1"/);
      assert.equal(off.calls.some((call) => call.path === '/api/streamer/snapshot'), false);

      const read = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { device: 'lab2', langs: 'eng', left: 1, top: 2, right: 3, bottom: 4 },
      });
      assert.notEqual(read.result.isError, true, read.result.content[0].text);
      assert.match(read.result.content[0].text, /screen text/);
      const shot = on.calls.filter((call) => call.path === '/api/streamer/snapshot').at(-1);
      assert.equal(shot.query, '?ocr=1&ocr_langs=eng&ocr_left=1&ocr_top=2&ocr_right=3&ocr_bottom=4');

      on.calls.length = 0;
      const badLang = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { device: 'lab2', langs: 'fra' },
      });
      assert.equal(badLang.result.isError, true);
      assert.match(badLang.result.content[0].text, /not available/);
      assert.equal(on.calls.some((call) => call.path === '/api/streamer/snapshot'), false);
    } finally {
      await srv.close();
      await closeFleet(fleet);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await off.close();
    await on.close();
  }
});

test('OCR errors are redacted', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock({
    ocr: { enabled: true, langs: ['eng'] },
    ocrError: SECRET,
    routes: {
      'GET /api/streamer/ocr': {
        status: 500,
        body: { ok: false, result: { error: 'OcrError', error_msg: SECRET } },
      },
    },
  });
  try {
    const lines = [];
    const orig = console.error;
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    const client = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    try {
      const state = await client.probeOcr('lab1');
      assert.deepEqual(state, { status: 'unknown', langs: [] });
    } finally {
      console.error = orig;
      await client.close();
    }
    const probeLog = lines.join('\n');
    assert.equal(probeLog.includes('SECRETPW'), false);
    assert.equal(probeLog.includes('TOK'), false);
    assert.match(probeLog, /lab1/);

    const reading = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    reading.ocrState = () => ({ status: 'enabled', langs: ['eng'] });
    const srv = await listen(() => createMcpServer({
      pikvm: reading,
      lock: new BusyLock(),
      calibrationConfig,
      armGateEnforced: false,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const result = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: {},
      });
      assert.equal(result.result.isError, true);
      const text = result.result.content[0].text;
      assert.equal(text.includes('SECRETPW'), false);
      assert.equal(text.includes('TOK'), false);
      assert.match(text, /127\.0\.0\.1\/kvm/);
    } finally {
      await srv.close();
      await reading.close();
    }
  } finally {
    await mock.close();
  }
});

test('a crop does not move the default click frame', async () => {
  const mock = await startKvmdMock();
  try {
    const session = await startLegacy(mock);
    try {
      const full = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      const fullMeta = metadataOf(full.result);
      const cropped = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { region: { x: 100, y: 50, width: 10, height: 10 } },
      });
      const cropMeta = metadataOf(cropped.result);
      assert.notEqual(cropMeta.frameId, fullMeta.frameId);
      const fromFull = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270 },
      });
      assert.notEqual(fromFull.result.isError, true, fromFull.result.content[0].text);
      const fullEcho = metadataOf(fromFull.result);
      assert.equal(fullEcho.frameId, 'default');
      assert.equal(fullEcho.width, 960);
      assert.equal(fullEcho.height, 540);
      assert.equal(fullEcho.scaleX, 2);
      assert.equal(fullEcho.scaleY, 2);
      assert.deepEqual(fullEcho.origin, { x: 0, y: 0 });
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 17, y: 30 });

      const fromCrop = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270, frameId: cropMeta.frameId },
      });
      assert.notEqual(fromCrop.result.isError, true, fromCrop.result.content[0].text);
      const cropEcho = metadataOf(fromCrop.result);
      assert.equal(cropEcho.frameId, cropMeta.frameId);
      assert.equal(cropEcho.width, 10);
      assert.equal(cropEcho.height, 10);
      assert.deepEqual(cropEcho.origin, { x: 100, y: 50 });
      assert.equal(cropEcho.scaleX, 2);
      assert.equal(cropEcho.scaleY, 2);
      const screenX = Math.round((480 + 100) * 2);
      const screenY = Math.round((270 + 50) * 2);
      assert.deepEqual(
        moveTarget(hidMoves(mock).at(-1)),
        pixelToNormalized(screenX, screenY, { width: 1920, height: 1080 }, null),
      );
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 6847, y: 6104 });
    } finally {
      await session.close();
    }
  } finally {
    await mock.close();
  }
});

test('interleaved screenshots keep request order, and frameId is exact', async () => {
  const mock = await startKvmdMock({ holdSnapshots: 1 });
  try {
    const session = await startLegacy(mock);
    try {
      const otherId = await openSession(session.srv.base);
      const firstPromise = rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { maxWidth: 480, maxHeight: 270 },
      });
      await waitUntil(() => mock.calls.some((call) => call.path === '/api/streamer/snapshot'));
      const second = await rpc(session.srv.base, otherId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      const secondMeta = metadataOf(second.result);
      assert.equal(secondMeta.width, 960);
      assert.equal(secondMeta.height, 540);
      mock.releaseSnapshots();
      const first = await firstPromise;
      const firstMeta = metadataOf(first.result);
      assert.equal(firstMeta.width, 480);
      assert.equal(firstMeta.height, 270);
      assert.notEqual(firstMeta.frameId, secondMeta.frameId);

      const clicked = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270 },
      });
      const echo = metadataOf(clicked.result);
      assert.equal(echo.frameId, 'default');
      assert.equal(echo.width, 960);
      assert.equal(echo.height, 540);
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 17, y: 30 });

      const byFirst = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270, frameId: firstMeta.frameId },
      });
      assert.equal(metadataOf(byFirst.result).frameId, firstMeta.frameId);
      assert.equal(metadataOf(byFirst.result).width, 480);
      assert.deepEqual(
        moveTarget(hidMoves(mock).at(-1)),
        pixelToNormalized(480 * 4, 270 * 4, { width: 1920, height: 1080 }, null),
      );
      const bySecond = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270, frameId: secondMeta.frameId },
      });
      assert.equal(metadataOf(bySecond.result).frameId, secondMeta.frameId);
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 17, y: 30 });
    } finally {
      mock.releaseSnapshots();
      await session.close();
    }
  } finally {
    await mock.close();
  }
});

test('an evicted or cross-device frameId sends no HID', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock();
  const other = await startKvmdMock();
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-frame-'));
  try {
    const session = await startLegacy(mock);
    try {
      const ids = [];
      for (let i = 0; i < 17; i += 1) {
        const shot = await rpc(session.srv.base, session.sessionId, 'tools/call', {
          name: 'pikvm_screenshot',
          arguments: {},
        });
        ids.push(metadataOf(shot.result).frameId);
      }
      const moves = hidMoves(mock).length;
      const buttons = hidButtons(mock).length;
      const evicted = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 1, y: 1, frameId: ids[0] },
      });
      assert.equal(evicted.result.isError, true);
      assert.match(evicted.result.content[0].text, /PIKVM_UNKNOWN_FRAME/);
      const unknown = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_move',
        arguments: { x: 1, y: 1, frameId: '00000000-0000-4000-8000-000000000000' },
      });
      assert.equal(unknown.result.isError, true);
      assert.match(unknown.result.content[0].text, /PIKVM_UNKNOWN_FRAME/);
      assert.equal(hidMoves(mock).length, moves);
      assert.equal(hidButtons(mock).length, buttons);
      const kept = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270, frameId: ids[16] },
      });
      assert.notEqual(kept.result.isError, true, kept.result.content[0].text);
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 17, y: 30 });
    } finally {
      await session.close();
    }

    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const config = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'lab1',
        devices: {
          lab1: {
            host: mock.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
          lab2: {
            host: other.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
        },
      }),
    }, () => loadConfig());
    const fleet = buildFleet(config, { hid: true, msd: true });
    const srv = await listen(() => createMcpServer({
      pikvm: fleet.devices.get('lab1').client,
      lock: fleet.devices.get('lab1').lock,
      fleet,
      calibrationConfig,
      armGateEnforced: false,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const shot = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { device: 'lab2' },
      });
      const frameId = metadataOf(shot.result).frameId;
      mock.calls.length = 0;
      other.calls.length = 0;
      const crossed = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { device: 'lab1', x: 10, y: 10, frameId },
      });
      assert.equal(crossed.result.isError, true);
      assert.match(crossed.result.content[0].text, /PIKVM_UNKNOWN_FRAME/);
      assert.equal(hidMoves(mock).length, 0);
      assert.equal(hidButtons(mock).length, 0);
      assert.equal(hidMoves(other).length, 0);
      assert.equal(hidButtons(other).length, 0);
    } finally {
      await srv.close();
      await closeFleet(fleet);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await mock.close();
    await other.close();
  }
});

test('screenshot, auto_calibrate, then click keeps the preview frame', { timeout: 60000 }, async () => {
  const mock = await startKvmdMock();
  try {
    const session = await startLegacy(mock);
    try {
      await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      const calibrated = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_auto_calibrate',
        arguments: { rounds: 2, verifyRounds: 1, moveDelayMs: 20, minSamples: 3 },
      });
      assert.equal(typeof calibrated.result.content[0].text, 'string');
      const clicked = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270 },
      });
      assert.notEqual(clicked.result.isError, true, clicked.result.content[0].text);
      const echo = metadataOf(clicked.result);
      assert.equal(echo.frameId, 'default');
      assert.equal(echo.width, 960);
      assert.equal(echo.height, 540);
      assert.equal(echo.scaleX, 2);
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 17, y: 30 });
      assert.notDeepEqual(moveTarget(hidMoves(mock).at(-1)), { x: -16376, y: -16369 });
    } finally {
      await session.close();
    }
  } finally {
    await mock.close();
  }
});

function ocrGets(mock) {
  return mock.calls.filter((call) => call.path === '/api/streamer/ocr');
}

function ocrSnapshots(mock) {
  return mock.calls.filter((call) => call.path === '/api/streamer/snapshot' && call.query.includes('ocr=1'));
}

test('a slow OCR snapshot is one kvmd request', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock({
    ocr: { enabled: true, langs: ['eng'] },
    ocrDelayMs: 800,
  });
  const client = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
    ocrTimeoutMs: 200,
  });
  try {
    await client.probeOcr('lab1');
    assert.equal(client.ocrState().status, 'enabled');
    const started = Date.now();
    await assert.rejects(() => client.readText(), (err) => {
      assert.equal(err.type, 'PIKVM_TIMEOUT');
      return true;
    });
    assert.equal(ocrSnapshots(mock).length, 1);
    assert.ok(Date.now() - started < 1000, 'a timeout must not be retried');
  } finally {
    await client.close();
    await mock.close();
  }
});

test('an OCR probe does not retry, and unknown is probed again', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock({
    routes: {
      'GET /api/streamer/ocr': {
        status: 503,
        failTimes: 1,
        then: {
          status: 200,
          body: {
            ok: true,
            result: { ocr: { enabled: true, langs: { available: ['eng'], default: ['eng'] } } },
          },
        },
      },
    },
  });
  const client = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
  });
  try {
    const first = await client.probeOcr('lab1');
    assert.equal(first.status, 'unknown');
    assert.equal(ocrGets(mock).length, 1);
    const second = await client.probeOcr('lab1');
    assert.equal(second.status, 'enabled');
    assert.equal(ocrGets(mock).length, 2);
    const third = await client.probeOcr('lab1');
    assert.equal(third.status, 'enabled');
    assert.equal(ocrGets(mock).length, 2);
  } finally {
    await client.close();
    await mock.close();
  }
});

test('OCR probes run together, and a disabled answer is cached', async () => {
  const slow = await startKvmdMock({
    routes: {
      'GET /api/streamer/ocr': {
        status: 200,
        delayMs: 400,
        body: {
          ok: true,
          result: { ocr: { enabled: true, langs: { available: ['eng'], default: ['eng'] } } },
        },
      },
    },
  });
  const fast = await startKvmdMock({ ocr: { enabled: false, langs: [] } });
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-ocr-probe-'));
  try {
    const left = new PiKVMClient({
      host: slow.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    const right = new PiKVMClient({
      host: fast.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    try {
      const started = Date.now();
      startOcrProbes([
        { name: 'slow', client: left },
        { name: 'fast', client: right },
      ]);
      await waitUntil(
        () => ocrGets(slow).length > 0 && ocrGets(fast).length > 0,
        250,
      );
      assert.ok(Date.now() - started < 250);
      await waitUntil(() => left.ocrState().status === 'enabled' && right.ocrState().status === 'disabled');
    } finally {
      await left.close();
      await right.close();
    }

    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const config = withEnv({
      PIKVM_DEVICES: JSON.stringify({
        default: 'lab1',
        devices: {
          lab1: {
            host: fast.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
          lab2: {
            host: slow.url,
            username: 'admin',
            passwordFile,
            tls: { mode: 'insecure' },
          },
        },
      }),
    }, () => loadConfig());
    const fleet = buildFleet(config, { hid: true, msd: true });
    const srv = await listen(() => createMcpServer({
      pikvm: fleet.devices.get('lab1').client,
      lock: fleet.devices.get('lab1').lock,
      fleet,
      calibrationConfig,
      armGateEnforced: false,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const listed = await rpc(srv.base, sessionId, 'tools/list', {});
      assert.equal(listed.result.tools.some((tool) => tool.name === 'pikvm_read_text'), true);
      fast.calls.length = 0;
      const blocked = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { device: 'lab1' },
      });
      assert.equal(blocked.result.isError, true);
      assert.match(blocked.result.content[0].text, /PIKVM_OCR_UNAVAILABLE/);
      assert.equal(ocrSnapshots(fast).length, 0);
      assert.equal(ocrGets(fast).length, 1);
      fast.calls.length = 0;
      const again = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { device: 'lab1' },
      });
      assert.match(again.result.content[0].text, /PIKVM_OCR_UNAVAILABLE/);
      assert.equal(ocrGets(fast).length, 0);
      assert.equal(ocrSnapshots(fast).length, 0);
    } finally {
      await srv.close();
      await closeFleet(fleet);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await slow.close();
    await fast.close();
  }
});

test('an OCR box is preview pixels, and text is capped', async (t) => {
  watchCrashes(t);
  const big = 'a'.repeat(70 * 1024);
  const mock = await startKvmdMock({
    ocr: { enabled: true, langs: ['eng'] },
    ocrText: big,
  });
  try {
    assert.throws(
      () => withEnv({
        PIKVM_HOST: 'http://127.0.0.1:9',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'insecure',
        PIKVM_OCR_TIMEOUT_MS: '0',
      }, () => loadConfig()),
      /PIKVM_OCR_TIMEOUT_MS/,
    );
    assert.equal(withEnv({
      PIKVM_HOST: 'http://127.0.0.1:9',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_TLS_MODE: 'insecure',
    }, () => loadConfig()).pikvm.ocrTimeoutMs, 30000);

    const session = await startLegacy(mock);
    try {
      await session.pikvm.probeOcr('default');
      const plain = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { langs: 'eng', left: 1, top: 2, right: 3, bottom: 4 },
      });
      assert.match(plain.result.content[0].text, /\[truncated\]/);
      assert.ok(Buffer.byteLength(plain.result.content[0].text) <= 64 * 1024);
      assert.equal(
        ocrSnapshots(mock).at(-1).query,
        '?ocr=1&ocr_langs=eng&ocr_left=1&ocr_top=2&ocr_right=3&ocr_bottom=4',
      );

      const shot = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      const frameId = metadataOf(shot.result).frameId;
      mock.calls.length = 0;
      const scaled = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { langs: 'eng', left: 1, top: 2, right: 3, bottom: 4 },
      });
      assert.notEqual(scaled.result.isError, true, scaled.result.content[0].text);
      assert.equal(
        ocrSnapshots(mock).at(-1).query,
        '?ocr=1&ocr_langs=eng&ocr_left=2&ocr_top=4&ocr_right=6&ocr_bottom=8',
      );

      const cropped = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: { region: { x: 10, y: 20, width: 100, height: 80 } },
      });
      const cropId = metadataOf(cropped.result).frameId;
      mock.calls.length = 0;
      const inCrop = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { langs: 'eng', left: 1, top: 2, right: 3, bottom: 4, frameId: cropId },
      });
      assert.notEqual(inCrop.result.isError, true, inCrop.result.content[0].text);
      assert.equal(
        ocrSnapshots(mock).at(-1).query,
        '?ocr=1&ocr_langs=eng&ocr_left=22&ocr_top=44&ocr_right=26&ocr_bottom=48',
      );

      mock.calls.length = 0;
      const outside = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { langs: 'eng', left: 0, top: 0, right: 1000, bottom: 10, frameId },
      });
      assert.equal(outside.result.isError, true);
      assert.match(outside.result.content[0].text, /outside the frame/);
      assert.equal(ocrSnapshots(mock).length, 0);

      mock.calls.length = 0;
      const missing = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { frameId: '00000000-0000-4000-8000-000000000000' },
      });
      assert.equal(missing.result.isError, true);
      assert.match(missing.result.content[0].text, /PIKVM_UNKNOWN_FRAME/);
      assert.equal(ocrSnapshots(mock).length, 0);
    } finally {
      await session.close();
    }
  } finally {
    await mock.close();
  }
});

test('an oversized screenshot is rejected and the click frame stays', async (t) => {
  watchCrashes(t);
  const tiny = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#111111' },
  }).jpeg().toBuffer();
  const sof = tiny.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(sof > 0);
  const patched = Buffer.from(tiny);
  patched.writeUInt16BE(8193, sof + 5);
  patched.writeUInt16BE(8192, sof + 7);
  await assert.rejects(() => limitedSharp(patched).metadata(), /pixel limit/);
  await assert.rejects(() => limitedSharp(patched).removeAlpha().raw().toBuffer(), /pixel limit/);

  const mock = await startKvmdMock({ snapshotJpeg: patched, snapshotJpegAfter: 1 });
  try {
    const session = await startLegacy(mock);
    try {
      const full = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      assert.notEqual(full.result.isError, true, full.result.content[0].text);
      const rejected = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      assert.equal(rejected.result.isError, true);
      assert.match(rejected.result.content[0].text, /pixel limit/);
      assert.equal(rejected.result.content.some((part) => part.type === 'image'), false);
      const clicked = await rpc(session.srv.base, session.sessionId, 'tools/call', {
        name: 'pikvm_mouse_click',
        arguments: { x: 480, y: 270 },
      });
      assert.notEqual(clicked.result.isError, true, clicked.result.content[0].text);
      assert.equal(metadataOf(clicked.result).frameId, 'default');
      assert.equal(metadataOf(clicked.result).width, 960);
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), { x: 17, y: 30 });
    } finally {
      await session.close();
    }
  } finally {
    await mock.close();
  }
});
