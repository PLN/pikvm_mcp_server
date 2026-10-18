// Modified 2026-10 by PLN: opt-in HID hardware check (GPL-3.0; see NOTICE).

/**
 * Types a short string into whatever currently has focus on the target.
 * Skipped unless PIKVM_HW_TEST_ALLOW_HID=1 and PIKVM_MCP_ARM_HID=1.
 * Put the target on a safe screen, such as an empty text editor, first.
 * delay is milliseconds. 0 and 50 must be accepted, which means kvmd
 * received seconds (0 and 0.05), not 50 seconds.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hwSkipReason } from './gate.mjs';
import { openHardwareSession } from './session.mjs';

const skip = hwSkipReason();

describe('HID hardware', { concurrency: false }, () => {
  test('pikvm_type accepts delay 0 and 50 ms', { skip }, async (t) => {
    if (process.env.PIKVM_HW_TEST_ALLOW_HID !== '1') {
      t.skip('PIKVM_HW_TEST_ALLOW_HID is not 1; nothing is typed');
      return;
    }
    if (process.env.PIKVM_MCP_ARM_HID !== '1') {
      t.skip('PIKVM_MCP_ARM_HID is not 1; HID tools stay disarmed');
      return;
    }
    const session = await openHardwareSession();
    try {
      for (const delay of [0, 50]) {
        const result = await session.call('pikvm_type', { text: 'hw', delay });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        console.log(`hw: pikvm_type delay ${delay} accepted`);
      }
    } finally {
      await session.close();
    }
  });
});
