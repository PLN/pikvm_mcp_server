// Modified 2026-10 by PLN: opt-in MSD hardware cycle (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD also needs the device armMsd (GPL-3.0; see NOTICE).

/**
 * MSD write cycle. Skipped unless PIKVM_HW_TEST_DEVICE is set, and
 * skipped again unless PIKVM_HW_TEST_ALLOW_MSD is 1 or force and
 * PIKVM_MCP_ARM_MSD is 1. force is dangerous: it disconnects a drive
 * that is already in use. Cleanup still runs if the process is not killed.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { hwSkipReason } from './gate.mjs';
import { hwTestImageName, prepareHwImage } from './media.mjs';
import { openHardwareSession } from './session.mjs';
import { runMsdWriteCycle } from './cycle.mjs';

const skip = hwSkipReason();

describe('MSD hardware cycle', { concurrency: false }, () => {
  test('upload, mount, eject, and remove', { skip }, async (t) => {
    const allow = process.env.PIKVM_HW_TEST_ALLOW_MSD;
    if (allow !== '1' && allow !== 'force') {
      t.skip('PIKVM_HW_TEST_ALLOW_MSD is not 1; the drive is not changed');
      return;
    }
    if (process.env.PIKVM_MCP_ARM_MSD !== '1') {
      t.skip('PIKVM_MCP_ARM_MSD is not 1; MSD tools stay disarmed');
      return;
    }
    const fetchUrl = process.env.PIKVM_HW_TEST_FETCH_URL;
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-hw-'));
    const imageName = hwTestImageName();
    const fetchImageName = fetchUrl ? hwTestImageName('url') : undefined;
    let session;
    try {
      const prepared = await prepareHwImage(dir, imageName);
      console.log(`hw: image ${imageName} (${prepared.bytes} bytes)`);
      session = await openHardwareSession({ msd: { localDir: dir } });
      if (session.armMsd !== true) {
        throw new Error(`device ${session.device} armMsd is off; the hardware MSD check is refused`);
      }
      const outcome = await runMsdWriteCycle(session.call, {
        allow,
        imageName,
        fetchUrl: fetchUrl || undefined,
        fetchImageName,
        allowlist: session.config.msd.urlAllow,
        client: session.pikvm,
      });
      if (outcome.skipped) {
        t.skip(outcome.reason);
        return;
      }
      assert.deepEqual(outcome.leftovers, []);
    } finally {
      if (session) await session.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
