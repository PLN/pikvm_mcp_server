// Modified 2026-10 by PLN: HID print ceiling tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_type delay is milliseconds (GPL-3.0; see NOTICE).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HID_OTHER_DEADLINE_MS,
  HID_PRINT_MIN_MS,
  hidDelayQueryValue,
  hidPrintCeilingMs,
} from '../dist/hid-deadline.js';

test('print ceiling is at least 10s when there is no per-event delay', () => {
  assert.equal(HID_PRINT_MIN_MS, 10_000);
  assert.equal(hidPrintCeilingMs(0, undefined, false), 10_000);
  assert.equal(hidPrintCeilingMs(1, undefined, false), 10_000);
  assert.equal(hidPrintCeilingMs(5000, undefined, false), 10_000);
  assert.equal(hidPrintCeilingMs(1, 0, true), 10_000);
});

test('slow uses 0.02s per event when delay is omitted', () => {
  // 5 + 1.5 × (4·1 + 2) × 0.02 + 5 = 10.18s
  assert.equal(hidPrintCeilingMs(1, undefined, true), 10_180);
});

test('delay is the per-event seconds actually sent to kvmd', () => {
  // 50 ms is 0.05s. 5 + 1.5 × (4·10 + 2) × 0.05 + 5 = 13.15s
  assert.equal(hidPrintCeilingMs(10, 0.05, false), 13_150);
});

test('tool delay milliseconds become the kvmd seconds query', () => {
  assert.equal(hidDelayQueryValue(0), '0');
  assert.equal(hidDelayQueryValue(50), '0.05');
  assert.equal(hidDelayQueryValue(200), '0.2');
  assert.equal(hidDelayQueryValue(1), '0.001');
});

test('200 ms on a long string is 0.2s per event in the ceiling', () => {
  // 33 characters: 5 + 1.5 × (4·33 + 2) × 0.2 + 5 = 50.2s
  assert.equal(hidPrintCeilingMs(33, 0.2, false), 50_200);
  // 32 characters: 49s, under the 50s refusal line
  assert.equal(hidPrintCeilingMs(32, 0.2, false), 49_000);
});

test('print length is capped at 1024 for the ceiling', () => {
  const atCap = hidPrintCeilingMs(1024, 0.01, false);
  const pastCap = hidPrintCeilingMs(5000, 0.01, false);
  assert.equal(atCap, pastCap);
  assert.ok(atCap > hidPrintCeilingMs(1023, 0.01, false));
});

test('other HID routes use a fixed 30s deadline', () => {
  assert.equal(HID_OTHER_DEADLINE_MS, 30_000);
});
