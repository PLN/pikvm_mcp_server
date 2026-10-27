// Modified 2026-10 by PLN: idle capture start, no signal, HID ordering, relative moves (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the no-signal cause from USB state (GPL-3.0; see NOTICE).

/**
 * kvmd runs capture only while a stream-enabled WebSocket is connected.
 * Observed on a PiKVM V4 Mini with kvmd 4.227: with no web viewer, every
 * snapshot was HTTP 503 until a browser opened, and relative mouse moves
 * were answered ok but dropped because the mouse was absolute. The mock
 * models that lifecycle; no real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { PiKVMClient, setCaptureTimingForTests } from '../dist/pikvm/client.js';
import { startKvmdMock } from './kvmd-mock.mjs';

async function waitUntil(fn, ms = 3000) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withClient(mockOptions, timing, fn) {
  const mock = await startKvmdMock(mockOptions);
  const client = new PiKVMClient({ host: mock.url, username: 'admin', password: 'testpw', verifySsl: false });
  setCaptureTimingForTests(client, { lingerMs: 200, signalWaitMs: 1000, pollMs: 20, ...timing });
  try {
    await fn({ mock, client });
  } finally {
    // The shutdown test has closed the client already.
    await client.close().catch(() => {});
    await mock.close();
  }
}

const opens = (mock) => mock.wsEvents.filter((e) => e.type === 'open');
const closes = (mock) => mock.wsEvents.filter((e) => e.type === 'close');
const snapshots = (mock) => mock.calls.filter((c) => c.path === '/api/streamer/snapshot');

test('idle capture is started by one shared stream session, which closes after the linger', async () => {
  await withClient({ capture: { running: false, startMs: 100 } }, {}, async ({ mock, client }) => {
    const [shot, resolution] = await Promise.all([
      client.screenshot({ maxWidth: 960 }),
      client.getResolution(true),
    ]);
    assert.equal(shot.actualWidth, 1920);
    assert.equal(shot.width, 960);
    assert.deepEqual(resolution, { width: 1920, height: 1080 });
    assert.equal(opens(mock).length, 1);
    assert.equal(opens(mock)[0].stream, true);

    await client.screenshot();
    assert.equal(opens(mock).length, 1, 'a warm session is reused');

    await waitUntil(() => closes(mock).length === 1);
    assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 0, 'no input is sent to start capture');
  });
});

test('no signal is reported at once when capture already runs, and after the wait when it was started', async () => {
  await withClient({ capture: { running: true, signal: false } }, {}, async ({ mock, client }) => {
    await assert.rejects(client.screenshot(), (err) => {
      assert.equal(err.type, 'PIKVM_NO_SIGNAL');
      assert.equal(err.reason, 'display_asleep');
      assert.deepEqual(err.next, { tool: 'pikvm_key', args: { key: 'ShiftLeft' } });
      return true;
    });
    await assert.rejects(client.getResolution(true), { type: 'PIKVM_NO_SIGNAL' });
    assert.equal(opens(mock).length, 0);
    assert.equal(snapshots(mock).length, 0);
  });

  await withClient({ capture: { running: false, signal: false } }, { signalWaitMs: 300 }, async ({ mock, client }) => {
    const started = Date.now();
    await assert.rejects(client.screenshot(), { type: 'PIKVM_NO_SIGNAL' });
    assert.ok(Date.now() - started >= 250, 'waited for a signal after starting capture');
    assert.equal(opens(mock).length, 1);

    mock.setSignal(true);
    const shot = await client.screenshot();
    assert.equal(shot.actualWidth, 1920);
    assert.equal(opens(mock).length, 1);
  });
});

test('no signal with the USB keyboard and mouse offline is a host that is off or unplugged', async () => {
  // As on a PiKVM whose host was unplugged: no picture, keyboard and mouse offline.
  await withClient({ capture: { running: true, signal: false }, hidOnline: false }, {}, async ({ client }) => {
    await assert.rejects(client.screenshot(), (err) => {
      assert.equal(err.type, 'PIKVM_NO_SIGNAL');
      assert.equal(err.reason, 'usb_offline');
      assert.match(err.message, /off, suspended or unplugged/);
      assert.equal(err.next, undefined);
      return true;
    });
  });
});

test('a refused stream session is PIKVM_CAPTURE_START_FAILED', async () => {
  await withClient({ capture: { running: false, wsStatus: 403 } }, {}, async ({ mock, client }) => {
    await assert.rejects(client.screenshot(), (err) => {
      assert.equal(err.type, 'PIKVM_CAPTURE_START_FAILED');
      assert.equal(err.endpoint, 'GET /api/ws');
      return true;
    });
    assert.equal(snapshots(mock).length, 0);
  });
});

test('the stream session opens and closes only while HID is idle', async () => {
  // kvmd clears HID when a session opens or closes. A print in flight
  // finishes, and its reports drain, before the session opens.
  await withClient({
    capture: { running: false },
    routes: { 'POST /api/hid/print': { delayMs: 300, status: 204, body: '' } },
  }, {}, async ({ mock, client }) => {
    const typing = client.type('hello').then(() => Date.now());
    await waitUntil(() => mock.calls.some((c) => c.path === '/api/hid/print'));
    const shot = client.screenshot();
    const typed = await typing;
    await shot;
    assert.ok(opens(mock)[0].at - typed >= 250, `opened ${opens(mock)[0].at - typed}ms after the print`);
  });

  await withClient({ capture: { running: false } }, {}, async ({ mock, client }) => {
    await client.sendKey('ShiftLeft', { state: true });
    await assert.rejects(client.screenshot(), (err) => {
      assert.equal(err.type, 'PIKVM_CAPTURE_HELD_INPUT');
      assert.match(err.message, /key ShiftLeft/);
      return true;
    });
    assert.equal(opens(mock).length, 0);

    await client.sendKey('ShiftLeft', { state: false });
    await client.screenshot();
    assert.equal(opens(mock).length, 1);

    // A held button keeps an idle session open past the linger.
    await client.mouseClick('left', { state: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(closes(mock).length, 0);
    await client.mouseClick('left', { state: false });
    await waitUntil(() => closes(mock).length === 1);
  });
});

test('HID guard: a press during a waiting close, queued prints, a refused press', async () => {
  // The linger expires during a print; a key pressed while the close
  // waits for HID keeps the session open until it is released.
  await withClient({
    capture: { running: false },
    routes: { 'POST /api/hid/print': { delayMs: 600, status: 204, body: '' } },
  }, {}, async ({ mock, client }) => {
    await client.screenshot();
    const typing = client.type('hello');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.sendKey('ShiftLeft', { state: true });
    await typing;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(closes(mock).length, 0);
    await client.sendKey('ShiftLeft', { state: false });
    await waitUntil(() => closes(mock).length === 1);
  });

  // kvmd writes each fast print's reports after the previous one's, so
  // the waits add up: about 1 s per 100 characters here.
  await withClient({ capture: { running: false } }, {}, async ({ mock, client }) => {
    await client.type('a'.repeat(100));
    await client.type('b'.repeat(100));
    const typed = Date.now();
    await client.screenshot();
    assert.ok(opens(mock)[0].at - typed >= 1900, `opened ${opens(mock)[0].at - typed}ms after two prints`);
  });

  // A press that kvmd refuses is not held.
  await withClient({
    capture: { running: false },
    routes: {
      'POST /api/hid/events/send_key': {
        status: 400,
        failTimes: 1,
        body: { ok: false, result: { error: 'ValidatorError', error_msg: 'unknown key' } },
      },
    },
  }, {}, async ({ mock, client }) => {
    await assert.rejects(client.sendKey('NoSuchKey', { state: true }), { status: 400 });
    await client.screenshot();
    assert.equal(opens(mock).length, 1);
  });
});

test('closing the client closes the stream session', async () => {
  await withClient({ capture: { running: false } }, { lingerMs: 60_000 }, async ({ mock, client }) => {
    await client.screenshot();
    assert.equal(opens(mock).length, 1);
    await client.close();
    await waitUntil(() => closes(mock).length === 1, 1000);
  });
});

test('a relative move is refused while kvmd reports an absolute mouse', async () => {
  await withClient({}, {}, async ({ mock, client }) => {
    await assert.rejects(client.mouseMoveRelative(12, 8), { type: 'PIKVM_MOUSE_ABSOLUTE' });
    assert.equal(mock.calls.some((c) => c.path === '/api/hid/events/send_mouse_relative'), false);
  });
  await withClient({ mouseAbsolute: false }, {}, async ({ mock, client }) => {
    await client.mouseMoveRelative(12, 8);
    assert.equal(mock.calls.filter((c) => c.path === '/api/hid/events/send_mouse_relative').length, 1);
  });
});
