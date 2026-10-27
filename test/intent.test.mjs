// Modified 2026-10 by PLN: wake, observe, pikvm_wait_for and pikvm_click_text (GPL-3.0; see NOTICE).

/**
 * Intent tools, each replacing a sequence seen in real sessions: a dark
 * display took screenshot, key, poll and screenshot; every action needed
 * a separate screenshot; waits were sleeps; a click on text took a
 * screenshot, OCR and a computed move. No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { hostOcr } from '../dist/ocr.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { PiKVMClient, pixelToNormalized } from '../dist/pikvm/client.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const TOKEN = 'test-bearer-token-0123456789abcdef';

const word = (text, left, top, width = 40, height = 12) => ({ text, conf: 95, bbox: { left, top, width, height }, block: 1, par: 1, line: 1 });

async function withServer({ mockOptions = {}, armed = true, recognize } = {}, fn) {
  const mock = await startKvmdMock(mockOptions);
  const pikvm = new PiKVMClient({ host: mock.url, username: 'admin', password: 'testpw', verifySsl: false });
  const frame = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#202020' } }).jpeg().toBuffer();
  pikvm.fetchFullSnapshot = async () => frame;
  const ocr = recognize ? hostOcr({ recognize, allowFullFrame: true }) : undefined;
  const httpServer = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    bearerToken: TOKEN,
    createServer: () => createMcpServer({
      pikvm,
      lock: new BusyLock(),
      calibrationConfig: {},
      armGateEnforced: !armed,
      ...(ocr ? { ocr } : {}),
    }),
  });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const headers = (id) => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${TOKEN}`,
    ...(id ? { 'mcp-session-id': id } : {}),
  });
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'intent-test', version: '1' } },
    }),
  });
  const id = res.headers.get('mcp-session-id');
  await res.text();
  const call = async (name, args = {}) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers(id),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await r.json()).result;
  };
  try {
    await fn({ mock, call, pikvm });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await pikvm.close();
    await mock.close();
  }
}

const posts = (mock, path) => mock.calls.filter((c) => c.method === 'POST' && c.path === path);
const keysSent = (mock) => posts(mock, '/api/hid/events/send_key').map((c) => new URLSearchParams(c.query).get('key'));

test('screenshot wake: one F15 brings a dark display back; never with USB offline or HID disarmed', async () => {
  await withServer({ mockOptions: { capture: { running: true, signal: false, wakeKey: 'F15' } } }, async ({ mock, call }) => {
    const shot = await call('pikvm_screenshot', { wake: true });
    assert.notEqual(shot.isError, true, shot.content[0].text);
    assert.match(shot.content[0].text, /^Woke the display: pressed F15, picture after \d+ ms\. Screenshot: 960x540/);
    assert.equal(shot.content[1].type, 'image');
    assert.deepEqual(keysSent(mock), ['F15']);
  });

  await withServer({ mockOptions: { capture: { running: true, signal: false }, hidOnline: false } }, async ({ mock, call }) => {
    const shot = await call('pikvm_screenshot', { wake: true });
    assert.equal(shot.isError, true);
    assert.match(shot.content[0].text, /off, suspended or unplugged/);
    assert.equal(keysSent(mock).length, 0);
  });

  await withServer({ mockOptions: { capture: { running: true, signal: false } }, armed: false }, async ({ mock, call }) => {
    const shot = await call('pikvm_screenshot', { wake: true });
    assert.equal(shot.isError, true);
    assert.match(shot.content[0].text, /wake did not press a key: HID is disarmed/);
    assert.equal(shot.structuredContent.error.next, undefined, 'no hint to repeat a wake that cannot work');
    assert.equal(keysSent(mock).length, 0);
  });
});

test('observe returns the screenshot after an action in the same call', async () => {
  await withServer({}, async ({ call }) => {
    const plain = await call('pikvm_key', { key: 'KeyA' });
    assert.equal(plain.content.length, 1);
    const seen = await call('pikvm_key', { key: 'KeyA', observe: true, observeDelayMs: 0 });
    assert.notEqual(seen.isError, true, seen.content[0].text);
    assert.equal(seen.content[0].text, 'Sent key: KeyA');
    assert.match(seen.content[1].text, /^After the action: Screenshot: 960x540 image of the 1920x1080 screen/);
    assert.equal(seen.content[2].type, 'image');
  });
});

test('wait_for: text that appears, a timeout with the last look, a screen that changes', async () => {
  let looks = 0;
  const recognize = async () => {
    looks += 1;
    return { words: looks >= 3 ? [word('Install', 100, 200), word('complete', 150, 200)] : [word('Installing', 100, 200)] };
  };
  await withServer({ recognize }, async ({ call }) => {
    const done = await call('pikvm_wait_for', { text: 'install complete', intervalMs: 250, timeoutSeconds: 10 });
    assert.notEqual(done.isError, true, done.content[0].text);
    assert.match(done.content[0].text, /\(3 looks\): "install complete" is on screen at screen \(145, 206\)\./);
    assert.equal(done.content[1].type, 'image');

    const missed = await call('pikvm_wait_for', { text: 'never there', intervalMs: 250, timeoutSeconds: 1 });
    assert.equal(missed.isError, true);
    assert.match(missed.content[0].text, /^Error \[PIKVM_WAIT_TIMEOUT\]: "never there" did not appear within 1 s/);
    const details = JSON.parse(missed.content[0].text.split('\n').at(-1));
    assert.equal(details.lastText, 'Install complete');
    assert.equal(missed.content[1].type, 'image');

    const bad = await call('pikvm_wait_for', { text: 'a', gone: 'b' });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /exactly one of text, gone, changed or signal/);
  });

  const white = await sharp({ create: { width: 960, height: 540, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  await withServer({ mockOptions: { snapshotJpeg: white, snapshotJpegAfter: 2 } }, async ({ call }) => {
    const changed = await call('pikvm_wait_for', { changed: true, intervalMs: 250, timeoutSeconds: 10 });
    assert.notEqual(changed.isError, true, changed.content[0].text);
    assert.match(changed.content[0].text, /\(3 looks\): the screen changed\./);
  });
});

test('wait_for keeps to its timeout, looks more than once, and keeps waiting after a failed wake', async () => {
  // Cold, dark capture: the first look must not take its own 10 s signal wait.
  await withServer({ mockOptions: { capture: { running: false, signal: false } } }, async ({ call }) => {
    const started = Date.now();
    const result = await call('pikvm_wait_for', { signal: true, timeoutSeconds: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PIKVM_WAIT_TIMEOUT/);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });

  // A 1 s wait with the default 1 s interval still gets a second look.
  await withServer({}, async ({ call }) => {
    const started = Date.now();
    const result = await call('pikvm_wait_for', { changed: true, timeoutSeconds: 1 });
    assert.equal(result.isError, true);
    const details = JSON.parse(result.content[0].text.split('\n').at(-1));
    assert.ok(details.checks >= 2, `${details.checks} looks`);
    assert.ok(Date.now() - started >= 900);
  });

  // F15 brings no picture: one key press, then the wait goes on to its timeout.
  await withServer({ mockOptions: { capture: { running: true, signal: false } } }, async ({ mock, call }) => {
    const started = Date.now();
    const result = await call('pikvm_wait_for', { signal: true, wake: true, timeoutSeconds: 3, intervalMs: 250 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error \[PIKVM_WAIT_TIMEOUT\]: no picture appeared within 3 s/);
    const details = JSON.parse(result.content[0].text.split('\n').at(-1));
    assert.match(details.wake, /Wake did not bring a picture/);
    assert.deepEqual(keysSent(mock), ['F15']);
    assert.ok(Date.now() - started >= 2500, 'waited out its timeout');
  });
});

test('a text wait keeps to its deadline through capture start and slow OCR', async () => {
  // Cold, dark capture: OCR's own resolution read must not wait 10 s.
  await withServer({
    mockOptions: { capture: { running: false, signal: false } },
    recognize: async () => ({ words: [] }),
  }, async ({ call }) => {
    const started = Date.now();
    const result = await call('pikvm_wait_for', { text: 'ready', timeoutSeconds: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PIKVM_WAIT_TIMEOUT/);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });

  // OCR slower than the time left: the wait ends with its own timeout and the last text.
  await withServer({
    recognize: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { words: [word('Installing', 100, 200)] };
    },
  }, async ({ call }) => {
    const result = await call('pikvm_wait_for', { text: 'complete', timeoutSeconds: 2 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error \[PIKVM_WAIT_TIMEOUT\]: "complete" did not appear within 2 s/);
    const details = JSON.parse(result.content[0].text.split('\n').at(-1));
    assert.equal(details.lastText, 'Installing');
  });
});

test('click_text: a phrase over two lines, ambiguous text, nth, and text that is not there', async () => {
  const words = [
    word('Recycle', 88, 61, 38, 12),
    word('Bin', 131, 61, 15, 9),
    word('Update', 620, 58, 40, 12),
    word('Windows', 612, 74, 56, 12),
    word('OK', 900, 500),
    word('OK', 900, 700),
    word('Save', 300, 900, 40, 12),
    word('&', 345, 900, 10, 12),
    word('Close', 360, 900, 40, 12),
  ];
  await withServer({ recognize: async () => ({ words }) }, async ({ mock, call }) => {
    const clicked = await call('pikvm_click_text', { text: 'update windows' });
    assert.notEqual(clicked.isError, true, clicked.content[0].text);
    // Union of both words: left 612..668, top 58..86, centre (640, 72).
    assert.equal(clicked.content[0].text, 'Clicked "Update Windows" at screen (640, 72).');
    const [move] = posts(mock, '/api/hid/events/send_mouse_move');
    const target = pixelToNormalized(640, 72, { width: 1920, height: 1080 }, null);
    assert.equal(move.query, `?to_x=${target.x}&to_y=${target.y}`);
    assert.equal(posts(mock, '/api/hid/events/send_mouse_button').length, 2, 'press and release');
    assert.match(clicked.content[1].text, /^After the action: Screenshot/);

    mock.calls.length = 0;
    const ambiguous = await call('pikvm_click_text', { text: 'OK' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /^Error \[PIKVM_TEXT_AMBIGUOUS\]: "OK" is on screen 2 times; pass nth to choose/);
    assert.equal(posts(mock, '/api/hid/events/send_mouse_move').length, 0);

    const second = await call('pikvm_click_text', { text: 'OK', nth: 2, observe: false });
    assert.equal(second.content.length, 1);
    assert.match(second.content[0].text, /at screen \(920, 706\) \(match 2 of 2\)/);

    // OCR keeps "&" as its own word; it is skipped like the query's "&".
    const saved = await call('pikvm_click_text', { text: 'Save & Close', observe: false });
    assert.equal(saved.content[0].text, 'Clicked "Save & Close" at screen (350, 906).');

    const missing = await call('pikvm_click_text', { text: 'Cancel' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /^Error \[PIKVM_TEXT_NOT_FOUND\]: "Cancel" is not on screen/);
  });
});
