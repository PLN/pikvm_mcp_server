// Modified 2026-10 by PLN: MSD cycle cleanup against the mock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: 1 MiB ISO and leftover names (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: restore a leftover image this run did not create (GPL-3.0; see NOTICE).

/**
 * Forced-failure dry run. The kvmd mock stands in for the device.
 * Cleanup must disconnect, delete only the names this run created, and
 * restore the snapshot. Another mcp-hwtest-* image is left in place.
 * No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { parseUrlAllowlist } from '../dist/url-policy.js';
import {
  HW_ISO_BYTES,
  HW_ISO_SECTOR,
  hwIsoBytes,
  hwTestImageName,
  isHwTestImageName,
  prepareHwImage,
} from './hw/media.mjs';
import { openToolSession } from './hw/session.mjs';
import { runMsdWriteCycle } from './hw/cycle.mjs';
import { startKvmdMock } from './kvmd-mock.mjs';

const execFileAsync = promisify(execFile);
const ALLOW = parseUrlAllowlist('https://images.example/hw');
const FETCH_URL = 'https://images.example/hw/payload.iso';

function msdConfig(dir, extra = {}) {
  return {
    localDir: dir,
    maxBytes: 8 * 1024 * 1024,
    extensions: ['.iso', '.img'],
    urlAllow: ALLOW,
    allowPrivate: false,
    connectTimeoutSec: 30,
    resolveUrl: async () => ['192.0.3.10'],
    uploadPollMs: 20,
    ...extra,
  };
}

async function withCycle(mockOptions, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pikvm-hwcycle-'));
  const mock = await startKvmdMock(mockOptions);
  const pikvm = new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
    requestTimeoutMs: 2000,
    msdJobTimeoutMs: 20000,
    msdIdleTimeoutMs: 5000,
  });
  const session = await openToolSession({
    pikvm,
    msd: msdConfig(dir),
    armMsd: true,
    armHid: false,
  });
  try {
    await fn({ mock, dir, session, pikvm });
  } finally {
    await session.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function assertIsoLayout(bytes) {
  assert.ok(bytes.length >= 614400);
  assert.equal(bytes.length % HW_ISO_SECTOR, 0);
  assert.equal(bytes.length, HW_ISO_BYTES);
  const pvd = 16 * HW_ISO_SECTOR;
  assert.equal(bytes[pvd], 1);
  assert.equal(bytes.toString('ascii', pvd + 1, pvd + 6), 'CD001');
  assert.equal(bytes[pvd + 6], 1);
  assert.equal(bytes.readUInt32LE(pvd + 80), 512);
  assert.equal(bytes.readUInt32BE(pvd + 84), 512);
  assert.equal(bytes.readUInt16LE(pvd + 128), 2048);
  assert.equal(bytes.readUInt16BE(pvd + 130), 2048);
  assert.equal(bytes.readUInt32LE(pvd + 158), 18);
  const term = 17 * HW_ISO_SECTOR;
  assert.equal(bytes[term], 0xff);
  assert.equal(bytes.toString('ascii', term + 1, term + 6), 'CD001');
  assert.equal(bytes[term + 6], 1);
  const root = 18 * HW_ISO_SECTOR;
  assert.equal(bytes[root + 33], 0x00);
  assert.equal(bytes[root + 34 + 33], 0x01);
}

async function optionalIsoTool(bin, args, pattern) {
  try {
    const { stdout } = await execFileAsync(bin, args, { encoding: 'utf8' });
    assert.match(String(stdout), pattern, bin);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
}

test('the generated ISO is at least 300 sectors and has a PVD', async () => {
  const bytes = hwIsoBytes();
  assertIsoLayout(bytes);
  assert.deepEqual(bytes, hwIsoBytes());
  assert.equal(isHwTestImageName('mcp-hwtest-1-ab.iso'), true);
  assert.equal(isHwTestImageName('mcp-hwtest.iso'), false);
  assert.equal(isHwTestImageName('keep.img'), false);
  assert.equal(isHwTestImageName('mcp-hwtest-../x.iso'), false);
  const dir = await mkdtemp(join(tmpdir(), 'pikvm-hwmedia-'));
  try {
    const name = hwTestImageName();
    const prepared = await prepareHwImage(dir, name);
    assert.equal(prepared.bytes, HW_ISO_BYTES);
    assert.match(name, /^mcp-hwtest-\d+-[0-9a-f]+\.iso$/);
    const stored = await readFile(prepared.path);
    assertIsoLayout(stored);
    await optionalIsoTool('file', ['-b', prepared.path], /ISO 9660/i);
    await optionalIsoTool('isoinfo', ['-d', '-i', prepared.path], /CD001|Volume size is/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('MSD cycle dry run', { concurrency: false }, () => {
  test('a connected drive is skipped and not changed', async () => {
    await withCycle({
      images: ['disk.img', 'keep.img'],
      drive: { image: 'disk.img', connected: true, cdrom: false, rw: true },
    }, async ({ mock, session }) => {
      const outcome = await runMsdWriteCycle(session.call, {
        allow: '1',
        imageName: hwTestImageName(),
        allowlist: ALLOW,
        timeoutMs: 5000,
      });
      assert.equal(outcome.skipped, true);
      assert.match(outcome.reason, /connected/);
      assert.match(outcome.reason, /force/);
      assert.equal(mock.state.drive.connected, true);
      assert.equal(mock.state.drive.image.name, 'disk.img');
      assert.equal(mock.state.drive.rw, true);
      assert.equal(mock.calls.some((call) => call.method === 'POST'), false);
    });
  });

  test('a busy drive is skipped', async () => {
    await withCycle({
      images: ['disk.img'],
      busyFor: 4,
    }, async ({ mock, session }) => {
      const outcome = await runMsdWriteCycle(session.call, {
        allow: '1',
        imageName: hwTestImageName(),
        allowlist: ALLOW,
        timeoutMs: 5000,
      });
      assert.equal(outcome.skipped, true);
      assert.match(outcome.reason, /busy/);
      assert.equal(mock.calls.some((call) => call.method === 'POST'), false);
    });
  });

  test('a forced failure restores the snapshot and leaves other mcp-hwtest names', async () => {
    const imageName = hwTestImageName();
    const logs = [];
    await withCycle({
      images: ['disk.img', 'keep.img', 'mcp-hwtest.iso', 'mcp-hwtest-stale.iso'],
      drive: { image: 'disk.img', connected: true, cdrom: false, rw: true },
    }, async ({ mock, dir, session, pikvm }) => {
      await writeFile(join(dir, imageName), hwIsoBytes());
      await assert.rejects(
        () => runMsdWriteCycle(session.call, {
          allow: 'force',
          imageName,
          allowlist: ALLOW,
          failAfter: 'mount-cdrom',
          timeoutMs: 5000,
          client: pikvm,
          log: (line) => logs.push(line),
        }),
        /forced failure/,
      );
      assert.equal(mock.state.drive.connected, true);
      assert.equal(mock.state.drive.image.name, 'disk.img');
      assert.equal(mock.state.drive.cdrom, false);
      assert.equal(mock.state.drive.rw, true);
      assert.ok(mock.state.images['disk.img']);
      assert.ok(mock.state.images['keep.img']);
      assert.ok(mock.state.images['mcp-hwtest.iso']);
      assert.ok(mock.state.images['mcp-hwtest-stale.iso']);
      assert.equal(mock.state.images[imageName], undefined);
      assert.ok(logs.some((line) => line.includes('leftover') && line.includes('mcp-hwtest-stale.iso')));
      assert.ok(logs.some((line) => line.includes('cleanup restored disk.img')));
    });
  });

  test('a selected leftover mcp-hwtest image is restored', async () => {
    const imageName = hwTestImageName();
    const logs = [];
    await withCycle({
      images: ['mcp-hwtest-stale.img', 'keep.img'],
      drive: { image: 'mcp-hwtest-stale.img', connected: true, cdrom: false, rw: true },
    }, async ({ mock, dir, session, pikvm }) => {
      await writeFile(join(dir, imageName), hwIsoBytes());
      await assert.rejects(
        () => runMsdWriteCycle(session.call, {
          allow: 'force',
          imageName,
          allowlist: ALLOW,
          failAfter: 'mount-cdrom',
          timeoutMs: 5000,
          client: pikvm,
          log: (line) => logs.push(line),
        }),
        /forced failure/,
      );
      assert.equal(mock.state.drive.connected, true);
      assert.equal(mock.state.drive.image.name, 'mcp-hwtest-stale.img');
      assert.equal(mock.state.drive.cdrom, false);
      assert.equal(mock.state.drive.rw, true);
      assert.ok(mock.state.images['mcp-hwtest-stale.img']);
      assert.ok(mock.state.images['keep.img']);
      assert.equal(mock.state.images[imageName], undefined);
      assert.ok(logs.some((line) => line.includes('cleanup restored mcp-hwtest-stale.img')));
    });
  });

  test('the full cycle uploads, ejects twice, fetches, and leaves the snapshot', async () => {
    const imageName = hwTestImageName();
    const fetchImageName = hwTestImageName('url');
    await withCycle({
      images: ['disk.img', 'keep.img'],
      drive: { image: 'disk.img', connected: false, cdrom: true, rw: false },
    }, async ({ mock, dir, session, pikvm }) => {
      await writeFile(join(dir, imageName), hwIsoBytes());
      const outcome = await runMsdWriteCycle(session.call, {
        allow: '1',
        imageName,
        fetchUrl: FETCH_URL,
        fetchImageName,
        allowlist: ALLOW,
        timeoutMs: 5000,
        client: pikvm,
      });
      assert.equal(outcome.skipped, false);
      assert.deepEqual(outcome.leftovers, []);
      assert.equal(mock.state.drive.connected, false);
      assert.equal(mock.state.drive.image.name, 'disk.img');
      assert.equal(mock.state.drive.cdrom, true);
      assert.equal(mock.state.drive.rw, false);
      assert.ok(mock.state.images['disk.img']);
      assert.ok(mock.state.images['keep.img']);
      assert.equal(mock.state.images[imageName], undefined);
      assert.equal(mock.state.images[fetchImageName], undefined);
      assert.ok(mock.calls.some((call) => call.path === '/api/msd/write_remote'));
      const ejects = mock.calls.filter((call) => call.path === '/api/msd/set_connected' && call.query.includes('connected=0'));
      assert.ok(ejects.length >= 2);
    });
  });

  test('cdrom and rw are restored when the snapshot has no image', async () => {
    const imageName = hwTestImageName();
    await withCycle({
      images: [],
      drive: { image: null, connected: false, cdrom: false, rw: true },
    }, async ({ mock, dir, session, pikvm }) => {
      await writeFile(join(dir, imageName), hwIsoBytes());
      await assert.rejects(
        () => runMsdWriteCycle(session.call, {
          allow: '1',
          imageName,
          allowlist: ALLOW,
          failAfter: 'mount-cdrom',
          timeoutMs: 5000,
          client: pikvm,
        }),
        /forced failure/,
      );
      assert.equal(mock.state.drive.image, null);
      assert.equal(mock.state.drive.connected, false);
      assert.equal(mock.state.drive.cdrom, false);
      assert.equal(mock.state.drive.rw, true);
      assert.equal(mock.state.images[imageName], undefined);
    });
  });

  test('a non-https fetch URL fails before any upload', async () => {
    await withCycle({ images: ['disk.img'] }, async ({ mock, session }) => {
      await assert.rejects(
        () => runMsdWriteCycle(session.call, {
          allow: '1',
          imageName: hwTestImageName(),
          fetchUrl: 'http://images.example/hw/payload.iso',
          fetchImageName: hwTestImageName('url'),
          allowlist: ALLOW,
          timeoutMs: 5000,
        }),
        /https/,
      );
      assert.equal(mock.calls.some((call) => call.method === 'POST'), false);
    });
  });
});
