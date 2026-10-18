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
import { buildFleet, closeFleet } from '../dist/devices.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { PiKVMClient, pixelToNormalized } from '../dist/pikvm/client.js';
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

test('crop bounds and metadata match pixelToNormalized, with and without calibration', async () => {
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

test('OCR is hidden when every device is disabled, and a disabled device does not fetch', async () => {
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

test('OCR errors are redacted', async () => {
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
