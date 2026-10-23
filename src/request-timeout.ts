// Modified 2026-10 by PLN: clamp PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD upload job and idle deadlines (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: cap MSD job at 7 days and idle at 1 hour (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD catalog readiness budget (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: short confirm when an image never appeared (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash reads use the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD progress windows (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: finalise window arms on request sent (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload finalise window is twice the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: stock nginx does not pre-empt the finalise window (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: nginx 60s bounds kvmd's finish, not the drain (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a post-send job cap reports phase job_timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the upload response read is phase job_timeout (GPL-3.0; see NOTICE).

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
 * During hashing the failure is PIKVM_MSD_HASH_TIMEOUT. After the request
 * has been sent, on the upload body, upload finalise, the upload
 * response read, write_remote headers, or the write_remote stream, it is
 * PIKVM_MSD_STATE_UNKNOWN with phase job_timeout. The message names
 * PIKVM_MSD_JOB_TIMEOUT_MS
 * and this millisecond value. An idle, finalise, or header window keeps
 * its own phase.
 */
export const MSD_JOB_TIMEOUT_DEFAULT_MS = 6 * 60 * 60 * 1000;

/**
 * Progress bound for each hash read, the upload body, and the
 * write_remote stream. Upload finalise, armed when the request has been
 * sent, is twice this value: the OS send buffer and the peer's receive
 * window can still be draining after the bytes are handed to the socket,
 * and the client cannot see when kvmd has read them. nginx's 60s
 * proxy_read_timeout starts only after the whole body has gone upstream,
 * so it bounds kvmd's own finish (a 504, reported as
 * PIKVM_MSD_STATE_UNKNOWN), not the drain, which can use the full 120s.
 * write_remote headers are the connect
 * timeout plus this value. A hash read that does not return within the
 * limit fails, threadpool queueing included. A 0-byte read ends the
 * hash. Not a cap on a phase that keeps making progress. The catalog
 * wait uses MSD_READY_TIMEOUT_DEFAULT_MS.
 */
export const MSD_IDLE_TIMEOUT_DEFAULT_MS = 60 * 1000;

/**
 * Seven days. Node's timer delay is a 32-bit signed integer: a larger
 * value throws RangeError from AbortSignal.timeout, or makes setTimeout
 * fire after 1 ms. Uploads must not see either.
 */
export const MSD_JOB_TIMEOUT_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** One hour. Same timer limit as the job cap, on a shorter cap. */
export const MSD_IDLE_TIMEOUT_MAX_MS = 60 * 60 * 1000;

/**
 * How long a successful upload or write_remote waits for that image
 * to show up complete in the catalog. Thirty seconds.
 */
export const MSD_READY_TIMEOUT_DEFAULT_MS = 30 * 1000;

/** Ten minutes. A longer catalog wait is clamped to this. */
export const MSD_READY_TIMEOUT_MAX_MS = 10 * 60 * 1000;

/**
 * Cleanup budget when the catalog wait never saw the image.
 * Three polls: an immediate read, then 250 ms, then 500 ms.
 * A shorter readiness budget wins. If the image appears during
 * this window, confirmation switches to the readiness budget.
 */
export const MSD_UNSEEN_CONFIRM_MS = 750;

/**
 * Parse an MSD deadline. Only a string of digits is accepted.
 * Anything else, including 0, uses `fallback`. Values above `max`
 * clamp to `max`.
 */
export function parseMsdTimeoutMs(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  return normalizeMsdTimeoutMs(Number(raw), fallback, max);
}

/**
 * A positive integer in 1..max, or `fallback` when the value is unusable.
 * Values above `max` clamp to `max`.
 */
export function normalizeMsdTimeoutMs(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const n = Math.trunc(value);
  if (!Number.isSafeInteger(n) || n <= 0) return fallback;
  if (n > max) return max;
  return n;
}
