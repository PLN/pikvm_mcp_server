// Modified 2026-10 by PLN: per-call HID deadlines (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_type delay is milliseconds (GPL-3.0; see NOTICE).

/**
 * PiKVM's nginx likely applies the default 60s proxy_read_timeout on
 * /api/. That has not been confirmed on hardware. A print whose own
 * ceiling is above 50s would be cut off there while kvmd is still
 * typing, so the client refuses it before the call.
 */
export const HID_PRINT_REFUSE_MS = 50_000;

/** Floor for a print that has no per-event delay. */
export const HID_PRINT_MIN_MS = 10_000;

/** Key, shortcut, mouse, wheel, and reset. */
export const HID_OTHER_DEADLINE_MS = 30_000;

/** kvmd's built-in delay when `slow` is set and `delay` is not. */
export const HID_SLOW_EVENT_SEC = 0.02;

export const HID_STATE_UNKNOWN_MESSAGE = 'input may still be applying; do not resend';

/**
 * Seconds kvmd waits between HID events for this print.
 * `delaySent` is the query value, which is the tool delay in
 * milliseconds divided by 1000. kvmd reads that number as seconds.
 * When it is omitted, slow uses 0.02s.
 */
export function hidPrintPerEventSec(delaySent: number | undefined, slow: boolean): number {
  if (delaySent !== undefined && Number.isFinite(delaySent) && delaySent >= 0) {
    return delaySent;
  }
  if (slow) return HID_SLOW_EVENT_SEC;
  return 0;
}

/**
 * Abort ceiling for POST /hid/print, in milliseconds.
 * 5s + 1.5 × (4·min(len,1024) + 2) × perEventSec + 5s, and at least 10s.
 */
export function hidPrintCeilingMs(
  textLength: number,
  delaySent: number | undefined,
  slow: boolean,
): number {
  const len = Number.isFinite(textLength) && textLength > 0 ? textLength : 0;
  const perEventSec = hidPrintPerEventSec(delaySent, slow);
  const events = 4 * Math.min(len, 1024) + 2;
  const seconds = 5 + 1.5 * events * perEventSec + 5;
  return Math.max(HID_PRINT_MIN_MS, Math.round(seconds * 1000));
}

/**
 * Tool `delay` is milliseconds. kvmd's query is seconds.
 * Three decimal places is one millisecond, which is the step this
 * conversion keeps.
 */
export function hidDelayQueryValue(delayMs: number): string {
  const ms = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  return (ms / 1000).toFixed(3).replace(/\.?0+$/, '');
}
