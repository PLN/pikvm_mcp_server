// Modified 2026-10 by PLN: configurable error, status, and delay routes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD state machine (GPL-3.0; see NOTICE).

/**
 * Minimal KVMD REST mock implementing exactly the routes src/pikvm/client.ts
 * calls. Never touches real hardware — every HID POST just returns 204 and
 * is recorded in `calls` for assertions.
 *
 * `options.routes` overrides a route for the first `failTimes` hits
 * (every hit, when `failTimes` is omitted). Keys are `METHOD /api/...`.
 * `delayMs` waits, and ends early if the client aborts. `drop` destroys
 * the socket. `resetAfterHeaders` writes a partial body and resets.
 * `delayAfterHeaders` sends headers, then waits, then the body.
 * `then` runs after `failTimes` is exhausted. Otherwise the built-in
 * route runs.
 *
 * MSD routes are registered before the POST 204 catch-all. `state` is
 * the live drive. `uploads` records write bodies. `bytes` holds stored
 * image bytes. Options: `free`, `busyFor` (how many MSD mutations
 * answer MsdIsBusyError), `failMidWrite`, `failSetConnected`,
 * `legacyFreeShape`, `writeHoldMs`, and `remote` (`lines`, `gapMs`,
 * `headerDelayMs`, `stallAfterHeadersMs`, `redirectTo`).
 */

import http from 'node:http';
import sharp from 'sharp';

let jpegCache = null;
async function tinyJpeg() {
  if (!jpegCache) {
    jpegCache = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#111111' },
    }).jpeg().toBuffer();
  }
  return jpegCache;
}

function waitOrClose(req, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      req.off('close', done);
      clearTimeout(timer);
      resolve();
    }
    req.on('close', done);
  });
}

const defaultBody = { ok: false, result: { error: 'MockError', error_msg: 'mock error' } };

async function sendRoute(req, res, route) {
  if (route.delayMs && !route.delayAfterHeaders) await waitOrClose(req, route.delayMs);
  if (req.destroyed || res.writableEnded) return;
  if (route.drop) {
    req.socket.destroy();
    return;
  }
  if (route.resetAfterHeaders) {
    res.writeHead(route.status ?? 200, { 'Content-Type': route.contentType ?? 'application/json' });
    res.write('{"ok":');
    req.socket.destroy();
    return;
  }
  const status = route.status ?? 500;
  const body = route.body === undefined ? defaultBody : route.body;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': route.contentType ?? 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (route.delayAfterHeaders) {
    res.writeHead(status, headers);
    await waitOrClose(req, route.delayMs ?? 0);
    if (req.destroyed || res.writableEnded || res.destroyed) return;
    res.end(payload);
    return;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function readIncoming(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    req.on('data', (c) => chunks.push(c));
    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
  });
}

/**
 * Node destroys the IncomingMessage once its body has been consumed, while
 * the keep-alive socket is still writable. Abort is the socket going away.
 */
function clientGone(req, res) {
  return Boolean(req.socket?.destroyed || res.writableEnded || res.destroyed);
}

function waitOrSocketClose(req, ms) {
  return new Promise((resolve) => {
    const socket = req.socket;
    const timer = setTimeout(done, ms);
    function done() {
      socket?.off('close', done);
      clearTimeout(timer);
      resolve();
    }
    if (!socket || socket.destroyed) {
      done();
      return;
    }
    socket.on('close', done);
  });
}

function kvmdFail(res, status, error, errorMsg) {
  const payload = JSON.stringify({ ok: false, result: { error, error_msg: errorMsg } });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function kvmdOk(res, result = {}) {
  const payload = JSON.stringify({ ok: true, result });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function flagParam(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

const MSD_CONNECTED = 'MSD is connected to Server, but shouldn\'t for this operation';
const MSD_DISCONNECTED = 'MSD is disconnected from Server, but should be for this operation';
const MSD_BUSY = 'Performing another MSD operation, please try again later';
const MSD_EXISTS = 'This image is already exists';
const MSD_UNKNOWN = 'The image is not found in the storage';
const MSD_NONE = 'The image is not selected';
const MSD_OFFLINE = 'MSD is not found';

function imageMeta(name, size, complete) {
  const iso = name.toLowerCase().endsWith('.iso');
  return {
    size,
    mod_ts: 0,
    writable: !iso,
    cdromable: true,
    removable: true,
    complete,
  };
}

export async function startKvmdMock(options = {}) {
  const calls = [];
  const routes = options.routes ?? {};
  const routeHits = {};
  const freeBytes = Number.isInteger(options.free) ? options.free : 1024 * 1024 * 1024;
  const legacyFreeShape = options.legacyFreeShape === true;
  let busyRemaining = Number.isInteger(options.busyFor) ? options.busyFor : 0;
  const bytes = new Map();
  const uploads = [];
  const state = {
    online: options.online !== false,
    busy: busyRemaining > 0,
    images: {},
    parts: {
      '': { size: freeBytes + 4096, free: freeBytes, writable: true },
    },
    drive: { image: null, connected: false, cdrom: true, rw: false },
    uploading: null,
    downloading: null,
  };

  function syncBusy() {
    state.busy = busyRemaining > 0;
  }

  function storageImages() {
    const images = {};
    for (const [name, meta] of Object.entries(state.images)) {
      images[name] = {
        size: meta.size,
        mod_ts: meta.mod_ts,
        writable: meta.writable,
        cdromable: meta.cdromable,
        removable: meta.removable,
        complete: meta.complete,
        in_storage: true,
      };
    }
    return images;
  }

  function msdResult() {
    const drive = state.online
      ? {
          image: state.drive.image,
          connected: state.drive.connected,
          cdrom: state.drive.cdrom,
          rw: state.drive.rw,
        }
      : null;
    let storage = null;
    if (state.online) {
      const images = storageImages();
      storage = legacyFreeShape
        ? {
            size: state.parts[''].size,
            free: state.parts[''].free,
            images,
            uploading: state.uploading ? state.uploading : false,
          }
        : {
            images,
            parts: state.parts,
            uploading: state.uploading,
            downloading: state.downloading,
          };
    }
    return {
      enabled: true,
      online: state.online,
      busy: state.busy,
      storage,
      drive,
    };
  }

  function guardMutation(res) {
    if (busyRemaining > 0) {
      busyRemaining -= 1;
      syncBusy();
      kvmdFail(res, 409, 'MsdIsBusyError', MSD_BUSY);
      return true;
    }
    if (!state.online) {
      kvmdFail(res, 400, 'MsdOfflineError', MSD_OFFLINE);
      return true;
    }
    return false;
  }

  async function handleMsd(req, res, u) {
    if (req.method === 'GET' && u.pathname === '/api/msd') {
      kvmdOk(res, msdResult());
      return true;
    }
    if (req.method === 'GET' && u.pathname === '/api/msd/read') {
      if (guardMutation(res)) return true;
      const name = u.searchParams.get('image') || '';
      const stored = bytes.get(name);
      if (!stored) {
        kvmdFail(res, 400, 'MsdUnknownImageError', MSD_UNKNOWN);
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stored.length,
      });
      res.end(stored);
      return true;
    }
    if (req.method === 'POST' && u.pathname === '/api/msd/set_params') {
      if (guardMutation(res)) return true;
      if (state.drive.connected) {
        kvmdFail(res, 400, 'MsdConnectedError', MSD_CONNECTED);
        return true;
      }
      const image = u.searchParams.get('image');
      const cdrom = u.searchParams.get('cdrom');
      const rw = u.searchParams.get('rw');
      if (image !== null) {
        if (image === '') {
          state.drive.image = null;
        } else if (!state.images[image]) {
          kvmdFail(res, 400, 'MsdUnknownImageError', MSD_UNKNOWN);
          return true;
        } else {
          const meta = state.images[image];
          state.drive.image = {
            name: image,
            size: meta.size,
            complete: meta.complete,
            removable: meta.removable,
          };
        }
      }
      if (cdrom !== null) state.drive.cdrom = flagParam(cdrom);
      if (rw !== null) state.drive.rw = flagParam(rw);
      if (state.drive.cdrom) state.drive.rw = false;
      const selected = state.drive.image ? state.images[state.drive.image.name] : null;
      if (selected && !selected.writable) state.drive.rw = false;
      kvmdOk(res);
      return true;
    }
    if (req.method === 'POST' && u.pathname === '/api/msd/set_connected') {
      if (guardMutation(res)) return true;
      const connected = flagParam(u.searchParams.get('connected'));
      if (connected && options.failSetConnected) {
        kvmdFail(res, 400, 'MsdIoError', 'connect failed');
        return true;
      }
      if (connected) {
        if (!state.drive.image) {
          kvmdFail(res, 400, 'MsdImageNotSelected', MSD_NONE);
          return true;
        }
        if (!state.images[state.drive.image.name]) {
          kvmdFail(res, 400, 'MsdUnknownImageError', MSD_UNKNOWN);
          return true;
        }
        state.drive.connected = true;
      } else if (!state.drive.connected) {
        kvmdFail(res, 400, 'MsdDisconnectedError', MSD_DISCONNECTED);
        return true;
      } else {
        state.drive.connected = false;
      }
      kvmdOk(res);
      return true;
    }
    if (req.method === 'POST' && u.pathname === '/api/msd/remove') {
      if (guardMutation(res)) return true;
      if (state.drive.connected) {
        kvmdFail(res, 400, 'MsdConnectedError', MSD_CONNECTED);
        return true;
      }
      const name = u.searchParams.get('image') || '';
      if (!state.images[name]) {
        kvmdFail(res, 400, 'MsdUnknownImageError', MSD_UNKNOWN);
        return true;
      }
      delete state.images[name];
      bytes.delete(name);
      if (state.drive.image && state.drive.image.name === name) state.drive.image = null;
      kvmdOk(res);
      return true;
    }
    if (req.method === 'POST' && u.pathname === '/api/msd/write') {
      const transferEncoding = req.headers['transfer-encoding'] ?? null;
      const contentLength = req.headers['content-length'] ?? null;
      const chunked = String(transferEncoding || '').toLowerCase().includes('chunked');
      const image = u.searchParams.get('image') || '';
      const removeIncomplete = flagParam(u.searchParams.get('remove_incomplete'));
      if (!contentLength || chunked) {
        await readIncoming(req);
        if (clientGone(req, res)) return true;
        kvmdFail(res, 400, 'ValidatorError', 'Content-Length is required');
        return true;
      }
      if (guardMutation(res)) {
        await readIncoming(req);
        return true;
      }
      if (state.drive.connected) {
        await readIncoming(req);
        if (clientGone(req, res)) return true;
        kvmdFail(res, 400, 'MsdConnectedError', MSD_CONNECTED);
        return true;
      }
      if (!image || state.images[image]) {
        await readIncoming(req);
        if (clientGone(req, res)) return true;
        kvmdFail(
          res,
          400,
          state.images[image] ? 'MsdImageExistsError' : 'ValidatorError',
          state.images[image] ? MSD_EXISTS : 'invalid image name',
        );
        return true;
      }
      const buf = await readIncoming(req);
      uploads.push({
        image,
        body: buf,
        contentLength,
        transferEncoding,
        removeIncomplete,
        complete: !options.failMidWrite && buf.length === Number(contentLength),
      });
      if (clientGone(req, res)) return true;
      if (buf.length !== Number(contentLength)) {
        kvmdFail(res, 400, 'ValidatorError', 'Content-Length does not match the body');
        return true;
      }
      if (options.failMidWrite) {
        if (!removeIncomplete) {
          state.images[image] = imageMeta(image, buf.length, false);
          bytes.set(image, buf);
        }
        kvmdFail(res, 400, 'MsdIoError', 'write failed');
        return true;
      }
      if (options.writeHoldMs) await waitOrSocketClose(req, options.writeHoldMs);
      if (clientGone(req, res)) return true;
      state.images[image] = imageMeta(image, buf.length, true);
      bytes.set(image, buf);
      state.parts[''].free = Math.max(0, state.parts[''].free - buf.length);
      kvmdOk(res, { image: { name: image, size: buf.length, written: buf.length } });
      return true;
    }
    if (req.method === 'POST' && u.pathname === '/api/msd/write_remote') {
      if (guardMutation(res)) return true;
      if (state.drive.connected) {
        kvmdFail(res, 400, 'MsdConnectedError', MSD_CONNECTED);
        return true;
      }
      const remote = options.remote ?? {};
      if (remote.redirectTo) {
        res.writeHead(302, { Location: remote.redirectTo });
        res.end();
        return true;
      }
      const url = u.searchParams.get('url') || '';
      let name = u.searchParams.get('image') || '';
      if (!name) {
        try {
          name = new URL(url).pathname.split('/').filter(Boolean).pop() || 'remote.iso';
        } catch {
          name = 'remote.iso';
        }
      }
      if (remote.headerDelayMs) await waitOrClose(req, remote.headerDelayMs);
      if (req.destroyed || res.writableEnded) return true;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.flushHeaders();
      if (remote.stallAfterHeadersMs) await waitOrClose(req, remote.stallAfterHeadersMs);
      if (req.destroyed || res.writableEnded) return true;
      const lines = remote.lines ?? [
        JSON.stringify({ ok: true, result: { image: { name, size: 4, written: 2 } } }),
        JSON.stringify({ ok: true, result: { image: { name, size: 4, written: 4 } } }),
      ];
      for (const line of lines) {
        if (remote.gapMs) await waitOrClose(req, remote.gapMs);
        if (req.destroyed || res.writableEnded) return true;
        res.write(String(line).endsWith('\n') ? String(line) : `${line}\r\n`);
      }
      if (!remote.lines) {
        state.images[name] = imageMeta(name, 4, true);
        bytes.set(name, Buffer.from('remote'));
      }
      res.end();
      return true;
    }
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    calls.push({
      method: req.method,
      path: u.pathname,
      query: u.search,
      at: Date.now(),
      contentLength: req.headers['content-length'] ?? null,
      transferEncoding: req.headers['transfer-encoding'] ?? null,
    });

    const routeKey = `${req.method} ${u.pathname}`;
    const route = routes[routeKey];
    if (route) {
      const n = (routeHits[routeKey] = (routeHits[routeKey] ?? 0) + 1);
      const override = route.failTimes === undefined || n <= route.failTimes;
      if (override) {
        await sendRoute(req, res, route);
        return;
      }
      if (route.then) {
        await sendRoute(req, res, route.then);
        return;
      }
    }

    if (req.method === 'GET' && u.pathname === '/api/auth/check') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/streamer') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { streamer: { source: { resolution: { width: 1920, height: 1080 } } } },
      }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/streamer/snapshot') {
      const jpeg = await tinyJpeg();
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
      res.end(jpeg);
      return;
    }
    if (await handleMsd(req, res, u)) return;
    if (req.method === 'POST') {
      // HID/event endpoints land here (send_mouse_button, send_mouse_move,
      // send_key, print, send_shortcut, ...). 204 = accepted, no body.
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'mock: unknown route' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    calls,
    state,
    bytes,
    uploads,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
