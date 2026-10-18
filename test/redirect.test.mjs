// Modified 2026-10 by PLN: kvmd redirects are not followed (GPL-3.0; see NOTICE).

/**
 * A 302 to another origin must not be followed. The second origin
 * receives nothing, so it never sees X-KVMD-Passwd.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { KvmdError, PiKVMClient } from '../dist/pikvm/client.js';
import { kvmdGet } from './hw/session.mjs';

const SENTINEL = 'sentinel-redirect-4c8e1a';
const USERINFO = 'secret-token';

function listen(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handler(req, res, Buffer.concat(chunks)));
  });
  const sockets = new Set();
  let connections = 0;
  const requests = [];
  server.on('connection', (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const started = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    connections: () => connections,
    async port() {
      await started;
      return server.address().port;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
    note(req) {
      requests.push(req.headers);
    },
  };
}

describe('kvmd redirects', { concurrency: false }, () => {
  let first;
  let second;
  let port1;
  let port2;

  before(async () => {
    second = listen((req, res) => {
      second.note(req);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '11' });
      res.end('{"ok":true}');
    });
    port2 = await second.port();
    first = listen((req, res) => {
      first.note(req);
      const location = `http://${USERINFO}:${USERINFO}@127.0.0.1:${port2}/private?pw=${SENTINEL}`;
      res.writeHead(302, { Location: location, 'Content-Length': '0' });
      res.end();
    });
    port1 = await first.port();
  });

  after(async () => {
    await first.close();
    await second.close();
  });

  function client() {
    return new PiKVMClient({
      host: `http://127.0.0.1:${port1}`,
      username: 'admin',
      password: SENTINEL,
      tls: { default: { device: 'default', mode: 'insecure' } },
      requestTimeoutMs: 3000,
      msdJobTimeoutMs: 3000,
      msdIdleTimeoutMs: 1000,
    });
  }

  function assertRedirect(err) {
    assert.ok(err instanceof KvmdError);
    assert.equal(err.type, 'PIKVM_UNEXPECTED_REDIRECT');
    assert.match(err.message, /HTTP 302/);
    assert.match(err.message, new RegExp(`http://127\\.0\\.0\\.1:${port2}`));
    assert.equal(err.message.includes(SENTINEL), false);
    assert.equal(err.message.includes(USERINFO), false);
    assert.equal(err.message.includes('/private'), false);
    assert.equal(err.type === 'PIKVM_UNREACHABLE', false);
    return true;
  }

  async function oneAttempt(call) {
    const seen = first.requests.length;
    const other = second.requests.length;
    await assert.rejects(call, assertRedirect);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(first.requests.length - seen, 1);
    assert.equal(second.requests.length, other);
    assert.equal(second.connections(), 0);
  }

  test('a GET 302 is terminal and the other origin sees nothing', async () => {
    const pikvm = client();
    try {
      await oneAttempt(() => pikvm.getMsdState());
      assert.equal(first.connections(), 1);
      assert.equal(first.requests.some((headers) => headers['x-kvmd-passwd'] === SENTINEL), true);
      assert.equal(second.requests.some((headers) => headers['x-kvmd-passwd'] === SENTINEL), false);
    } finally {
      await pikvm.close();
    }
  });

  test('HID and the upload path do not follow a 302', async () => {
    const pikvm = client();
    try {
      await oneAttempt(() => pikvm.type('a'));
      await oneAttempt(() => pikvm.msdWrite('mcp-hwtest.iso', Readable.from([Buffer.from('x')]), 1));
    } finally {
      await pikvm.close();
    }
  });

  test('kvmdGet does not follow a 302', async () => {
    const before = first.connections();
    await assert.rejects(
      () => kvmdGet({
        host: `http://127.0.0.1:${port1}`,
        username: 'admin',
        password: SENTINEL,
        tls: { default: { device: 'default', mode: 'insecure' } },
        requestTimeoutMs: 3000,
      }, '/api/auth/check'),
      (err) => {
        const text = err instanceof Error ? err.message : String(err);
        assert.match(text, /PIKVM_UNEXPECTED_REDIRECT/);
        assert.match(text, /HTTP 302/);
        assert.match(text, new RegExp(`http://127\\.0\\.0\\.1:${port2}`));
        assert.equal(text.includes(SENTINEL), false);
        assert.equal(text.includes(USERINFO), false);
        return true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(first.connections() - before, 1);
    assert.equal(second.requests.length, 0);
  });
});
