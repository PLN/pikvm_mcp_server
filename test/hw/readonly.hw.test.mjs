// Modified 2026-10 by PLN: read-only hardware checks (GPL-3.0; see NOTICE).

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
      console.log(`hw: tls verifySsl=${session.config.pikvm.verifySsl}`);
    } finally {
      await session.close();
    }
  });

  test('a bad password is one 401 and PIKVM_AUTH_FAILED', { skip }, async () => {
    const session = await openHardwareSession();
    try {
      const wrong = new PiKVMClient({
        ...session.config.pikvm,
        password: `hw-test-bad-${randomBytes(8).toString('hex')}`,
      });
      try {
        await assert.rejects(
          () => wrong.getMsdState(),
          (err) => {
            assert.ok(err instanceof KvmdError);
            assert.equal(err.status, 401);
            assert.equal(err.type, 'PIKVM_AUTH_FAILED');
            assert.equal(err.message.includes(session.config.pikvm.password), false);
            return true;
          },
        );
      } finally {
        wrong.close();
      }
    } finally {
      await session.close();
    }
  });

  test('a closed port on the same host is PIKVM_UNREACHABLE', { skip }, async (t) => {
    const session = await openHardwareSession();
    try {
      const url = new URL(session.config.pikvm.host);
      url.port = '1';
      const probe = new PiKVMClient({
        ...session.config.pikvm,
        host: url.origin,
        requestTimeoutMs: 2000,
      });
      try {
        await assert.rejects(() => probe.getMsdState(), (err) => {
          assert.ok(err instanceof KvmdError);
          if (err.type === 'PIKVM_TIMEOUT') {
            t.skip('port 1 did not refuse the connection');
            return true;
          }
          assert.equal(err.type, 'PIKVM_UNREACHABLE');
          return true;
        });
      } finally {
        probe.close();
      }
    } finally {
      await session.close();
    }
  });
});
