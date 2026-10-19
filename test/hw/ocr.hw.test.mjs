// Modified 2026-10 by PLN: host OCR hardware timings (GPL-3.0; see NOTICE).

/**
 * Read-only OCR timings. Nothing here moves the mouse or changes the drive.
 * A bounded crop is logged for the effective engine. kvmd is also timed
 * when that device has OCR enabled. Full-frame kvmd is not called: on a
 * CM4 it can exceed 30 seconds, and a timeout is not retried.
 * With PIKVM_HW_TEST_DEVICE unset, every test is skipped.
 */

import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { describe, test } from 'node:test';
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

async function info(session) {
  const response = await kvmdGet(session.config.pikvm, '/api/info?fields=system,hw');
  assert.equal(response.status, 200, redactForLog(response.text, session.config.pikvm.password));
  const body = JSON.parse(response.text);
  return {
    version: versionOf(body.result?.system) ?? 'unknown',
    model: modelOf(body.result?.hw) ?? 'unknown',
  };
}

describe('ocr hardware', { concurrency: false }, () => {
  test('a bounded crop records snapshot and OCR time', { skip }, async (t) => {
    const session = await openHardwareSession();
    try {
      if (session.ocr.engine === 'off') {
        t.skip('OCR is off');
        return;
      }
      if (session.ocr.engine === 'kvmd' && session.pikvm.ocrState().status !== 'enabled') {
        t.skip(`kvmd OCR is ${session.pikvm.ocrState().status}`);
        return;
      }
      const source = await session.pikvm.getResolution(true);
      const box = { left: 0, top: 440, right: 640, bottom: 540 };
      if (source.width < box.right || source.height < box.bottom) {
        t.skip(`source ${source.width}x${source.height} is smaller than the crop`);
        return;
      }
      const cpu = cpus();
      const about = await info(session);
      console.log(`hw: ocr cpu ${cpu[0]?.model ?? 'unknown'} cores=${cpu.length}`);
      console.log(`hw: ocr kvmd version ${about.version}`);
      console.log(`hw: ocr model ${about.model}`);
      if (session.ocr.engine === 'host') {
        const result = await session.call('pikvm_read_text', box);
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        const body = JSON.parse(result.content[0].text);
        assert.equal(body.engine, 'host');
        console.log(
          `hw: ocr host crop snapshot=${body.durationMs.snapshot} ocr=${body.durationMs.ocr} total=${body.durationMs.total} words=${body.words.length}`,
        );
      }
      let kvmd = session.pikvm.ocrState().status;
      if (session.ocr.engine === 'host' && kvmd === 'unknown') {
        kvmd = (await session.pikvm.probeOcr(session.device)).status;
      }
      if (kvmd === 'enabled') {
        const result = await session.call('pikvm_read_text', { ...box, engine: 'kvmd' });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        const body = JSON.parse(result.content[0].text);
        assert.equal(body.engine, 'kvmd');
        console.log(
          `hw: ocr kvmd crop snapshot=${body.durationMs.snapshot} total=${body.durationMs.total}`,
        );
      }
    } finally {
      await session.close();
    }
  });

  test('fullFrame host timing when the allow flag is set', { skip }, async (t) => {
    if (process.env.PIKVM_OCR_ALLOW_FULL_FRAME !== '1') {
      t.skip('PIKVM_OCR_ALLOW_FULL_FRAME is not 1');
      return;
    }
    const session = await openHardwareSession();
    try {
      if (session.ocr.engine !== 'host') {
        t.skip('host OCR is not the effective engine');
        return;
      }
      console.log('hw: full-frame kvmd OCR is not run. On a CM4 it can exceed 30s and is not retried.');
      const result = await session.call('pikvm_read_text', { fullFrame: true });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      const body = JSON.parse(result.content[0].text);
      assert.equal(body.engine, 'host');
      assert.equal(body.crop, null);
      console.log(
        `hw: ocr host full snapshot=${body.durationMs.snapshot} ocr=${body.durationMs.ocr} total=${body.durationMs.total} words=${body.words.length}`,
      );
    } finally {
      await session.close();
    }
  });
});
