// Modified 2026-10 by PLN: read-only hardware checks (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: closed-port probe uses 65000 (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: reject fetch bad ports (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: log the TLS mode (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: screenshot region and optional OCR (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a bad password is 401 or 403 (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: kvmd OCR text is a JSON block (GPL-3.0; see NOTICE).

/**
 * Read-only checks. Nothing here changes the drive.
 * With PIKVM_HW_TEST_DEVICE unset, every test is skipped and this
 * file does not open a socket. A name other than "default" fails
 * before a client is constructed.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { KvmdError, PiKVMClient } from '../../dist/pikvm/client.js';
import { hwSkipReason } from './gate.mjs';
import { unreachableProbePort } from './probe-port.mjs';
import { kvmdGet, openHardwareSession, redactForLog } from './session.mjs';

const skip = hwSkipReason();

function versionOf(system) {
  if (!system || typeof system !== 'object') return undefined;
  if (typeof system.kvmd?.version === 'string') return system.kvmd.version;
  if (typeof system.version === 'string') return system.version;
  return undefined;
}

function modelOf(hw) {
  const platform = hw?.platform;
  if (!platform || typeof platform !== 'object') return undefined;
  for (const key of ['base', 'type', 'model', 'board']) {
    if (typeof platform[key] === 'string' && platform[key] !== '') return platform[key];
  }
  return undefined;
}

function metadataOf(result) {
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '';
  const line = text.split('\n').find((item) => item.startsWith('{'));
  assert.ok(line, text);
  return JSON.parse(line);
}

describe('read-only hardware', { concurrency: false }, () => {
  test('connectivity and auth', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const ok = await session.pikvm.checkAuth();
      assert.equal(ok, true);
      console.log(`hw: auth ok device=${session.device}`);
    } finally {
      await session.close();
    }
  });

  test('system info logs the kvmd version and model', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const response = await kvmdGet(session.config.pikvm, '/api/info?fields=system,hw');
      assert.equal(response.status, 200, redactForLog(response.text, session.config.pikvm.password));
      const body = JSON.parse(response.text);
      assert.equal(body.ok, true);
      const version = versionOf(body.result?.system);
      const model = modelOf(body.result?.hw);
      console.log(`hw: kvmd version ${version ?? 'unknown'}`);
      console.log(`hw: model ${model ?? 'unknown'}`);
      console.log(`hw: info ${redactForLog(body.result ?? {}, session.config.pikvm.password)}`);
      assert.equal(typeof version, 'string');
      assert.ok(version.length > 0);
    } finally {
      await session.close();
    }
  });

  test('raw /api/msd is parsed by pikvm_msd_status', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const response = await kvmdGet(session.config.pikvm, '/api/msd');
      assert.equal(response.status, 200);
      console.log(`hw: raw /api/msd ${redactForLog(response.text, session.config.pikvm.password)}`);
      const raw = JSON.parse(response.text);
      assert.equal(raw.ok, true);
      const result = await session.call('pikvm_msd_status', {});
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(typeof parsed.online, 'boolean');
      assert.equal(typeof parsed.busy, 'boolean');
      assert.ok('drive' in parsed);
      assert.equal(typeof parsed.images, 'object');
      assert.ok(parsed.images);
      const rawImages = raw.result?.storage?.images ?? {};
      for (const name of Object.keys(rawImages)) {
        assert.ok(Object.hasOwn(parsed.images, name), name);
      }
      console.log(`hw: tls mode=${session.config.pikvm.tls.default.mode}`);
    } finally {
      await session.close();
    }
  });

  test('tls mode is logged and a pin matches', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const tls = session.config.pikvm.tls.default;
      console.log(`hw: tls mode=${tls.mode}`);
      if (tls.mode === 'pin') {
        await session.pikvm.getMsdState();
        console.log(`hw: tls pin=match spki=${tls.spkiSha256}`);
      }
      assert.equal(tls.device, 'default');
      assert.ok(tls.mode === 'verify' || tls.mode === 'pin' || tls.mode === 'insecure');
    } finally {
      await session.close();
    }
  });

  test('a bad password is one 401 or 403 and PIKVM_AUTH_FAILED', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const wrong = new PiKVMClient({
        ...session.config.pikvm,
        password: `hw-test-bad-${randomBytes(8).toString('hex')}`,
      });
      try {
        // One getMsdState. 401 and 403 are both PIKVM_AUTH_FAILED and are not retried.
        await assert.rejects(
          () => wrong.getMsdState(),
          (err) => {
            assert.ok(err instanceof KvmdError);
            assert.ok(err.status === 401 || err.status === 403);
            assert.equal(err.type, 'PIKVM_AUTH_FAILED');
            assert.equal(err.message.includes(session.config.pikvm.password), false);
            return true;
          },
        );
      } finally {
        await wrong.close();
      }
    } finally {
      await session.close();
    }
  });

  test('a closed port on the same host is PIKVM_UNREACHABLE', { skip }, async (t) => {
    const choice = unreachableProbePort(process.env.PIKVM_HW_TEST_UNREACHABLE_PORT);
    if (choice.skip) {
      t.skip(choice.reason);
      return;
    }
    const port = choice.port;
    const session = await openHardwareSession();
    try {
      const url = new URL(session.config.pikvm.host);
      url.port = String(port);
      const probe = new PiKVMClient({
        ...session.config.pikvm,
        host: url.origin,
        requestTimeoutMs: 2000,
      });
      try {
        await assert.rejects(() => probe.getMsdState(), (err) => {
          assert.ok(err instanceof KvmdError);
          if (err.type === 'PIKVM_TIMEOUT') {
            t.skip(`port ${port} did not refuse the connection`);
            return true;
          }
          assert.equal(err.type, 'PIKVM_UNREACHABLE');
          return true;
        });
      } finally {
        await probe.close();
      }
    } finally {
      await session.close();
    }
  });

  test('screenshot region and coordinate metadata', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const full = await session.call('pikvm_screenshot', {});
      assert.notEqual(full.isError, true, full.content?.[0]?.text);
      const meta = metadataOf(full);
      assert.equal(meta.hid.min, -32768);
      assert.equal(meta.hid.max, 32767);
      assert.equal(typeof meta.actualWidth, 'number');
      assert.ok(meta.width >= 1 && meta.height >= 1);
      assert.equal(typeof meta.scaleX, 'number');
      assert.equal(typeof meta.scaleY, 'number');
      assert.equal(typeof meta.frameId, 'string');
      assert.ok(meta.frameId.length > 0);
      const cropped = await session.call('pikvm_screenshot', {
        region: { x: 0, y: 0, width: 1, height: 1 },
      });
      assert.notEqual(cropped.isError, true, cropped.content?.[0]?.text);
      const regionMeta = metadataOf(cropped);
      assert.deepEqual(regionMeta.region, { x: 0, y: 0, width: 1, height: 1 });
      assert.equal(regionMeta.width, 1);
      assert.equal(regionMeta.height, 1);
      assert.equal(typeof regionMeta.frameId, 'string');
      assert.notEqual(regionMeta.frameId, meta.frameId);
      assert.equal(regionMeta.actualWidth, meta.actualWidth);
      assert.equal(regionMeta.actualHeight, meta.actualHeight);
      const image = cropped.content.find((part) => part.type === 'image');
      assert.equal(image?.mimeType, 'image/jpeg');
      assert.equal(typeof image?.data, 'string');
      assert.ok(image.data.length > 0);
    } finally {
      await session.close();
    }
  });

  test('OCR reads text when the device enables it', { skip }, async (t) => {
    const session = await openHardwareSession();
    try {
      if (session.ocr.engine !== 'kvmd') {
        t.skip('kvmd is not the effective OCR engine');
        return;
      }
      const state = session.pikvm.ocrState();
      if (state.status !== 'enabled') {
        t.skip('OCR is disabled on this device');
        return;
      }
      const args = state.langs.length > 0 ? { langs: state.langs[0] } : {};
      const result = await session.call('pikvm_read_text', args);
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const body = JSON.parse(result.content[0].text);
      assert.equal(body.engine, 'kvmd');
      assert.deepEqual(body.words, []);
      assert.equal(typeof body.text, 'string');
    } finally {
      await session.close();
    }
  });
});
