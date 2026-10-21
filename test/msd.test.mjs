// Modified 2026-10 by PLN: MSD status, mount, eject, and arm-gate tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: expectImage, preflight, and MSD mutex tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload jobs, remove, and disconnected expectImage (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hashing jobs, bad-image cleanup, upload try-lock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: URL fetch jobs and mount block during a transfer (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: fetch cleanup only after our progress line (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: local NAT64 and non-global wrapped IPv4 (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: trailing-dot host is the form sent to kvmd (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload abort must not crash the process (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: abort tests reject a raw-fd upload read (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: catalog readiness and confirmed removal (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: stable size mismatch, unseen confirm, and the readiness deadline (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: symlink and FIFO path checks follow the platform (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a finished job has already released the upload slot (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: incomplete size polling, slot-before-mount, and catalog cleanup (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the slot-free upload test releases the second job (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash timeout releases the upload slot (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash timeout releases the upload slot before close (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: removal confirm stays hidden across an extra catalog GET (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: catalog budgets use a monotonic clock (GPL-3.0; see NOTICE).

/**
 * MSD tools against the mock. The HTTP harness matches test/http.test.mjs.
 * No real PiKVM is contacted. Subtest ceilings and teardown bounds live
 * in test/msd-bounds.mjs.
 */

import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open as openHandle, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cancelMsdJob } from '../dist/msd.js';
import { MSD_UNSEEN_CONFIRM_MS } from '../dist/request-timeout.js';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { createMcpServer, ARM_GATED_TOOLS, MSD_READ_ONLY_TOOLS, msdToolRequiresArm } from '../dist/server.js';
import { parseUrlAllowlist } from '../dist/url-policy.js';
import { startHttpServer } from '../dist/http.js';
import { startKvmdMock } from './kvmd-mock.mjs';
import { fifoAvailable, symlinkAvailable } from './posix-caps.mjs';
import {
  MSD_FILE_TIMEOUT_MS,
  MSD_UPLOAD_SUITE_TIMEOUT_MS,
  bounded,
  boundedFetch,
  closed,
  finishWith,
  msdSubtest,
  msdTest,
  onTestTeardown,
  runBounded,
} from './msd-bounds.mjs';

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
    msdIdleTimeoutMs: flags.msdIdleTimeoutMs,
    msdJobTimeoutMs: flags.msdJobTimeoutMs,
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
  return boundedFetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }, `mcp ${method}`);
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
  await boundedFetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }, 'mcp notifications/initialized');
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
  const start = performance.now();
  for (;;) {
    if (await fn()) return true;
    if (performance.now() - start > ms) return false;
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
  await finishWith(
    async () => {
      const sessionId = await openSession(base);
      await fn({ mock, base, sessionId });
    },
    onTestTeardown(() => runBounded([
      () => closed(httpServer, 'withSession http server close'),
      () => bounded('withSession mock close', mock.close()),
    ])),
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      closed(server, 'free-port server close').then(() => resolve(port), reject);
    });
  });
}

describe('MSD tools', { timeout: MSD_FILE_TIMEOUT_MS }, () => {
  msdTest('MSD arm-gate allows only the read-only list', () => {
    assert.deepEqual([...MSD_READ_ONLY_TOOLS], ['pikvm_msd_status', 'pikvm_msd_job']);
    assert.equal(msdToolRequiresArm('pikvm_msd_status'), false);
    assert.equal(msdToolRequiresArm('pikvm_msd_job'), false);
    assert.equal(msdToolRequiresArm('pikvm_msd_mount'), true);
    assert.equal(msdToolRequiresArm('pikvm_msd_eject'), true);
    assert.equal(msdToolRequiresArm('pikvm_msd_upload'), true);
    assert.equal(msdToolRequiresArm('pikvm_msd_fetch_url'), true);
    assert.equal(msdToolRequiresArm('pikvm_msd_remove'), true);
    assert.equal(msdToolRequiresArm('pikvm_type'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_mount'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_eject'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_status'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_job'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_upload'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_fetch_url'), false);
    assert.equal(ARM_GATED_TOOLS.has('pikvm_msd_remove'), false);
  });

  msdTest('HTTP: MSD disarmed blocks mount and eject, status still reads', async () => {
    await withSession(
      { images: ['disk.img'] },
      { armGateEnforced: true, msdArmGateEnforced: true },
      async ({ mock, base, sessionId }) => {
        for (const [name, args] of [
          ['pikvm_msd_mount', { image: 'disk.img', mode: 'flash', confirmImage: 'disk.img' }],
          ['pikvm_msd_eject', { expectImage: '' }],
          ['pikvm_msd_upload', { file: 'disk.img', confirmImage: 'disk.img' }],
          ['pikvm_msd_fetch_url', { url: 'https://images.example/disk.img', confirmImage: 'disk.img' }],
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

  msdTest('HTTP: ARM_HID armed does not arm MSD', async () => {
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

  msdTest('confirmImage mismatch makes no kvmd call', async () => {
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

  msdTest('expectImage mismatch makes no mutating kvmd call', async () => {
    await withSession(
      { images: ['disk.img'], drive: { image: 'disk.img', connected: true, cdrom: true, rw: false } },
      OPEN,
      async ({ mock, base, sessionId }) => {
        const result = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: 'other.img' });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /MsdExpectImageError/);
        assert.match(result.content[0].text, /drive image is "disk\.img"/);
        const details = JSON.parse(result.content[0].text.split('\n')[1]);
        assert.equal(details.type, 'MsdExpectImageError');
        assert.equal(details.image, 'disk.img');
        assert.deepEqual(msdPosts(mock), []);
        assert.equal(mock.calls.filter((call) => call.method === 'GET' && call.path === '/api/msd').length, 1);
        assert.equal(mock.state.drive.connected, true);
        assert.equal(mock.state.drive.image.name, 'disk.img');
      },
    );
  });

  msdTest('eject twice: the second reports alreadyDisconnected', async () => {
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

  msdTest('mount failure rolls back to the snapshot', async () => {
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

  msdTest('a failed mount rollback reports rollbackError', async () => {
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

  msdTest('cdrom and non-writable images report rw false after kvmd coercion', async () => {
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

  msdTest('mount refuses to eject a connected drive unless expectImage matches', async () => {
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

  msdTest('a URL image makes no MSD POST', async () => {
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

  msdTest('an unknown image makes no MSD POST', async () => {
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

  msdTest('an incomplete image makes no MSD POST', async () => {
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

  msdTest('a busy kvmd makes no MSD POST', async () => {
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

  msdTest('an offline kvmd makes no MSD POST', async () => {
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

  msdTest('rollback keeps every error, including an unrestorable URL image', async () => {
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

  msdTest('eject surfaces a kvmd error other than MsdDisconnectedError', async () => {
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

  msdTest('MSD mount is single-flight across HTTP sessions', { timeout: 15000 }, async () => {
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

  msdTest('HTTP process: PIKVM_MCP_ARM_HID=1 leaves MSD disarmed', { timeout: 20000 }, async () => {
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
      await runBounded([
        () => waitChild(child, 'HTTP child exit'),
        () => bounded('HTTP child mock close', mock.close()),
      ]);
    }
  });

  msdTest('stdio: MSD mount is ungated', { timeout: 20000 }, async () => {
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
      const deadline = performance.now() + 12000;
      while (!responses.has(id)) {
        if (closed) throw new Error(`child exited early. stderr: ${stderr}`);
        if (performance.now() > deadline) throw new Error(`timed out waiting for id=${id}. stderr: ${stderr}`);
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
      await runBounded([
        () => waitChild(child, 'stdio child exit'),
        () => bounded('stdio child mock close', mock.close()),
      ]);
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

  function waitChild(child, label) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return bounded(label, new Promise((resolve) => {
      child.once('exit', resolve);
    })).catch((err) => {
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      throw err;
    });
  }

  async function withDir(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-msd-'));
    await finishWith(
      () => fn(dir),
      onTestTeardown(() => bounded('fixture cleanup', rm(dir, { recursive: true, force: true }))),
    );
  }

  async function toolNames(base, sessionId) {
    const res = await rpc(base, { sessionId, method: 'tools/list', params: {} });
    const body = await res.json();
    return body.result.tools.map((tool) => tool.name);
  }

  async function pollJob(base, sessionId, jobId, ms = 4000) {
    let body;
    assert.equal(await waitFor(async () => {
      const result = await callTool(base, sessionId, 'pikvm_msd_job', { jobId });
      assert.equal(result.isError, undefined, result.content[0].text);
      body = JSON.parse(result.content[0].text);
      return body.state !== 'running'
        && body.state !== 'hashing'
        && body.state !== 'awaiting_catalog';
    }, ms), true);
    return body;
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
      assert.equal(crashes.length, 0, crashes.map(crashReason).join('\n\n'));
    });
  }

  function crashReason(err) {
    if (err instanceof Error) return err.stack || err.message;
    return String(err);
  }

  /**
   * Listens for the whole call. A mid-upload abort used to surface as an
   * uncaught EBADF after the job had already been marked failed. That was
   * the upload descriptor being closed twice, not a mock socket.
   */
  async function whileWatchingProcess(fn) {
    const crashes = [];
    const onException = (err) => {
      crashes.push(err);
    };
    const onRejection = (err) => {
      crashes.push(err);
    };
    process.on('uncaughtException', onException);
    process.on('unhandledRejection', onRejection);
    const stop = onTestTeardown(() => {
      process.off('uncaughtException', onException);
      process.off('unhandledRejection', onRejection);
    });
    let failure;
    try {
      await fn();
    } catch (err) {
      failure = err;
    } finally {
      await stop();
    }
    assert.equal(crashes.length, 0, crashes.map(crashReason).join('\n\n'));
    if (failure) throw failure;
  }

  async function assertKvmdStillAnswers(base, sessionId) {
    const status = await callTool(base, sessionId, 'pikvm_msd_status', {});
    assert.equal(status.isError, undefined, status.content[0].text);
    const state = JSON.parse(status.content[0].text);
    assert.equal(state.online, true);
  }

  const stalledUploadFds = new Set();
  const closedStalledFds = [];

  /**
   * Hold the read that the upload stream actually uses. FileHandle.read
   * is what FileHandle.createReadStream calls. fs.read is what a numeric
   * fd passed to fs.createReadStream calls. Recording those fds, and any
   * fs.close of them, is how an abort test sees the raw-fd stream come
   * back. The prototype is taken from a real handle and restored in
   * finally. Nothing here closes a descriptor it did not open.
   */
  async function withStalledFsRead(ms, fn) {
    const probe = await openHandle(process.execPath, 'r');
    const proto = Object.getPrototypeOf(probe);
    const origHandleRead = proto.read;
    await probe.close();
    const origRead = fs.read;
    const origClose = fs.close;
    const origCloseSync = fs.closeSync;
    stalledUploadFds.clear();
    closedStalledFds.length = 0;
    proto.read = function stalledHandleRead(...args) {
      return Promise.resolve(origHandleRead.apply(this, args)).then((result) => new Promise((resolve) => {
        setTimeout(() => resolve(result), ms);
      }));
    };
    fs.read = function stalledRead(fd, buffer, offset, length, position, callback) {
      stalledUploadFds.add(fd);
      return origRead.call(fs, fd, buffer, offset, length, position, (err, bytesRead, buf) => {
        setTimeout(() => callback(err, bytesRead, buf), ms);
      });
    };
    fs.close = function stalledClose(fd, cb) {
      if (stalledUploadFds.has(fd)) closedStalledFds.push(fd);
      return origClose.call(fs, fd, cb);
    };
    fs.closeSync = function stalledCloseSync(fd) {
      if (stalledUploadFds.has(fd)) closedStalledFds.push(fd);
      return origCloseSync.call(fs, fd);
    };
    const restore = onTestTeardown(() => {
      proto.read = origHandleRead;
      fs.read = origRead;
      fs.close = origClose;
      fs.closeSync = origCloseSync;
      stalledUploadFds.clear();
      closedStalledFds.length = 0;
    });
    try {
      await fn();
    } finally {
      await restore();
    }
  }

  /**
   * Hashing calls fs.read and does not fs.close that fd.
   * The upload stream uses FileHandle.read. A raw-fd upload stream
   * would fs.close the fd it read, which is the double-close that
   * used to surface as an uncaught EBADF.
   */
  function assertNoRawUploadRead() {
    assert.equal(closedStalledFds.length, 0);
  }

  /**
   * The job is failed while fh.close is still waiting for the stalled
   * read. That wait holds the process-wide upload lock. Give the read
   * time to finish so the next test is not told an upload is running.
   */
  function finishStalledRead(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms + 100));
  }

  /**
   * Hashing uses fs.read. The first FileHandle.read is the upload
   * stream, and it rejects with EIO once. Later reads, including a
   * follow-up upload, succeed.
   */
  async function withEioAfterFirstRead(fn) {
    const probe = await openHandle(process.execPath, 'r');
    const proto = Object.getPrototypeOf(probe);
    const orig = proto.read;
    await probe.close();
    let reads = 0;
    proto.read = function eioAfterFirst(...args) {
      reads += 1;
      if (reads === 1) {
        return Promise.reject(Object.assign(new Error('disk read failed'), { code: 'EIO' }));
      }
      return orig.apply(this, args);
    };
    const restore = onTestTeardown(() => {
      proto.read = orig;
    });
    try {
      await fn();
    } finally {
      await restore();
    }
  }

  /**
   * The first fs.read is the hash, and its callback is never called.
   * Later reads, including the next upload, use the real fs.read.
   * The fd from the hung call is what the test checks is closed.
   */
  async function withHungHashRead(fn) {
    const orig = fs.read;
    const hung = { fd: -1, armed: false, callback: undefined };
    fs.read = function hungHashRead(fd, buffer, offset, length, position, callback) {
      if (!hung.armed) {
        hung.armed = true;
        hung.fd = fd;
        hung.callback = callback;
        return;
      }
      return orig.call(fs, fd, buffer, offset, length, position, callback);
    };
    const restore = onTestTeardown(() => {
      fs.read = orig;
    });
    try {
      await fn(hung);
    } finally {
      await restore();
    }
  }

  function fdIdentity(fd) {
    return new Promise((resolve, reject) => {
      fs.fstat(fd, (err, stat) => {
        if (!err) resolve(`${stat.dev}:${stat.ino}`);
        else if (err.code === 'EBADF') resolve('');
        else reject(err);
      });
    });
  }

  /**
   * The number can be reused by a later socket or file. Closed means this
   * descriptor no longer names the same file.
   */
  async function waitUntilFdReleased(fd, identity) {
    const start = performance.now();
    for (;;) {
      const now = await fdIdentity(fd);
      if (now !== identity) return;
      if (performance.now() - start > 1000) {
        throw new Error(`fd ${fd} still names ${identity}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function activeTimeouts() {
    return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  }

  /** Two matching samples, so a timer that is about to fire is not the baseline. */
  async function settledTimeouts() {
    let last = -1;
    let now = activeTimeouts();
    for (let i = 0; i < 10 && now !== last; i += 1) {
      last = now;
      await new Promise((resolve) => setTimeout(resolve, 30));
      now = activeTimeouts();
    }
    return now;
  }

  msdTest('expectImage is checked when the drive is disconnected', async () => {
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

  msdTest('upload, remove, and job polling', { timeout: MSD_UPLOAD_SUITE_TIMEOUT_MS }, async (t) => {
    const body = Buffer.from('abcd');
    const sum = digest(body);

    await msdSubtest(t, 'pikvm_msd_upload is hidden until the local directory is set', async () => {
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

    await msdSubtest(t, 'path rejections make no kvmd call', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'real.img'), body);
        await mkdir(join(dir, 'dir.img'));
        await writeFile(join(dir, 'big.img'), body);
        const cases = [
          ['traversal', { file: '../real.img', confirmImage: '../real.img' }, /bare image name/],
          ['absolute', { file: '/tmp/real.img', confirmImage: '/tmp/real.img' }, /bare image name/],
          ['directory', { file: 'dir.img', confirmImage: 'dir.img' }, /directory/],
          ['oversize', { file: 'big.img', confirmImage: 'big.img' }, /PIKVM_MSD_MAX_BYTES/],
          ['sha256 format', { file: 'real.img', confirmImage: 'real.img', sha256: 'nope' }, /64 hex/],
        ];
        if (symlinkAvailable()) {
          await symlink(join(dir, 'real.img'), join(dir, 'link.img'));
          cases.push(['symlink', { file: 'link.img', confirmImage: 'link.img' }, /symlink/]);
        }
        if (fifoAvailable()) {
          await execFileAsync('mkfifo', [join(dir, 'pipe.img')]);
          cases.push(['fifo', { file: 'pipe.img', confirmImage: 'pipe.img' }, /not a regular file/]);
        }
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

    await msdSubtest(t, 'pre-check refusals make no MSD POST', async () => {
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

    await msdSubtest(t, 'a happy upload reaches done with the same bytes and sha256', async () => {
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

    await msdSubtest(t, 'job polling sees running before done', async () => {
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

    await msdSubtest(t, 'a mid-upload reset is PIKVM_MSD_STATE_UNKNOWN on the job', async () => {
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

    await msdSubtest(t, 'a sha256 mismatch fails the job before any kvmd call', async () => {
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

    await msdSubtest(t, 'the jobId returns before hashing finishes', async () => {
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

    await msdSubtest(t, 'a second upload fails immediately while one is hashing', async () => {
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
            const began = performance.now();
            const refused = await callTool(base, other, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.ok(performance.now() - began < 700, 'second upload waited on the first');
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

    await msdSubtest(t, 'a stuck hash read fails within the job ceiling and frees the slot', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), body);
        await writeFile(join(dir, 'next.img'), Buffer.from('wxyz'));
        await withHungHashRead((hung) => whileWatchingProcess(async () => {
          const flags = uploadMsd(dir);
          flags.msdJobTimeoutMs = 500;
          await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
            const began = performance.now();
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            const failed = await pollJob(base, sessionId, jobId, 4000);
            const elapsed = performance.now() - began;
            assert.equal(failed.state, 'failed');
            assert.equal(failed.error.type, 'PIKVM_MSD_HASH_TIMEOUT');
            assert.match(failed.error.message, /hash timeout/);
            assert.ok(elapsed >= 400, `hash failed before the ceiling (${elapsed}ms)`);
            assert.ok(elapsed < 4000, `hash hung past the bound (${elapsed}ms)`);
            assert.ok(hung.fd >= 0, 'hash never called fs.read');
            const openIdentity = await fdIdentity(hung.fd);
            assert.notEqual(openIdentity, '');
            hung.callback(Object.assign(new Error('closed'), { code: 'EBADF' }));
            await waitUntilFdReleased(hung.fd, openIdentity);
            hung.callback(null, body.length);
            await new Promise((resolve) => setTimeout(resolve, 30));
            assert.equal(mock.calls.some((call) => call.path === '/api/msd/write'), false);
            const again = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'next.img',
              confirmImage: 'next.img',
            });
            assert.equal(again.isError, undefined, again.content[0].text);
            assert.equal(again.content[0].text.includes('MsdUploadBusyError'), false);
            const done = await pollJob(base, sessionId, JSON.parse(again.content[0].text).jobId);
            assert.equal(done.state, 'done');
            assert.equal(mock.bytes.get('next.img').toString(), 'wxyz');
          });
        }));
      });
    });

    await msdSubtest(t, 'a hash timeout frees the slot while close is still pending', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), body);
        await writeFile(join(dir, 'next.img'), Buffer.from('wxyz'));
        const logged = [];
        const origErr = console.error;
        console.error = (...args) => {
          logged.push(args.map(String).join(' '));
          origErr(...args);
        };
        const restoreLog = onTestTeardown(() => {
          console.error = origErr;
        });
        try {
          await withHungHashRead((hung) => whileWatchingProcess(async () => {
            const releaseFd = onTestTeardown(() => new Promise((resolve, reject) => {
              if (hung.fd < 0 || closeCalls > 0) {
                resolve();
                return;
              }
              fs.close(hung.fd, (err) => {
                if (err && err.code !== 'EBADF') reject(err);
                else resolve();
              });
            }));
            let closeCalls = 0;
            let rejectClose;
            const flags = uploadMsd(dir, {
              closeFile: (fh) => {
                if (fh.fd !== hung.fd) return fh.close();
                closeCalls += 1;
                const pending = new Promise((resolve, reject) => {
                  rejectClose = reject;
                });
                fh.close().then(() => undefined, (err) => {
                  rejectClose(err);
                });
                return pending;
              },
            });
            flags.msdJobTimeoutMs = 500;
            await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
              const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
                file: 'disk.img',
                confirmImage: 'disk.img',
              });
              assert.equal(started.isError, undefined, started.content[0].text);
              const { jobId } = JSON.parse(started.content[0].text);
              const failed = await pollJob(base, sessionId, jobId, 4000);
              assert.equal(failed.state, 'failed');
              assert.equal(failed.error.type, 'PIKVM_MSD_HASH_TIMEOUT');
              assert.equal(closeCalls, 0);
              const openIdentity = await fdIdentity(hung.fd);
              assert.notEqual(openIdentity, '');
              const again = await callTool(base, sessionId, 'pikvm_msd_upload', {
                file: 'next.img',
                confirmImage: 'next.img',
              });
              assert.equal(again.isError, undefined, again.content[0].text);
              assert.equal(again.content[0].text.includes('MsdUploadBusyError'), false);
              assert.equal(closeCalls, 0);
              hung.callback(Object.assign(new Error('late read'), { code: 'EIO' }));
              assert.equal(closeCalls, 1);
              hung.callback(null, body.length);
              assert.equal(closeCalls, 1);
              assert.equal(typeof rejectClose, 'function');
              await waitUntilFdReleased(hung.fd, openIdentity);
              rejectClose(new Error('hash close failed'));
              await new Promise((resolve) => setImmediate(resolve));
              assert.ok(
                logged.some((line) => line.includes('"close":true') && line.includes('hash close failed')),
                logged.filter((line) => line.includes('msd_upload')).join('\n'),
              );
              const still = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
              assert.equal(still.error.type, 'PIKVM_MSD_HASH_TIMEOUT');
              assert.equal(mock.calls.some((call) => (
                call.path === '/api/msd/write' && call.query.includes('disk.img')
              )), false);
              const done = await pollJob(base, sessionId, JSON.parse(again.content[0].text).jobId);
              assert.equal(done.state, 'done');
              assert.equal(mock.bytes.get('next.img').toString(), 'wxyz');
            });
            await releaseFd();
          }));
        } finally {
          await restoreLog();
        }
      });
    });

    await msdSubtest(t, 'a hash and a POST that each use most of the job ceiling still succeed', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), body);
        const ceiling = 500;
        const hashDelayMs = 300;
        const postDelayMs = 300;
        const origRead = fs.read;
        let delayed = false;
        fs.read = function delayedHashRead(fd, buffer, offset, length, position, callback) {
          if (!delayed) {
            delayed = true;
            return origRead.call(fs, fd, buffer, offset, length, position, (err, bytesRead, buf) => {
              setTimeout(() => callback(err, bytesRead, buf), hashDelayMs);
            });
          }
          return origRead.call(fs, fd, buffer, offset, length, position, callback);
        };
        const restoreRead = onTestTeardown(() => {
          fs.read = origRead;
        });
        const flags = uploadMsd(dir);
        flags.msdJobTimeoutMs = ceiling;
        try {
          await withSession({
            images: [],
            free: 1000,
            writeHoldMs: postDelayMs,
          }, flags, async ({ base, sessionId }) => {
            const began = performance.now();
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
              sha256: sum,
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const done = await pollJob(base, sessionId, JSON.parse(started.content[0].text).jobId, 4000);
            const elapsed = performance.now() - began;
            assert.equal(done.state, 'done', done.error && done.error.message);
            assert.equal(done.sha256, sum);
            assert.ok(elapsed >= ceiling, `finished inside one ceiling (${elapsed}ms)`);
            assert.ok(elapsed < 4000, `upload hung (${elapsed}ms)`);
          });
        } finally {
          await restoreRead();
        }
      });
    });

    await msdSubtest(t, 'a finished hash leaves no hash timer armed', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), body);
        const flags = uploadMsd(dir);
        flags.msdJobTimeoutMs = 30000;
        await withSession({ images: [], free: 1000 }, flags, async ({ base, sessionId }) => {
          const before = await settledTimeouts();
          const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
            sha256: sum,
          });
          assert.equal(started.isError, undefined, started.content[0].text);
          const done = await pollJob(base, sessionId, JSON.parse(started.content[0].text).jobId);
          assert.equal(done.state, 'done');
          const after = await settledTimeouts();
          assert.equal(after, before);
        });
      });
    });

    await msdSubtest(t, 'a file changed before the stream fails the job and the image is removed', async () => {
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

    await msdSubtest(t, 'finished jobs past the cap are dropped', async () => {
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

    await msdSubtest(t, 'a failed job stays unfinished until the upload slot is free', async (inner) => {
      watchCrashes(inner);
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), body);
        let release;
        const flags = uploadMsd(dir, {
          beforeSlotRelease: () => new Promise((resolve) => { release = resolve; }),
        });
        try {
          await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
              sha256: 'a'.repeat(64),
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            assert.equal(await waitFor(() => typeof release === 'function'), true);
            const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            assert.equal(mid.state, 'hashing');
            const other = await openSession(base);
            const refused = await callTool(base, other, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
              sha256: 'a'.repeat(64),
            });
            assert.equal(refused.isError, true);
            assert.match(refused.content[0].text, /upload already running/);
            assert.deepEqual(mock.calls, []);
            release();
            release = undefined;
            const failed = await pollJob(base, sessionId, jobId);
            assert.equal(failed.state, 'failed');
            assert.match(failed.error.message, /sha256 mismatch/);
            const next = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
              sha256: 'b'.repeat(64),
            });
            assert.equal(next.isError, undefined, next.content[0].text);
            const nextId = JSON.parse(next.content[0].text).jobId;
            assert.equal(await waitFor(() => typeof release === 'function'), true);
            release();
            release = undefined;
            const nextFailed = await pollJob(base, sessionId, nextId);
            assert.equal(nextFailed.state, 'failed');
          });
        } finally {
          if (release) release();
        }
      });
    });

    await msdSubtest(t, 'a finished job is dropped after its ttl', async () => {
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

    await msdSubtest(t, 'a screenshot is not blocked during an upload', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), body);
        await withSession({ images: [], writeHoldMs: 1200 }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
            file: 'disk.img',
            confirmImage: 'disk.img',
          });
          const { jobId } = JSON.parse(started.content[0].text);
          assert.equal(await waitFor(() => mock.state.busy === true), true);
          const began = performance.now();
          const shot = await callTool(base, sessionId, 'pikvm_screenshot', {});
          assert.ok(performance.now() - began < 700, 'screenshot waited on the upload');
          assert.equal(shot.isError, undefined, shot.content?.[0]?.text);
          assert.doesNotMatch(shot.content[0].text, /please wait/);
          const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
          assert.equal(mid.state, 'running');
          const done = await pollJob(base, sessionId, jobId);
          assert.equal(done.state, 'done');
        });
      });
    });

    await msdSubtest(t, 'mount and eject do not queue behind an upload', async () => {
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
          const began = performance.now();
          const mounted = await callTool(base, sessionId, 'pikvm_msd_mount', {
            image: 'other.img',
            mode: 'flash',
            confirmImage: 'other.img',
          });
          const ejected = await callTool(base, sessionId, 'pikvm_msd_eject', { expectImage: '' });
          assert.ok(performance.now() - began < 700, 'mount or eject waited on the upload');
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

    await msdSubtest(t, 'mount of an image with an active upload makes no POST', async () => {
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
            const before = mock.calls.length;
            const refused = await callTool(base, sessionId, 'pikvm_msd_mount', {
              image: 'disk.img',
              mode: 'flash',
              confirmImage: 'disk.img',
            });
            assert.equal(refused.isError, true);
            assert.match(refused.content[0].text, /MsdImageTransferError/);
            assert.match(refused.content[0].text, /disk\.img/);
            assert.equal(mock.calls.slice(before).some((call) => call.method === 'POST'), false);
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

    await msdSubtest(t, 'remove refuses while the drive is connected', async () => {
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

  function fetchFlags(allowRaw, extra = {}) {
    return {
      ...OPEN,
      msd: {
        maxBytes: 1024 * 1024,
        extensions: ['.iso', '.img'],
        urlAllow: parseUrlAllowlist(allowRaw),
        allowPrivate: false,
        connectTimeoutSec: 30,
        resolveUrl: async () => ['192.0.3.10'],
        ...extra,
      },
    };
  }

  const FETCH_ALLOW = 'https://images.example/iso';
  const FETCH_URL = 'https://images.example/iso/disk.img';

  async function refusedFetch(base, sessionId, mock, args, pattern) {
    const result = await callTool(base, sessionId, 'pikvm_msd_fetch_url', args);
    if (result.isError) {
      assert.match(result.content[0].text, pattern);
      assert.deepEqual(mock.calls, []);
      return result.content[0].text;
    }
    const { jobId } = JSON.parse(result.content[0].text);
    const failed = await pollJob(base, sessionId, jobId);
    assert.equal(failed.state, 'failed');
    assert.match(`${failed.error.type} ${failed.error.message}`, pattern);
    assert.deepEqual(mock.calls, []);
    return failed.error.message;
  }

    await msdSubtest(t, 'pikvm_msd_fetch_url is hidden until the allowlist has an https entry', async () => {
      await withSession({ images: [] }, OPEN, async ({ base, sessionId }) => {
        const hidden = await toolNames(base, sessionId);
        assert.equal(hidden.includes('pikvm_msd_fetch_url'), false);
        const refused = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        assert.equal(refused.isError, true);
        assert.match(refused.content[0].text, /PIKVM_MSD_URL_ALLOWLIST/);
      });
      await withSession({ images: [] }, fetchFlags(FETCH_ALLOW), async ({ base, sessionId }) => {
        const shown = await toolNames(base, sessionId);
        assert.equal(shown.includes('pikvm_msd_fetch_url'), true);
      });
    });

    await msdSubtest(t, 'url policy refusals make no kvmd call', async () => {
      const cases = [
        ['not allowlisted', FETCH_ALLOW, { url: 'https://other.example/iso/disk.img', confirmImage: 'disk.img' }, /not allowlisted/, {}],
        ['http', FETCH_ALLOW, { url: 'http://images.example/iso/disk.img', confirmImage: 'disk.img' }, /https/, {}],
        ['userinfo', FETCH_ALLOW, { url: 'https://alice:s3cret@images.example/iso/disk.img', confirmImage: 'disk.img' }, /userinfo/, {}],
        ['loopback', FETCH_ALLOW, { url: FETCH_URL, confirmImage: 'disk.img' }, /private/, { resolveUrl: async () => ['127.0.0.1'] }],
        ['rfc1918', FETCH_ALLOW, { url: FETCH_URL, confirmImage: 'disk.img' }, /private/, { resolveUrl: async () => ['10.1.2.3'] }],
        ['tailscale', FETCH_ALLOW, { url: FETCH_URL, confirmImage: 'disk.img' }, /tailscale/, { resolveUrl: async () => ['100.101.102.103'] }],
        ['metadata', `${FETCH_ALLOW}`, { url: FETCH_URL, confirmImage: 'disk.img' }, /link-local or metadata/, { allowPrivate: true, resolveUrl: async () => ['169.254.169.254'] }],
        ['fe80', FETCH_ALLOW, { url: FETCH_URL, confirmImage: 'disk.img' }, /link-local or metadata/, { allowPrivate: true, resolveUrl: async () => ['fe80::1'] }],
        ['mapped metadata', FETCH_ALLOW, { url: FETCH_URL, confirmImage: 'disk.img' }, /link-local or metadata/, { allowPrivate: true, resolveUrl: async () => ['::ffff:169.254.169.254'] }],
      ];
      for (const [label, allowRaw, args, pattern, extra] of cases) {
        await withSession({ images: [] }, fetchFlags(allowRaw, extra), async ({ mock, base, sessionId }) => {
          const text = await refusedFetch(base, sessionId, mock, args, pattern);
          if (label === 'userinfo') assert.equal(text.includes('s3cret'), false, text);
        });
      }
    });

    await msdSubtest(t, 'an allowlisted tailscale address reaches write_remote', async () => {
      const rows = [
        ['v4', 'https://100.101.102.103/,100.101.102.103/32', 'https://100.101.102.103/disk.img', async () => { throw new Error('dns'); }],
        ['v6', `${FETCH_ALLOW},fd7a:115c:a1e0::/48`, FETCH_URL, async () => ['fd7a:115c:a1e0::50']],
      ];
      for (const [label, allowRaw, url, resolveUrl] of rows) {
        await withSession({ images: [] }, fetchFlags(allowRaw, { resolveUrl }), async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
            url,
            confirmImage: 'disk.img',
          });
          assert.equal(started.isError, undefined, `${label}: ${started.content[0].text}`);
          const { jobId } = JSON.parse(started.content[0].text);
          const done = await pollJob(base, sessionId, jobId);
          assert.equal(done.state, 'done', label);
          const call = mock.calls.find((item) => item.path === '/api/msd/write_remote');
          assert.ok(call, label);
          assert.match(call.query, /verify=1/);
          assert.match(call.query, /remove_incomplete=1/);
          assert.match(call.query, /timeout=30/);
          assert.doesNotMatch(call.query, /insecure/);
        });
      }
    });

    await msdSubtest(t, 'ALLOW_PRIVATE lets an rfc1918 address through and not metadata', async () => {
      await withSession({ images: [] }, fetchFlags(FETCH_ALLOW, {
        allowPrivate: true,
        resolveUrl: async () => ['10.1.2.3'],
      }), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        assert.ok(mock.calls.some((call) => call.path === '/api/msd/write_remote'));
      });
    });

    await msdSubtest(t, 'ndjson progress maps into the job', async () => {
      await withSession({
        images: [],
        remote: {
          gapMs: 200,
          lines: [
            JSON.stringify({ ok: true, result: { image: { name: 'disk.img', size: 8, written: 3 } } }),
            JSON.stringify({ ok: true, result: { image: { name: 'disk.img', size: 8, written: 8 } } }),
          ],
        },
      }, fetchFlags(FETCH_ALLOW), async ({ base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        assert.equal(await waitFor(async () => {
          const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
          return mid.state === 'running' && mid.bytes === 3 && mid.total === 8;
        }), true);
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        assert.equal(done.bytes, 8);
        assert.equal(done.total, 8);
      });
    });

    await msdSubtest(t, 'an error line fails the job and removes the incomplete image', async () => {
      await withSession({
        images: [],
        remote: {
          storeIncomplete: true,
          lines: [
            JSON.stringify({ ok: true, result: { image: { name: 'disk.img', size: 4, written: 2 } } }),
            JSON.stringify({ ok: false, result: { error: 'MsdOperationError', error_msg: 'disk failed' } }),
          ],
        },
      }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.error.type, 'MsdOperationError');
        assert.equal(failed.removed, true);
        assert.equal(mock.state.images['disk.img'], undefined);
        assert.ok(mock.calls.some((call) => call.path === '/api/msd/remove'));
      });
    });

    await msdSubtest(t, 'a short stream is STATE_UNKNOWN and skips cleanup', async () => {
      await withSession({
        images: [],
        remote: {
          lines: [
            JSON.stringify({ ok: true, result: { image: { name: 'disk.img', size: 4, written: 2 } } }),
          ],
        },
      }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.error.type, 'PIKVM_MSD_STATE_UNKNOWN');
        assert.equal(failed.removed, undefined);
        assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
      });
    });

    await msdSubtest(t, 'a second transfer fails fast and mount of that image makes no POST', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.from('abcd'));
        let release;
        const flags = fetchFlags(FETCH_ALLOW, {
          localDir: dir,
          beforeFetch: () => new Promise((resolve) => { release = resolve; }),
        });
        try {
          await withSession({ images: [] }, flags, async ({ mock, base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
              url: FETCH_URL,
              confirmImage: 'disk.img',
            });
            const { jobId } = JSON.parse(started.content[0].text);
            assert.equal(await waitFor(() => typeof release === 'function'), true);
            const other = await openSession(base);
            const began = performance.now();
            const second = await callTool(base, other, 'pikvm_msd_fetch_url', {
              url: FETCH_URL,
              confirmImage: 'disk.img',
            });
            const upload = await callTool(base, other, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.ok(performance.now() - began < 700, 'second transfer waited');
            assert.match(second.content[0].text, /MsdUploadBusyError/);
            assert.match(second.content[0].text, /upload already running/);
            assert.match(upload.content[0].text, /upload already running/);
            const before = mock.calls.length;
            const mounted = await callTool(base, sessionId, 'pikvm_msd_mount', {
              image: 'disk.img',
              mode: 'flash',
              confirmImage: 'disk.img',
            });
            assert.match(mounted.content[0].text, /MsdImageTransferError/);
            assert.equal(mock.calls.slice(before).some((call) => call.method === 'POST'), false);
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

    await msdSubtest(t, 'logs omit the query string and an explicit image is sent', async () => {
      const logged = [];
      const orig = console.error;
      console.error = (...args) => {
        logged.push(args.map(String).join(' '));
        orig(...args);
      };
      try {
        await withSession({ images: [] }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
            url: 'https://images.example/iso/other.img?token=supersecret#frag',
            image: 'disk.img',
            confirmImage: 'disk.img',
          });
          const { jobId } = JSON.parse(started.content[0].text);
          const done = await pollJob(base, sessionId, jobId);
          assert.equal(done.state, 'done');
          const call = mock.calls.find((item) => item.path === '/api/msd/write_remote');
          assert.match(call.query, /image=disk\.img/);
          assert.match(decodeURIComponent(call.query), /token=supersecret/);
          assert.equal(decodeURIComponent(call.query).includes('frag'), false);
        });
      } finally {
        console.error = orig;
      }
      const fetchLogs = logged.filter((line) => line.includes('msd_fetch'));
      assert.ok(fetchLogs.length >= 1);
      assert.equal(fetchLogs.some((line) => line.includes('supersecret') || line.includes('token=')), false);
    });

    await msdSubtest(t, 'pre-check refusals make no MSD POST', async () => {
      const cases = [
        ['connected', { images: ['other.img'], drive: { image: 'other.img', connected: true, cdrom: false, rw: false } }, 'MsdConnectedError'],
        ['exists', { images: ['disk.img'] }, 'MsdImageExistsError'],
      ];
      for (const [label, mockOptions, type] of cases) {
        await withSession(mockOptions, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
            url: FETCH_URL,
            confirmImage: 'disk.img',
          });
          const { jobId } = JSON.parse(started.content[0].text);
          const failed = await pollJob(base, sessionId, jobId);
          assert.equal(failed.state, 'failed', label);
          assert.equal(failed.error.type, type, label);
          assert.deepEqual(msdPosts(mock), [], label);
        });
      }
    });

    await msdSubtest(t, 'service and embedded addresses make no kvmd call', async () => {
      const wide = `${FETCH_ALLOW},100.64.0.0/10,fd7a:115c:a1e0::/48`;
      const cases = [
        ['aws', 'fd00:ec2::254', true],
        ['quad100', '100.100.100.100', true],
        ['quad200', '100.100.100.200', true],
        ['quad6', 'fd7a:115c:a1e0::53', true],
        ['nat64 metadata', '64:ff9b::a9fe:a9fe', true],
        ['6to4 metadata', '2002:a9fe:a9fe::', true],
        ['compatible metadata', '::a9fe:a9fe', true],
        ['nat64 loopback', '64:ff9b::7f00:1', true],
        ['local nat64 metadata', '64:ff9b:1::a9fe:a9fe', true],
        ['local nat64 other', '64:ff9b:1::1', true],
        ['nat64 tailscale', '64:ff9b::6440:1', true],
        ['6to4 tailscale', '2002:6440:0001::', true],
        ['compat private', '::0a01:0203', true],
      ];
      for (const [label, address, allowPrivate] of cases) {
        await withSession({ images: [] }, fetchFlags(wide, {
          allowPrivate,
          resolveUrl: async () => [address],
        }), async ({ mock, base, sessionId }) => {
          await refusedFetch(base, sessionId, mock, {
            url: FETCH_URL,
            confirmImage: 'disk.img',
          }, /denied|private/);
        });
      }
    });

    await msdSubtest(t, 'decimal octal and hex loopback literals make no kvmd call', async () => {
      const allow = 'https://127.0.0.1/';
      for (const url of [
        'https://2130706433/disk.img',
        'https://0177.0.0.1/disk.img',
        'https://0x7f.0.0.1/disk.img',
      ]) {
        await withSession({ images: [] }, fetchFlags(allow, {
          resolveUrl: async () => { throw new Error('dns'); },
        }), async ({ mock, base, sessionId }) => {
          await refusedFetch(base, sessionId, mock, { url, confirmImage: 'disk.img' }, /private/);
        });
      }
    });

    await msdSubtest(t, 'a trailing-dot host matches the allowlist', async () => {
      let seen = '';
      await withSession({ images: [] }, fetchFlags(FETCH_ALLOW, {
        resolveUrl: async (host) => {
          seen = host;
          return ['192.0.3.10'];
        },
      }), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: 'https://images.example./iso/disk.img',
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        assert.equal(seen, 'images.example');
        const call = mock.calls.find((item) => item.path === '/api/msd/write_remote');
        assert.ok(call);
        assert.equal(call.query.includes('images.example.'), false);
        assert.match(call.query, /images\.example%2Fiso%2Fdisk\.img/);
      });
    });

    await msdSubtest(t, 'derived names with encoded separators are refused', async () => {
      const cases = [
        ['dot slash', 'https://images.example/iso/%2e%2e%2fsecret.img', '../secret.img', /bare image name/],
        ['slash', 'https://images.example/iso/foo%2Fbar.img', 'foo/bar.img', /bare image name/],
        ['iso', 'https://images.example/iso', 'iso', /suffix/],
      ];
      for (const [label, url, confirmImage, pattern] of cases) {
        await withSession({ images: [] }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
          const result = await callTool(base, sessionId, 'pikvm_msd_fetch_url', { url, confirmImage });
          assert.equal(result.isError, true, label);
          assert.match(result.content[0].text, pattern, label);
          assert.deepEqual(mock.calls, [], label);
        });
      }
    });

    await msdSubtest(t, 'confirmImage must echo the derived name', async () => {
      await withSession({ images: [] }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
        const result = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'other.img',
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /confirmImage does not match image/);
        assert.deepEqual(mock.calls, []);
      });
    });

    await msdSubtest(t, 'a DNS failure makes no kvmd call', async () => {
      await withSession({ images: [] }, fetchFlags(FETCH_ALLOW, {
        resolveUrl: async () => { throw new Error('dns down'); },
      }), async ({ mock, base, sessionId }) => {
        await refusedFetch(base, sessionId, mock, {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        }, /did not resolve/);
      });
    });

    await msdSubtest(t, 'an early write_remote error does not remove', async () => {
      const bodies = [
        [400, 'ValidatorError', 'missing Content-Length for https://alice:s3cret@images.example/iso/disk.img?token=supersecret'],
        [404, 'NotFoundError', 'not found'],
        [400, 'MsdImageExistsError', 'image already exists'],
      ];
      for (const [status, error, errorMsg] of bodies) {
        await withSession({
          images: [],
          routes: {
            'POST /api/msd/write_remote': {
              status,
              body: { ok: false, result: { error, error_msg: errorMsg } },
            },
          },
        }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
          const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
            url: FETCH_URL,
            confirmImage: 'disk.img',
          });
          const { jobId } = JSON.parse(started.content[0].text);
          const failed = await pollJob(base, sessionId, jobId);
          assert.equal(failed.state, 'failed', error);
          assert.equal(failed.error.type, error, error);
          assert.equal(failed.removed, undefined, error);
          assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false, error);
          assert.equal(`${failed.error.message}`.includes('s3cret'), false);
          assert.equal(`${failed.error.message}`.includes('supersecret'), false);
          assert.equal(`${failed.error.message}`.includes('token='), false);
        });
      }
    });

    await msdSubtest(t, 'an error after another image progress does not remove', async () => {
      await withSession({
        images: ['other.img'],
        remote: {
          lines: [
            JSON.stringify({ ok: true, result: { image: { name: 'other.img', size: 4, written: 2 } } }),
            JSON.stringify({ ok: false, result: { error: 'MsdOperationError', error_msg: 'disk failed' } }),
          ],
        },
      }, fetchFlags(FETCH_ALLOW), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.removed, undefined);
        assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
        assert.ok(mock.state.images['other.img']);
      });
    });

    await msdSubtest(t, 'kvmd removing the incomplete image is already gone', async () => {
      await withSession({
        images: [],
        remote: {
          lines: [
            JSON.stringify({ ok: true, result: { image: { name: 'disk.img', size: 4, written: 2 } } }),
            JSON.stringify({ ok: false, result: { error: 'MsdOperationError', error_msg: 'disk failed' } }),
          ],
        },
      }, fetchFlags(FETCH_ALLOW, { readyTimeoutMs: 400 }), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const began = performance.now();
        const failed = await pollJob(base, sessionId, jobId, 4000);
        assert.equal(failed.state, 'failed');
        assert.equal(failed.error.type, 'MsdOperationError');
        assert.equal(failed.removed, true);
        assert.equal(failed.removeError, undefined);
        assert.equal(mock.state.images['disk.img'], undefined);
        assert.ok(performance.now() - began >= 300, 'an unknown name is not proof the image is gone');
      });
    });

    await msdSubtest(t, 'connect timeout is the value sent to write_remote', async () => {
      await withSession({ images: [] }, fetchFlags(FETCH_ALLOW, {
        connectTimeoutSec: 12,
      }), async ({ mock, base, sessionId }) => {
        const started = await callTool(base, sessionId, 'pikvm_msd_fetch_url', {
          url: FETCH_URL,
          confirmImage: 'disk.img',
        });
        const { jobId } = JSON.parse(started.content[0].text);
        const done = await pollJob(base, sessionId, jobId);
        assert.equal(done.state, 'done');
        const call = mock.calls.find((item) => item.path === '/api/msd/write_remote');
        assert.match(call.query, /timeout=12/);
      });
    });

    await msdSubtest(t, 'a connection reset mid-upload does not crash the process', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.alloc(256 * 1024, 4));
        await withStalledFsRead(200, () => whileWatchingProcess(async () => {
          await withSession({ images: [], resetDuringWrite: true }, uploadMsd(dir), async ({ base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            const failed = await pollJob(base, sessionId, jobId);
            assertNoRawUploadRead();
            assert.equal(failed.state, 'failed');
            assert.equal(failed.error.type, 'PIKVM_MSD_STATE_UNKNOWN');
            await assertKvmdStillAnswers(base, sessionId);
            await finishStalledRead(200);
          });
        }));
      });
    });

    await msdSubtest(t, 'an idle timeout mid-upload does not crash the process', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.alloc(64 * 1024, 5));
        const flags = uploadMsd(dir, { maxBytes: 1024 * 1024 });
        flags.msdIdleTimeoutMs = 400;
        flags.msdJobTimeoutMs = 20000;
        await withStalledFsRead(800, () => whileWatchingProcess(async () => {
          await withSession({ images: [], pauseWrite: true }, flags, async ({ base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            const failed = await pollJob(base, sessionId, jobId);
            assertNoRawUploadRead();
            assert.equal(failed.state, 'failed');
            assert.equal(failed.error.type, 'PIKVM_MSD_STATE_UNKNOWN');
            await assertKvmdStillAnswers(base, sessionId);
            await finishStalledRead(800);
          });
        }));
      });
    });

    await msdSubtest(t, 'a source read error mid-upload does not crash the process', async () => {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.from('abcd'));
        await writeFile(join(dir, 'next.img'), Buffer.from('wxyz'));
        await withStalledFsRead(200, () => withEioAfterFirstRead(() => whileWatchingProcess(async () => {
          await withSession({ images: [] }, uploadMsd(dir), async ({ mock, base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            const failed = await pollJob(base, sessionId, jobId);
            assertNoRawUploadRead();
            assert.equal(failed.state, 'failed');
            assert.equal(failed.error.type, 'PIKVM_SOURCE_READ_ERROR');
            await finishStalledRead(200);
            await assertKvmdStillAnswers(base, sessionId);
            const again = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'next.img',
              confirmImage: 'next.img',
            });
            assert.equal(again.isError, undefined, again.content[0].text);
            const done = await pollJob(base, sessionId, JSON.parse(again.content[0].text).jobId);
            assert.equal(done.state, 'done');
            assert.equal(mock.bytes.get('next.img').toString(), 'wxyz');
          });
        })));
      });
    });

    function transferPosts(mock, kind) {
      const path = kind === 'upload' ? '/api/msd/write' : '/api/msd/write_remote';
      return mock.calls.filter((call) => call.path === path);
    }

    async function withUpload(mockOptions, readyTimeoutMs, fn) {
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.from('abcd'));
        await withSession(mockOptions, uploadMsd(dir, { readyTimeoutMs }), fn);
      });
    }

    async function withFetch(mockOptions, readyTimeoutMs, fn) {
      await withSession(mockOptions, fetchFlags(FETCH_ALLOW, { readyTimeoutMs }), fn);
    }

    async function startTransfer(kind, base, sessionId) {
      if (kind === 'upload') {
        return callTool(base, sessionId, 'pikvm_msd_upload', {
          file: 'disk.img',
          confirmImage: 'disk.img',
        });
      }
      return callTool(base, sessionId, 'pikvm_msd_fetch_url', {
        url: FETCH_URL,
        confirmImage: 'disk.img',
      });
    }

    for (const kind of ['upload', 'fetch']) {
      await msdSubtest(t, `${kind}: a delayed catalog succeeds with one write`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogHidePolls: 3 }, 4000, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          assert.equal(started.isError, undefined, started.content[0].text);
          const { jobId } = JSON.parse(started.content[0].text);
          const catalogGets = () => mock.calls.filter((call) => (
            call.method === 'GET' && call.path === '/api/msd'
          )).length;
          let awaitingGets = 0;
          assert.equal(await waitFor(async () => {
            const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            if (mid.state !== 'awaiting_catalog') return false;
            if (awaitingGets === 0) awaitingGets = catalogGets();
            // The catalog GET runs inside the device lock, and the next
            // backoff keeps that lock. A mount on this same session would
            // sit behind the in-flight job poll.
            return catalogGets() > awaitingGets;
          }, 4000), true, kind);
          const other = await openSession(base);
          const mountPromise = callTool(base, other, 'pikvm_msd_mount', {
            image: 'disk.img',
            confirmImage: 'disk.img',
            mode: 'flash',
            rw: false,
            connect: false,
          });
          await new Promise((resolve) => setTimeout(resolve, 40));
          const during = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
          assert.equal(during.state, 'awaiting_catalog', kind);
          assert.equal(mock.calls.some((call) => call.path === '/api/msd/set_params'), false, kind);
          const done = await pollJob(base, sessionId, jobId, 8000);
          assert.equal(done.state, 'done', kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(mock.state.images['disk.img'].complete, true);
          assert.equal(mock.state.images['disk.img'].size, 4);
          const mounted = await mountPromise;
          assert.equal(mounted.isError, undefined, `${kind}: ${mounted.content[0].text}`);
          assert.ok(mock.calls.some((call) => call.path === '/api/msd/set_params'), kind);
        });
      });

      await msdSubtest(t, `${kind}: an incomplete catalog row that becomes complete succeeds`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogIncompletePolls: 2 }, 2000, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const done = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(done.state, 'done', kind);
          assert.ok(elapsed >= 700, `${kind} did not keep polling an incomplete row (${elapsed} ms)`);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(mock.state.images['disk.img'].complete, true);
        });
      });

      await msdSubtest(t, `${kind}: an image that never appears is PIKVM_MSD_CATALOG_TIMEOUT`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogHidePolls: 1000 }, 300, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const failed = await pollJob(base, sessionId, jobId, 8000);
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_CATALOG_TIMEOUT', kind);
          assert.match(failed.error.message, /was accepted/, kind);
          assert.match(failed.error.message, /may still appear/, kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(failed.removed, true, kind);
        });
      });

      await msdSubtest(t, `${kind}: an image that stays incomplete is incomplete`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogIncompletePolls: 1000 }, 300, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const failed = await pollJob(base, sessionId, jobId, 8000);
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_IMAGE_INCOMPLETE', kind);
          assert.match(failed.error.message, /incomplete/, kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
          assert.equal(failed.removed, true, kind);
        });
      });

      await msdSubtest(t, `${kind}: a size mismatch fails the job`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogSize: 9 }, 300, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const failed = await pollJob(base, sessionId, jobId, 8000);
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_SIZE_MISMATCH', kind);
          assert.match(failed.error.message, /size is 9, expected 4/, kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
        });
      });

      await msdSubtest(t, `${kind}: cancellation during readiness does not write again`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogHidePolls: 1000 }, 800, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          assert.equal(await waitFor(async () => {
            const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            return mid.state === 'awaiting_catalog';
          }), true, kind);
          assert.equal(cancelMsdJob(jobId), true);
          const failed = await pollJob(base, sessionId, jobId, 8000);
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_CANCELLED', kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
        });
      });

      await msdSubtest(t, `${kind}: a complete wrong size fails before the budget ends`, async (inner) => {
        watchCrashes(inner);
        const budget = 3000;
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogSize: 9 }, budget, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const failed = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_SIZE_MISMATCH', kind);
          assert.match(failed.error.message, /size is 9, expected 4/, kind);
          assert.ok(elapsed < 1000, `${kind} burned the budget (${elapsed} ms)`);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
          assert.equal(failed.removed, true, kind);
        });
      });

      await msdSubtest(t, `${kind}: an image that never appears is confirmed without another full budget`, async (inner) => {
        watchCrashes(inner);
        const budget = 2000;
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogHidePolls: 1000 }, budget, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const failed = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_CATALOG_TIMEOUT', kind);
          assert.equal(failed.removed, true, kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.ok(elapsed >= budget, `${kind} ended before the readiness budget (${elapsed} ms)`);
          assert.ok(
            elapsed < budget + MSD_UNSEEN_CONFIRM_MS + 500,
            `${kind} spent another full budget confirming absence (${elapsed} ms)`,
          );
        });
      });

      await msdSubtest(t, `${kind}: an image that comes back after remove uses the full confirm budget`, async (inner) => {
        watchCrashes(inner);
        const budget = 2000;
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({
          images: [],
          catalogIncompletePolls: 1000,
          catalogReappearPolls: 3,
        }, budget, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const failed = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_IMAGE_INCOMPLETE', kind);
          assert.equal(failed.removed, true, failed.removeError?.message);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.ok(
            elapsed > budget + MSD_UNSEEN_CONFIRM_MS,
            `${kind} confirmed on the short budget (${elapsed} ms)`,
          );
          assert.ok(elapsed < budget * 2 + 1500, `${kind} ran past the confirm budget (${elapsed} ms)`);
        });
      });

      await msdSubtest(t, `${kind}: a realtime step during confirm keeps the budget and frees the slot`, async (inner) => {
        watchCrashes(inner);
        const budget = 2000;
        const realNow = Date.now;
        let extra = 0;
        const restoreNow = () => {
          Date.now = realNow;
        };
        Date.now = () => realNow() + extra;
        inner.after(restoreNow);
        const run = kind === 'upload' ? withUpload : withFetch;
        try {
          await run({
            images: [],
            catalogIncompletePolls: 1000,
            catalogReappearPolls: 3,
          }, budget, async ({ mock, base, sessionId }) => {
            const started = await startTransfer(kind, base, sessionId);
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            const began = performance.now();
            const stepTimer = setTimeout(() => {
              extra = 10000;
            }, 400);
            inner.after(() => clearTimeout(stepTimer));
            const failed = await pollJob(base, sessionId, jobId, 8000);
            const elapsed = performance.now() - began;
            assert.equal(extra, 10000, `${kind} clock step did not run`);
            assert.equal(failed.state, 'failed', kind);
            assert.equal(failed.error.type, 'PIKVM_MSD_IMAGE_INCOMPLETE', kind);
            assert.equal(failed.removed, true, failed.removeError?.message);
            assert.equal(transferPosts(mock, kind).length, 1, kind);
            assert.ok(
              elapsed > budget + MSD_UNSEEN_CONFIRM_MS,
              `${kind} confirmed on the short budget (${elapsed} ms)`,
            );
            assert.ok(elapsed < budget * 2 + 1500, `${kind} ran past the confirm budget (${elapsed} ms)`);
            const again = await startTransfer(kind, base, sessionId);
            assert.equal(again.isError, undefined, `${kind} slot: ${again.content[0].text}`);
            const againId = JSON.parse(again.content[0].text).jobId;
            const finished = await pollJob(base, sessionId, againId, 8000);
            assert.equal(finished.state, 'failed', kind);
            assert.equal(finished.error.type, 'PIKVM_MSD_IMAGE_INCOMPLETE', kind);
          });
        } finally {
          restoreNow();
        }
      });

      await msdSubtest(t, `${kind}: a slow catalog read stops near the readiness deadline`, async (inner) => {
        watchCrashes(inner);
        const budget = 500;
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({
          images: [],
          catalogHidePolls: 50,
          msdGetDelayMs: 4000,
          msdGetDelayCount: 1,
        }, budget, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const failed = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_CATALOG_TIMEOUT', kind);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.ok(elapsed >= budget + 350, `${kind} stopped early (${elapsed} ms)`);
          assert.ok(
            elapsed < budget + MSD_UNSEEN_CONFIRM_MS + 600,
            `${kind} waited out the slow read (${elapsed} ms)`,
          );
        });
      });

      await msdSubtest(t, `${kind}: an incomplete wrong size keeps polling`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogIncompletePolls: 2, catalogSize: 9 }, 4000, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const failed = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_SIZE_MISMATCH', kind);
          assert.match(failed.error.message, /size is 9, expected 4/, kind);
          assert.ok(elapsed >= 700, `${kind} stopped on an incomplete wrong size (${elapsed} ms)`);
          assert.ok(elapsed < 2500, `${kind} waited out a long budget (${elapsed} ms)`);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(failed.removed, true, kind);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
        });
      });

      await msdSubtest(t, `${kind}: an incomplete wrong size stays incomplete until the deadline`, async (inner) => {
        watchCrashes(inner);
        const budget = 500;
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({ images: [], catalogIncompletePolls: 1000, catalogSize: 9 }, budget, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          const began = performance.now();
          const failed = await pollJob(base, sessionId, jobId, 8000);
          const elapsed = performance.now() - began;
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_IMAGE_INCOMPLETE', kind);
          assert.ok(elapsed >= 400, `${kind} failed fast on an incomplete wrong size (${elapsed} ms)`);
          assert.equal(transferPosts(mock, kind).length, 1, kind);
          assert.equal(failed.removed, true, kind);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
        });
      });

      await msdSubtest(t, `${kind}: catalog failure cleanup holds the MSD lock`, async (inner) => {
        watchCrashes(inner);
        const run = kind === 'upload' ? withUpload : withFetch;
        await run({
          images: ['other.img'],
          catalogIncompletePolls: 1000,
        }, 800, async ({ mock, base, sessionId }) => {
          const started = await startTransfer(kind, base, sessionId);
          const { jobId } = JSON.parse(started.content[0].text);
          assert.equal(await waitFor(async () => {
            const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            return mid.state === 'awaiting_catalog';
          }, 4000), true, kind);
          const other = await openSession(base);
          const mountPromise = callTool(base, other, 'pikvm_msd_mount', {
            image: 'other.img',
            confirmImage: 'other.img',
            mode: 'flash',
            connect: false,
          });
          await new Promise((resolve) => setTimeout(resolve, 40));
          assert.equal(mock.calls.some((call) => call.path === '/api/msd/set_params'), false, kind);
          const failed = await pollJob(base, sessionId, jobId, 8000);
          assert.equal(failed.state, 'failed', kind);
          assert.equal(failed.error.type, 'PIKVM_MSD_IMAGE_INCOMPLETE', kind);
          assert.equal(failed.removed, true, kind);
          const mounted = await mountPromise;
          assert.equal(mounted.isError, undefined, `${kind}: ${mounted.content[0].text}`);
          const paths = mock.calls.map((call) => call.path);
          const removeAt = paths.indexOf('/api/msd/remove');
          const paramsAt = paths.indexOf('/api/msd/set_params');
          assert.ok(removeAt !== -1 && paramsAt !== -1, kind);
          assert.ok(removeAt < paramsAt, `${kind} mounted before cleanup (${removeAt} vs ${paramsAt})`);
          assert.equal(mock.state.images['disk.img'], undefined, kind);
        });
      });
    }

    await msdSubtest(t, 'an image absent at remove time, then visible, is confirmed gone', async (inner) => {
      watchCrashes(inner);
      // The catalog budget is fractional monotonic time. setTimeout
      // truncates a fractional remain and can fire about 1 ms early, so
      // this 300 ms budget sometimes starts a fourth GET. Hiding three
      // polls lets that GET see the image, and the job ends done. Hide
      // until 350 ms after the first fresh catalog read: that extra GET
      // is still absent, and removal confirm, which starts after the
      // budget, sees the image.
      await withUpload({ images: [], catalogHideMs: 350 }, 300, async ({ mock, base, sessionId }) => {
        const started = await startTransfer('upload', base, sessionId);
        const { jobId } = JSON.parse(started.content[0].text);
        const failed = await pollJob(base, sessionId, jobId, 8000);
        const catalogGets = mock.calls.filter((call) => call.method === 'GET' && call.path === '/api/msd').length;
        assert.equal(failed.state, 'failed', `gets ${catalogGets} error ${failed.error?.type}`);
        assert.equal(failed.error.type, 'PIKVM_MSD_CATALOG_TIMEOUT');
        assert.equal(failed.removed, true, failed.removeError?.message);
        assert.equal(mock.state.images['disk.img'], undefined);
        assert.equal(transferPosts(mock, 'upload').length, 1);
        assert.ok(mock.calls.some((call) => call.path === '/api/msd/remove'));
      });
    });

    await msdSubtest(t, 'a successful upload is done, with the slot free, before mount', async (inner) => {
      watchCrashes(inner);
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.from('abcd'));
        await writeFile(join(dir, 'next.img'), Buffer.from('wxyz'));
        let release;
        // The hook pauses only the first upload. The sha256-mismatch upload
        // below also closes through this hook; blocking it keeps the
        // process-wide slot held after this test returns.
        let pauseSlotRelease = true;
        const flags = uploadMsd(dir, {
          beforeSlotRelease: () => {
            if (!pauseSlotRelease) return undefined;
            pauseSlotRelease = false;
            return new Promise((resolve) => { release = resolve; });
          },
        });
        try {
          await withSession({
            images: ['other.img'],
            holdMutations: 1,
          }, flags, async ({ mock, base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            assert.equal(await waitFor(() => typeof release === 'function'), true);
            const mid = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            assert.equal(mid.state, 'awaiting_catalog');
            const blocked = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'next.img',
              confirmImage: 'next.img',
            });
            assert.equal(blocked.isError, true);
            assert.match(blocked.content[0].text, /upload already running/);
            const other = await openSession(base);
            const mountPromise = callTool(base, other, 'pikvm_msd_mount', {
              image: 'other.img',
              confirmImage: 'other.img',
              mode: 'flash',
              connect: false,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(mock.calls.some((call) => call.path === '/api/msd/set_params'), false);
            release();
            release = undefined;
            assert.equal(await waitFor(() => mock.calls.some((call) => call.path === '/api/msd/set_params'), 4000), true);
            const done = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            assert.equal(done.state, 'done');
            const next = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'next.img',
              confirmImage: 'next.img',
              sha256: 'b'.repeat(64),
            });
            assert.equal(next.isError, undefined, next.content[0].text);
            const nextId = JSON.parse(next.content[0].text).jobId;
            assert.equal(typeof nextId, 'string');
            mock.releaseHold();
            const mounted = await mountPromise;
            assert.equal(mounted.isError, undefined, mounted.content[0].text);
            assert.equal(JSON.parse(mounted.content[0].text).drive.image.name, 'other.img');
            assert.equal(mock.calls.filter((call) => (
              call.path === '/api/msd/write' && call.query.includes('next.img')
            )).length, 0);
            const nextFailed = await pollJob(base, sessionId, nextId);
            assert.equal(nextFailed.state, 'failed');
            assert.match(nextFailed.error.message, /sha256 mismatch/);
          });
        } finally {
          if (release) release();
        }
      });
    });

    await msdSubtest(t, 'a close failure after the catalog removes the image under the lock', async (inner) => {
      watchCrashes(inner);
      await withDir(async (dir) => {
        await writeFile(join(dir, 'disk.img'), Buffer.from('abcd'));
        let opened = false;
        let release;
        const flags = uploadMsd(dir, {
          closeFile: async (fh) => {
            await fh.close();
            opened = true;
            await new Promise((resolve) => { release = resolve; });
            throw new Error('close failed');
          },
        });
        try {
          await withSession({
            images: ['other.img'],
            holdMutations: 1,
          }, flags, async ({ mock, base, sessionId }) => {
            const started = await callTool(base, sessionId, 'pikvm_msd_upload', {
              file: 'disk.img',
              confirmImage: 'disk.img',
            });
            assert.equal(started.isError, undefined, started.content[0].text);
            const { jobId } = JSON.parse(started.content[0].text);
            assert.equal(await waitFor(() => opened && typeof release === 'function'), true);
            assert.equal(mock.state.images['disk.img'].complete, true);
            const other = await openSession(base);
            const mountPromise = callTool(base, other, 'pikvm_msd_mount', {
              image: 'other.img',
              confirmImage: 'other.img',
              mode: 'flash',
              connect: false,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.equal(mock.calls.some((call) => call.path === '/api/msd/set_params'), false);
            release();
            release = undefined;
            assert.equal(await waitFor(() => mock.calls.some((call) => call.path === '/api/msd/set_params'), 8000), true);
            assert.equal(mock.state.images['disk.img'], undefined);
            const failed = JSON.parse((await callTool(base, sessionId, 'pikvm_msd_job', { jobId })).content[0].text);
            assert.equal(failed.state, 'failed');
            assert.match(failed.error.message, /close failed/);
            assert.equal(failed.removed, true);
            const paths = mock.calls.map((call) => call.path);
            assert.ok(paths.indexOf('/api/msd/remove') < paths.indexOf('/api/msd/set_params'));
            mock.releaseHold();
            const mounted = await mountPromise;
            assert.equal(mounted.isError, undefined, mounted.content[0].text);
          });
        } finally {
          if (release) release();
        }
      });
    });
  });
});
