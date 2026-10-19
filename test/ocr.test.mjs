// Modified 2026-10 by PLN: host OCR tests (GPL-3.0; see NOTICE).

/**
 * Host OCR with a fake recognizer and fake tesseract binaries.
 * No real PiKVM is contacted. The real-engine test lives in ocr-real.test.mjs.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { BusyLock } from '../dist/pikvm/lock.js';
import { PiKVMClient, pixelToNormalized } from '../dist/pikvm/client.js';
import { parseDeviceRegistry } from '../dist/registry.js';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import {
  OcrError,
  OCR_FULL_FRAME_MAX_PIXELS,
  createTesseractEngine,
  executeOcr,
  hostOcr,
  kvmdOcr,
  mapHostWord,
  offOcr,
  ocrToolVisible,
  parseDeviceOcr,
  parseOcrSettings,
  parseTsv,
  resolveOcr,
} from '../dist/ocr.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';
const calibrationConfig = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };
const SOURCE = { width: 1920, height: 1080 };

function crashText(err) {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

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
        clientInfo: { name: 'ocr-test', version: '1.0' },
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

function ocrSnapshots(mock) {
  return mock.calls.filter((call) => call.path === '/api/streamer/snapshot' && call.query.includes('ocr=1'));
}

function imageSnapshots(mock) {
  return mock.calls.filter((call) => call.path === '/api/streamer/snapshot' && !call.query.includes('ocr=1'));
}

function hidMoves(mock) {
  return mock.calls.filter((call) => call.path === '/api/hid/events/send_mouse_move');
}

function moveTarget(call) {
  const query = new URLSearchParams(call.query);
  return { x: Number(query.get('to_x')), y: Number(query.get('to_y')) };
}

function word(text, conf, bbox, line = 1) {
  return { text, conf, bbox, block: 1, par: 1, line };
}

function captureOcrLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    if (text.includes('"event":"ocr"')) lines.push(text);
    else orig(...args);
  };
  const restore = () => { console.error = orig; };
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      restore();
      return { value, lines };
    }, (err) => {
      restore();
      err.ocrLines = lines;
      throw err;
    });
}

async function jpeg(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: '#222222' },
  }).jpeg().toBuffer();
}

function hostInput(overrides = {}) {
  const runtime = overrides.runtime ?? hostOcr({
    recognize: overrides.recognize ?? (async () => ({ words: [] })),
    ...overrides.runtimePartial,
  });
  return {
    deviceName: 'lab1',
    runtime,
    frame: null,
    frameId: 'default',
    fullFrame: false,
    getSource: async () => SOURCE,
    calibration: null,
    fetchSnapshot: overrides.fetchSnapshot ?? (async () => jpeg(8, 8)),
    readKvmd: async () => { throw new Error('kvmd must not be called'); },
    ensureKvmd: async () => { throw new Error('kvmd probe must not be called'); },
    ...overrides.input,
  };
}

test('OCR settings parse the process env and reject junk', () => {
  assert.equal(parseOcrSettings({}).requested, 'unset');
  assert.equal(parseOcrSettings({}).bin, 'tesseract');
  assert.deepEqual(parseOcrSettings({}).langs, ['eng']);
  assert.equal(parseOcrSettings({}).maxConcurrency, 1);
  assert.equal(parseOcrSettings({}).timeoutMs, 30000);
  assert.equal(parseOcrSettings({}).maxPixels, 1048576);
  assert.equal(parseOcrSettings({}).allowFullFrame, false);
  assert.equal(parseOcrSettings({}).minConf, 60);
  assert.throws(() => parseOcrSettings({ PIKVM_OCR_ENGINE: 'auto' }), /PIKVM_OCR_ENGINE/);
  assert.throws(() => parseOcrSettings({ PIKVM_OCR_MAX_CONCURRENCY: '5' }), /PIKVM_OCR_MAX_CONCURRENCY/);
  assert.throws(() => parseOcrSettings({ PIKVM_OCR_ALLOW_FULL_FRAME: '2' }), /PIKVM_OCR_ALLOW_FULL_FRAME/);
  assert.throws(() => parseOcrSettings({ PIKVM_OCR_LANGS: 'eng,EN' }), /PIKVM_OCR_LANGS/);
  assert.throws(() => parseOcrSettings({ PIKVM_OCR_MIN_CONF: '101' }), /PIKVM_OCR_MIN_CONF/);
  const narrow = parseOcrSettings({
    PIKVM_OCR_ENGINE: 'host',
    PIKVM_OCR_MAX_CONCURRENCY: '4',
    PIKVM_OCR_ALLOW_FULL_FRAME: '1',
    PIKVM_OCR_LANGS: 'eng,osd',
    PIKVM_OCR_MIN_CONF: '0',
    PIKVM_OCR_TESSDATA_DIR: '/opt/tessdata',
  });
  assert.equal(narrow.requested, 'host');
  assert.equal(narrow.maxConcurrency, 4);
  assert.equal(narrow.allowFullFrame, true);
  assert.deepEqual(narrow.langs, ['eng', 'osd']);
  assert.equal(narrow.tessdataDir, '/opt/tessdata');
});

test('a device ocr object only narrows', () => {
  assert.equal(parseDeviceOcr('lab1', undefined), undefined);
  assert.deepEqual(parseDeviceOcr('lab1', { engine: 'off' }), { engine: 'off', langs: undefined, minConf: undefined });
  assert.deepEqual(parseDeviceOcr('lab1', { engine: 'kvmd', langs: ['eng'], minConf: 80 }), {
    engine: 'kvmd',
    langs: ['eng'],
    minConf: 80,
  });
  assert.throws(() => parseDeviceOcr('lab1', { bin: 'tesseract' }), /unknown field "bin"/);
  assert.throws(() => parseDeviceOcr('lab1', { engine: 'host' }), /process-wide/);
  assert.throws(() => parseDeviceOcr('lab1', { minConf: 101 }), /minConf/);
});

test('registry ocr is stored and an unknown key is an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-ocr-reg-'));
  try {
    const passwordFile = join(dir, 'pw');
    writeFileSync(passwordFile, 'testpw\n', { mode: 0o600 });
    const device = {
      host: 'https://pikvm.example.ts.net',
      username: 'admin',
      passwordFile,
      tls: { mode: 'insecure' },
    };
    const parsed = parseDeviceRegistry({
      default: 'lab1',
      devices: {
        lab1: { ...device, ocr: { engine: 'kvmd', langs: ['eng'], minConf: 80 } },
      },
    });
    assert.deepEqual(parsed.devices.get('lab1').ocr, { engine: 'kvmd', langs: ['eng'], minConf: 80 });
    assert.throws(() => parseDeviceRegistry({
      default: 'lab1',
      devices: { lab1: { ...device, ocr: { engine: 'off', bin: 'nope' } } },
    }), /unknown field "bin"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listing follows the effective engine', () => {
  const host = hostOcr({ recognize: async () => ({ words: [] }) });
  const kvmd = kvmdOcr();
  const off = offOcr();
  assert.equal(ocrToolVisible(off, [{ ocrStatus: 'enabled' }]), false);
  assert.equal(ocrToolVisible(host, [{ ocrStatus: 'disabled' }]), true);
  assert.equal(ocrToolVisible(host, [{ ocr: { engine: 'off' }, ocrStatus: 'enabled' }]), false);
  assert.equal(ocrToolVisible(kvmd, [{ ocrStatus: 'unknown' }]), true);
  assert.equal(ocrToolVisible(kvmd, [{ ocrStatus: 'disabled' }]), false);
  assert.equal(ocrToolVisible(kvmd, [{ ocrStatus: 'disabled' }, { ocrStatus: 'enabled' }]), true);
  assert.equal(ocrToolVisible(kvmd, [{ ocr: { engine: 'off' }, ocrStatus: 'unknown' }]), false);
});

test('word boxes map through the frame and calibration', () => {
  const glyph = word('ZXQOCR', 95, { left: 10, top: 20, width: 30, height: 40 });
  const full = mapHostWord(glyph, null, null, SOURCE, null);
  assert.deepEqual(full.click, { x: 25, y: 40 });
  assert.deepEqual(full.hid, pixelToNormalized(25, 40, SOURCE, null));
  assert.deepEqual(full.bbox, glyph.bbox);

  const cropped = mapHostWord(glyph, { left: 100, top: 200, right: 140, bottom: 260 }, null, SOURCE, null);
  assert.deepEqual(cropped.click, { x: 125, y: 240 });
  assert.deepEqual(cropped.hid, pixelToNormalized(125, 240, SOURCE, null));

  const frame = {
    id: 'frame',
    width: 960,
    height: 540,
    scaleX: 2,
    scaleY: 2,
    originX: 10,
    originY: 20,
    full: false,
  };
  const scaled = mapHostWord(glyph, { left: 100, top: 200, right: 160, bottom: 280 }, frame, SOURCE, null);
  const sourceLeft = 100 + glyph.bbox.left;
  const sourceTop = 200 + glyph.bbox.top;
  const centreX = sourceLeft + glyph.bbox.width / 2;
  const centreY = sourceTop + glyph.bbox.height / 2;
  assert.equal(scaled.frameBox.left, sourceLeft / frame.scaleX - frame.originX);
  assert.equal(scaled.frameBox.top, sourceTop / frame.scaleY - frame.originY);
  assert.deepEqual(scaled.click, {
    x: Math.round(scaled.frameBox.left + scaled.frameBox.width / 2),
    y: Math.round(scaled.frameBox.top + scaled.frameBox.height / 2),
  });
  assert.deepEqual(scaled.hid, pixelToNormalized(centreX, centreY, SOURCE, null));
  const withCal = mapHostWord(
    glyph,
    { left: 100, top: 200, right: 160, bottom: 280 },
    frame,
    SOURCE,
    { factorX: 1.1, factorY: 0.9 },
  );
  assert.deepEqual(withCal.click, scaled.click);
  assert.deepEqual(withCal.hid, pixelToNormalized(centreX, centreY, SOURCE, { factorX: 1.1, factorY: 0.9 }));
  assert.notDeepEqual(withCal.hid, scaled.hid);
});

test('minConf, text, and word caps', async (t) => {
  watchCrashes(t);
  const image = await jpeg(8, 8);
  const many = Array.from({ length: 2001 }, (_, index) => word(`w${index}`, 90, {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  }, index + 1));
  const capped = await executeOcr(hostInput({
    recognize: async () => ({ words: many }),
    fetchSnapshot: async () => image,
    input: { box: { left: 0, top: 0, right: 4, bottom: 4 } },
  }));
  assert.equal(capped.words.length, 2000);
  assert.equal(capped.truncated, true);

  const huge = await executeOcr(hostInput({
    recognize: async () => ({
      words: [word('Z'.repeat(70 * 1024), 99, { left: 0, top: 0, width: 2, height: 2 })],
    }),
    fetchSnapshot: async () => image,
    input: { box: { left: 0, top: 0, right: 4, bottom: 4 } },
  }));
  assert.equal(huge.truncated, true);
  assert.match(huge.text, /\[truncated\]/);
  assert.ok(Buffer.byteLength(huge.text) <= 64 * 1024);

  const filtered = await executeOcr(hostInput({
    recognize: async () => ({
      words: [
        word('keep', 90, { left: 0, top: 0, width: 2, height: 2 }, 1),
        word('drop', 40, { left: 2, top: 0, width: 2, height: 2 }, 1),
      ],
    }),
    fetchSnapshot: async () => image,
    input: { box: { left: 0, top: 0, right: 4, bottom: 4 } },
  }));
  assert.equal(filtered.droppedLowConf, 1);
  assert.equal(filtered.text, 'keep');
  assert.equal(filtered.words.length, 1);
  assert.equal(filtered.minConf, 60);
});

test('a missing box or an oversized region does not fetch a snapshot', async (t) => {
  watchCrashes(t);
  let fetches = 0;
  const fetchSnapshot = async () => {
    fetches += 1;
    return jpeg(8, 8);
  };
  const runtime = hostOcr({
    recognize: async () => ({ words: [] }),
    maxPixels: 100,
  });
  await assert.rejects(
    () => executeOcr(hostInput({ runtime, fetchSnapshot })),
    (err) => err instanceof OcrError && err.type === 'PIKVM_OCR_BOX_REQUIRED' && err.engine === 'host',
  );
  assert.equal(fetches, 0);
  await assert.rejects(
    () => executeOcr(hostInput({
      runtime,
      fetchSnapshot,
      input: { fullFrame: true },
    })),
    (err) => err instanceof OcrError && err.type === 'PIKVM_OCR_BOX_REQUIRED',
  );
  assert.equal(fetches, 0);
  await assert.rejects(
    () => executeOcr(hostInput({
      runtime,
      fetchSnapshot,
      input: { box: { left: 0, top: 0, right: 20, bottom: 20 } },
    })),
    (err) => err instanceof OcrError && err.type === 'PIKVM_OCR_TOO_LARGE',
  );
  assert.equal(fetches, 0);

  const allowed = hostOcr({
    recognize: async () => ({ words: [] }),
    allowFullFrame: true,
    maxPixels: 100,
  });
  let sources = 0;
  const full = await executeOcr(hostInput({
    runtime: allowed,
    fetchSnapshot,
    input: {
      fullFrame: true,
      getSource: async () => {
        sources += 1;
        return { width: 2, height: 2 };
      },
    },
  }));
  assert.equal(full.engine, 'host');
  assert.equal(full.crop, null);
  assert.equal(fetches, 1);
  assert.equal(sources, 1);
  assert.ok(OCR_FULL_FRAME_MAX_PIXELS >= 8_294_400);

  fetches = 0;
  await assert.rejects(
    () => executeOcr(hostInput({
      runtime: allowed,
      fetchSnapshot,
      input: {
        fullFrame: true,
        getSource: async () => ({ width: 4000, height: 3000 }),
      },
    })),
    (err) => err instanceof OcrError && err.type === 'PIKVM_OCR_TOO_LARGE',
  );
  assert.equal(fetches, 0);
});

test('the host semaphore waits, then returns busy', async (t) => {
  watchCrashes(t);
  const image = await jpeg(8, 8);
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  let peak = 0;
  let running = 0;
  const runtime = hostOcr({
    timeoutMs: 350,
    recognize: async () => {
      running += 1;
      peak = Math.max(peak, running);
      try {
        await gate;
        return { words: [] };
      } finally {
        running -= 1;
      }
    },
  });
  const input = () => hostInput({
    runtime,
    fetchSnapshot: async () => image,
    input: { box: { left: 0, top: 0, right: 4, bottom: 4 } },
  });
  const first = executeOcr(input());
  const second = executeOcr(input());
  const winner = await Promise.race([
    first.then((value) => ({ kind: 'ok', value }), (err) => ({ kind: 'err', err })),
    second.then((value) => ({ kind: 'ok', value }), (err) => ({ kind: 'err', err })),
  ]);
  assert.equal(winner.kind, 'err');
  assert.equal(winner.err.type, 'PIKVM_OCR_BUSY');
  assert.equal(winner.err.engine, 'host');
  assert.equal(peak, 1);
  release();
  const rest = await Promise.allSettled([first, second]);
  assert.equal(rest.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(rest.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(peak, 1);
});

test('a device cannot widen OCR or lower the confidence floor', async () => {
  await assert.rejects(
    () => executeOcr(hostInput({
      runtime: offOcr(),
      input: { override: { engine: 'kvmd' } },
    })),
    /widens/,
  );
  await assert.rejects(
    () => executeOcr(hostInput({
      runtime: hostOcr({ recognize: async () => ({ words: [] }), minConf: 60 }),
      input: { override: { minConf: 10 }, box: { left: 0, top: 0, right: 2, bottom: 2 } },
    })),
    /cannot be below 60/,
  );
  await assert.rejects(
    () => executeOcr(hostInput({
      runtime: hostOcr({ recognize: async () => ({ words: [] }) }),
      input: { override: { langs: ['fra'] }, box: { left: 0, top: 0, right: 2, bottom: 2 } },
    })),
    /outside the process languages/,
  );
});

test('host failure does not call kvmd', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock({ ocr: { enabled: true, langs: ['eng'] } });
  const image = await jpeg(64, 64);
  try {
    const pikvm = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    const lock = new BusyLock();
    const runtime = hostOcr({
      recognize: async () => {
        assert.equal(lock.isBusy, false);
        throw new OcrError('PIKVM_OCR_FAILED', 'recognizer failed', 'host');
      },
    });
    pikvm.fetchFullSnapshot = async () => image;
    const srv = await listen(() => createMcpServer({
      pikvm,
      lock,
      calibrationConfig,
      armGateEnforced: false,
      ocr: runtime,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const failed = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { left: 0, top: 0, right: 4, bottom: 4 },
      });
      assert.equal(failed.result.isError, true);
      assert.match(failed.result.content[0].text, /PIKVM_OCR_FAILED/);
      assert.match(failed.result.content[0].text, /"engine":"host"/);
      assert.equal(ocrSnapshots(mock).length, 0);
    } finally {
      await srv.close();
      await pikvm.close();
    }
  } finally {
    await mock.close();
  }
});

test('a click on a host word uses that frame', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock();
  try {
    const pikvm = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    const lock = new BusyLock();
    const runtime = hostOcr({
      recognize: async (png) => {
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(lock.isBusy, false);
        return { words: [word('ZXQOCR', 99, { left: 0, top: 0, width: 4, height: 4 })] };
      },
    });
    const srv = await listen(() => createMcpServer({
      pikvm,
      lock,
      calibrationConfig,
      armGateEnforced: false,
      ocr: runtime,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const listed = await rpc(srv.base, sessionId, 'tools/list', {});
      const tool = listed.result.tools.find((item) => item.name === 'pikvm_read_text');
      assert.ok(tool);
      assert.match(tool.description, /JSON/);
      assert.match(tool.description, /not plain text/);
      const preview = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_screenshot',
        arguments: {},
      });
      const metaLine = preview.result.content[0].text.split('\n').find((line) => line.startsWith('{'));
      const meta = JSON.parse(metaLine);
      assert.equal(meta.scaleX, 2);
      assert.equal(meta.scaleY, 2);
      const before = imageSnapshots(mock).length;
      const logged = await captureOcrLogs(() => rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { left: 0, top: 0, right: 4, bottom: 4, frameId: meta.frameId },
      }));
      const read = logged.value;
      assert.notEqual(read.result.isError, true, read.result.content[0].text);
      const body = JSON.parse(read.result.content[0].text);
      assert.equal(body.engine, 'host');
      assert.equal(body.frameId, meta.frameId);
      assert.equal(body.text, 'ZXQOCR');
      assert.equal(body.words.length, 1);
      assert.deepEqual(body.words[0].click, { x: 1, y: 1 });
      assert.deepEqual(body.words[0].hid, pixelToNormalized(2, 2, SOURCE, null));
      assert.equal(body.crop.left, 0);
      assert.equal(body.source.width, 1920);
      assert.equal(ocrSnapshots(mock).length, 0);
      assert.equal(imageSnapshots(mock).length, before + 1);
      assert.equal(mock.calls.some((call) => call.path.includes('/api/msd')), false);
      const log = logged.lines.join('\n');
      assert.equal(log.includes('ZXQOCR'), false);
      const parsed = JSON.parse(logged.lines.at(-1));
      assert.equal(parsed.event, 'ocr');
      assert.equal(parsed.engine, 'host');
      assert.equal(parsed.outcome, 'ok');
      assert.equal(parsed.words, 1);
      assert.equal(parsed.text, undefined);
      assert.equal(lock.isBusy, false);

      const moved = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_mouse_move',
        arguments: { x: body.words[0].click.x, y: body.words[0].click.y, frameId: body.frameId },
      });
      assert.notEqual(moved.result.isError, true, moved.result.content[0].text);
      assert.deepEqual(moveTarget(hidMoves(mock).at(-1)), body.words[0].hid);
    } finally {
      await srv.close();
      await pikvm.close();
    }
  } finally {
    await mock.close();
  }
});

test('auto-calibrate blocks OCR without taking the lock', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock();
  try {
    const pikvm = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    const lock = new BusyLock();
    lock.acquire('auto-calibrate');
    const runtime = hostOcr({
      recognize: async () => { throw new Error('recognizer must not run'); },
    });
    const srv = await listen(() => createMcpServer({
      pikvm,
      lock,
      calibrationConfig,
      armGateEnforced: false,
      ocr: runtime,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const blocked = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { left: 0, top: 0, right: 4, bottom: 4 },
      });
      assert.equal(blocked.result.isError, true);
      assert.match(blocked.result.content[0].text, /auto-calibrate in progress/);
      assert.equal(mock.calls.some((call) => call.path === '/api/streamer/snapshot'), false);
      assert.equal(lock.isBusy, true);
      assert.equal(lock.holder, 'auto-calibrate');
    } finally {
      lock.release();
      await srv.close();
      await pikvm.close();
    }
  } finally {
    await mock.close();
  }
});

test('an unset engine is host only when the probe finds tesseract', async () => {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const missing = await resolveOcr(parseOcrSettings({
      PIKVM_OCR_TESSERACT_BIN: '/no/such/tesseract-bin',
    }));
    assert.equal(missing.requested, 'unset');
    assert.equal(missing.engine, 'off');
    assert.equal(missing.hostReady, false);
    await assert.rejects(
      () => resolveOcr(parseOcrSettings({
        PIKVM_OCR_ENGINE: 'host',
        PIKVM_OCR_TESSERACT_BIN: '/no/such/tesseract-bin',
      })),
      /PIKVM_OCR_ENGINE=host/,
    );
    const kvmd = await resolveOcr(parseOcrSettings({
      PIKVM_OCR_ENGINE: 'kvmd',
      PIKVM_OCR_TESSERACT_BIN: '/no/such/tesseract-bin',
    }));
    assert.equal(kvmd.engine, 'kvmd');
  } finally {
    console.error = orig;
  }
  const text = lines.join('\n');
  assert.match(text, /OCR is off/);
  assert.equal(text.includes('selected kvmd'), false);
});

function writeStub(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

const stubHeader = `
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('tesseract 5.0.0\\n');
  process.exit(0);
}
if (args.includes('--list-langs')) {
  process.stderr.write('List of available languages (1):\\neng\\n');
  process.exit(0);
}
appendFileSync(join(dir, 'runs.txt'), String(process.pid) + '\\n');
writeFileSync(join(dir, 'argv.json'), JSON.stringify(args));
writeFileSync(join(dir, 'env.json'), JSON.stringify(process.env));
writeFileSync(join(dir, 'pid'), String(process.pid));
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
writeFileSync(join(dir, 'stdin.bin'), Buffer.concat(chunks));
`;

test('fake tesseract binaries cover timeout, TSV, and a failed exit', async (t) => {
  watchCrashes(t);
  if (process.platform === 'win32') {
    t.skip('the tesseract stub is a shebang script');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pikvm-ocr-bin-'));
  const savedPassword = process.env.PIKVM_PASSWORD;
  process.env.PIKVM_PASSWORD = 'secret-ocr-value';
  try {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '5\t1\t1\t1\t1\t1\t10\t20\t30\t40\t95\tHELLO',
      '5\t1\t1\t1\t1\t2\t50\t20\t20\t40\t90\tWORLD',
      '5\t1\t1\t1\t1\t3\t80\t20\t10\t10\t-1\tDROP',
      '4\t1\t1\t1\t1\t0\t10\t20\t80\t40\t-1\t',
      '5\t1\t1\t1\t2\t1\t10\t70\t40\t40\t40\tlow',
      'not a row',
      '5\t1\t1\t1\t2\t2\t1\t2\t3\t4\tnope\tbad',
      '5\t1\t1\t1\t3\t1\t0\t0\t0\t0\t80\tempty',
      '',
    ].join('\n');
    const parsed = parseTsv(tsv);
    assert.deepEqual(parsed.map((item) => item.text), ['HELLO', 'WORLD', 'low']);
    assert.equal(parsed.some((item) => item.conf < 0), false);

    const tsvBin = writeStub(dir, 'tsv.mjs', `${stubHeader}\nprocess.stdout.write(${JSON.stringify(tsv)});\n`);
    const found = await resolveOcr(parseOcrSettings({ PIKVM_OCR_TESSERACT_BIN: tsvBin }));
    assert.equal(found.engine, 'host');
    assert.ok(found.probedLangs.includes('eng'));
    await assert.rejects(
      () => resolveOcr(parseOcrSettings({
        PIKVM_OCR_ENGINE: 'host',
        PIKVM_OCR_TESSERACT_BIN: tsvBin,
        PIKVM_OCR_LANGS: 'fra',
      })),
      /PIKVM_OCR_LANGS/,
    );

    const tess = join(dir, 'tessdata');
    const engine = createTesseractEngine({ bin: tsvBin, timeoutMs: 5000, tessdataDir: tess });
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#fff' },
    }).png().toBuffer();
    const recognized = await engine.recognize(png, {
      langs: 'eng',
      psm: 6,
      signal: new AbortController().signal,
    });
    assert.deepEqual(recognized.words.map((item) => item.text), ['HELLO', 'WORLD', 'low']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8')), [
      'stdin', 'stdout', '-l', 'eng', '--psm', '6', '--tessdata-dir', tess, 'tsv',
    ]);
    const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
    assert.equal(env.OMP_THREAD_LIMIT, '1');
    assert.equal(env.TESSDATA_PREFIX, tess);
    assert.equal(env.PIKVM_PASSWORD, undefined);
    assert.equal(readFileSync(join(dir, 'stdin.bin')).subarray(0, 4).toString('hex'), '89504e47');
    assert.equal(readFileSync(join(dir, 'runs.txt'), 'utf8').trim().split('\n').length, 1);

    const failBin = writeStub(dir, 'fail.mjs', `${stubHeader}\nprocess.exit(2);\n`);
    const failing = createTesseractEngine({ bin: failBin, timeoutMs: 5000 });
    await assert.rejects(
      () => failing.recognize(png, { langs: 'eng', psm: 6, signal: new AbortController().signal }),
      (err) => err instanceof OcrError && err.type === 'PIKVM_OCR_FAILED' && /exited 2/.test(err.message),
    );
    const failRuns = readFileSync(join(dir, 'runs.txt'), 'utf8').trim().split('\n');
    assert.equal(failRuns.length, 2);

    const sleepBin = writeStub(dir, 'sleep.mjs', `${stubHeader}\nsetTimeout(() => {}, 60000);\n`);
    const sleeping = createTesseractEngine({ bin: sleepBin, timeoutMs: 1000 });
    const started = Date.now();
    await assert.rejects(
      () => sleeping.recognize(png, { langs: 'eng', psm: 6, signal: new AbortController().signal }),
      (err) => err instanceof OcrError && err.type === 'PIKVM_OCR_TIMEOUT' && err.engine === 'host',
    );
    assert.ok(Date.now() - started < 4000);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const sleepRuns = readFileSync(join(dir, 'runs.txt'), 'utf8').trim().split('\n');
    assert.equal(sleepRuns.length, 3);
  } finally {
    if (savedPassword === undefined) delete process.env.PIKVM_PASSWORD;
    else process.env.PIKVM_PASSWORD = savedPassword;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kvmd OCR is wrapped JSON and is not the unset default', async (t) => {
  watchCrashes(t);
  const mock = await startKvmdMock({ ocr: { enabled: true, langs: ['eng'] } });
  try {
    const pikvm = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    await pikvm.probeOcr('lab1');
    const srv = await listen(() => createMcpServer({
      pikvm,
      lock: new BusyLock(),
      calibrationConfig,
      armGateEnforced: false,
      ocr: kvmdOcr(),
    }));
    try {
      const sessionId = await openSession(srv.base);
      const read = await rpc(srv.base, sessionId, 'tools/call', {
        name: 'pikvm_read_text',
        arguments: { langs: 'eng', left: 1, top: 2, right: 3, bottom: 4, engine: 'kvmd' },
      });
      assert.notEqual(read.result.isError, true, read.result.content[0].text);
      const body = JSON.parse(read.result.content[0].text);
      assert.equal(body.engine, 'kvmd');
      assert.deepEqual(body.words, []);
      assert.equal(body.text, 'screen text');
      assert.equal(body.durationMs.ocr, 0);
      assert.equal(
        ocrSnapshots(mock).at(-1).query,
        '?ocr=1&ocr_langs=eng&ocr_left=1&ocr_top=2&ocr_right=3&ocr_bottom=4',
      );
    } finally {
      await srv.close();
      await pikvm.close();
    }
  } finally {
    await mock.close();
  }
});
