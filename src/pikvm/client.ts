// Modified 2026-10 by PLN: typed KvmdError, timeouts, GET retry (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: client MSD methods (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD deadline caps and upload error codes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: source-error flag and partial-image message (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: remove_incomplete defaults on (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: write_remote timeout is the connect timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: connect timeout and DNS map to unreachable (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_type delay is milliseconds (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: header and body timeouts stay timeouts (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: TLS verify, pin, and insecure modes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: kvmd redirects are not followed (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: configured host and TLS mode for the device list (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: redactUrl on kvmd error text (GPL-3.0; see NOTICE).
// AbortSignal.timeout and PIKVM_UNREACHABLE / PIKVM_AUTH_FAILED no-retry codes
// adapted from dtrukr/pikvm_mcp_server src/pikvm/client.ts @ d120243 (GPL-3.0).
// Snapshot HTTP 503 retry-once adapted from dvaerum/pikvm_mcp_server
// fetchSnapshotWithRetry and PiKVMApiError @ b5fdc31 (GPL-3.0).
//
// HID ceilings: /hid/print is 5s + 1.5 × (4·min(len,1024) + 2) × perEventSec + 5s,
// at least 10s, and is refused above 50s. Other HID POSTs use 30s. When a
// ceiling expires the error is PIKVM_HID_STATE_UNKNOWN and the call is not retried.
//
// MSD upload ceiling: msdWrite and msdWriteRemote do not use
// PIKVM_REQUEST_TIMEOUT_MS. kvmd answers POST /msd/write only after it has
// read the body, so the 5s ordinary abort would kill a real image.
// PIKVM_MSD_JOB_TIMEOUT_MS (default 6 hours, max 7 days) is a cleared
// setTimeout plus AbortController, and undici headersTimeout.
// PIKVM_MSD_IDLE_TIMEOUT_MS (default 60 seconds, max 1 hour) aborts when
// the request body or the response body stops moving, and is also undici
// bodyTimeout. AbortSignal.timeout is not used: above 2^32-1 it throws
// RangeError, and a delay of 2^31 or more makes the timer fire after 1 ms.
// Checked on undici 7.24.1: headersTimeout does not abort a request body
// that is still being written without socket backpressure. Once the body
// has ended it is only the wait for response headers. bodyTimeout starts
// after response headers and resets on each response chunk, so it does not
// cap a multi-GB stream that keeps sending. Delays above 1s use undici's
// about-1s fast timer. The job AbortSignal is the hard ceiling.
// A stream that ends short of Content-Length, or a chunk that runs past
// it, is UND_ERR_REQ_CONTENT_LENGTH_MISMATCH and is reported as
// PIKVM_CONTENT_LENGTH_MISMATCH. A chunk that ends exactly on
// Content-Length, with more bytes not yet buffered, can upload as a
// shorter complete image. MSD POSTs are not retried.
// After POST /msd/write or /msd/write_remote has started, a timeout, a
// socket reset, or HTTP 504 is PIKVM_MSD_STATE_UNKNOWN. Connection refused
// before the request is sent stays PIKVM_UNREACHABLE. A connect timeout
// (UND_ERR_CONNECT_TIMEOUT) and DNS ENOTFOUND / EAI_AGAIN are the same,
// whether the code is on the error or on a cause. An error reading
// the local source is PIKVM_SOURCE_READ_ERROR ("image may be partial;
// re-read /api/msd"). That flag is the source stream's own error event.
// On undici 7.24.1 an abort or reset while kvmd is not reading destroys
// the upload wrapper; that is not a source error.
// MSD facts are from pikvm/kvmd v4.227 (0dd244f) and docs.pikvm.org.

/**
 * PiKVM API Client
 *
 * Handles communication with PiKVM's REST API for HID control.
 * All mouse operations use the REST API which is more reliable than WebSocket.
 */

import { Readable } from 'node:stream';
import { fetch, request as undiciRequest } from 'undici';
import type { Agent, Dispatcher } from 'undici';
import {
  TLS_PIN_MISMATCH,
  TLS_VERIFY_FAILED,
  classifyTlsFailure,
  createKvmdAgent,
  deviceTlsFrom,
  type DeviceTls,
} from '../tls.js';
import sharp from 'sharp';
import {
  HID_OTHER_DEADLINE_MS,
  HID_PRINT_REFUSE_MS,
  HID_STATE_UNKNOWN_MESSAGE,
  hidPrintCeilingMs,
  hidDelayQueryValue,
} from '../hid-deadline.js';
import { capKvmdField, redactSecrets } from '../redact.js';
import { redactUrl } from '../url-policy.js';
import {
  MSD_IDLE_TIMEOUT_DEFAULT_MS,
  MSD_IDLE_TIMEOUT_MAX_MS,
  MSD_JOB_TIMEOUT_DEFAULT_MS,
  MSD_JOB_TIMEOUT_MAX_MS,
  clampRequestTimeoutMs,
  normalizeMsdTimeoutMs,
} from '../request-timeout.js';

export interface PiKVMConfig {
  host: string;
  username: string;
  password: string;
  verifySsl?: boolean;
  /**
   * TLS for this client. A registry builds one client per device and
   * puts that device's spec in `default`.
   */
  tls?: { default: DeviceTls };
  defaultKeymap?: string;
  /** Abort deadline for one ordinary kvmd call. Default 5000. */
  requestTimeoutMs?: number;
  /**
   * Wall clock for msdWrite and msdWriteRemote. Default 6 hours.
   * These calls do not use requestTimeoutMs.
   */
  msdJobTimeoutMs?: number;
  /**
   * Idle gap while an MSD upload body or progress stream is moving.
   * Default 60 seconds. The wait for response headers uses the job ceiling.
   */
  msdIdleTimeoutMs?: number;
}

export interface TypeOptions {
  keymap?: string;
  slow?: boolean;
  /** Milliseconds between keystrokes. Sent to kvmd as seconds. */
  delay?: number;
}

export interface KeyOptions {
  state?: boolean; // true = press, false = release, undefined = press+release
}

export interface ScreenResolution {
  width: number;
  height: number;
}

export type MouseButton = 'left' | 'right' | 'middle' | 'up' | 'down';

export interface ScreenshotResult {
  buffer: Buffer;
  screenshotWidth: number;
  screenshotHeight: number;
  actualWidth: number;
  actualHeight: number;
  scaleX: number;
  scaleY: number;
}

// PiKVM uses signed 16-bit integers for absolute mouse coordinates
const MOUSE_COORD_MIN = -32768;
const MOUSE_COORD_MAX = 32767;

// Relative mouse deltas are limited to signed 8-bit range
const MOUSE_DELTA_MIN = -127;
const MOUSE_DELTA_MAX = 127;

/**
 * Linearly remap a value from one range to another
 */
function remap(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number): number {
  return Math.round(toMin + (value - fromMin) * (toMax - toMin) / (fromMax - fromMin));
}

/**
 * Clamp a value to a range
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface CalibrationState {
  factorX: number;
  factorY: number;
  resolution: ScreenResolution;
}

export interface CalibrationResult {
  expectedPosition: { x: number; y: number };
  requestedNormalized: { x: number; y: number };
  resolution: ScreenResolution;
  message: string;
}

/**
 * Failure from one kvmd call.
 *
 * `type` is kvmd's `result.error` when the body is
 * `{ok:false,result:{error,error_msg}}`. Network, timeout, and auth
 * failures use PIKVM_UNREACHABLE, PIKVM_TIMEOUT, and PIKVM_AUTH_FAILED.
 * `message` is kvmd's `error_msg` after secret redaction. `endpoint` is
 * the method and path with no query string.
 */
export class KvmdError extends Error {
  readonly status: number;
  readonly type: string;
  readonly endpoint: string;

  constructor(status: number, type: string, message: string, endpoint: string) {
    super(message);
    this.name = 'KvmdError';
    this.status = status;
    this.type = type;
    this.endpoint = endpoint;
  }
}

export interface MsdPart {
  size: number;
  free: number;
  writable: boolean;
}

export interface MsdImageRecord {
  size: number;
  complete: boolean;
  removable: boolean;
}

export interface MsdDriveImage {
  name: string;
  size: number | null;
  complete: boolean | null;
  removable: boolean | null;
}

export interface MsdDriveState {
  image: MsdDriveImage | null;
  connected: boolean;
  cdrom: boolean;
  rw: boolean;
}

export interface MsdTransfer {
  name: string;
  size: number;
  written: number;
}

export interface MsdDownload {
  name: string;
  size: number;
  readed: number;
}

/**
 * Normalized GET /msd. `free` is the root part when `parts` has `""`,
 * otherwise the sum of part free space, otherwise legacy `storage.free`.
 */
export interface MsdState {
  enabled: boolean;
  online: boolean;
  busy: boolean;
  drive: MsdDriveState | null;
  images: Record<string, MsdImageRecord>;
  parts: Record<string, MsdPart> | null;
  free: number | null;
  uploading: MsdTransfer | null;
  downloading: MsdDownload | null;
}

export interface MsdWriteOptions {
  /**
   * kvmd remove_incomplete. Default true so a failed upload does not
   * leave a partial image. Pass false to keep kvmd's own default.
   */
  removeIncomplete?: boolean;
}

export interface MsdWriteResult {
  name: string;
  size: number;
  written: number;
}

export interface MsdSetParams {
  /** Storage image name. A URL is refused and is not sent. */
  image?: string;
  cdrom?: boolean;
  rw?: boolean;
}

export interface MsdWriteRemoteOptions {
  /** Storage name. Omitted lets kvmd take the name from the URL. */
  image?: string;
  /**
   * kvmd downloader connect timeout in seconds (aiohttp sock_connect).
   * The job wall clock stays on msdJobTimeoutMs. Omitted sends kvmd's own default.
   */
  timeout?: number;
  removeIncomplete?: boolean;
}

/** Idempotent GET attempts, including the first. */
const MAX_GET_ATTEMPTS = 3;

/** Backoff before the second and third GET attempt. */
const GET_RETRY_BACKOFF_MS = [250, 500] as const;

/** Added to each GET retry backoff. Inclusive range 0..99. */
const GET_RETRY_JITTER_MS = 100;

/**
 * Grace before the single snapshot 503 retry. ustreamer can answer 503
 * while it is starting after an idle stop; a short backoff is not enough.
 */
const SNAPSHOT_503_GRACE_MS = 1500;

function isSnapshotPath(path: string): boolean {
  return path.split('?')[0] === '/streamer/snapshot';
}

/**
 * POST /hid and /hid/* finish only when kvmd has applied the input.
 * A client abort does not cancel that work, and a retry would send it
 * again. These calls use a per-call ceiling instead of the ordinary
 * deadline, and expiry is never retried.
 */
function isHidPost(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const pathname = path.split('?')[0];
  return pathname === '/hid' || pathname.startsWith('/hid/');
}

function isTimeoutError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const name = (current as { name?: unknown }).name;
    const code = (current as { code?: unknown }).code;
    if (name === 'TimeoutError') return true;
    if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function parseKvmdFailure(text: string): { error: string; error_msg: string } | null {
  try {
    const parsed = JSON.parse(text) as {
      result?: { error?: unknown; error_msg?: unknown };
    };
    const error = parsed?.result?.error;
    const errorMsg = parsed?.result?.error_msg;
    if (typeof error === 'string' && typeof errorMsg === 'string') {
      return { error, error_msg: errorMsg };
    }
  } catch {
    // Not the kvmd JSON error shape.
  }
  return null;
}

/** Nothing was written. Same retry class as connection refused. */
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * The request may already be at kvmd. A reset here must not be retried,
 * and must not be reported as a clean "unreachable".
 */
const POST_SEND_SOCKET_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

function failedAfterSend(err: unknown): boolean {
  const codes = errorCodes(err);
  if (codes.some((code) => PRE_SEND_CODES.has(code))) return false;
  return codes.some((code) => POST_SEND_SOCKET_CODES.has(code));
}

function isPreSendFailure(err: unknown): boolean {
  return errorCodes(err).some((code) => PRE_SEND_CODES.has(code));
}

function transportError(err: unknown, endpoint: string, hid: boolean, device = 'default'): KvmdError {
  const tlsFailure = classifyTlsFailure(err, device);
  if (tlsFailure) {
    return new KvmdError(0, tlsFailure.type, tlsFailure.message, endpoint);
  }
  // A connect timeout or DNS failure can sit under a TimeoutError.
  // Nothing was sent, so this stays unreachable rather than a timeout.
  if (isPreSendFailure(err)) {
    return new KvmdError(0, 'PIKVM_UNREACHABLE', 'kvmd network error', endpoint);
  }
  if (isTimeoutError(err)) {
    if (hid) {
      return new KvmdError(0, 'PIKVM_HID_STATE_UNKNOWN', HID_STATE_UNKNOWN_MESSAGE, endpoint);
    }
    return new KvmdError(0, 'PIKVM_TIMEOUT', 'kvmd request timed out', endpoint);
  }
  if (hid && failedAfterSend(err)) {
    return new KvmdError(0, 'PIKVM_HID_STATE_UNKNOWN', HID_STATE_UNKNOWN_MESSAGE, endpoint);
  }
  return new KvmdError(0, 'PIKVM_UNREACHABLE', 'kvmd network error', endpoint);
}

/** No existing code fits: unreachable is retried, and an HTTP error hides the redirect. */
export const UNEXPECTED_REDIRECT = 'PIKVM_UNEXPECTED_REDIRECT';

/** `protocol//host` only. Userinfo, path, and query are dropped. */
export function redirectTargetOrigin(location: string | null, requestUrl: string): string {
  if (!location) return 'unknown';
  let parsed: URL;
  try {
    parsed = new URL(location, requestUrl);
  } catch {
    return 'unreadable';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'unreadable';
  return `${parsed.protocol}//${parsed.host}`;
}

export function unexpectedRedirectMessage(status: number, location: string | null, requestUrl: string): string {
  const origin = redirectTargetOrigin(location, requestUrl);
  return `${UNEXPECTED_REDIRECT}: kvmd returned an unexpected HTTP ${status} redirect to ${origin}. The redirect was not followed.`;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

function isRetryableGetError(err: KvmdError): boolean {
  if (err.type === 'PIKVM_HID_STATE_UNKNOWN') return false;
  if (err.type === TLS_PIN_MISMATCH || err.type === TLS_VERIFY_FAILED) return false;
  if (err.type === UNEXPECTED_REDIRECT) return false;
  if (err.type === 'PIKVM_UNREACHABLE' || err.type === 'PIKVM_TIMEOUT') return true;
  return err.status === 502 || err.status === 503;
}

/** `delay` as it appears on the query string, or undefined when omitted. */
function printDelaySent(path: string): number | undefined {
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  const raw = new URLSearchParams(query).get('delay');
  if (raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function printIsSlow(path: string): boolean {
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  const slow = new URLSearchParams(query).get('slow');
  return slow === '1' || slow === 'true';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jitterMs(): number {
  return Math.floor(Math.random() * GET_RETRY_JITTER_MS);
}

function isContentLengthMismatch(err: unknown): boolean {
  return errorCodes(err).includes('UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
}

/** Image may already exist, complete or not. Do not upload it again. */
const MSD_STATE_UNKNOWN_MESSAGE =
  'image may be partial or complete; re-read /api/msd; do not resend';

const SOURCE_READ_MESSAGE = 'image may be partial; re-read /api/msd';

function isSourceReadError(err: unknown): boolean {
  return errorCodes(err).includes('EIO') || errorCodes(err).includes('PIKVM_SOURCE_READ_ERROR');
}

function msdStateUnknown(status: number, endpoint: string): KvmdError {
  return new KvmdError(status, 'PIKVM_MSD_STATE_UNKNOWN', MSD_STATE_UNKNOWN_MESSAGE, endpoint);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function kvmdBool(value: boolean): string {
  return value ? '1' : '0';
}

interface KvmdEnvelope {
  ok?: boolean;
  result?: {
    error?: unknown;
    error_msg?: unknown;
    image?: { name?: unknown; size?: unknown; written?: unknown };
    [key: string]: unknown;
  };
}

function readImages(storage: Record<string, unknown> | null): Record<string, MsdImageRecord> {
  const images = storage?.images;
  if (!images || typeof images !== 'object' || Array.isArray(images)) return {};
  const out: Record<string, MsdImageRecord> = {};
  for (const [name, info] of Object.entries(images as Record<string, unknown>)) {
    if (!info || typeof info !== 'object') continue;
    const row = info as Record<string, unknown>;
    out[name] = {
      size: finiteNumber(row.size) ?? 0,
      complete: row.complete === true,
      removable: row.removable === true,
    };
  }
  return out;
}

function readParts(storage: Record<string, unknown> | null): {
  parts: Record<string, MsdPart> | null;
  free: number | null;
} {
  const raw = storage?.parts;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const parts: Record<string, MsdPart> = {};
    let saw = false;
    for (const [name, info] of Object.entries(raw as Record<string, unknown>)) {
      if (!info || typeof info !== 'object') continue;
      const row = info as Record<string, unknown>;
      const free = finiteNumber(row.free);
      const size = finiteNumber(row.size);
      if (free === null || size === null) continue;
      parts[name] = { size, free, writable: row.writable === true };
      saw = true;
    }
    if (saw) {
      let writableFree = 0;
      for (const part of Object.values(parts)) {
        if (part.writable) writableFree += part.free;
      }
      return { parts, free: writableFree };
    }
  }
  return { parts: null, free: finiteNumber(storage?.free) };
}

function readTransfer(value: unknown): MsdTransfer | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string') return null;
  return {
    name: row.name,
    size: finiteNumber(row.size) ?? 0,
    written: finiteNumber(row.written) ?? 0,
  };
}

function readDownload(value: unknown): MsdDownload | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== 'string') return null;
  return {
    name: row.name,
    size: finiteNumber(row.size) ?? 0,
    readed: finiteNumber(row.readed) ?? 0,
  };
}

function readDrive(value: unknown): MsdDriveState | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  let image: MsdDriveImage | null = null;
  if (row.image && typeof row.image === 'object') {
    const img = row.image as Record<string, unknown>;
    image = {
      name: typeof img.name === 'string' ? img.name : '',
      size: finiteNumber(img.size),
      complete: typeof img.complete === 'boolean' ? img.complete : null,
      removable: typeof img.removable === 'boolean' ? img.removable : null,
    };
  }
  return {
    image,
    connected: row.connected === true,
    cdrom: row.cdrom === true,
    rw: row.rw === true,
  };
}

function normalizeMsdState(result: unknown): MsdState {
  const row = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const storage = row.storage && typeof row.storage === 'object'
    ? row.storage as Record<string, unknown>
    : null;
  const space = readParts(storage);
  return {
    enabled: row.enabled === true,
    online: row.online === true,
    busy: row.busy === true,
    drive: readDrive(row.drive),
    images: readImages(storage),
    parts: space.parts,
    free: space.free,
    uploading: readTransfer(storage?.uploading),
    downloading: readDownload(storage?.downloading),
  };
}

function readWriteImage(result: unknown): MsdWriteResult | null {
  if (!result || typeof result !== 'object') return null;
  const image = (result as { image?: unknown }).image;
  if (!image || typeof image !== 'object') return null;
  const row = image as Record<string, unknown>;
  if (typeof row.name !== 'string') return null;
  const size = finiteNumber(row.size);
  const written = finiteNumber(row.written);
  if (size === null || written === null) return null;
  return { name: row.name, size, written };
}

/**
 * Pulls `source` for undici. Each chunk refreshes the idle timer.
 * When the source ends, idle is disarmed: kvmd has not sent headers yet,
 * and that wait is the job ceiling, not the idle gap.
 */
interface MsdWatch {
  sourceError: boolean;
}

function trackUpload(
  source: Readable,
  bump: () => void,
  disarm: () => void,
  watch: MsdWatch,
): Readable {
  // Set the flag from the source only. The wrapper's own failure is how
  // undici 7.24.1 reports an abort or reset while kvmd is not reading, and
  // that must stay PIKVM_MSD_STATE_UNKNOWN rather than a source error.
  const onSourceError = () => {
    watch.sourceError = true;
  };
  source.on('error', onSourceError);
  return Readable.from(async function* () {
    try {
      for await (const chunk of source) {
        bump();
        yield chunk;
      }
    } finally {
      source.off('error', onSourceError);
      disarm();
    }
  }());
}

interface MsdDeadline {
  signal: AbortSignal;
  /** Arm or refresh the idle gap. */
  arm: () => void;
  /** Stop the idle gap without aborting. Header wait uses the job signal. */
  disarm: () => void;
  done: () => void;
}

function startMsdDeadline(jobMs: number, idleMs: number): MsdDeadline {
  const jobCtrl = new AbortController();
  const idleCtrl = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let jobTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = () => new DOMException(
    'The operation was aborted due to timeout',
    'TimeoutError',
  );
  const arm = () => {
    if (idleCtrl.signal.aborted || jobCtrl.signal.aborted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleCtrl.abort(timeoutError());
    }, idleMs);
  };
  const disarm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const onJob = () => {
    disarm();
  };
  const done = () => {
    disarm();
    if (jobTimer) clearTimeout(jobTimer);
    jobTimer = undefined;
    jobCtrl.signal.removeEventListener('abort', onJob);
  };
  jobTimer = setTimeout(() => {
    jobCtrl.abort(timeoutError());
  }, jobMs);
  jobCtrl.signal.addEventListener('abort', onJob, { once: true });
  arm();
  return {
    signal: AbortSignal.any([jobCtrl.signal, idleCtrl.signal]),
    arm,
    disarm,
    done,
  };
}

/**
 * HID abort timers are multiplied by this in tests. Not a config field.
 * Refusal still uses the unscaled estimate.
 */
const hidDeadlineScales = new WeakMap<PiKVMClient, number>();
const testDispatchers = new WeakMap<PiKVMClient, Dispatcher>();

/** Configured password for tool-error redaction. Not a client method. */
const redactionPasswords = new WeakMap<PiKVMClient, string>();

/** Test-only. Shrinks HID abort timers without putting a scale on PiKVMConfig. */
export function setHidDeadlineScaleForTests(client: PiKVMClient, scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) return;
  hidDeadlineScales.set(client, scale);
}

/** Test-only. Sends ordinary calls and MSD posts through this dispatcher. */
export function setDispatcherForTests(client: PiKVMClient, dispatcher: Dispatcher): void {
  testDispatchers.set(client, dispatcher);
}

/** Package-internal. The tool error path redacts with this password. */
export function redactionPassword(client: PiKVMClient): string {
  return redactionPasswords.get(client) ?? '';
}

interface ResolvedPiKVMConfig extends PiKVMConfig {
  verifySsl: boolean;
  defaultKeymap: string;
  requestTimeoutMs: number;
  msdJobTimeoutMs: number;
  msdIdleTimeoutMs: number;
  tls: { default: DeviceTls };
}

export class PiKVMClient {
  private config: ResolvedPiKVMConfig;
  private dispatcher: Agent;
  private cachedResolution: ScreenResolution | null = null;
  private screenshotScale: {
    scaleX: number;
    scaleY: number;
  } | null = null;
  private calibration: CalibrationState | null = null;

  constructor(config: PiKVMConfig) {
    const base = {
      verifySsl: false,
      defaultKeymap: 'en-us',
      requestTimeoutMs: 5000,
      msdJobTimeoutMs: MSD_JOB_TIMEOUT_DEFAULT_MS,
      msdIdleTimeoutMs: MSD_IDLE_TIMEOUT_DEFAULT_MS,
      ...config,
    };
    base.requestTimeoutMs = clampRequestTimeoutMs(base.requestTimeoutMs);
    base.msdJobTimeoutMs = normalizeMsdTimeoutMs(
      base.msdJobTimeoutMs,
      MSD_JOB_TIMEOUT_DEFAULT_MS,
      MSD_JOB_TIMEOUT_MAX_MS,
    );
    base.msdIdleTimeoutMs = normalizeMsdTimeoutMs(
      base.msdIdleTimeoutMs,
      MSD_IDLE_TIMEOUT_DEFAULT_MS,
      MSD_IDLE_TIMEOUT_MAX_MS,
    );
    const resolved: ResolvedPiKVMConfig = {
      ...base,
      tls: {
        default: deviceTlsFrom({
          host: base.host,
          verifySsl: base.verifySsl,
          tls: config.tls,
        }),
      },
    };
    this.config = resolved;
    redactionPasswords.set(this, this.config.password);

    // headersTimeout and bodyTimeout 0 turn off undici's 300s defaults.
    // Each call sets its own AbortSignal, including HID ceilings.
    // The same agent is used for GET, POST, HID, and both MSD upload paths.
    this.dispatcher = createKvmdAgent(this.config, { headersTimeout: 0, bodyTimeout: 0 });
  }

  /**
   * Close the kvmd dispatcher.
   */
  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  /** Host string this client was given. The registry stores a normalised origin. */
  configuredHost(): string {
    return this.config.host;
  }

  tlsMode(): DeviceTls['mode'] {
    return this.config.tls.default.mode;
  }

  /**
   * Make an authenticated request to the PiKVM API.
   *
   * Idempotent GETs are tried up to three times on a network error, a
   * timeout, HTTP 502, or HTTP 503. POST is never retried. HTTP 400, 401,
   * 403, 409, 500, and 504 are never retried. GET /streamer/snapshot on
   * HTTP 503 waits out the ustreamer idle-stop grace and retries once.
   * That extra try does not consume one of the three attempts, so a
   * snapshot can make at most four calls. HID POSTs use a per-call
   * ceiling and are never retried. /hid/print above 50s is refused
   * before the request is sent. A socket reset after a HID POST was
   * sent is PIKVM_HID_STATE_UNKNOWN. A connect refusal, a connect
   * timeout, or DNS ENOTFOUND / EAI_AGAIN stays PIKVM_UNREACHABLE.
   * GET retries those the same way it retries connection refused.
   * POST, including HID, does not.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: string | object,
    contentType?: string
  ): Promise<T> {
    const idempotentGet = method.toUpperCase() === 'GET';
    const snapshot = idempotentGet && isSnapshotPath(path);
    let generalFailures = 0;
    let snapshot503Retried = false;

    for (;;) {
      try {
        return await this.requestOnce<T>(method, path, body, contentType);
      } catch (err) {
        if (!idempotentGet || !(err instanceof KvmdError) || !isRetryableGetError(err)) {
          throw err;
        }
        if (snapshot && err.status === 503) {
          if (snapshot503Retried) throw err;
          snapshot503Retried = true;
          await delay(SNAPSHOT_503_GRACE_MS);
          continue;
        }
        generalFailures += 1;
        if (generalFailures >= MAX_GET_ATTEMPTS) throw err;
        const backoff = GET_RETRY_BACKOFF_MS[generalFailures - 1];
        await delay(backoff + jitterMs());
      }
    }
  }

  /**
   * One kvmd call. Throws KvmdError on HTTP, network, and timeout failures.
   */
  private async requestOnce<T = unknown>(
    method: string,
    path: string,
    body?: string | object,
    contentType?: string
  ): Promise<T> {
    const url = new URL(`/api${path}`, this.config.host);
    const endpoint = `${method.toUpperCase()} ${url.pathname}`;

    const headers: Record<string, string> = {
      'X-KVMD-User': this.config.username,
      'X-KVMD-Passwd': this.config.password,
    };

    if (body !== undefined) {
      if (contentType) {
        headers['Content-Type'] = contentType;
      } else if (typeof body === 'object') {
        headers['Content-Type'] = 'application/json';
      } else {
        headers['Content-Type'] = 'text/plain';
      }
    }

    const hidPost = isHidPost(method, path);
    const timeoutMs = hidPost
      ? this.hidTimeoutMs(path, body)
      : this.config.requestTimeoutMs;
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body ? (typeof body === 'object' ? JSON.stringify(body) : body) : undefined,
        dispatcher: testDispatchers.get(this) ?? this.dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (err) {
      throw transportError(err, endpoint, hidPost, this.config.tls.default.device);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await this.cancelBody(response);
      throw new KvmdError(
        response.status,
        UNEXPECTED_REDIRECT,
        this.redact(unexpectedRedirectMessage(response.status, location, url.toString())),
        endpoint,
      );
    }

    if (!response.ok) {
      const errorText = await this.readBody(() => response.text(), endpoint, hidPost);
      throw this.httpFailure(response.status, errorText, endpoint);
    }

    // Check content type for response handling
    const responseType = response.headers.get('content-type') || '';
    if (responseType.includes('image/')) {
      return await this.readBody(() => response.arrayBuffer() as Promise<T>, endpoint, hidPost);
    }

    // Handle empty responses (204 No Content)
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {} as T;
    }

    const text = await this.readBody(() => response.text(), endpoint, hidPost);
    if (!text) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      // If not JSON, return as-is wrapped in an object
      return { result: text } as T;
    }
  }

  /**
   * kvmd `{ok:false,result:{error,error_msg}}` on a non-2xx response.
   * 401 and 403 stay PIKVM_AUTH_FAILED. The body is redacted.
   */
  private httpFailure(status: number, text: string, endpoint: string): KvmdError {
    const parsed = parseKvmdFailure(text);
    if (status === 401 || status === 403) {
      return new KvmdError(
        status,
        'PIKVM_AUTH_FAILED',
        this.kvmdField(parsed?.error_msg ?? 'authentication failed'),
        endpoint,
      );
    }
    if (parsed) {
      return new KvmdError(
        status,
        this.kvmdField(parsed.error),
        this.kvmdField(parsed.error_msg),
        endpoint,
      );
    }
    const fallback = this.redact(text).substring(0, 200);
    return new KvmdError(
      status,
      'PIKVM_HTTP_ERROR',
      fallback || `HTTP ${status}`,
      endpoint,
    );
  }

  /** HTTP 200 can still carry `{ok:false}`. Surface that as KvmdError. */
  private assertKvmdOk(body: KvmdEnvelope | null | undefined, endpoint: string): void {
    if (!body || body.ok !== false) return;
    const error = body.result?.error;
    const errorMsg = body.result?.error_msg;
    throw new KvmdError(
      200,
      this.kvmdField(typeof error === 'string' ? error : 'PIKVM_HTTP_ERROR'),
      this.kvmdField(typeof errorMsg === 'string' ? errorMsg : 'kvmd reported failure'),
      endpoint,
    );
  }

  /** Redact secrets, then cap a kvmd error type or error_msg at about 1 KB. */
  private kvmdField(value: string): string {
    return capKvmdField(this.redact(value));
  }

  private redact(value: string): string {
    return redactUrl(redactSecrets(value, this.config.password));
  }

  /**
   * Abort timer for one HID POST. Print uses the length × delay ceiling
   * and is refused above 50s. Every other HID POST uses 30s.
   * The test hook shrinks the timer; the refusal check does not.
   */
  private hidTimeoutMs(path: string, body: string | object | undefined): number {
    const pathname = path.split('?')[0];
    let ceilingMs = HID_OTHER_DEADLINE_MS;
    if (pathname === '/hid/print') {
      const text = typeof body === 'string' ? body : '';
      ceilingMs = hidPrintCeilingMs(text.length, printDelaySent(path), printIsSlow(path));
      if (ceilingMs > HID_PRINT_REFUSE_MS) {
        const seconds = Math.ceil(ceilingMs / 1000);
        throw new Error(
          `Refusing /hid/print: estimated time is ${seconds}s, above the 50s ceiling. Shorten the text or lower the delay.`,
        );
      }
    }
    const scale = hidDeadlineScales.get(this) ?? 1;
    return Math.max(1, Math.round(ceilingMs * scale));
  }

  /**
   * Body reads can fail after headers: the deadline aborts a slow body,
   * or the socket resets. A HID reset is PIKVM_HID_STATE_UNKNOWN.
   * Other resets match a failed fetch, and GET retry treats them the
   * same way.
   */
  private async readBody<T>(read: () => Promise<T>, endpoint: string, hid: boolean): Promise<T> {
    try {
      return await read();
    } catch (err) {
      throw transportError(err, endpoint, hid, this.config.tls.default.device);
    }
  }

  /**
   * Take a screenshot and calculate coordinate scaling factors
   */
  async screenshot(options?: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  }): Promise<ScreenshotResult> {
    const params = new URLSearchParams();
    if (options?.maxWidth || options?.maxHeight) {
      params.set('preview', '1');
      if (options.maxWidth) params.set('preview_max_width', options.maxWidth.toString());
      if (options.maxHeight) params.set('preview_max_height', options.maxHeight.toString());
      if (options.quality) params.set('preview_quality', options.quality.toString());
    }

    const path = `/streamer/snapshot${params.toString() ? '?' + params : ''}`;
    const arrayBuffer = await this.request<ArrayBuffer>('GET', path);
    const buffer = Buffer.from(arrayBuffer);

    // Get actual screen resolution (force refresh to ensure accuracy)
    const actualResolution = await this.getResolution(true);

    // Get screenshot dimensions using sharp
    const metadata = await sharp(buffer).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Failed to read screenshot dimensions');
    }
    const dimensions = { width: metadata.width, height: metadata.height };

    // Calculate and store scale factors
    const scaleX = actualResolution.width / dimensions.width;
    const scaleY = actualResolution.height / dimensions.height;
    this.screenshotScale = { scaleX, scaleY };

    return {
      buffer,
      screenshotWidth: dimensions.width,
      screenshotHeight: dimensions.height,
      actualWidth: actualResolution.width,
      actualHeight: actualResolution.height,
      scaleX,
      scaleY,
    };
  }

  /**
   * Get current screen resolution from the video streamer
   */
  async getResolution(forceRefresh = false): Promise<ScreenResolution> {
    if (this.cachedResolution && !forceRefresh) {
      return this.cachedResolution;
    }

    interface StreamerResponse {
      ok: boolean;
      result: {
        streamer: {
          source: {
            resolution: {
              width: number;
              height: number;
            };
          };
        };
      };
    }

    const response = await this.request<StreamerResponse>('GET', '/streamer');

    // Defensive null checks for nested API response structure
    const resolution = response?.result?.streamer?.source?.resolution;
    if (!resolution || typeof resolution.width !== 'number' || typeof resolution.height !== 'number') {
      throw new Error('Invalid or missing resolution data from PiKVM streamer API');
    }

    this.cachedResolution = {
      width: resolution.width,
      height: resolution.height,
    };
    return this.cachedResolution;
  }

  /**
   * Convert pixel coordinates to PiKVM's normalized coordinate system
   * PiKVM uses range -32768 to 32767 for absolute positioning
   *
   * Calibration factors are applied to compensate for resolution-dependent
   * coordinate scaling issues. Without calibration, factors default to 1.0.
   */
  private pixelToNormalized(pixelX: number, pixelY: number, resolution: ScreenResolution): { x: number; y: number } {
    // Calculate base normalized coordinates
    const baseX = remap(pixelX, 0, resolution.width - 1, MOUSE_COORD_MIN, MOUSE_COORD_MAX);
    const baseY = remap(pixelY, 0, resolution.height - 1, MOUSE_COORD_MIN, MOUSE_COORD_MAX);

    // Apply calibration factors if available, otherwise use 1.0 (no correction)
    const factorX = this.calibration?.factorX ?? 1.0;
    const factorY = this.calibration?.factorY ?? 1.0;

    // Convert to unsigned (0-65535), apply calibration, convert back to signed
    const correctedX = Math.round((baseX + 32768) * factorX) - 32768;
    const correctedY = Math.round((baseY + 32768) * factorY) - 32768;

    // Clamp to valid range
    return {
      x: clamp(correctedX, MOUSE_COORD_MIN, MOUSE_COORD_MAX),
      y: clamp(correctedY, MOUSE_COORD_MIN, MOUSE_COORD_MAX),
    };
  }

  /**
   * Perform calibration by moving cursor to center of screen.
   * Returns information needed for the agent to calculate calibration factors.
   */
  async calibrate(): Promise<CalibrationResult> {
    // Force refresh resolution to ensure accuracy
    const resolution = await this.getResolution(true);

    // Calculate center position
    const centerX = Math.round(resolution.width / 2);
    const centerY = Math.round(resolution.height / 2);

    // Temporarily clear calibration to get raw coordinates
    const savedCalibration = this.calibration;
    this.calibration = null;

    // Calculate the normalized coordinates we'll send (without calibration)
    const normalized = this.pixelToNormalized(centerX, centerY, resolution);

    // Move cursor to center using raw coordinates
    const params = new URLSearchParams();
    params.set('to_x', normalized.x.toString());
    params.set('to_y', normalized.y.toString());
    await this.request('POST', `/hid/events/send_mouse_move?${params}`);

    // Restore previous calibration (if any)
    this.calibration = savedCalibration;

    return {
      expectedPosition: { x: centerX, y: centerY },
      requestedNormalized: normalized,
      resolution,
      message: `Cursor moved to expected center position (${centerX}, ${centerY}). ` +
        `Please take a screenshot and visually verify the actual cursor position. ` +
        `Then call pikvm_set_calibration with the calculated factors: ` +
        `factorX = ${centerX} / actual_x, factorY = ${centerY} / actual_y`,
    };
  }

  /**
   * Set calibration factors for coordinate correction
   */
  setCalibrationFactors(factorX: number, factorY: number): void {
    // Sanity check: factors should be reasonable (0.5 to 2.0)
    if (factorX < 0.5 || factorX > 2.0 || factorY < 0.5 || factorY > 2.0) {
      throw new Error(`Calibration factors out of reasonable range (0.5-2.0): factorX=${factorX}, factorY=${factorY}`);
    }

    this.calibration = {
      factorX,
      factorY,
      resolution: this.cachedResolution || { width: 0, height: 0 },
    };
  }

  /**
   * Get current calibration state
   */
  getCalibration(): CalibrationState | null {
    return this.calibration;
  }

  /**
   * Clear calibration (revert to uncalibrated mode)
   */
  clearCalibration(): void {
    this.calibration = null;
  }

  /**
   * Move mouse to absolute pixel position WITHOUT calibration or screenshot scaling.
   * Used during auto-calibration to send known uncalibrated positions.
   */
  async mouseMoveRaw(x: number, y: number): Promise<void> {
    const resolution = await this.getResolution();

    // Temporarily clear calibration to get raw coordinates
    const savedCalibration = this.calibration;
    this.calibration = null;

    const normalized = this.pixelToNormalized(x, y, resolution);

    // Restore calibration
    this.calibration = savedCalibration;

    const params = new URLSearchParams();
    params.set('to_x', normalized.x.toString());
    params.set('to_y', normalized.y.toString());
    await this.request('POST', `/hid/events/send_mouse_move?${params}`);
  }

  /**
   * Check if resolution has changed since calibration
   */
  private hasResolutionChanged(currentResolution: ScreenResolution): boolean {
    if (!this.calibration) return false;
    return this.calibration.resolution.width !== currentResolution.width ||
           this.calibration.resolution.height !== currentResolution.height;
  }

  /**
   * Scale coordinates from screenshot space to actual screen space
   * If no screenshot has been taken, coordinates pass through unchanged
   */
  private scaleCoordinates(x: number, y: number): { x: number; y: number } {
    if (!this.screenshotScale) {
      return { x, y };
    }
    return {
      x: Math.round(x * this.screenshotScale.scaleX),
      y: Math.round(y * this.screenshotScale.scaleY),
    };
  }

  /**
   * Type text using paste-as-keys (handles special characters correctly)
   */
  async type(text: string, options?: TypeOptions): Promise<void> {
    const params = new URLSearchParams();
    params.set('keymap', options?.keymap || this.config.defaultKeymap);
    if (options?.slow) params.set('slow', '1');
    if (options?.delay !== undefined) params.set('delay', hidDelayQueryValue(options.delay));

    await this.request('POST', `/hid/print?${params}`, text, 'text/plain');
  }

  /**
   * Send a key event
   */
  async sendKey(key: string, options?: KeyOptions): Promise<void> {
    const params = new URLSearchParams();
    params.set('key', key);
    if (options?.state !== undefined) {
      params.set('state', options.state.toString());
    }

    await this.request('POST', `/hid/events/send_key?${params}`);
  }

  /**
   * Send a keyboard shortcut (multiple keys pressed together)
   */
  async sendShortcut(keys: string[]): Promise<void> {
    await this.request('POST', '/hid/events/send_shortcut', keys);
  }

  /**
   * Move mouse to absolute pixel position (via REST API)
   * Coordinates are automatically scaled from screenshot space to screen space
   * if a scaled screenshot was previously taken.
   * @param x - X coordinate in pixels (0 = left edge), in screenshot space
   * @param y - Y coordinate in pixels (0 = top edge), in screenshot space
   * @returns Object with calibrationInvalidated flag if resolution changed
   */
  async mouseMove(x: number, y: number): Promise<{ calibrationInvalidated: boolean }> {
    // Scale coordinates from screenshot space to screen space
    const scaled = this.scaleCoordinates(x, y);

    // Get screen resolution for coordinate conversion (force refresh to detect changes)
    const resolution = await this.getResolution(true);

    // Check if resolution changed since calibration
    let calibrationInvalidated = false;
    if (this.hasResolutionChanged(resolution)) {
      // Clear calibration since it's no longer valid
      this.calibration = null;
      calibrationInvalidated = true;
    }

    const normalized = this.pixelToNormalized(scaled.x, scaled.y, resolution);

    const params = new URLSearchParams();
    params.set('to_x', normalized.x.toString());
    params.set('to_y', normalized.y.toString());

    await this.request('POST', `/hid/events/send_mouse_move?${params}`);

    return { calibrationInvalidated };
  }

  /**
   * Move mouse relative to current position (via REST API)
   * @param deltaX - Horizontal movement (negative = left, positive = right)
   * @param deltaY - Vertical movement (negative = up, positive = down)
   */
  async mouseMoveRelative(deltaX: number, deltaY: number): Promise<void> {
    // Clamp deltas to valid range (-127 to 127)
    const clampedX = clamp(Math.round(deltaX), MOUSE_DELTA_MIN, MOUSE_DELTA_MAX);
    const clampedY = clamp(Math.round(deltaY), MOUSE_DELTA_MIN, MOUSE_DELTA_MAX);

    const params = new URLSearchParams();
    params.set('delta_x', clampedX.toString());
    params.set('delta_y', clampedY.toString());

    await this.request('POST', `/hid/events/send_mouse_relative?${params}`);
  }

  /**
   * Click mouse button (via REST API)
   */
  async mouseClick(button: MouseButton = 'left', options?: KeyOptions): Promise<void> {
    const params = new URLSearchParams();
    params.set('button', button);

    if (options?.state !== undefined) {
      params.set('state', options.state.toString());
      await this.request('POST', `/hid/events/send_mouse_button?${params}`);
    } else {
      // Full click: press then release
      params.set('state', 'true');
      await this.request('POST', `/hid/events/send_mouse_button?${params}`);
      params.set('state', 'false');
      await this.request('POST', `/hid/events/send_mouse_button?${params}`);
    }
  }

  /**
   * Scroll mouse wheel (via REST API)
   */
  async mouseScroll(deltaX: number, deltaY: number): Promise<void> {
    const params = new URLSearchParams();
    params.set('delta_x', Math.round(deltaX).toString());
    params.set('delta_y', Math.round(deltaY).toString());

    await this.request('POST', `/hid/events/send_mouse_wheel?${params}`);
  }

  /**
   * Get available keymaps
   */
  async getKeymaps(): Promise<string[]> {
    const response = await this.request<{ result: { keymaps: Record<string, unknown> } }>('GET', '/hid/keymaps');
    return Object.keys(response.result.keymaps);
  }

  /**
   * Reset HID device
   */
  async resetHid(): Promise<void> {
    await this.request('POST', '/hid/reset');
  }

  /**
   * Check authentication
   */
  async checkAuth(): Promise<boolean> {
    try {
      await this.request('GET', '/auth/check');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * GET /api/msd. Idempotent, so the ordinary GET retry applies.
   * `free` accepts the parts map and legacy top-level `storage.free`.
   */
  async getMsdState(): Promise<MsdState> {
    const body = await this.request<KvmdEnvelope>('GET', '/msd');
    this.assertKvmdOk(body, 'GET /api/msd');
    return normalizeMsdState(body?.result);
  }

  /**
   * POST /api/msd/set_params. Query only: image, cdrom, rw.
   * A URL is not a storage name. kvmd would treat it as a remote drive,
   * so this method refuses it before any request. Not retried.
   */
  async msdSetParams(params: MsdSetParams = {}): Promise<void> {
    if (params.image !== undefined && params.image.includes('://')) {
      throw new Error('msdSetParams does not accept a URL');
    }
    const query = new URLSearchParams();
    if (params.image !== undefined) query.set('image', params.image);
    if (params.cdrom !== undefined) query.set('cdrom', kvmdBool(params.cdrom));
    if (params.rw !== undefined) query.set('rw', kvmdBool(params.rw));
    const qs = query.toString();
    const body = await this.request<KvmdEnvelope>(
      'POST',
      `/msd/set_params${qs ? `?${qs}` : ''}`,
    );
    this.assertKvmdOk(body, 'POST /api/msd/set_params');
  }

  /**
   * POST /api/msd/set_connected?connected=0|1. Not retried.
   */
  async msdSetConnected(connected: boolean): Promise<void> {
    const body = await this.request<KvmdEnvelope>(
      'POST',
      `/msd/set_connected?connected=${kvmdBool(connected)}`,
    );
    this.assertKvmdOk(body, 'POST /api/msd/set_connected');
  }

  /**
   * POST /api/msd/remove?image=. Not retried.
   */
  async msdRemove(image: string): Promise<void> {
    const query = new URLSearchParams();
    query.set('image', image);
    const body = await this.request<KvmdEnvelope>('POST', `/msd/remove?${query}`);
    this.assertKvmdOk(body, 'POST /api/msd/remove');
  }

  /**
   * POST /api/msd/write. Streams `body` with an exact Content-Length of
   * `size` bytes. Never chunked, never retried, and not limited by the
   * ordinary 5s deadline. `removeIncomplete` maps to remove_incomplete.
   */
  async msdWrite(
    image: string,
    body: Readable,
    size: number,
    options: MsdWriteOptions = {},
  ): Promise<MsdWriteResult> {
    if (!Number.isInteger(size) || size < 0) {
      throw new Error('msdWrite size must be a non-negative integer');
    }
    const query = new URLSearchParams();
    query.set('image', image);
    query.set('remove_incomplete', kvmdBool(options.removeIncomplete !== false));
    const outcome = await this.msdPost(
      `/msd/write?${query}`,
      'POST /api/msd/write',
      body,
      size,
    );
    const imageInfo = readWriteImage(outcome.result);
    if (!imageInfo) {
      throw new KvmdError(
        outcome.statusCode,
        'PIKVM_HTTP_ERROR',
        'msd write response has no image',
        'POST /api/msd/write',
      );
    }
    return imageInfo;
  }

  /**
   * POST /api/msd/write_remote. Yields NDJSON `{image:{name,size,written}}`
   * progress. An `{ok:false}` line throws KvmdError. verify=1 is always
   * sent. `insecure` is never sent. Not retried.
   */
  async *msdWriteRemote(
    url: string,
    options: MsdWriteRemoteOptions = {},
  ): AsyncGenerator<MsdWriteResult> {
    const query = new URLSearchParams();
    query.set('url', url);
    query.set('verify', '1');
    query.set('remove_incomplete', kvmdBool(options.removeIncomplete !== false));
    if (options.image !== undefined) query.set('image', options.image);
    if (options.timeout !== undefined) query.set('timeout', String(options.timeout));
    const endpoint = 'POST /api/msd/write_remote';
    let deadline: MsdDeadline | undefined;
    let responseBody: AsyncIterable<Uint8Array> | undefined;
    try {
      deadline = startMsdDeadline(this.config.msdJobTimeoutMs, this.config.msdIdleTimeoutMs);
      const response = await this.msdDispatch(
        `/msd/write_remote?${query}`,
        endpoint,
        undefined,
        undefined,
        deadline,
        undefined,
      );
      responseBody = response.body;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const text = await this.readUploadText(response.body, deadline);
        throw this.msdHttpFailure(response.statusCode, text, endpoint);
      }
      deadline.arm();
      const decoder = new TextDecoder();
      let pending = '';
      let last: MsdWriteResult | undefined;
      const take = (line: string) => {
        let image: MsdWriteResult | undefined;
        for (const row of this.ndjsonLine(line, response.statusCode, endpoint)) image = row;
        return image;
      };
      for await (const chunk of response.body) {
        deadline.arm();
        pending += decoder.decode(chunk, { stream: true });
        let nl = pending.indexOf('\n');
        while (nl !== -1) {
          const line = pending.slice(0, nl).replace(/\r$/, '');
          pending = pending.slice(nl + 1);
          if (line) {
            const image = take(line);
            if (image) {
              last = image;
              yield image;
            }
          }
          nl = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
      const tail = pending.replace(/\r$/, '').trim();
      if (tail) {
        const image = take(tail);
        if (image) {
          last = image;
          yield image;
        }
      }
      if (!last || last.written !== last.size) {
        throw msdStateUnknown(response.statusCode, endpoint);
      }
    } catch (err) {
      if (err instanceof KvmdError) throw err;
      throw this.msdTransport(err, endpoint);
    } finally {
      deadline?.done();
      await this.dumpBody(responseBody);
    }
  }

  private *ndjsonLine(line: string, status: number, endpoint: string): Generator<MsdWriteResult> {
    let parsed: KvmdEnvelope;
    try {
      parsed = JSON.parse(line) as KvmdEnvelope;
    } catch {
      throw new KvmdError(
        status,
        'PIKVM_HTTP_ERROR',
        this.kvmdField(line.slice(0, 200)) || 'invalid msd progress line',
        endpoint,
      );
    }
    if (parsed.ok === false) {
      const failure = parseKvmdFailure(line);
      if (failure) {
        throw new KvmdError(
          status,
          this.kvmdField(failure.error),
          this.kvmdField(failure.error_msg),
          endpoint,
        );
      }
      throw new KvmdError(status, 'PIKVM_HTTP_ERROR', 'kvmd reported failure', endpoint);
    }
    const image = readWriteImage(parsed.result);
    if (image) yield image;
  }

  /**
   * One long MSD POST. No retry. Content-Length is `size` when a body
   * is present, so undici does not fall back to chunked encoding.
   */
  private async msdPost(
    path: string,
    endpoint: string,
    body: Readable | undefined,
    size: number | undefined,
  ): Promise<{ statusCode: number; result: unknown }> {
    let deadline: MsdDeadline | undefined;
    let responseBody: AsyncIterable<Uint8Array> | undefined;
    const watch: MsdWatch = { sourceError: false };
    try {
      deadline = startMsdDeadline(this.config.msdJobTimeoutMs, this.config.msdIdleTimeoutMs);
      const response = await this.msdDispatch(path, endpoint, body, size, deadline, watch);
      responseBody = response.body;
      deadline.arm();
      const text = await this.readUploadText(response.body, deadline);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw this.msdHttpFailure(response.statusCode, text, endpoint);
      }
      if (!text) return { statusCode: response.statusCode, result: {} };
      let parsed: KvmdEnvelope;
      try {
        parsed = JSON.parse(text) as KvmdEnvelope;
      } catch {
        throw new KvmdError(
          response.statusCode,
          'PIKVM_HTTP_ERROR',
          this.kvmdField(text.slice(0, 200)) || 'invalid msd response',
          endpoint,
        );
      }
      this.assertKvmdOk(parsed, endpoint);
      return { statusCode: response.statusCode, result: parsed.result };
    } catch (err) {
      if (err instanceof KvmdError) throw err;
      // The flag is only the source stream's error event, so an idle abort
      // is not rewritten into a source error here.
      if (watch.sourceError) {
        throw new KvmdError(0, 'PIKVM_SOURCE_READ_ERROR', SOURCE_READ_MESSAGE, endpoint);
      }
      throw this.msdTransport(err, endpoint);
    } finally {
      deadline?.done();
      await this.dumpBody(responseBody);
    }
  }

  private async msdDispatch(
    path: string,
    endpoint: string,
    body: Readable | undefined,
    size: number | undefined,
    deadline: MsdDeadline,
    watch: MsdWatch | undefined,
  ): Promise<{ statusCode: number; body: AsyncIterable<Uint8Array> & { destroy?: () => void; text?: () => Promise<string> } }> {
    const url = new URL(`/api${path}`, this.config.host);
    const headers: Record<string, string> = {
      'X-KVMD-User': this.config.username,
      'X-KVMD-Passwd': this.config.password,
    };
    let upload: Readable | undefined;
    if (body !== undefined && size !== undefined) {
      headers['content-length'] = String(size);
      headers['content-type'] = 'application/octet-stream';
      upload = trackUpload(body, deadline.arm, deadline.disarm, watch ?? { sourceError: false });
    } else {
      // No request body. The wait for response headers is the job ceiling.
      // Idle starts again once those headers arrive.
      deadline.disarm();
    }
    try {
      // request() does not follow redirects. maxRedirections 0 is the
      // explicit off switch; the type omits the field.
      const requestOptions = {
        method: 'POST' as const,
        headers,
        body: upload,
        dispatcher: testDispatchers.get(this) ?? this.dispatcher,
        headersTimeout: this.config.msdJobTimeoutMs,
        bodyTimeout: this.config.msdIdleTimeoutMs,
        signal: deadline.signal,
        idempotent: false as const,
        maxRedirections: 0,
      };
      const response = await undiciRequest(url, requestOptions);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = headerValue(response.headers, 'location');
        try {
          for await (const chunk of response.body) {
            void chunk;
          }
        } catch {
          // The redirect body is already finished.
        }
        throw new KvmdError(
          response.statusCode,
          UNEXPECTED_REDIRECT,
          this.redact(unexpectedRedirectMessage(response.statusCode, location, url.toString())),
          endpoint,
        );
      }
      return response;
    } catch (err) {
      if (watch?.sourceError || (!isContentLengthMismatch(err) && isSourceReadError(err))) {
        throw new KvmdError(0, 'PIKVM_SOURCE_READ_ERROR', SOURCE_READ_MESSAGE, endpoint);
      }
      throw this.msdTransport(err, endpoint);
    }
  }

  /** HTTP 504 on an upload means nginx gave up while kvmd may still be writing. */
  private msdHttpFailure(status: number, text: string, endpoint: string): KvmdError {
    if (status === 504) return msdStateUnknown(status, endpoint);
    return this.httpFailure(status, text, endpoint);
  }

  private msdTransport(err: unknown, endpoint: string): KvmdError {
    if (err instanceof KvmdError) return err;
    const tlsFailure = classifyTlsFailure(err, this.config.tls.default.device);
    if (tlsFailure) {
      return new KvmdError(0, tlsFailure.type, tlsFailure.message, endpoint);
    }
    if (isContentLengthMismatch(err)) {
      return new KvmdError(
        0,
        'PIKVM_CONTENT_LENGTH_MISMATCH',
        'request body length does not match Content-Length',
        endpoint,
      );
    }
    if (isSourceReadError(err)) {
      return new KvmdError(0, 'PIKVM_SOURCE_READ_ERROR', SOURCE_READ_MESSAGE, endpoint);
    }
    const beforeSend = isPreSendFailure(err);
    if (!beforeSend && (isTimeoutError(err) || failedAfterSend(err))) {
      return msdStateUnknown(0, endpoint);
    }
    return new KvmdError(0, 'PIKVM_UNREACHABLE', 'kvmd network error', endpoint);
  }

  private async readUploadText(
    body: AsyncIterable<Uint8Array>,
    deadline: MsdDeadline,
  ): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      deadline.arm();
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async cancelBody(response: { body?: { cancel?: () => Promise<void> } | null }): Promise<void> {
    const cancel = response.body?.cancel;
    if (typeof cancel !== 'function') return;
    try {
      await cancel.call(response.body);
    } catch {
      // The redirect body is already closed.
    }
  }

  private async dumpBody(body: unknown): Promise<void> {
    if (!body || typeof body !== 'object' || !('destroy' in body)) return;
    const destroy = (body as { destroy?: unknown }).destroy;
    if (typeof destroy !== 'function') return;
    try {
      destroy.call(body);
    } catch {
      // The response is already finished or already destroyed.
    }
  }
}
