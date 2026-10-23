// Modified 2026-10 by PLN: MSD client tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD deadline caps and upload error codes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: source-error flag and partial-image message (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a kvmd 302 is an unexpected redirect (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: teardown still runs after a hung test body (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: test timers use a monotonic clock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: teardown waits for the upload slot (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD progress windows (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: finalise window arms on request sent (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload finalise window is twice the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: early upload headers keep the stream timer (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: finalise arms on request sent, and the upload highWaterMark is 1 (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: onResponseStarted is counted through the interceptor (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a post-send job cap reports phase job_timeout (GPL-3.0; see NOTICE).

/**
 * Plain kvmd MSD client methods against the mock. No MCP tools.
 * Also pins undici 7.24.1 Content-Length and timer behaviour.
 * Subtest ceilings and teardown bounds live in test/msd-bounds.mjs.
 */

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { Agent, Dispatcher, request } from 'undici';
import { KvmdError, PiKVMClient, setDispatcherForTests } from '../dist/pikvm/client.js';
import { startKvmdMock } from './kvmd-mock.mjs';
import {
  MSD_FETCH_TIMEOUT_MS,
  MSD_FILE_TIMEOUT_MS,
  bounded,
  boundedDispatch,
  closed,
  finishWith,
  msdTest,
  onTestTeardown,
  runBounded,
  waitForMsdUploadSlots,
} from './msd-bounds.mjs';

function makeClient(mock, extra = {}) {
  return new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
    requestTimeoutMs: 1000,
    msdJobTimeoutMs: 10000,
    msdIdleTimeoutMs: 10000,
    ...extra,
  });
}

async function withMock(options, fn, clientExtra) {
  const mock = await startKvmdMock(options);
  const client = makeClient(mock, clientExtra);
  await finishWith(
    () => fn(mock, client),
    onTestTeardown(() => runBounded([
      () => waitForMsdUploadSlots(),
      () => bounded('withMock close', mock.close()),
    ])),
  );
}

function msdRequest(url, init, label = 'msd client request') {
  return boundedDispatch(request, url, init, label);
}

function bodyOf(text) {
  return Readable.from([Buffer.from(text)]);
}

function chunkedBody(size, chunkSize) {
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= size) {
        this.push(null);
        return;
      }
      const n = Math.min(chunkSize, size - sent);
      sent += n;
      this.push(Buffer.alloc(n, 7));
    },
  });
}

function pacedBody(text, gapMs) {
  return Readable.from((async function* () {
    for (const part of text) {
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      yield Buffer.from(part);
    }
  })());
}

function remoteLines(name, count) {
  return Array.from({ length: count }, (_, i) => JSON.stringify({
    ok: true,
    result: { image: { name, size: count, written: i + 1 } },
  }));
}

function count(mock, method, path) {
  return mock.calls.filter((c) => c.method === method && c.path === path).length;
}

async function waitFor(fn, ms = 1000) {
  const start = performance.now();
  while (!fn()) {
    if (performance.now() - start > ms) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rawJsonHeaders(payload) {
  return [
    Buffer.from('content-type'),
    Buffer.from('application/json'),
    Buffer.from('content-length'),
    Buffer.from(String(payload.length)),
  ];
}

function writeResultPayload(name, size) {
  return Buffer.from(JSON.stringify({
    ok: true,
    result: { image: { name, size, written: size } },
  }));
}

function finishScriptedWrite(handler, name, size) {
  const payload = writeResultPayload(name, size);
  handler.onRequestSent?.();
  handler.onHeaders?.(200, rawJsonHeaders(payload), () => {}, 'OK');
  handler.onData?.(payload);
  handler.onComplete?.([]);
}

class ScriptedDispatcher extends Dispatcher {
  constructor(run) {
    super();
    this.run = run;
  }

  dispatch(opts, handler) {
    Promise.resolve()
      .then(() => this.run(opts, handler))
      .catch((err) => {
        try {
          handler.onError?.(err);
        } catch {
          // The request is already failing.
        }
      });
    return true;
  }

  close() {
    return Promise.resolve();
  }

  destroy() {
    return Promise.resolve();
  }
}

function listen(handler) {
  const server = http.createServer(handler);
  const close = onTestTeardown(() => closed(server, 'listen server close'));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close,
      });
    });
  });
}

describe('MSD client', { timeout: MSD_FILE_TIMEOUT_MS }, () => {
  msdTest('msdWrite sends an exact Content-Length, no chunked encoding, and the same bytes', async () => {
    const payload = 'hello-msd-image';
    await withMock({}, async (mock, client) => {
      const result = await client.msdWrite('disk.img', bodyOf(payload), payload.length, {
        removeIncomplete: true,
      });
      assert.deepEqual(result, { name: 'disk.img', size: payload.length, written: payload.length });
      const call = mock.calls.find((c) => c.path === '/api/msd/write');
      assert.equal(call.contentLength, String(payload.length));
      assert.equal(call.transferEncoding, null);
      assert.match(call.query, /remove_incomplete=1/);
      assert.equal(mock.uploads.length, 1);
      assert.equal(mock.uploads[0].body.toString(), payload);
      assert.equal(mock.bytes.get('disk.img').toString(), payload);
      assert.equal(mock.state.images['disk.img'].complete, true);
      assert.equal(mock.state.images['disk.img'].writable, true);
      assert.equal(count(mock, 'POST', '/api/msd/write'), 1);
    });
  });

  msdTest('msdWrite defaults remove_incomplete to 1', async () => {
    await withMock({}, async (mock, client) => {
      await client.msdWrite('disk.img', bodyOf('ab'), 2);
      const call = mock.calls.find((c) => c.path === '/api/msd/write');
      assert.match(call.query, /remove_incomplete=1/);
      assert.equal(mock.state.images['disk.img'].complete, true);
    });
  });

  msdTest('a body that ends short of Content-Length is a mismatch and leaves an incomplete image', async () => {
    await withMock({}, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('short.img', bodyOf('ab'), 6, { removeIncomplete: false }),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_CONTENT_LENGTH_MISMATCH');
          assert.equal(err.status, 0);
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
      await waitFor(() => mock.state.images['short.img']);
      assert.equal(mock.state.images['short.img'].complete, false);
      assert.equal(mock.bytes.get('short.img').toString(), 'ab');
      await assert.rejects(
        () => client.msdWrite('dropped.img', bodyOf('ab'), 6, { removeIncomplete: true }),
        (err) => err instanceof KvmdError && err.type === 'PIKVM_CONTENT_LENGTH_MISMATCH',
      );
      assert.equal(mock.state.images['dropped.img'], undefined);
    });
  });

  msdTest('undici rejects a short body and an overrunning chunk; an exact boundary can succeed', async () => {
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    const seen = [];
    const srv = await listen(async (req, res) => {
      const chunks = [];
      try {
        for await (const chunk of req) chunks.push(chunk);
      } catch {
        // A Content-Length mismatch aborts the socket from the client side.
        return;
      }
      if (res.destroyed || res.writableEnded) return;
      seen.push({
        cl: req.headers['content-length'] ?? null,
        te: req.headers['transfer-encoding'] ?? null,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
      res.end('ok');
    });
    try {
      const exact = await msdRequest(`${srv.origin}/exact`, {
        method: 'POST',
        dispatcher: agent,
        headers: { 'content-length': '6' },
        body: Readable.from([Buffer.from('abcdef')]),
      });
      assert.equal(exact.statusCode, 200);
      await exact.body.text();
      assert.deepEqual(seen.at(-1), { cl: '6', te: null, body: 'abcdef' });

      await assert.rejects(
        () => msdRequest(`${srv.origin}/short`, {
          method: 'POST',
          dispatcher: agent,
          headers: { 'content-length': '6' },
          body: Readable.from([Buffer.from('ab')]),
        }),
        (err) => {
          assert.equal(err.code, 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
          assert.equal(err.name, 'RequestContentLengthMismatchError');
          return true;
        },
      );
      await assert.rejects(
        () => msdRequest(`${srv.origin}/long`, {
          method: 'POST',
          dispatcher: agent,
          headers: { 'content-length': '4' },
          body: Readable.from([Buffer.from('abcdef')]),
        }),
        (err) => {
          assert.equal(err.code, 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
          return true;
        },
      );

      let pushed = false;
      const boundary = new Readable({
        read() {
          if (pushed) return;
          pushed = true;
          this.push(Buffer.from('abcdef'));
          setTimeout(() => {
            this.push(Buffer.from('ghij'));
            this.push(null);
          }, 30);
        },
      });
      const late = await msdRequest(`${srv.origin}/boundary`, {
        method: 'POST',
        dispatcher: agent,
        headers: { 'content-length': '6' },
        body: boundary,
      });
      assert.equal(late.statusCode, 200);
      await late.body.text();
      assert.equal(seen.at(-1).body, 'abcdef');
    } finally {
      await runBounded([
        () => srv.close(),
        () => bounded('undici agent close', agent.close()),
      ]);
    }
  });

  msdTest('the mock rejects a chunked or missing Content-Length write', async () => {
    await withMock({}, async (mock) => {
      const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
      try {
        const res = await msdRequest(`${mock.url}/api/msd/write?image=a.img`, {
          method: 'POST',
          dispatcher: agent,
          body: Readable.from([Buffer.from('abc')]),
        });
        const body = await res.body.json();
        assert.equal(body.ok, false);
        assert.equal(body.result.error, 'ValidatorError');
        assert.equal(mock.state.images['a.img'], undefined);
        const call = mock.calls.find((c) => c.path === '/api/msd/write');
        assert.equal(call.contentLength, null);
        assert.equal(call.transferEncoding, 'chunked');
      } finally {
        await bounded('undici agent close', agent.close());
      }
    });
  });

  msdTest('typed errors: connected, busy, exists, and no image', async () => {
    await withMock({}, async (mock, client) => {
      await client.msdWrite('disk.img', bodyOf('abcd'), 4);
      await client.msdSetParams({ image: 'disk.img', cdrom: false, rw: false });
      await client.msdSetConnected(true);
      await assert.rejects(
        () => client.msdSetParams({ rw: true }),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdConnectedError');
          assert.equal(err.status, 400);
          assert.equal(err.endpoint, 'POST /api/msd/set_params');
          return true;
        },
      );
      await assert.rejects(
        () => client.msdWrite('other.img', bodyOf('abcd'), 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdConnectedError');
          return true;
        },
      );
    });

    await withMock({}, async (_mock, client) => {
      await client.msdWrite('disk.img', bodyOf('abcd'), 4);
      await assert.rejects(
        () => client.msdWrite('disk.img', bodyOf('abcd'), 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdImageExistsError');
          assert.equal(err.status, 400);
          return true;
        },
      );
    });

    await withMock({ busyFor: 1 }, async (mock, client) => {
      await assert.rejects(
        () => client.msdRemove('disk.img'),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdIsBusyError');
          assert.equal(err.status, 409);
          return true;
        },
      );
      assert.equal(count(mock, 'POST', '/api/msd/remove'), 1);
      assert.equal(mock.state.busy, false);
    });

    await withMock({}, async (mock, client) => {
      await assert.rejects(
        () => client.msdRemove('missing.iso'),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdUnknownImageError');
          assert.equal(err.endpoint, 'POST /api/msd/remove');
          return true;
        },
      );
      await assert.rejects(
        () => client.msdSetConnected(true),
        (err) => {
          assert.equal(err.type, 'MsdImageNotSelected');
          return true;
        },
      );
      await assert.rejects(
        () => client.msdSetConnected(false),
        (err) => {
          assert.equal(err.type, 'MsdDisconnectedError');
          return true;
        },
      );
      assert.equal(count(mock, 'POST', '/api/msd/remove'), 1);
      assert.equal(count(mock, 'POST', '/api/msd/set_connected'), 2);
    });
  });

  msdTest('getMsdState reads the parts map and legacy storage.free', async () => {
    await withMock({ free: 111 }, async (mock, client) => {
      const state = await client.getMsdState();
      assert.equal(state.free, 111);
      assert.equal(state.parts[''].free, 111);
      assert.equal(state.parts[''].writable, true);
      assert.equal(state.online, true);
      assert.equal(state.drive.connected, false);
      assert.equal(state.uploading, null);
      assert.equal(state.downloading, null);
      assert.equal(mock.state.parts[''].free, 111);
    });

    await withMock({ free: 222, legacyFreeShape: true }, async (_mock, client) => {
      const state = await client.getMsdState();
      assert.equal(state.free, 222);
      assert.equal(state.parts, null);
      assert.deepEqual(state.images, {});
      assert.equal(state.uploading, null);
    });

    await withMock({
      routes: {
        'GET /api/msd': {
          status: 200,
          body: {
            ok: true,
            result: {
              enabled: true,
              online: true,
              busy: false,
              drive: { image: null, connected: false, cdrom: true, rw: false },
              storage: {
                free: 1,
                parts: {
                  a: { size: 10, free: 3, writable: true },
                  b: { size: 10, free: 4, writable: false },
                },
                images: { 'x.img': { size: 8, complete: true, removable: true } },
                uploading: { name: 'x.img', size: 8, written: 2 },
              },
            },
          },
        },
      },
    }, async (_mock, client) => {
      const state = await client.getMsdState();
      assert.equal(state.free, 3);
      assert.equal(state.parts.a.free, 3);
      assert.equal(state.images['x.img'].complete, true);
      assert.deepEqual(state.uploading, { name: 'x.img', size: 8, written: 2 });
    });
  });

  msdTest('msdWriteRemote yields NDJSON progress and throws on an error line', async () => {
    await withMock({}, async (mock, client) => {
      const progress = [];
      for await (const row of client.msdWriteRemote('https://example.test/pics/a.iso', {
        removeIncomplete: true,
        timeout: 10,
      })) {
        progress.push(row);
      }
      assert.deepEqual(progress, [
        { name: 'a.iso', size: 4, written: 2 },
        { name: 'a.iso', size: 4, written: 4 },
      ]);
      const call = mock.calls.find((c) => c.path === '/api/msd/write_remote');
      assert.match(call.query, /verify=1/);
      assert.match(call.query, /remove_incomplete=1/);
      assert.match(call.query, /timeout=10/);
      assert.doesNotMatch(call.query, /insecure/);
      assert.equal(mock.state.images['a.iso'].complete, true);
      assert.equal(mock.state.images['a.iso'].writable, false);
      assert.equal(count(mock, 'POST', '/api/msd/write_remote'), 1);
    });

    await withMock({
      remote: {
        lines: [
          JSON.stringify({ ok: true, result: { image: { name: 'a.iso', size: 9, written: 3 } } }),
          JSON.stringify({ ok: false, result: { error: 'MsdOfflineError', error_msg: 'MSD is not found' } }),
        ],
      },
    }, async (_mock, client) => {
      const progress = [];
      await assert.rejects(
        async () => {
          for await (const row of client.msdWriteRemote('https://example.test/pics/a.iso')) {
            progress.push(row);
          }
        },
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdOfflineError');
          assert.equal(err.message, 'MSD is not found');
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          assert.equal(err.endpoint.includes('?'), false);
          return true;
        },
      );
      assert.deepEqual(progress, [{ name: 'a.iso', size: 9, written: 3 }]);
    });
  });

  msdTest('remove_incomplete drops a failed write and keeps an incomplete image otherwise', async () => {
    await withMock({ failMidWrite: true }, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('gone.img', bodyOf('abcdef'), 6, { removeIncomplete: true }),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'MsdOperationError');
          return true;
        },
      );
      assert.equal(mock.state.images['gone.img'], undefined);
      assert.equal(mock.bytes.has('gone.img'), false);
      assert.equal(count(mock, 'POST', '/api/msd/write'), 1);
    });

    await withMock({ failMidWrite: true }, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('kept.img', bodyOf('abcdef'), 6, { removeIncomplete: false }),
        (err) => {
          assert.equal(err.type, 'MsdOperationError');
          return true;
        },
      );
      assert.equal(mock.state.images['kept.img'].complete, false);
      assert.equal(mock.bytes.get('kept.img').toString(), 'abcdef');
    });
  });

  msdTest('MSD POSTs are not retried and a remote redirect is not followed', async () => {
    const kvmdBody = (error, errorMsg) => ({ ok: false, result: { error, error_msg: errorMsg } });
    await withMock({
      routes: {
        'POST /api/msd/remove': { status: 502, body: kvmdBody('BadGateway', 'proxy') },
        'POST /api/msd/set_connected': { status: 503, body: kvmdBody('UnavailableError', 'down') },
      },
    }, async (mock, client) => {
      await assert.rejects(() => client.msdRemove('a.img'), (err) => {
        assert.equal(err.status, 502);
        assert.equal(err.type, 'BadGateway');
        return true;
      });
      await assert.rejects(() => client.msdSetConnected(false), (err) => {
        assert.equal(err.status, 503);
        assert.equal(err.type, 'UnavailableError');
        return true;
      });
      assert.equal(count(mock, 'POST', '/api/msd/remove'), 1);
      assert.equal(count(mock, 'POST', '/api/msd/set_connected'), 1);
    });

    await withMock({
      routes: {
        'GET /api/msd': { status: 503, body: kvmdBody('UnavailableError', 'down') },
      },
    }, async (mock, client) => {
      await assert.rejects(() => client.getMsdState(), (err) => {
        assert.equal(err.type, 'UnavailableError');
        assert.equal(err.status, 503);
        return true;
      });
      assert.equal(count(mock, 'GET', '/api/msd'), 3);
    });

    await withMock({ remote: { redirectTo: 'https://example.test/elsewhere' } }, async (mock, client) => {
      await assert.rejects(
        () => client.msdWriteRemote('https://example.test/pics/a.iso')[Symbol.asyncIterator]().next(),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.status, 302);
          assert.equal(err.type, 'PIKVM_UNEXPECTED_REDIRECT');
          assert.match(err.message, /https:\/\/example\.test/);
          assert.equal(err.message.includes('/elsewhere'), false);
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
      assert.equal(count(mock, 'POST', '/api/msd/write_remote'), 1);
      assert.equal(mock.calls.some((c) => c.path === '/elsewhere'), false);
    });
  });

  msdTest('msdSetParams never sends a URL and shows cdrom rw coercion', async () => {
    await withMock({}, async (mock, client) => {
      await assert.rejects(
        () => client.msdSetParams({ image: 'https://example.test/a.iso' }),
        /does not accept a URL/,
      );
      assert.equal(count(mock, 'POST', '/api/msd/set_params'), 0);
      await client.msdSetParams({ cdrom: true, rw: true });
      const state = await client.getMsdState();
      assert.equal(state.drive.cdrom, true);
      assert.equal(state.drive.rw, false);
    });
  });

  msdTest('an upload reply inside the finalise window is not killed by the ordinary request timeout', async () => {
    // The hold is longer than PIKVM_REQUEST_TIMEOUT_MS and shorter than
    // the finalise window (2× PIKVM_MSD_IDLE_TIMEOUT_MS). The ordinary
    // deadline does not apply. The job cap is far longer than the hold.
    const idleMs = 1000;
    await withMock({ writeHoldMs: 400 }, async (_mock, client) => {
      const result = await client.msdWrite('slow.img', bodyOf('abcd'), 4);
      assert.equal(result.written, 4);
    }, { requestTimeoutMs: 150, msdJobTimeoutMs: 8000, msdIdleTimeoutMs: idleMs });
  });

  msdTest('the finalise window aborts a write that holds the response', { timeout: 15000 }, async () => {
    const idleMs = 300;
    const started = performance.now();
    await withMock({ writeHoldMs: 8000 }, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('held.img', bodyOf('abcd'), 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, finaliseMessage(idleMs));
          assert.equal(err.phase, 'finalise');
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
      await waitFor(() => mock.state.images['held.img']);
      assert.equal(mock.state.images['held.img'].complete, true);
      assert.equal(mock.uploads[0].body.length, 4);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    // A 1× window is idleMs. The armed window is 2×.
    assert.ok(elapsed >= idleMs * 2 * 0.75, `finalise window fired early: ${elapsed}ms`);
    assert.ok(elapsed < idleMs * 2 + 1500, `finalise window waited too long: ${elapsed}ms`);
  });

  msdTest('a slow multi-megabyte upload finishes inside the 2× finalise window', { timeout: 20000 }, async () => {
    // The peer reads one 512 KiB step, then waits. Eight waits are longer
    // than one idle window and shorter than two. Finalise is armed when
    // undici onRequestSent fires, after the body has been handed to the
    // socket. Those waits are the drain that window covers. A 1× window
    // would abort the upload.
    const size = 4 * 1024 * 1024;
    const step = 512 * 1024;
    const pauseMs = 120;
    const pauses = size / step;
    const idleMs = 800;
    const started = performance.now();
    await withMock({ writePace: { step, pauseMs } }, async (mock, client) => {
      const result = await client.msdWrite('paced.img', chunkedBody(size, step), size);
      assert.equal(result.written, size);
      assert.equal(mock.uploads[0].body.length, size);
      assert.equal(mock.pace.pauses, pauses);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    const paced = pauses * pauseMs;
    assert.ok(paced > idleMs, `paced reads ${paced}ms did not pass the ${idleMs}ms idle window`);
    assert.ok(paced < idleMs * 2, `paced reads ${paced}ms do not fit in the 2× window`);
    assert.ok(elapsed > idleMs, `upload finished inside one idle window (${elapsed}ms)`);
    assert.ok(elapsed < 8000, `upload hung (${elapsed}ms)`);
  });

  msdTest('early response headers leave the stream idle timer in charge', { timeout: 15000 }, async () => {
    // Headers go out before the body has been read. The response then
    // streams with gaps below the idle timeout, and the whole stream
    // lasts longer than the 2× finalise window. A finalise window armed
    // from onRequestSent after those headers would ignore the chunks.
    const idleMs = 300;
    const gapMs = 50;
    const gaps = 16;
    // A few MiB, so the socket write yields and undici can read the
    // early headers before onRequestSent. The response tail starts
    // after that handoff.
    const size = 4 * 1024 * 1024;
    const leadMs = 40;
    assert.ok(gapMs < idleMs);
    assert.ok(gaps * gapMs > idleMs * 2);
    await withMock({ writeEarlyStream: { gapMs, gaps, leadMs } }, async (mock, client) => {
      const result = await client.msdWrite('early.img', chunkedBody(size, 8 * 1024), size);
      assert.equal(result.name, 'early.img');
      assert.equal(result.written, size);
      assert.equal(mock.uploads[0].body.length, size);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
  });

  msdTest('finalise is armed on onRequestSent, not when the source ends', { timeout: 15000 }, async () => {
    // The script reads the whole source, then keeps handing chunks to
    // the socket for longer than 2× idle, and only then calls
    // onRequestSent. Arming finalise at source end would ignore those
    // handoffs and abort. Arming it on onRequestSent lets the upload
    // finish as soon as that call is made.
    const idleMs = 200;
    const gapMs = 40;
    const holdMs = idleMs * 2 + 250;
    const size = 8;
    const name = 'sent.img';
    assert.ok(gapMs < idleMs);
    assert.ok(holdMs > idleMs * 2);
    await withMock({}, async (_mock, client) => {
      const dispatcher = new ScriptedDispatcher(async (opts, handler) => {
        let aborted = false;
        let pulse;
        handler.onConnect?.((err) => {
          aborted = true;
          clearInterval(pulse);
          handler.onError?.(err);
        }, null);
        for await (const chunk of opts.body) {
          if (aborted) return;
          void chunk;
        }
        if (aborted) return;
        const bump = () => {
          if (!aborted) handler.onBodySent?.(Buffer.alloc(1));
        };
        bump();
        pulse = setInterval(bump, gapMs);
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        clearInterval(pulse);
        if (aborted) return;
        finishScriptedWrite(handler, name, size);
      });
      setDispatcherForTests(client, dispatcher);
      try {
        const result = await client.msdWrite(name, chunkedBody(size, 1), size);
        assert.equal(result.name, name);
        assert.equal(result.written, size);
      } finally {
        await dispatcher.close();
      }
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
  });

  msdTest('the upload readable stays at highWaterMark 1', { timeout: 15000 }, async () => {
    // Pausing the wrapper after one chunk shows how far Readable.from
    // pulled the source. highWaterMark 1 stays within a few chunks.
    // The object-mode default of 16 pulls a full window ahead.
    const chunkSize = 64 * 1024;
    const total = 24;
    const state = { pulls: 0, responseStarted: 0 };
    const source = new Readable({
      highWaterMark: 1,
      read() {
        if (state.pulls >= total) {
          this.push(null);
          return;
        }
        state.pulls += 1;
        this.push(Buffer.alloc(chunkSize, 1));
      },
    });
    let release;
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    let resumeFlow;
    const resumed = new Promise((resolve) => {
      resumeFlow = resolve;
    });
    await withMock({}, async (_mock, client) => {
      const dispatcher = new ScriptedDispatcher(async (opts, handler) => {
        state.hwm = opts.body?.readableHighWaterMark;
        state.objectMode = opts.body?.readableObjectMode;
        // The handler here is the interceptor's wrapper. Calling
        // onResponseStarted must reach the spy wrapped around the
        // inner handler, once.
        handler.onResponseStarted?.();
        let aborted = false;
        handler.onConnect?.((err) => {
          aborted = true;
          handler.onError?.(err);
        }, null);
        const body = opts.body;
        body.once('data', () => {
          body.pause();
          release();
        });
        body.resume();
        await resumed;
        if (aborted) return;
        for await (const chunk of body) {
          if (aborted) return;
          void chunk;
        }
        if (aborted) return;
        finishScriptedWrite(handler, 'hwm.img', total * chunkSize);
      });
      // The client composes the upload interceptor around this dispatcher.
      // The spy is outside that interceptor, so onResponseStarted is counted
      // only when the interceptor forwards the call.
      dispatcher.compose = function compose(...interceptors) {
        const spy = (dispatch) => (opts, handler) => {
          const next = handler;
          const wrapped = {
            onConnect: (abort, context) => next.onConnect?.(abort, context),
            onError: (err) => next.onError?.(err),
            onUpgrade: (statusCode, rawHeaders, socket) => next.onUpgrade?.(statusCode, rawHeaders, socket),
            onResponseStarted: () => {
              state.responseStarted += 1;
              return next.onResponseStarted?.();
            },
            onHeaders: (statusCode, rawHeaders, resume, statusMessage) => (
              next.onHeaders?.(statusCode, rawHeaders, resume, statusMessage)
            ),
            onData: (chunk) => next.onData?.(chunk),
            onComplete: (trailers) => next.onComplete?.(trailers),
            onBodySent: (chunk) => next.onBodySent?.(chunk),
            onRequestSent: () => next.onRequestSent?.(),
          };
          return dispatch(opts, wrapped);
        };
        return Dispatcher.prototype.compose.call(this, ...interceptors, spy);
      };
      setDispatcherForTests(client, dispatcher);
      const pending = client.msdWrite('hwm.img', source, total * chunkSize);
      let assertError;
      try {
        await paused;
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(state.responseStarted, 1);
        assert.equal(state.objectMode, true);
        assert.equal(state.hwm, 1);
        assert.ok(state.pulls >= 1, 'source was not read');
        assert.ok(state.pulls <= 8, `source ran ahead by ${state.pulls} chunks`);
      } catch (err) {
        assertError = err;
      } finally {
        resumeFlow();
      }
      try {
        const result = await pending;
        if (!assertError) {
          assert.equal(result.written, total * chunkSize);
        }
      } finally {
        await dispatcher.close();
      }
      if (assertError) throw assertError;
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: 10000 });
  });

  msdTest('the job cap stops a steadily trickled upload body', { timeout: 15000 }, async () => {
    const jobMs = 400;
    const idleMs = 3000;
    const gapMs = 40;
    const text = 'a'.repeat(40);
    const started = performance.now();
    await withMock({}, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWrite('trickle.img', pacedBody(text, gapMs), text.length),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.status, 0);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, jobTimeoutMessage(jobMs));
          assert.equal(err.phase, 'job_timeout');
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
    }, { msdJobTimeoutMs: jobMs, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    assert.ok(gapMs < idleMs);
    assert.ok(gapMs * text.length > jobMs);
    assert.ok(elapsed < 2500, `job cap waited too long: ${elapsed}ms`);
  });

  msdTest('an upload headersTimeout is the job cap', async () => {
    const jobMs = 8000;
    const idleMs = 300;
    const connectSec = 1;
    await withMock({ remote: { lines: remoteLines('pin.iso', 1) } }, async (_mock, client) => {
      const seen = [];
      const inner = new Agent();
      try {
        const recording = inner.compose((dispatch) => (opts, handler) => {
          seen.push(opts.headersTimeout);
          return dispatch(opts, handler);
        });
        setDispatcherForTests(client, recording);
        const result = await client.msdWrite('pin.img', bodyOf('abcd'), 4);
        assert.equal(result.written, 4);
        for await (const row of client.msdWriteRemote('https://example.test/pics/pin.iso', { timeout: connectSec })) {
          assert.equal(row.written, 1);
        }
        assert.deepEqual(seen, [jobMs, connectSec * 1000 + idleMs]);
      } finally {
        await inner.close();
      }
    }, { msdJobTimeoutMs: jobMs, msdIdleTimeoutMs: idleMs });
  });

  msdTest('a slow upload body past the idle bound still finishes inside the finalise window', { timeout: 15000 }, async () => {
    const idleMs = 400;
    const gapMs = 50;
    const text = 'abcdefghijkl';
    const started = performance.now();
    await withMock({}, async (_mock, client) => {
      const result = await client.msdWrite('slow.img', pacedBody(text, gapMs), text.length);
      assert.equal(result.written, text.length);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    assert.ok(gapMs * text.length > idleMs);
    assert.ok(elapsed >= idleMs, `upload finished inside the idle bound (${elapsed}ms)`);
    assert.ok(elapsed < 8000, `slow upload hung (${elapsed}ms)`);
  });

  msdTest('the idle gap aborts a stalled upload and allows a slow progress stream', { timeout: 15000 }, async () => {
    const started = performance.now();
    await withMock({}, async (_mock, client) => {
      let pushed = false;
      const stalled = new Readable({
        read() {
          if (!pushed) {
            pushed = true;
            this.push(Buffer.from('ab'));
          }
        },
      });
      await assert.rejects(
        () => client.msdWrite('stall.img', stalled, 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, 'image may be partial or complete; re-read /api/msd; do not resend');
          assert.equal(err.phase, undefined);
          return true;
        },
      );
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: 400 });
    assert.ok(performance.now() - started < 3000, 'idle gap waited for the job ceiling');

    const lines = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
      JSON.stringify({ ok: true, result: { image: { name: 'drip.iso', size: 8, written: n + 1 } } })
    ));
    await withMock({ remote: { lines, gapMs: 80 } }, async (_mock, client) => {
      const progress = [];
      for await (const row of client.msdWriteRemote('https://example.test/pics/drip.iso')) {
        progress.push(row.written);
      }
      assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8]);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: 400 });
  });

  msdTest('the write_remote header window aborts when headers are late', { timeout: 15000 }, async () => {
    const connectSec = 1;
    const idleMs = 300;
    const headerMs = connectSec * 1000 + idleMs;
    const started = performance.now();
    await withMock({
      remote: { headerDelayMs: 8000, lines: remoteLines('late.iso', 1) },
    }, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWriteRemote('https://example.test/pics/late.iso', { timeout: connectSec })[Symbol.asyncIterator]().next(),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, headerMessage(headerMs));
          assert.equal(err.phase, 'write_remote_headers');
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= headerMs / 2, `header window fired early: ${elapsed}ms`);
    assert.ok(elapsed < 5000, `header window waited too long: ${elapsed}ms`);
  });

  msdTest('write_remote headers inside the window and a steady stream pass both windows', { timeout: 15000 }, async () => {
    const connectSec = 0.2;
    const idleMs = 250;
    const headerMs = Math.round(connectSec * 1000) + idleMs;
    const gapMs = 40;
    const count = 20;
    const started = performance.now();
    await withMock({
      remote: {
        headerDelayMs: 50,
        gapMs,
        lines: remoteLines('drip.iso', count),
      },
    }, async (_mock, client) => {
      const progress = [];
      for await (const row of client.msdWriteRemote('https://example.test/pics/drip.iso', { timeout: connectSec })) {
        progress.push(row.written);
      }
      assert.equal(progress.length, count);
      assert.equal(progress[count - 1], count);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    assert.ok(gapMs < idleMs);
    assert.ok(gapMs * count > headerMs);
    assert.ok(gapMs * count > idleMs);
    assert.ok(elapsed > idleMs, `stream finished inside the idle bound (${elapsed}ms)`);
    assert.ok(elapsed > headerMs, `stream finished inside the header window (${elapsed}ms)`);
  });

  msdTest('a write_remote stream that stops mid-way trips the per-chunk idle bound', { timeout: 15000 }, async () => {
    const idleMs = 300;
    const started = performance.now();
    await withMock({
      remote: {
        lines: remoteLines('stall.iso', 4),
        stallAfterLines: 1,
        stallMs: 8000,
      },
    }, async (_mock, client) => {
      const progress = [];
      await assert.rejects(
        async () => {
          for await (const row of client.msdWriteRemote('https://example.test/pics/stall.iso', { timeout: 1 })) {
            progress.push(row.written);
          }
        },
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, MSD_UNKNOWN);
          assert.equal(err.phase, undefined);
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
      assert.deepEqual(progress, [1]);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 4000, `per-chunk idle waited for the job cap: ${elapsed}ms`);
  });

  msdTest('the job cap stops a write_remote trickle that keeps resetting idle', { timeout: 15000 }, async () => {
    const jobMs = 400;
    const idleMs = 3000;
    const started = performance.now();
    await withMock({
      remote: {
        gapMs: 40,
        lines: remoteLines('trickle.iso', 40),
      },
    }, async (_mock, client) => {
      await assert.rejects(
        async () => {
          for await (const _row of client.msdWriteRemote('https://example.test/pics/trickle.iso', { timeout: 1 })) {
            // A short gap keeps the idle timer from firing.
          }
        },
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.status, 0);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, jobTimeoutMessage(jobMs));
          assert.equal(err.phase, 'job_timeout');
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
    }, { msdJobTimeoutMs: jobMs, msdIdleTimeoutMs: idleMs });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 2500, `job cap waited for the idle bound: ${elapsed}ms`);
  });

  msdTest('the job cap during finalise is job_timeout, not the finalise phase', { timeout: 15000 }, async () => {
    // The body is tiny, so finalise arms almost immediately. The finalise
    // window is 2× idle, longer than the job cap, so the cap is what fires.
    const jobMs = 400;
    const idleMs = 3000;
    await withMock({ writeHoldMs: 8000 }, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWrite('held.img', bodyOf('abcd'), 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.status, 0);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, jobTimeoutMessage(jobMs));
          assert.equal(err.phase, 'job_timeout');
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
    }, { msdJobTimeoutMs: jobMs, msdIdleTimeoutMs: idleMs });
  });

  msdTest('the job cap during write_remote headers is job_timeout, not the header phase', { timeout: 15000 }, async () => {
    const jobMs = 400;
    const idleMs = 3000;
    const connectSec = 1;
    await withMock({
      remote: { headerDelayMs: 8000, lines: remoteLines('late.iso', 1) },
    }, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWriteRemote('https://example.test/pics/late.iso', { timeout: connectSec })[Symbol.asyncIterator]().next(),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.status, 0);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, jobTimeoutMessage(jobMs));
          assert.equal(err.phase, 'job_timeout');
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
    }, { msdJobTimeoutMs: jobMs, msdIdleTimeoutMs: idleMs });
  });

  msdTest('undici headersTimeout waits for headers and does not cap a writing body', { timeout: 20000 }, async () => {
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    const late = await listen(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      await new Promise((done) => setTimeout(done, 2200));
      if (res.writableEnded || req.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
      res.end('ok');
    });
    try {
      const started = performance.now();
      await assert.rejects(
        () => msdRequest(`${late.origin}/late`, {
          method: 'POST',
          dispatcher: agent,
          headers: { 'content-length': '2' },
          body: Readable.from([Buffer.from('hi')]),
          headersTimeout: 700,
          bodyTimeout: 10000,
          signal: AbortSignal.timeout(MSD_FETCH_TIMEOUT_MS),
        }),
        (err) => {
          assert.equal(err.code, 'UND_ERR_HEADERS_TIMEOUT');
          assert.ok(performance.now() - started < 5000);
          return true;
        },
      );
    } finally {
      await late.close();
    }

    const slow = await listen(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
      res.end('ok');
    });
    try {
      const chunks = Array.from({ length: 6 }, () => Buffer.alloc(32, 0x61));
      const body = new Readable({
        async read() {
          const next = chunks.shift();
          if (!next) {
            this.push(null);
            return;
          }
          await new Promise((done) => setTimeout(done, 250));
          this.push(next);
        },
      });
      const res = await msdRequest(`${slow.origin}/slow`, {
        method: 'POST',
        dispatcher: agent,
        headers: { 'content-length': String(6 * 32) },
        body,
        headersTimeout: 400,
        bodyTimeout: 10000,
        signal: AbortSignal.timeout(MSD_FETCH_TIMEOUT_MS),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(await res.body.text(), 'ok');
    } finally {
      await runBounded([
        () => slow.close(),
        () => bounded('undici agent close', agent.close()),
      ]);
    }
  });

  msdTest('undici bodyTimeout is the gap between response bytes', { timeout: 20000 }, async () => {
    const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
    const stall = await listen(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders();
      await new Promise((done) => setTimeout(done, 2200));
      if (res.writableEnded) return;
      res.end('{"ok":true}\n');
    });
    try {
      const started = performance.now();
      await assert.rejects(
        async () => {
          const res = await msdRequest(`${stall.origin}/stall`, {
            method: 'GET',
            dispatcher: agent,
            headersTimeout: 10000,
            bodyTimeout: 700,
          });
          for await (const _chunk of res.body) { /* read */ }
        },
        (err) => {
          assert.equal(err.code, 'UND_ERR_BODY_TIMEOUT');
          assert.ok(performance.now() - started < 5000);
          return true;
        },
      );
    } finally {
      await stall.close();
    }

    const drip = await listen(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders();
      for (let n = 0; n < 6; n += 1) {
        await new Promise((done) => setTimeout(done, 250));
        res.write(`{"ok":true,"n":${n}}\n`);
      }
      res.end();
    });
    try {
      const res = await msdRequest(`${drip.origin}/drip`, {
        method: 'GET',
        dispatcher: agent,
        headersTimeout: 400,
        bodyTimeout: 700,
      });
      let text = '';
      for await (const chunk of res.body) text += chunk;
      assert.match(text, /"n":5/);
    } finally {
      await runBounded([
        () => drip.close(),
        () => bounded('undici agent close', agent.close()),
      ]);
    }
  });

  const MSD_UNKNOWN = 'image may be partial or complete; re-read /api/msd; do not resend';

  function finaliseMessage(idleMs) {
    return `timed out after ${idleMs * 2}ms waiting for kvmd to finish the write (2× PIKVM_MSD_IDLE_TIMEOUT_MS); ${MSD_UNKNOWN}`;
  }

  function headerMessage(headerMs) {
    return `timed out after ${headerMs}ms waiting for write_remote response headers (connect timeout + PIKVM_MSD_IDLE_TIMEOUT_MS); ${MSD_UNKNOWN}`;
  }

  function jobTimeoutMessage(jobMs) {
    return `job timeout after ${jobMs}ms (PIKVM_MSD_JOB_TIMEOUT_MS); ${MSD_UNKNOWN}`;
  }

  msdTest('99999999999 for both MSD deadlines is clamped and the upload still finishes', { timeout: 5000 }, async () => {
    await withMock({}, async (_mock, client) => {
      const result = await client.msdWrite('huge.img', bodyOf('abcd'), 4);
      assert.equal(result.written, 4);
    }, { msdJobTimeoutMs: 99999999999, msdIdleTimeoutMs: 99999999999 });
  });

  msdTest('NDJSON progress split across chunks is reassembled', async () => {
    const line = `${JSON.stringify({ ok: true, result: { image: { name: 'split.iso', size: 4, written: 4 } } })}\r\n`;
    const mid = Math.floor(line.length / 2);
    await withMock({ remote: { chunks: [line.slice(0, mid), line.slice(mid)] } }, async (_mock, client) => {
      const progress = [];
      for await (const row of client.msdWriteRemote('https://example.test/pics/split.iso')) {
        progress.push(row);
      }
      assert.deepEqual(progress, [{ name: 'split.iso', size: 4, written: 4 }]);
    });
  });

  msdTest('msdWriteRemote raises when the stream ends short of size', async () => {
    await withMock({
      remote: {
        lines: [
          JSON.stringify({ ok: true, result: { image: { name: 'part.iso', size: 9, written: 3 } } }),
        ],
      },
    }, async (_mock, client) => {
      const progress = [];
      await assert.rejects(
        async () => {
          for await (const row of client.msdWriteRemote('https://example.test/pics/part.iso')) {
            progress.push(row);
          }
        },
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, MSD_UNKNOWN);
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
      assert.deepEqual(progress, [{ name: 'part.iso', size: 9, written: 3 }]);
    });
  });

  msdTest('a mid-body abort keeps a complete:false image unless remove_incomplete', { timeout: 15000 }, async () => {
    const stalled = () => {
      let pushed = false;
      return new Readable({
        read() {
          if (!pushed) {
            pushed = true;
            this.push(Buffer.from('ab'));
          }
        },
      });
    };
    await withMock({}, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('part.img', stalled(), 8, { removeIncomplete: false }),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, MSD_UNKNOWN);
          return true;
        },
      );
      await waitFor(() => mock.state.images['part.img']);
      assert.equal(mock.state.images['part.img'].complete, false);
      assert.equal(mock.bytes.get('part.img').toString(), 'ab');
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: 400 });

    await withMock({}, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('gone.img', stalled(), 8, { removeIncomplete: true }),
        (err) => err instanceof KvmdError && err.type === 'PIKVM_MSD_STATE_UNKNOWN',
      );
      assert.equal(mock.state.images['gone.img'], undefined);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: 400 });
  });

  msdTest('a local source read error is PIKVM_SOURCE_READ_ERROR', async () => {
    await withMock({}, async (mock, client) => {
      const src = new Readable({
        read() {
          const err = new Error('disk read failed');
          err.code = 'EIO';
          this.destroy(err);
        },
      });
      await assert.rejects(
        () => client.msdWrite('src.img', src, 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_SOURCE_READ_ERROR');
          assert.equal(err.message, 'image may be partial; re-read /api/msd');
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
      assert.equal(count(mock, 'POST', '/api/msd/write'), 0);
    });
  });

  msdTest('a source read error after the first chunk is PIKVM_SOURCE_READ_ERROR', async () => {
    await withMock({}, async (_mock, client) => {
      let sent = false;
      const src = new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push(Buffer.from('ab'));
            return;
          }
          const err = new Error('disk read failed');
          err.code = 'EIO';
          this.destroy(err);
        },
      });
      await assert.rejects(
        () => client.msdWrite('partial.img', src, 8),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_SOURCE_READ_ERROR');
          assert.equal(err.message, 'image may be partial; re-read /api/msd');
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
    });
  });

  msdTest('an idle timeout while kvmd is not reading is PIKVM_MSD_STATE_UNKNOWN', { timeout: 15000 }, async () => {
    const stalled = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024, 1));
      },
    });
    await withMock({ pauseWrite: true }, async (mock, client) => {
      await assert.rejects(
        () => client.msdWrite('stall.img', stalled, 8 * 1024 * 1024),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, MSD_UNKNOWN);
          assert.equal(err.phase, undefined);
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
      assert.ok(count(mock, 'POST', '/api/msd/write') >= 1);
    }, { msdJobTimeoutMs: 20000, msdIdleTimeoutMs: 400 });
  });

  msdTest('connection refused before an upload is sent stays PIKVM_UNREACHABLE', async () => {
    const port = await new Promise((resolve, reject) => {
      const server = http.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port: p } = server.address();
        closed(server, 'probe server close').then(() => resolve(p), reject);
      });
    });
    const client = new PiKVMClient({
      host: `http://127.0.0.1:${port}`,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
      requestTimeoutMs: 1000,
      msdJobTimeoutMs: 2000,
      msdIdleTimeoutMs: 2000,
    });
    await assert.rejects(
      () => client.msdWrite('nope.img', bodyOf('abcd'), 4),
      (err) => {
        assert.ok(err instanceof KvmdError);
        assert.equal(err.type, 'PIKVM_UNREACHABLE');
        assert.equal(err.message, 'kvmd network error');
        assert.equal(err.endpoint, 'POST /api/msd/write');
        return true;
      },
    );
  });

  msdTest('a socket reset and HTTP 504 on an upload are PIKVM_MSD_STATE_UNKNOWN', async () => {
    await withMock({
      routes: { 'POST /api/msd/write': { drop: true } },
    }, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWrite('reset.img', bodyOf('abcd'), 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.message, MSD_UNKNOWN);
          assert.equal(err.endpoint, 'POST /api/msd/write');
          return true;
        },
      );
    });

    await withMock({
      routes: { 'POST /api/msd/write': { status: 504, body: 'gateway' } },
    }, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWrite('gw.img', bodyOf('abcd'), 4),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.status, 504);
          assert.equal(err.message, MSD_UNKNOWN);
          return true;
        },
      );
    });

    await withMock({
      routes: { 'POST /api/msd/write_remote': { status: 504, body: 'gateway' } },
    }, async (_mock, client) => {
      await assert.rejects(
        () => client.msdWriteRemote('https://example.test/pics/a.iso')[Symbol.asyncIterator]().next(),
        (err) => {
          assert.ok(err instanceof KvmdError);
          assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
          assert.equal(err.status, 504);
          assert.equal(err.endpoint, 'POST /api/msd/write_remote');
          return true;
        },
      );
    });
  });
});
