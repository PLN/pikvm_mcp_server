// Modified 2026-10 by PLN: configurable error, status, and delay routes (GPL-3.0; see NOTICE).

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

export async function startKvmdMock(options = {}) {
  const calls = [];
  const routes = options.routes ?? {};
  const routeHits = {};

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: u.pathname, query: u.search, at: Date.now() });

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
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
