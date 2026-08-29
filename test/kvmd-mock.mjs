/**
 * Minimal KVMD REST mock implementing exactly the routes src/pikvm/client.ts
 * calls. Never touches real hardware — every HID POST just returns 204 and
 * is recorded in `calls` for assertions.
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

export async function startKvmdMock() {
  const calls = [];

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    calls.push({ method: req.method, path: u.pathname, query: u.search });

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
