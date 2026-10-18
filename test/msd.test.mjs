// Modified 2026-10 by PLN: MSD status, mount, eject, and arm-gate tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: expectImage, preflight, and MSD mutex tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload jobs, remove, and disconnected expectImage (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hashing jobs, bad-image cleanup, upload try-lock (GPL-3.0; see NOTICE).

/**
 * MSD tools against the mock. The HTTP harness matches test/http.test.mjs.
 * No real PiKVM is contacted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { createMcpServer, ARM_GATED_TOOLS, MSD_READ_ONLY_TOOLS, msdToolRequiresArm } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const execFileAsync = promisify(execFile);
const TOKEN = 'test-bearer-token-0123456789abcdef';
const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const calibrationConfig = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };
const OPEN = { armGateEnforced: false, msdArmGateEnforced: false };

function depsFactory(mock, flags) {
  const pikvm = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
  });
  return () => createMcpServer({
    pikvm,
    lock: new BusyLock(),
    calibrationConfig,
    armGateEnforced: flags.armGateEnforced,
    msdArmGateEnforced: flags.msdArmGateEnforced,
    msd: flags.msd,
  });
}

function rpcHeaders(sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

async function rpc(base, { sessionId, method, params }) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function openSession(base) {
  const res = await rpc(base, {
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'msd-test', version: '1.0' },
    },
  });
  const body = await res.json();
  assert.equal(res.status, 200, `initialize failed: ${JSON.stringify(body)}`);
  const sessionId = res.headers.get('mcp-session-id');
  assert.ok(sessionId, 'initialize response must set mcp-session-id');
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(base, sessionId, name, args) {
  const res = await rpc(base, {
    sessionId,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const body = await res.json();
  assert.equal(res.status, 200, `${name}: ${JSON.stringify(body)}`);
  return body.result;
}

function msdPosts(mock) {
  return mock.calls.filter((call) => call.method === 'POST' && call.path.startsWith('/api/msd'));
}

async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CONNECTED = {
  images: ['disk.img', 'other.img'],
  drive: { image: 'disk.img', connected: true, cdrom: false, rw: false },
};

async function withSession(mockOptions, flags, fn) {
  const mock = await startKvmdMock(mockOptions);
  const httpServer = await startHttpServer({
    port: 0,
    bearerToken: TOKEN,
    createServer: depsFactory(mock, flags),
  });
  const { port } = httpServer.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const sessionId = await openSession(base);
    await fn({ mock, base, sessionId });
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    await mock.close();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test('MSD arm-gate allows only the read-only list', () => {
  assert.deepEqual([...MSD_READ_ONLY_TOOLS], ['pikvm_msd_status', 'pikvm_msd_job']);
  assert.equal(msdToolRequiresArm('pikvm_msd_status'), false);
  assert.equal(msdToolRequiresArm('pikvm_msd_job'), false);
  assert.equal(msdToolRequiresArm('pikvm_msd_mount'), true);
  assert.equal(msdToolRequiresArm('pikvm_msd_eject'), true);
  assert.equal(msdToolRequiresArm('pikvm_msd_upload'), true);
  assert.equal(msdToolRequiresArm('pikvm_msd_remove'), true);
  assert.equal(msdToolRequiresArm('pikvm_type'), false);
  assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_mount'), false);
  assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_eject'), false);
  assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_status'), false);
  assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_job'), false);
  assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_upload'), false);
  assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_remove'), false);
});

test('HTTP: MSD disarmed blocks mount and eject, status still reads', async () => {
  await withSession(
    { images: ['disk.img'] },
    { armGateEnforced: true, msdArmGateEnforced: true },
    async ({ mock, base, sessionId }) => {
      for (const [name, args] of [
        ['pikvm_msd_mount', { image: 'disk.img', mode: 'flash', confirmImage: 'disk.img' }],
        ['pikvm_msd_eject', { expectImage: '' }],
        ['pikvm_msd_upload', { file: 'disk.img', confirmImage: 'disk.img' }],
        ['pikvm_msd_remove', { image: 'disk.img', confirmImage: 'disk.img' }],
      ]) {
        const result = await callTool(base, sessionId, name, args);
        assert.equal(result.isError, true, name);
        assert.match(result.content[0].text, /MSD arm-gate/);
        assert.match(result.content[0].text, /PIKVM_MCP_ARM_MSD=1/);
      }
      assert.deepEqual(msdPosts(mock), []);
      const job = await callTool(base, sessionId, 'pikvm_msd_job', { jobId: 'missing' });
      assert.equal(job.isError, true);
      assert.match(job.content[0].text, /unknown job/);
      assert.doesNotMatch(job.content[0].text, /arm-gate/);
      assert.deepEqual(msdPosts(mock), []);
      const status = await callTool(base, sessionId, 'pikvm_msd_status', {});
      assert.equal(status.isError, undefined);
      const body = JSON.parse(status.content[0].text);
      assert.equal(body.online, true);
      assert.equal(body.busy, false);
      assert.equal(body.drive.connected, false);
      assert.equal(body.images['disk.img'].complete, true);
      assert.equal(typeof body.free, 'number');
      assert.equal(body.uploading, null);
      assert.equal(body.downloading, null);
      assert.deepEqual(msdPosts(mock), []);
    },
  );
});

test('HTTP: ARM_HID armed does not arm MSD', async () => {
  await withSession(
    { images: ['disk.img'] },
    { armGateEnforced: false, msdArmGateEnforced: true },
    async ({ mock, base, sessionId }) => {
      const click = await callTool(base, sessionId, 'pikvm_mouse_click', { button: 'left' });
      assert.equal(click.isError, undefined);
      assert.ok(mock.calls.some((call) => call.path === '/api/hid/events/send_mouse_button'));
      const mount = await callTool(base, sessionId, 'pikvm_msd_mount', {
        image: 'disk.img',
        mode: 'flash',
        confirmImage: 'disk.img',
      });
      assert.equal(mount.isError, true);
      assert.match(mount.content[0].text, /PIKVM_MCP_ARM_MSD=1/);
      assert.deepEqual(msdPosts(mock), []);
    },
  );
});

test('confirmImage mismatch makes no kvmd call', async () => {
  await withSession({ images: ['disk.img'] }, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'disk.img',
      mode: 'cdrom',
      rw: true,
      confirmImage: 'other.img',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /confirmImage does not match image/);
    assert.deepEqual(mock.calls.filter((call) => call.path.startsWith('/api/msd')), []);
    assert.equal(mock.state.drive.image, null);
    assert.equal(mock.state.drive.connected, false);
  });
});

test('expectImage mismatch makes no mutating kvmd call', async () => {
  await withSession(
    { images: ['disk.img'], drive: { image: 'disk.img', connected: true, cdrom: true, rw: false } },
    OPEN,
    async ({ mock, base, sessionId }) => {
      const result = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: 'other.img' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /expectImage mismatch/);
      assert.deepEqual(msdPosts(mock), []);
      assert.equal(mock.calls.filter((call) => call.method === 'GET' && call.path === '/api/msd').length, 1);
      assert.equal(mock.state.drive.connected, true);
      assert.equal(mock.state.drive.image.name, 'disk.img');
    },
  );
});

test('eject twice: the second reports alreadyDisconnected', async () => {
  await withSession({ images: ['disk.img'] }, OPEN, async ({ mock, base, sessionId }) => {
    const mounted = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'disk.img',
      mode: 'flash',
      confirmImage: 'disk.img',
    });
    assert.equal(mounted.isError, undefined, mounted.content[0].text);
    const mountedBody = JSON.parse(mounted.content[0].text);
    assert.equal(mountedBody.drive.connected, true);
    assert.equal(mountedBody.drive.image.name, 'disk.img');

    const first = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: 'disk.img' });
    assert.equal(first.isError, undefined, first.content[0].text);
    const firstBody = JSON.parse(first.content[0].text);
    assert.equal(firstBody.alreadyDisconnected, false);
    assert.equal(firstBody.drive.connected, false);
    assert.equal(firstBody.drive.image.name, 'disk.img');

    const second = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: 'disk.img' });
    assert.equal(second.isError, undefined, second.content[0].text);
    const secondBody = JSON.parse(second.content[0].text);
    assert.equal(secondBody.alreadyDisconnected, true);
    assert.equal(secondBody.drive.connected, false);
    assert.equal(secondBody.drive.image.name, 'disk.img');
    assert.equal(mock.state.drive.connected, false);
  });
});

test('mount failure rolls back to the snapshot', async () => {
  await withSession(
    { images: ['disk.img'], failSetConnected: true },
    OPEN,
    async ({ mock, base, sessionId }) => {
      const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
        image: 'disk.img',
        mode: 'flash',
        rw: true,
        confirmImage: 'disk.img',
      });
      assert.equal(result.isError, true);
      const body = JSON.parse(result.content[0].text);
      assert.equal(body.error.type, 'MsdOperationError');
      assert.equal(body.error.status, 400);
      assert.equal(body.error.endpoint, 'POST /api/msd/set_connected');
      assert.equal(body.restored.image, null);
      assert.equal(body.restored.connected, false);
      assert.equal(body.restored.cdrom, true);
      assert.equal(body.restored.rw, false);
      assert.equal(body.rollbackError, undefined);
      assert.equal(mock.state.drive.image, null);
      assert.equal(mock.state.drive.connected, false);
      assert.equal(mock.state.drive.cdrom, true);
      assert.equal(mock.state.drive.rw, false);
    },
  );
});

test('a failed mount rollback reports rollbackError', async () => {
  await withSession(
    {
      images: ['orig.img', 'next.img'],
      drive: { image: 'orig.img', connected: true, cdrom: false, rw: false },
      failSetConnected: true,
    },
    OPEN,
    async ({ mock, base, sessionId }) => {
      const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
        image: 'next.img',
        mode: 'flash',
        rw: false,
        confirmImage: 'next.img',
        expectImage: 'orig.img',
      });
      assert.equal(result.isError, true);
      const body = JSON.parse(result.content[0].text);
      assert.equal(body.error.type, 'MsdOperationError');
      assert.equal(body.error.endpoint, 'POST /api/msd/set_connected');
      assert.equal(body.rollbackError.length, 1);
      assert.equal(body.rollbackError[0].type, 'MsdOperationError');
      assert.equal(body.rollbackError[0].endpoint, 'POST /api/msd/set_connected');
      assert.equal(body.restored.connected, false);
      assert.equal(body.restored.image.name, 'orig.img');
      assert.equal(body.restored.cdrom, false);
      assert.equal(body.restored.rw, false);
      assert.equal(mock.state.drive.connected, false);
      assert.equal(mock.state.drive.image.name, 'orig.img');
    },
  );
});

test('cdrom and non-writable images report rw false after kvmd coercion', async () => {
  await withSession({ images: ['disk.img', 'os.iso'] }, OPEN, async ({ mock, base, sessionId }) => {
    const cdrom = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'disk.img',
      mode: 'cdrom',
      rw: true,
      confirmImage: 'disk.img',
    });
    assert.equal(cdrom.isError, undefined, cdrom.content[0].text);
    const cdromBody = JSON.parse(cdrom.content[0].text);
    assert.equal(cdromBody.drive.cdrom, true);
    assert.equal(cdromBody.drive.rw, false);
    assert.equal(cdromBody.drive.connected, true);
    assert.equal(cdromBody.drive.image.name, 'disk.img');
    const cdromParams = mock.calls.find((call) => call.path === '/api/msd/set_params' && call.query.includes('disk.img'));
    assert.match(cdromParams.query, /cdrom=1/);
    assert.match(cdromParams.query, /rw=1/);

    const flash = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'os.iso',
      mode: 'flash',
      rw: true,
      confirmImage: 'os.iso',
      expectImage: 'disk.img',
    });
    assert.equal(flash.isError, undefined, flash.content[0].text);
    const flashBody = JSON.parse(flash.content[0].text);
    assert.equal(flashBody.drive.cdrom, false);
    assert.equal(flashBody.drive.rw, false);
    assert.equal(flashBody.drive.connected, true);
    assert.equal(flashBody.drive.image.name, 'os.iso');
    const isoParams = mock.calls.find((call) => call.path === '/api/msd/set_params' && call.query.includes('os.iso'));
    assert.match(isoParams.query, /cdrom=0/);
    assert.match(isoParams.query, /rw=1/);
  });
});

test('mount refuses to eject a connected drive unless expectImage matches', async () => {
  await withSession(CONNECTED, OPEN, async ({ mock, base, sessionId }) => {
    const mountOther = {
      image: 'other.img',
      mode: 'flash',
      confirmImage: 'other.img',
    };
    const missing = await callTool(base, sessionId, 'pikvm_msd_mount', mountOther);
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /MsdExpectImageError/);
    assert.match(missing.content[0].text, /disk\.img/);
    assert.deepEqual(msdPosts(mock), []);

    const mismatch = await callTool(base, sessionId, 'pikvm_msd_mount', {
      ...mountOther,
      expectImage: 'nope.img',
    });
    assert.equal(mismatch.isError, true);
    assert.match(mismatch.content[0].text, /MsdExpectImageError/);
    assert.match(mismatch.content[0].text, /disk\.img/);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');

    const match = await callTool(base, sessionId, 'pikvm_msd_mount', {
      ...mountOther,
      expectImage: 'disk.img',
    });
    assert.equal(match.isError, undefined, match.content[0].text);
    const body = JSON.parse(match.content[0].text);
    assert.equal(body.drive.connected, true);
    assert.equal(body.drive.image.name, 'other.img');
  });
});

test('a URL image makes no MSD POST', async () => {
  await withSession(CONNECTED, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'nbd://host/disk',
      mode: 'flash',
      confirmImage: 'nbd://host/disk',
      expectImage: 'disk.img',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /:\/\//);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');
  });
});

test('an unknown image makes no MSD POST', async () => {
  await withSession(CONNECTED, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'missing.img',
      mode: 'flash',
      confirmImage: 'missing.img',
      expectImage: 'disk.img',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not in storage/);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');
  });
});

test('an incomplete image makes no MSD POST', async () => {
  await withSession({
    images: ['disk.img', { name: 'part.img', complete: false }],
    drive: { image: 'disk.img', connected: true, cdrom: false, rw: false },
  }, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'part.img',
      mode: 'flash',
      confirmImage: 'part.img',
      expectImage: 'disk.img',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /incomplete/);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');
  });
});

test('a busy kvmd makes no MSD POST', async () => {
  await withSession({ ...CONNECTED, busyFor: 1 }, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'other.img',
      mode: 'flash',
      confirmImage: 'other.img',
      expectImage: 'disk.img',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /busy/);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');
  });
});

test('an offline kvmd makes no MSD POST', async () => {
  await withSession({
    ...CONNECTED,
    online: false,
  }, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'other.img',
      mode: 'flash',
      confirmImage: 'other.img',
      expectImage: 'disk.img',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /offline/);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');
  });
});

test('rollback keeps every error, including an unrestorable URL image', async () => {
  await withSession({
    images: ['disk.img'],
    drive: { image: 'nbd://host/disk', connected: true, cdrom: false, rw: false },
    failSetConnected: true,
  }, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'disk.img',
      mode: 'flash',
      confirmImage: 'disk.img',
      expectImage: 'nbd://host/disk',
    });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.rollbackError.length, 2);
    assert.match(body.rollbackError[0].message, /msdSetParams refuses URLs/);
    assert.equal(body.rollbackError[1].type, 'MsdOperationError');
    assert.equal(body.rollbackError[1].endpoint, 'POST /api/msd/set_connected');
    const restores = mock.calls.filter((call) => (
      call.path === '/api/msd/set_params' && call.query.includes('nbd')
    ));
    assert.deepEqual(restores, []);
    assert.equal(mock.state.drive.connected, false);
  });
});

test('eject surfaces a kvmd error other than MsdDisconnectedError', async () => {
  await withSession({
    images: ['disk.img'],
    drive: { image: 'disk.img', connected: true, cdrom: true, rw: false },
    routes: {
      'POST /api/msd/set_connected': {
        status: 409,
        body: {
          ok: false,
          result: {
            error: 'MsdIsBusyError',
            error_msg: 'Performing another MSD operation, please try again later',
          },
        },
      },
    },
  }, OPEN, async ({ mock, base, sessionId }) => {
    const result = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: 'disk.img' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /MsdIsBusyError/);
    assert.doesNotMatch(result.content[0].text, /alreadyDisconnected/);
    assert.equal(mock.state.drive.connected, true);
    assert.equal(mock.state.drive.image.name, 'disk.img');
  });
});

test('MSD mount is single-flight across HTTP sessions', { timeout: 15000 }, async () => {
  await withSession(
    { images: ['a.img', 'b.img'], holdMutations: 1 },
    OPEN,
    async ({ mock, base, sessionId }) => {
      const other = await openSession(base);
      const first = callTool(base, sessionId, 'pikvm_msd_mount', {
        image: 'a.img',
        mode: 'flash',
        confirmImage: 'a.img',
      });
      assert.equal(await waitFor(() => msdPosts(mock).length >= 1), true);
      const second = callTool(base, other, 'pikvm_msd_mount', {
        image: 'b.img',
        mode: 'flash',
        confirmImage: 'b.img',
        expectImage: 'a.img',
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(msdPosts(mock).length, 1);
      mock.releaseHold();
      const [mountedA, mountedB] = await Promise.all([first, second]);
      assert.equal(mountedA.isError, undefined, mountedA.content[0].text);
      assert.equal(mountedB.isError, undefined, mountedB.content[0].text);
      assert.equal(JSON.parse(mountedA.content[0].text).drive.image.name, 'a.img');
      assert.equal(JSON.parse(mountedB.content[0].text).drive.image.name, 'b.img');
      const order = msdPosts(mock).map((call) => `${call.path}${call.query}`);
      const params = order.filter((item) => item.startsWith('/api/msd/set_params'));
      assert.equal(params.length, 2);
      assert.match(params[0], /a\.img/);
      assert.match(params[1], /b\.img/);
      const firstConnect = order.findIndex((item) => item.startsWith('/api/msd/set_connected'));
      const secondParams = order.findIndex((item) => item.includes('b.img'));
      assert.ok(firstConnect !== -1 && firstConnect < secondParams);
      assert.equal(mock.state.drive.image.name, 'b.img');
      assert.equal(mock.state.drive.connected, true);
    },
  );
});

test('HTTP process: PIKVM_MCP_ARM_HID=1 leaves MSD disarmed', { timeout: 20000 }, async () => {
  const mock = await startKvmdMock({ images: ['disk.img'] });
  const port = await freePort();
  const env = { ...process.env };
  delete env.PIKVM_MCP_ARM_MSD;
  env.PIKVM_MCP_NO_DOTENV = '1';
  env.PIKVM_HOST = mock.url;
  env.PIKVM_PASSWORD = 'testpw';
  env.PIKVM_USERNAME = 'admin';
  env.PIKVM_MCP_PORT = String(port);
  env.PIKVM_MCP_HOST = '127.0.0.1';
  env.PIKVM_MCP_BEARER = TOKEN;
  env.PIKVM_MCP_ARM_HID = '1';
  const child = spawn('node', [join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`HTTP server did not start. stderr: ${stderr}`));
      }, 12000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes('PiKVM MCP Server running')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP server exited ${code}. stderr: ${stderr}`));
      });
    });
    assert.match(stderr, /HID ARMED/);
    assert.match(stderr, /MSD DISARMED/);
    const base = `http://127.0.0.1:${port}`;
    const sessionId = await openSession(base);
    const mount = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'disk.img',
      mode: 'flash',
      confirmImage: 'disk.img',
    });
    assert.equal(mount.isError, true);
    assert.match(mount.content[0].text, /PIKVM_MCP_ARM_MSD=1/);
    assert.deepEqual(msdPosts(mock), []);
    const status = await callTool(base, sessionId, 'pikvm_msd_status', {});
    assert.equal(status.isError, undefined);
    assert.equal(JSON.parse(status.content[0].text).online, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await mock.close();
  }
});

test('stdio: MSD mount is ungated', { timeout: 20000 }, async () => {
  const mock = await startKvmdMock({ images: ['disk.img'] });
  const env = { ...process.env };
  delete env.PIKVM_MCP_PORT;
  delete env.PIKVM_MCP_BEARER;
  delete env.PIKVM_MCP_ARM_MSD;
  env.PIKVM_MCP_ARM_HID = '1';
  env.PIKVM_MCP_NO_DOTENV = '1';
  env.PIKVM_HOST = mock.url;
  env.PIKVM_PASSWORD = 'testpw';
  env.PIKVM_USERNAME = 'admin';
  const child = spawn('node', [join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const responses = new Map();
  let carry = '';
  let wakeup = null;
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    carry += chunk;
    let idx;
    while ((idx = carry.indexOf('\n')) !== -1) {
      const line = carry.slice(0, idx).trim();
      carry = carry.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    }
    if (wakeup) { wakeup(); wakeup = null; }
  });
  child.on('exit', () => { closed = true; if (wakeup) { wakeup(); wakeup = null; } });
  async function waitForResponse(id) {
    const deadline = Date.now() + 12000;
    while (!responses.has(id)) {
      if (closed) throw new Error(`child exited early. stderr: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for id=${id}. stderr: ${stderr}`);
      await new Promise((resolve) => { wakeup = resolve; setTimeout(resolve, 200); });
    }
    return responses.get(id);
  }
  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'msd-test', version: '1.0' },
      },
    }) + '\n');
    await waitForResponse(1);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'pikvm_msd_mount',
        arguments: { image: 'disk.img', mode: 'flash', confirmImage: 'disk.img' },
      },
    }) + '\n');
    const mount = await waitForResponse(2);
    assert.equal(mount.result.isError, undefined, JSON.stringify(mount.result));
    const body = JSON.parse(mount.result.content[0].text);
    assert.equal(body.drive.connected, true);
    assert.equal(body.drive.image.name, 'disk.img');
    assert.equal(mock.state.drive.connected, true);
    assert.doesNotMatch(stderr, /MSD arm-gate/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await mock.close();
  }
});

function digest(body) {
  return createHash('sha256').update(body).digest('hex');
}

function uploadMsd(dir, extra = {}) {
  return {
    ...OPEN,
    msd: {
      localDir: dir,
      maxBytes: 1024 * 1024,
      extensions: ['.iso', '.img'],
      ...extra,
    },
  };
}

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pikvm-msd-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function toolNames(base, sessionId) {
  const res = await rpc(base, { sessionId, method: 'tools/list', params: {} });
  const body = await res.json();
  return body.result.tools.map((tool) => tool.name);
}

async function pollJob(base, sessionId, jobId) {
  let body;
  assert.equal(await waitFor(async () => {
    const result = await callTool(base, sessionId, 'pikvm_msd_job', { jobId });
    assert.equal(result.isError, undefined, result.content[0].text);
    body = JSON.parse(result.content[0].text);
    return body.state !== 'running' && body.state !== 'hashing';
  }, 4000), true);
  return body;
}

test('expectImage is checked when the drive is disconnected', async () => {
  await withSession({
    images: ['disk.img', 'other.img'],
    drive: { image: 'disk.img', connected: false, cdrom: false, rw: false },
  }, OPEN, async ({ mock, base, sessionId }) => {
    const refused = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'other.img',
      mode: 'flash',
      confirmImage: 'other.img',
      expectImage: 'nope.img',
    });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /MsdExpectImageError/);
    assert.match(refused.content[0].text, /disk\.img/);
    assert.deepEqual(msdPosts(mock), []);
    assert.equal(mock.state.drive.connected, false);
    assert.equal(mock.state.drive.image.name, 'disk.img');

    const mounted = await callTool(base, sessionId, 'pikvm_msd_mount', {
      image: 'other.img',
      mode: 'flash',
      confirmImage: 'other.img',
      expectImage: 'disk.img',
    });
    assert.equal(mounted.isError, undefined, mounted.content[0].text);
    assert.equal(JSON.parse(mounted.content[0].text).drive.image.name, 'other.img');
  });
});

test('upload, remove, and job polling', { timeout: 30000 }, async (t) => {
  const body = Buffer.from('abcd');
  const sum = digest(body);

  await t.test('pikvm_msd_upload is hidden until the local directory is set', async () => {
    await withSession({ images: [] }, OPEN, async ({ base, sessionId }) => {
      const hidden = await toolNames(base, sessionId);
      assert.equal(hidden.includes('pikvm_msd_upload'), false);
      assert.equal(hidden.includes('pikvm_msd_job'), true);
      assert.equal(hidden.includes('pikvm_msd_remove'), true);
      const refused = await callTool(base, sessionId, 'pikvm_msd_upload', {
        file: 'disk.img',
        confirmImage: 'disk.img',
      });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /PIKVM_MSD_LOCAL_DIR/);
    });
    await withDir(async (dir) => {
      await withSession({ images: [] }, uploadMsd(dir), async ({ base, sessionId }) => {
        const shown = await toolNames(base, sessionId);
        assert.equal(shown.includes('pikvm_msd_upload'), true);
      });
    });
  });

  await t.test('path rejections make no kvmd call', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'real.img'), body);
      await symlink(join(dir, 'real.img'), join(dir, 'link.img'));
      await mkdir(join(dir, 'dir.img'));
      await writeFile(join(dir, 'big.img'), body);
      await execFileAsync('mkfifo', [join(dir, 'pipe.img')]);
      const cases = [
        ['traversal', { file: '../real.img', confirmImage: '../real.img' }, /bare image name/],
        ['absolute', { file: '/tmp/real.img', confirmImage: '/tmp/real.img' }, /bare image name/],
        ['symlink', { file: 'link.img', confirmImage: 'link.img' }, /symlink/],
        ['directory', { file: 'dir.img', confirmImage: 'dir.img' }, /directory/],
        ['fifo', { file: 'pipe.img', confirmImage: 'pipe.img' }, /not a regular file/],
        ['oversize', { file: 'big.img', confirmImage: 'big.img' }, /PIKVM_MSD_MAX_BYTES/],
        ['sha256 format', { file: 'real.img', confirmImage: 'real.img', sha256: 'nope' }, /64 hex/],
      ];
      for (const [label, args, pattern] of cases) {
        const flags = label === 'oversize'
          ? uploadMsd(dir, { maxBytes: 3 })
          : uploadMsd(dir);
        await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
          const result = await callTool(base, sessionId, 'pikvm_msd_upload', args);
          assert.equal(result.isError, true, label);
          assert.match(result.content[0].text, pattern, label);
          assert.deepEqual(mock.calls, [], label);
        });
      }
    });
  });

  await t.test('pre-check refusals make no MSD POST', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      const cases = [
        ['connected', { images: ['other.img'], drive: { image: 'other.img', connected: true, cdrom: false, rw: false } }, /connected/],
        ['exists', { images: ['disk.img'] }, /already exists/],
        ['free', { images: [], free: 2 }, /free space/],
        ['busy', { images: [], busyFor: 1 }, /busy/],
      ];
      const types = {
        connected: 'MsdConnectedError',
        exists: 'MsdImageExistsError',
        free: 'MsdFreeSpaceError',
        busy: 'MsdBusyError',
      };
      for (const [label, mockOptions, pattern] of cases) {
        await withSession(mockOptions, uploadMsd(dir), async ({ mock, base, sessionId }) => {
          const result = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
          });
          assert.equal(result.isError, undefined, `${label}: ${result.content[0].text}`);
          const { jobId } = JSON.parse(result.content[0].text);
          const failed = await pollJob(base, sessionId, jobId);
          assert.equal(failed.state, 'failed', label);
          assert.equal(failed.error.type, types[label], label);
          assert.match(failed.error.message, pattern, label);
          assert.deepEqual(msdPosts(mock), [], label);
        });
      }
    });
  });

  await t.test('a happy upload reaches done with the same bytes and sha256', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [], free: 1000 }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
          sha256: sum,
        });
        assert.equal(started.isError, undefined, started.content[0].text);
        const { jobId } = JSON.parse(started.content[0].text);
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        assert.equal(done.bytes, body.length);
        assert.equal(done.total, body.length);
        assert.equal(done.sha256, sum);
        assert.equal(done.error, undefined);
        assert.equal(mock.bytes.get('disk.img').toString(), 'abcd');
        assert.equal(mock.state.images['disk.img'].complete, true);
        const write = mock.calls.find((call) => call.path === '/api/msd/write');
        assert.match(write.query, /remove_incomplete=1/);
        assert.equal(mock.state.drive.connected, false);
      });
    });
  });

  await t.test('job polling sees running before done', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [], writeHoldMs: 400 }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        assert.equal(await waitFor(() => mock.calls.some((call) => call.path === '/api/msd/write')), true);
        const mid = await callTool(base, sessionId, 'pikvm_msd_job', { jobId });
        assert.equal(mid.isError, undefined, mid.content[0].text);
        const running = JSON.parse(mid.content[0].text);
        assert.equal(running.state, 'running');
        assert.equal(running.total, body.length);
        assert.equal(typeof running.bytes, 'number');
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        assert.equal(done.bytes, body.length);
        assert.equal(done.sha256, sum);
      });
    });
  });

  await t.test('a mid-upload reset is PIKVM_MSD_STATE_UNKNOWN on the job', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [], resetDuringWrite: true }, uploadMsd(dir), async ({ base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.error.type, 'PIKVM_MSD_STATE_UNKNOWN');
      });
    });
  });

  await t.test('a sha256 mismatch fails the job before any kvmd call', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [] }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
          sha256: 'a'.repeat(64),
        });
        assert.equal(started.isError, undefined, started.content[0].text);
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId);
        assert.equal(failed.state, 'failed');
        assert.match(failed.error.message, /sha256 mismatch/);
        assert.deepEqual(mock.calls, []);
        assert.equal(mock.state.images['disk.img'], undefined);
      });
    });
  });

  await t.test('the jobId returns before hashing finishes', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      let release;
      const flags = uploadMsd(dir, {
        beforeHash: () => new Promise((resolve) => { release = resolve; }),
      });
      try {
        await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
            sha256: sum,
          });
          assert.equal(started.isError, undefined, started.content[0].text);
          const { jobId } = JSON.parse(started.content[0].text);
          assert.equal(typeof release, 'function');
          const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
          assert.equal(mid.state, 'hashing');
          assert.equal(mid.sha256, undefined);
          assert.equal(mid.total, body.length);
          assert.deepEqual(mock.calls, []);
          release();
          const done = await pollJob(base, sessionId, jobId);
          assert.equal(done.state, 'done');
          assert.equal(done.sha256, sum);
        });
      } finally {
        if (release) release();
      }
    });
  });

  await t.test('a second upload fails immediately while one is hashing', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      let release;
      const flags = uploadMsd(dir, {
        beforeHash: () => new Promise((resolve) => { release = resolve; }),
      });
      try {
        await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
          });
          const { jobId } = JSON.parse(started.content[0].text);
          assert.equal(await waitFor(() => typeof release === 'function'), true);
          const other = await openSession(base);
          const began = Date.now();
          const refused = await callTool(base, other, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
          });
          assert.ok(Date.now() - began < 700, 'second upload waited on the first');
          assert.equal(refused.isError, true);
          assert.match(refused.content[0].text, /MsdUploadBusyError/);
          assert.match(refused.content[0].text, /upload already running/);
          assert.deepEqual(mock.calls, []);
          release();
          release = undefined;
          const done = await pollJob(base, sessionId, jobId);
          assert.equal(done.state, 'done');
        });
      } finally {
        if (release) release();
      }
    });
  });

  await t.test('a file changed before the stream fails the job and the image is removed', async () => {
    await withDir(async (dir) => {
      const file = join(dir, 'disk.img');
      await writeFile(file, body);
      let release;
      const flags = uploadMsd(dir, {
        beforeUploadStream: () => new Promise((resolve) => { release = resolve; }),
      });
      try {
        await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
          });
          const { jobId } = JSON.parse(started.content[0].text);
          assert.equal(await waitFor(() => typeof release === 'function'), true);
          await writeFile(file, Buffer.from('wxyz'));
          release();
          release = undefined;
          const failed = await pollJob(base, sessionId, jobId);
          assert.equal(failed.state, 'failed');
          assert.match(failed.error.message, /sha256 changed/);
          assert.notEqual(failed.sha256, sum);
          assert.equal(failed.removed, true);
          assert.equal(failed.removeError, undefined);
          assert.equal(mock.state.images['disk.img'], undefined);
        });
      } finally {
        if (release) release();
      }
    });
  });

  await t.test('finished jobs past the cap are dropped', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [] }, uploadMsd(dir, { jobLimit: 2 }), async ({ base, sessionId }) => {
        const ids = [];
        for (let i = 0; i < 3; i += 1) {
          const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
            sha256: 'a'.repeat(64),
          });
          assert.equal(started.isError, undefined, started.content[0].text);
          const { jobId } = JSON.parse(started.content[0].text);
          ids.push(jobId);
          const failed = await pollJob(base, sessionId, jobId);
          assert.equal(failed.state, 'failed');
        }
        const gone = await callTool(base, sessionId, 'pikvm_msd_job', { jobId: ids[0] });
        assert.equal(gone.isError, true);
        assert.match(gone.content[0].text, /unknown job/);
        const kept = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId: ids[2] })).content[0].text);
        assert.equal(kept.state, 'failed');
      });
    });
  });

  await t.test('a finished job is dropped after its ttl', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [] }, uploadMsd(dir, { jobTtlMs: 400 }), async ({ base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
          sha256: 'b'.repeat(64),
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId);
        assert.equal(failed.state, 'failed');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const gone = await callTool(base, sessionId, 'pikvm_msd_job', { jobId });
        assert.equal(gone.isError, true);
        assert.match(gone.content[0].text, /unknown job/);
      });
    });
  });

  await t.test('a screenshot is not blocked during an upload', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({ images: [], writeHoldMs: 1200 }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        assert.equal(await waitFor(() => mock.state.busy === true), true);
        const began = Date.now();
        const shot = await callTool(base, sessionId, 'pikvm_screenshot', {});
        assert.ok(Date.now() - began < 700, 'screenshot waited on the upload');
        assert.equal(shot.isError, undefined, shot.content?.[0]?.text);
        assert.doesNotMatch(shot.content[0].text, /please wait/);
        const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
        assert.equal(mid.state, 'running');
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
      });
    });
  });

  await t.test('mount and eject do not queue behind an upload', async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, 'disk.img'), body);
      await withSession({
        images: ['other.img'],
        writeHoldMs: 1200,
      }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        assert.equal(await waitFor(() => mock.state.busy === true), true);
        const began = Date.now();
        const mounted = await callTool(base, sessionId, 'pikvm_msd_mount', {
          image: 'other.img',
          mode: 'flash',
          confirmImage: 'other.img',
        });
        const ejected = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: '' });
        assert.ok(Date.now() - began < 700, 'mount or eject waited on the upload');
        assert.equal(mounted.isError, true);
        assert.match(mounted.content[0].text, /busy/);
        assert.equal(ejected.isError, true);
        assert.match(ejected.content[0].text, /MsdIsBusyError/);
        const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
        assert.equal(mid.state, 'running');
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        assert.equal(mock.state.drive.connected, false);
      });
    });
  });

  await t.test('remove refuses while the drive is connected', async () => {
    await withSession({
      images: ['disk.img'],
      drive: { image: 'disk.img', connected: true, cdrom: true, rw: false },
    }, OPEN, async ({ mock, base, sessionId }) => {
      const refused = await callTool(base, sessionId, 'pikvm_msd_remove', {
        image: 'disk.img',
        confirmImage: 'disk.img',
      });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /MsdConnectedError/);
      assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
      assert.equal(mock.state.drive.connected, true);
      assert.equal(mock.state.images['disk.img'].size, 4);
    });
    await withSession({
      images: ['disk.img'],
      drive: { image: 'disk.img', connected: false, cdrom: true, rw: false },
    }, OPEN, async ({ mock, base, sessionId }) => {
      const removed = await callTool(base, sessionId, 'pikvm_msd_remove', {
        image: 'disk.img',
        confirmImage: 'disk.img',
      });
      assert.equal(removed.isError, undefined, removed.content[0].text);
      const outcome = JSON.parse(removed.content[0].text);
      assert.equal(outcome.removed, true);
      assert.equal(outcome.drive.connected, false);
      assert.equal(mock.state.images['disk.img'], undefined);
    });
  });
});
