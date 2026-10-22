// Modified 2026-10 by PLN: hide a fresh image for a monotonic interval (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: configurable error, status, and delay routes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD state machine (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: incomplete images and kvmd error classes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pauseWrite and seeded images (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: holdMutations for the MSD mutex test (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload busy flag and resetDuringWrite (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: storeIncomplete for fetch cleanup tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: kvmd removes an incomplete download unless storeIncomplete (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: preview sizing and OCR routes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hold a snapshot so two captures can overlap (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hold one streamer read so a capture can finish first (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: delay a fresh image in the MSD catalog (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a slow catalog read and a name that returns after remove (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: stall a write_remote stream after N lines (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pace a write body (GPL-3.0; see NOTICE).

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
 * `legacyFreeShape`, `writeHoldMs`, `pauseWrite`, `writePace`
 * (`step`, `pauseMs`), and `remote` (`lines`,
 * `chunks`, `gapMs`, `headerDelayMs`, `stallAfterHeadersMs`,
 * `stallAfterLines` with `stallMs`, `redirectTo`,
 * `storeIncomplete`). `redirectTo` answers 302 and does not follow it.
 * An error line does not leave an image: kvmd removes the incomplete
 * file itself. `storeIncomplete` keeps that file so a test can see our remove.
 * `pauseWrite` accepts POST /api/msd/write, pauses the request, and does
 * not read the body until the socket closes. `resetDuringWrite` destroys
 * the socket after the first body chunk. A write in progress sets
 * `state.busy` and `state.uploading`. `holdMutations` is how many
 * MSD set_params calls wait until `releaseHold()`. `images` seeds storage
 * (`'name.img'` or `{name,size,complete}`). `holdSnapshots` is how many
 * image snapshots wait until `releaseSnapshots()`. `holdNextStreamer()`
 * makes the next GET /api/streamer wait until `releaseStreamer()`.
 * `catalogHidePolls` omits a freshly written image from that many
 * GET /api/msd responses. `catalogHideMs` omits it until that many
 * milliseconds of monotonic time have passed since the first
 * GET /api/msd that sees it fresh. `catalogIncompletePolls` shows it with
 * complete false for that many responses. `catalogSize` reports that
 * size instead of the stored one. Seeded images are not affected.
 * `catalogReappearPolls` puts a removed fresh image back for that many
 * later GET /api/msd responses. `msdGetDelayMs` and `msdGetDelayCount`
 * pause that many GET /api/msd responses after a fresh image exists.
 * The pause ends early when the client aborts.
 * `drive` sets the initial
 * selection (`image` is a seeded name or null, plus connected/cdrom/rw).
 * A write that is aborted or shorter than Content-Length keeps a
 * complete:false image unless remove_incomplete is set. Image writable
 * follows kvmd: .iso is not writable; an upload is in storage and not
 * adopted, so any other name is writable. Error class names and the
 * messages that kvmd defines are from kvmd v4.227 (see NOTICE).
 */

import http from 'node:http';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

let jpegCache = null;
const previewCache = new Map();

async function tinyJpeg() {
  if (!jpegCache) {
    jpegCache = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#111111' },
    }).jpeg().toBuffer();
  }
  return jpegCache;
}

/** Fit a 1920x1080 frame inside the preview limits, preserving aspect ratio. */
function previewSize(maxWidth, maxHeight) {
  const srcW = 1920;
  const srcH = 1080;
  const limitW = maxWidth > 0 ? maxWidth : srcW;
  const limitH = maxHeight > 0 ? maxHeight : srcH;
  const scale = Math.min(limitW / srcW, limitH / srcH, 1);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

async function previewJpeg(maxWidth, maxHeight) {
  const size = previewSize(maxWidth, maxHeight);
  const key = `${size.width}x${size.height}`;
  if (!previewCache.has(key)) {
    previewCache.set(key, await sharp({
      create: { width: size.width, height: size.height, channels: 3, background: '#111111' },
    }).jpeg().toBuffer());
  }
  return previewCache.get(key);
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

function readIncomingPaced(req, step, pauseMs, pace, onProgress) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let since = 0;
    let settled = false;
    let hold = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    const consider = () => {
      if (settled || hold || since < step) return;
      since -= step;
      pace.pauses += 1;
      hold = true;
      req.pause();
      setTimeout(() => {
        hold = false;
        if (req.destroyed || settled) return;
        req.resume();
        consider();
      }, pauseMs);
    };
    req.on('data', (c) => {
      chunks.push(c);
      received += c.length;
      since += c.length;
      if (onProgress) onProgress(received);
      consider();
    });
    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
  });
}

function readIncoming(req, onProgress) {
  return new Promise((resolve) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    req.on('data', (c) => {
      chunks.push(c);
      received += c.length;
      if (onProgress) onProgress(received);
    });
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

function imageWritable(name) {
  // kvmd FileImage.__is_writable (v4.227): .iso is never writable.
  // An image in storage that was not adopted is writable. Uploads here
  // are that case, so every other name is writable.
  return !String(name).toLowerCase().endsWith('.iso');
}

function imageMeta(name, size, complete) {
  return {
    size,
    mod_ts: 0,
    writable: imageWritable(name),
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
  let writeBusy = false;
  const bytes = new Map();
  const uploads = [];
  const pace = { pauses: 0 };
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

  if (Array.isArray(options.images)) {
    for (const image of options.images) {
      const name = typeof image === 'string' ? image : image.name;
      const size = typeof image === 'string' || !Number.isInteger(image.size) ? 4 : image.size;
      const complete = typeof image === 'string' ? true : image.complete !== false;
      const body = Buffer.alloc(size, 0x61);
      state.images[name] = imageMeta(name, size, complete);
      bytes.set(name, body);
    }
  }
  const heldMutations = [];
  const heldSnapshots = [];
  const heldStreamer = [];
  const catalogFresh = new Set();
  let streamerHolds = 0;
  let imageSnapshots = 0;
  let catalogHideLeft = Number.isInteger(options.catalogHidePolls) ? options.catalogHidePolls : 0;
  const catalogHideMs = Number.isInteger(options.catalogHideMs) && options.catalogHideMs > 0
    ? options.catalogHideMs
    : 0;
  let catalogHideUntil = null;
  let catalogIncompleteLeft = Number.isInteger(options.catalogIncompletePolls)
    ? options.catalogIncompletePolls
    : 0;
  const catalogSize = Number.isInteger(options.catalogSize) ? options.catalogSize : null;
  let catalogReappearLeft = Number.isInteger(options.catalogReappearPolls)
    ? options.catalogReappearPolls
    : 0;
  let reappear = null;
  let msdGetDelayLeft = Number.isInteger(options.msdGetDelayCount) ? options.msdGetDelayCount : 0;
  const msdGetDelayMs = Number.isInteger(options.msdGetDelayMs) ? options.msdGetDelayMs : 0;
  let holdsLeft = Number.isInteger(options.holdMutations) ? options.holdMutations : 0;
  async function maybeHoldMutation() {
    if (holdsLeft <= 0) return;
    holdsLeft -= 1;
    await new Promise((resolve) => {
      heldMutations.push(resolve);
    });
  }

  if (options.drive && typeof options.drive === 'object') {
    const drive = options.drive;
    if (typeof drive.image === 'string') {
      const meta = state.images[drive.image];
      state.drive.image = meta
        ? { name: drive.image, size: meta.size, complete: meta.complete, removable: meta.removable }
        : { name: drive.image, size: null, complete: null, removable: null };
    } else if (drive.image === null) {
      state.drive.image = null;
    }
    if (typeof drive.connected === 'boolean') state.drive.connected = drive.connected;
    if (typeof drive.cdrom === 'boolean') state.drive.cdrom = drive.cdrom;
    if (typeof drive.rw === 'boolean') state.drive.rw = drive.rw;
  }

  function syncBusy() {
    state.busy = busyRemaining > 0 || writeBusy;
  }

  function storageImages() {
    const images = {};
    for (const [name, meta] of Object.entries(state.images)) {
      if (catalogFresh.has(name) && catalogHideLeft > 0) {
        catalogHideLeft -= 1;
        continue;
      }
      if (catalogFresh.has(name) && catalogHideMs > 0) {
        if (catalogHideUntil === null) catalogHideUntil = performance.now() + catalogHideMs;
        if (performance.now() < catalogHideUntil) continue;
      }
      let complete = meta.complete;
      let size = meta.size;
      if (catalogFresh.has(name) && catalogIncompleteLeft > 0) {
        catalogIncompleteLeft -= 1;
        complete = false;
      }
      if (catalogFresh.has(name) && catalogSize !== null) size = catalogSize;
      images[name] = {
        size,
        mod_ts: meta.mod_ts,
        writable: meta.writable,
        cdromable: meta.cdromable,
        removable: meta.removable,
        complete,
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
    if (busyRemaining > 0 || writeBusy) {
      if (busyRemaining > 0) busyRemaining -= 1;
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
      if (reappear && catalogReappearLeft > 0) {
        catalogReappearLeft -= 1;
        state.images[reappear.name] = reappear.meta;
        bytes.set(reappear.name, reappear.body);
        reappear = null;
      }
      if (catalogFresh.size > 0 && msdGetDelayLeft > 0 && msdGetDelayMs > 0) {
        msdGetDelayLeft -= 1;
        await waitOrClose(req, msdGetDelayMs);
        if (req.destroyed || res.writableEnded || res.destroyed) return true;
      }
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
      await maybeHoldMutation();
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
        kvmdFail(res, 400, 'MsdOperationError', 'connect failed');
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
      const meta = state.images[name];
      const body = bytes.get(name);
      delete state.images[name];
      bytes.delete(name);
      if (catalogFresh.has(name) && catalogReappearLeft > 0 && meta && body) {
        reappear = { name, meta, body };
      }
      if (state.drive.image && state.drive.image.name === name) state.drive.image = null;
      kvmdOk(res);
      return true;
    }
    if (req.method === 'POST' && u.pathname === '/api/msd/write') {
      if (options.resetDuringWrite) {
        req.once('data', () => req.socket.destroy());
        req.resume();
        return true;
      }
      if (options.pauseWrite) {
        writeBusy = true;
        syncBusy();
        state.uploading = {
          name: u.searchParams.get('image') || '',
          size: Number(req.headers['content-length']) || 0,
          written: 0,
        };
        try {
          req.pause();
          await new Promise((resolve) => {
            const finish = () => resolve();
            req.once('aborted', finish);
            req.once('close', finish);
            req.socket?.once('close', finish);
          });
          if (!res.writableEnded && !res.destroyed) res.destroy();
          return true;
        } finally {
          writeBusy = false;
          state.uploading = null;
          syncBusy();
        }
      }
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
      const declared = Number(contentLength);
      writeBusy = true;
      syncBusy();
      state.uploading = { name: image, size: declared, written: 0 };
      try {
        const onWritten = (n) => {
          if (state.uploading) state.uploading.written = n;
        };
        const paced = options.writePace;
        const buf = paced
          ? await readIncomingPaced(req, paced.step, paced.pauseMs, pace, onWritten)
          : await readIncoming(req, onWritten);
        const full = buf.length === declared;
        uploads.push({
          image,
          body: buf,
          contentLength,
          transferEncoding,
          removeIncomplete,
          complete: full && !options.failMidWrite,
        });
        const keepIncomplete = () => {
          if (removeIncomplete || !image) return;
          state.images[image] = imageMeta(image, buf.length, false);
          bytes.set(image, buf);
        };
        const keepComplete = () => {
          state.images[image] = imageMeta(image, buf.length, true);
          bytes.set(image, buf);
          catalogFresh.add(image);
          state.parts[''].free = Math.max(0, state.parts[''].free - buf.length);
        };
        if (options.failMidWrite) {
          keepIncomplete();
          if (clientGone(req, res)) return true;
          kvmdFail(res, 400, 'MsdOperationError', 'write failed');
          return true;
        }
        if (!full) {
          keepIncomplete();
          if (clientGone(req, res)) return true;
          kvmdFail(res, 400, 'ValidatorError', 'Content-Length does not match the body');
          return true;
        }
        if (options.writeHoldMs) await waitOrSocketClose(req, options.writeHoldMs);
        keepComplete();
        if (clientGone(req, res)) return true;
        kvmdOk(res, { image: { name: image, size: buf.length, written: buf.length } });
        return true;
      } finally {
        writeBusy = false;
        state.uploading = null;
        syncBusy();
      }
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
      if (Array.isArray(remote.chunks)) {
        for (const chunk of remote.chunks) {
          if (remote.gapMs) await waitOrClose(req, remote.gapMs);
          if (req.destroyed || res.writableEnded) return true;
          res.write(String(chunk));
        }
        res.end();
        return true;
      }
      const lines = remote.lines ?? [
        JSON.stringify({ ok: true, result: { image: { name, size: 4, written: 2 } } }),
        JSON.stringify({ ok: true, result: { image: { name, size: 4, written: 4 } } }),
      ];
      if (remote.storeIncomplete) {
        state.images[name] = imageMeta(name, 4, false);
        bytes.set(name, Buffer.from('part'));
        catalogFresh.add(name);
      }
      let remoteFailed = false;
      let remoteSize = 4;
      let sentLines = 0;
      for (const line of lines) {
        if (remote.gapMs) await waitOrClose(req, remote.gapMs);
        if (remote.stallAfterLines !== undefined && sentLines === remote.stallAfterLines) {
          await waitOrClose(req, remote.stallMs ?? 60000);
        }
        if (req.destroyed || res.writableEnded) return true;
        const text = String(line);
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.ok === false) remoteFailed = true;
          const info = parsed?.result?.image;
          if (info && Number.isFinite(info.size) && info.size > 0) remoteSize = info.size;
          if (info && Number.isFinite(info.written) && info.written > 0) remoteSize = info.written;
        } catch {
          // A non-JSON progress line is still forwarded.
        }
        res.write(text.endsWith('\n') ? text : `${text}\r\n`);
        sentLines += 1;
      }
      if (!remoteFailed) {
        state.images[name] = imageMeta(name, remoteSize, true);
        bytes.set(name, Buffer.alloc(remoteSize, 0x72));
        catalogFresh.add(name);
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
      if (streamerHolds > 0) {
        streamerHolds -= 1;
        await new Promise((resolve) => {
          heldStreamer.push(resolve);
        });
        if (req.destroyed || res.writableEnded || res.destroyed) return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { streamer: { source: { resolution: { width: 1920, height: 1080 } } } },
      }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/streamer/ocr') {
      const spec = options.ocr ?? { enabled: false, langs: [] };
      const available = Array.isArray(spec.langs) ? spec.langs : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: {
          ocr: {
            enabled: spec.enabled === true,
            langs: { available, default: available.slice(0, 1) },
          },
        },
      }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/streamer/snapshot') {
      const ocr = u.searchParams.get('ocr');
      if (ocr === '1' || ocr === 'true') {
        if (options.ocrDelayMs) await waitOrClose(req, options.ocrDelayMs);
        if (req.destroyed || res.writableEnded || res.destroyed) return;
        if (typeof options.ocrError === 'string') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            result: { error: 'OcrError', error_msg: options.ocrError },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(options.ocrText ?? 'screen text');
        return;
      }
      const hold = options.holdSnapshots ?? 0;
      const snapshotIndex = imageSnapshots;
      imageSnapshots += 1;
      if (snapshotIndex < hold) {
        await new Promise((resolve) => {
          heldSnapshots.push(resolve);
        });
        if (req.destroyed || res.writableEnded || res.destroyed) return;
      }
      if (options.snapshotJpeg && snapshotIndex >= (options.snapshotJpegAfter ?? 0)) {
        const jpeg = options.snapshotJpeg;
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
        res.end(jpeg);
        return;
      }
      if (u.searchParams.get('preview') === '1') {
        const maxWidth = Number(u.searchParams.get('preview_max_width') || 0);
        const maxHeight = Number(u.searchParams.get('preview_max_height') || 0);
        const jpeg = await previewJpeg(maxWidth, maxHeight);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length });
        res.end(jpeg);
        return;
      }
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
    pace,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      // A paused upload can leave the socket open after the client aborts.
      // Drop it so close settles.
      server.close(resolve);
      server.closeAllConnections();
    }),
    releaseHold() {
      const pending = heldMutations.splice(0);
      for (const release of pending) release();
    },
    releaseSnapshots() {
      const pending = heldSnapshots.splice(0);
      for (const release of pending) release();
    },
    holdNextStreamer() {
      streamerHolds += 1;
    },
    releaseStreamer() {
      const pending = heldStreamer.splice(0);
      for (const release of pending) release();
    },
  };
}
