// Modified 2026-10 by PLN: clamp PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).

/** Default abort deadline for one ordinary kvmd call. */
export const REQUEST_TIMEOUT_DEFAULT_MS = 5000;

export const REQUEST_TIMEOUT_MIN_MS = 1;

/** Ten minutes. Longer HID typing is not covered by this deadline. */
export const REQUEST_TIMEOUT_MAX_MS = 600000;

/**
 * Integer milliseconds in 1..600000.
 * A non-finite value (missing or not a number) stays at the default.
 */
export function clampRequestTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return REQUEST_TIMEOUT_DEFAULT_MS;
  const n = Math.trunc(value);
  if (n < REQUEST_TIMEOUT_MIN_MS) return REQUEST_TIMEOUT_MIN_MS;
  if (n > REQUEST_TIMEOUT_MAX_MS) return REQUEST_TIMEOUT_MAX_MS;
  return n;
}
