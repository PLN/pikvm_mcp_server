// Modified 2026-10 by PLN: MSD cycle cleanup against the mock (GPL-3.0; see NOTICE).

/**
 * Forced-failure dry run. The kvmd mock stands in for the device.
 * Cleanup must disconnect, delete only mcp-hwtest-* names, and remount
 * the snapshot. No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { parseUrlAllowlist } from '../dist/url-policy.js';
import { fallbackIsoBytes, hwTestImageName, isHwTestImageName, prepareHwImage } from './hw/media.mjs';
import { openToolSession } from './hw/session.mjs';
import { runMsdWriteCycle } from './hw/cycle.mjs';
import { startKvmdMock } from './kvmd-mock.mjs';

const ALLOW = parseUrlAllowlist('https://images.example/hw');
const FETCH_URL = 'https://images.example/hw/payload.iso';

function msdConfig(dir, extra = {}) {
  return {
    localDir: dir,
    maxBytes: 1024 * 1024,
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
    await fn({ mock, dir, session });
  } finally {
    await session.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('fallback fixture is 64 bytes and stable', () => {
  const bytes = fallbackIsoBytes();
  assert.ok(bytes.length <= 32 * 1024);
  assert.equal(bytes.length, 64);
  assert.equal(bytes.toString('ascii', 0, 8), 'MCPHWISO');
  assert.deepEqual(bytes, fallbackIsoBytes());
  assert.equal(isHwTestImageName('mcp-hwtest-1-ab.iso'), true);
  assert.equal(isHwTestImageName('mcp-hwtest.iso'), false);
  assert.equal(isHwTestImageName('keep.img'), false);
  assert.equal(isHwTestImageName('mcp-hwtest-../x.iso'), false);
});

test('prepareHwImage writes a non-empty file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pikvm-hwmedia-'));
  try {
    const name = hwTestImageName();
    const prepared = await prepareHwImage(dir, name);
    assert.ok(prepared.bytes > 0);
    assert.ok(['fixture', 'xorriso', 'genisoimage'].includes(prepared.generator));
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

  test('a forced failure restores the snapshot and deletes only mcp-hwtest images', async () => {
    const imageName = hwTestImageName();
    const logs = [];
    await withCycle({
      images: ['disk.img', 'keep.img', 'mcp-hwtest.iso', 'mcp-hwtest-stale.iso'],
      drive: { image: 'disk.img', connected: true, cdrom: false, rw: true },
    }, async ({ mock, dir, session }) => {
      await writeFile(join(dir, imageName), fallbackIsoBytes());
      await assert.rejects(
        () => runMsdWriteCycle(session.call, {
          allow: 'force',
          imageName,
          allowlist: ALLOW,
          failAfter: 'mount-cdrom',
          timeoutMs: 5000,
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
      assert.equal(mock.state.images['mcp-hwtest-stale.iso'], undefined);
      assert.equal(mock.state.images[imageName], undefined);
      assert.ok(logs.some((line) => line.includes('no mcp-hwtest images left')));
      assert.ok(logs.some((line) => line.includes('cleanup restored disk.img')));
    });
  });

  test('the full cycle uploads, ejects twice, fetches, and leaves the snapshot', async () => {
    const imageName = hwTestImageName();
    const fetchImageName = hwTestImageName('url');
    await withCycle({
      images: ['disk.img', 'keep.img'],
      drive: { image: 'disk.img', connected: false, cdrom: true, rw: false },
    }, async ({ mock, dir, session }) => {
      await writeFile(join(dir, imageName), fallbackIsoBytes());
      const outcome = await runMsdWriteCycle(session.call, {
        allow: '1',
        imageName,
        fetchUrl: FETCH_URL,
        fetchImageName,
        allowlist: ALLOW,
        timeoutMs: 5000,
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
