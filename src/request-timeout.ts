// Modified 2026-10 by PLN: clamp PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD upload job and idle deadlines (GPL-3.0; see NOTICE).

/** Default abort deadline for one ordinary kvmd call. */
export const REQUEST_TIMEOUT_DEFAULT_MS = 5000;

/** Ten minutes. Longer waits are clamped to this. */
export const REQUEST_TIMEOUT_MAX_MS = 600000;

/**
 * Integer milliseconds in 1..600000.
 * A non-finite or non-positive value uses the default.
 * A value above 600000 is clamped.
 */
export function clampRequestTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return REQUEST_TIMEOUT_DEFAULT_MS;
  const n = Math.trunc(value);
  if (n <= 0) return REQUEST_TIMEOUT_DEFAULT_MS;
  if (n > REQUEST_TIMEOUT_MAX_MS) return REQUEST_TIMEOUT_MAX_MS;
  return n;
}

/**
 * Parse PIKVM_REQUEST_TIMEOUT_MS. Only a string of digits is accepted.
 * '5000abc', '1e3', ' 5000 ', and '5.5' use the default. 0 uses the
 * default. Values above 600000 clamp.
 */
export function parseRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return REQUEST_TIMEOUT_DEFAULT_MS;
  return clampRequestTimeoutMs(Number(raw));
}

/**
 * Wall clock for one MSD upload or remote download. Six hours.
 * Not clamped to REQUEST_TIMEOUT_MAX_MS: that cap is for ordinary calls.
 */
export const MSD_JOB_TIMEOUT_DEFAULT_MS = 6 * 60 * 60 * 1000;

/** Idle gap while an MSD upload body or progress stream is moving. */
export const MSD_IDLE_TIMEOUT_DEFAULT_MS = 60 * 1000;

/**
 * Parse an MSD deadline. Only a string of digits is accepted.
 * Anything else, including 0, uses `fallback`. No upper clamp.
 */
export function parseMsdTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return normalizeMsdTimeoutMs(Number(raw), fallback);
}

/** A positive integer, or `fallback` when the value is unusable. */
export function normalizeMsdTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const n = Math.trunc(value);
  if (!Number.isSafeInteger(n) || n <= 0) return fallback;
  return n;
}
