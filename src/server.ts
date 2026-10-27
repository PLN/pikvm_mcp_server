// Modified 2026-10 by PLN: typed KvmdError, timeouts, GET retry (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD status, mount, and eject (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD read-only allowlist and expectImage (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload, job, and remove tools (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hashing jobs and typed upload errors (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: URL fetch tool and transfer mount block (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: write_remote connect timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: redactUrl on tool errors (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_type delay is milliseconds (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: per-device client, lock, arm, and pikvm_devices (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_devices lists an origin (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: screenshot metadata, crop, and optional OCR (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: click frames and frameId (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: OCR stays listed until a device says disabled (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: mouse tools pass the resolved click frame (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD jobs wait for the catalog (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: catalog error codes on the upload and fetch tools (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: test hook before the upload slot is released (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: host OCR returns one JSON text block (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: fleet comments, typed eject, and rollbackError wording (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash timeout on the upload tool (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash timeout releases the upload slot before close (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash reads use the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD progress windows (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: finalise window arms on request sent (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload finalise window is twice the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: stock nginx does not pre-empt the finalise window (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: nginx 60s bounds kvmd's finish, not the drain (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the upload tool names the finalise drain limit (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: catalog budgets use a monotonic clock (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a catalog read is not started with under 1 ms left (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a post-send job cap reports phase job_timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the upload response read is phase job_timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: serverInfo.version follows package.json (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: situation-first errors, coordinate wording, plain-text OCR (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_keep_awake, suspended by other tool calls (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: pikvm_status (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: wake, observe, pikvm_wait_for, pikvm_click_text (GPL-3.0; see NOTICE).

/**
 * MCP server factory for PiKVM tools
 *
 * Builds a fresh MCP Server instance with all tool/prompt handlers registered.
 * stdio mode uses one instance; each HTTP session gets its own (per the
 * Streamable HTTP session model). Sessions share the fleet: one PiKVMClient
 * and one BusyLock per device.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type DeviceStatusReading,
  type PiKVMClient,
  type FrameEcho,
  type ScreenshotResult,
  KvmdError,
  SERVER_ERROR_TYPES,
  WAKE_KEY,
  redactionPassword,
} from './pikvm/client.js';
import sharp from 'sharp';
import { redactSecrets } from './redact.js';
import type { BusyLock } from './pikvm/lock.js';
import { type Fleet, type FleetDevice, resolveFleetDevice } from './devices.js';
import {
  defaultScreenshotSettings,
  OcrUnavailableError,
  UnknownFrameError,
  parseOcrBox,
  parseRegion,
  requireScreenshotInteger,
  SCREENSHOT_DIMENSION_MAX,
  type ScreenshotSettings,
} from './screenshot.js';
import { autoCalibrateWithRetries } from './pikvm/auto-calibrate.js';
import { allPrompts, getPromptByName } from './prompts/index.js';
import { skillTools, isSkillTool, handleSkillToolCall } from './prompts/skill-tools.js';
import {
  MSD_EXTENSIONS_DEFAULT,
  MSD_MAX_BYTES_DEFAULT,
  MSD_URL_CONNECT_TIMEOUT_DEFAULT_SEC,
  type MsdConfig,
} from './config.js';
import {
  ejectMsd,
  mountMsd,
  MsdExpectImageError,
  MsdImageTransferError,
  MsdPreflightError,
  MsdUploadBusyError,
  publicMsdState,
  readMsdJob,
  removeMsd,
  startMsdFetch,
  startMsdUpload,
} from './msd.js';
import { MsdUrlPolicyError, redactUrl } from './url-policy.js';
import {
  executeOcr,
  OcrError,
  ocrToolVisible,
  offOcr,
  parseFullFrame,
  parseOcrEngineArg,
  type ResolvedOcr,
} from './ocr.js';
import { createRequire } from 'node:module';
import {
  KEEP_AWAKE_INTERVAL,
  KEEP_AWAKE_KEY,
  KEEP_AWAKE_MODES,
  KEEP_AWAKE_QUADRANTS,
  KEEP_AWAKE_SUSPEND,
  type KeepAwakeOptions,
  type KeepAwakeState,
} from './keep-awake.js';

/** package.json sits one level above dist/ (and src/), including in the image. */
const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export interface McpServerDeps {
  pikvm: PiKVMClient;
  lock: BusyLock;
  calibrationConfig: { rounds: number; verifyRounds: number; moveDelayMs: number };
  /**
   * When true, HID-control tools are disarmed and return an error instead of
   * dispatching to the device. Only HTTP mode ever sets this (default there
   * is enforced); stdio callers gate on their own side.
   */
  armGateEnforced: boolean;
  /**
   * When true, pikvm_msd_mount and pikvm_msd_eject are disarmed. Only HTTP
   * mode ever sets this, and only while PIKVM_MCP_ARM_MSD is not 1.
   * Independent of armGateEnforced: PIKVM_MCP_ARM_HID=1 does not arm MSD.
   * Omitted means ungated, which is stdio.
   */
  msdArmGateEnforced?: boolean;
  /** Local upload directory and caps. Upload is hidden while localDir is unset. */
  msd?: MsdServerConfig;
  /**
   * Per-device clients and locks. Omitted means one implicit device named
   * default, using pikvm and lock, with registryActive false.
   */
  fleet?: Fleet;
  /** Legacy preview defaults. Registry devices carry their own. */
  screenshot?: ScreenshotSettings;
  /**
   * Process OCR runtime. Omitted is off, so a test that does not care
   * does not spawn tesseract. index.ts probes and passes the result.
   */
  ocr?: ResolvedOcr;
}

/**
 * MsdConfig plus optional knobs the production entrypoint leaves unset.
 * Tests use them to pause a job, shorten the uploading poll, and cap jobs.
 */
export interface MsdServerConfig extends MsdConfig {
  beforeHash?: () => Promise<void>;
  beforeUploadStream?: () => Promise<void>;
  beforeSlotRelease?: () => Promise<void>;
  /**
   * Replaces the upload file close. Unset in production. The hook must
   * close the handle. A rejection is a close failure.
   */
  closeFile?: (fh: { close(): Promise<void> }) => Promise<void>;
  beforeFetch?: () => Promise<void>;
  /** Hostname to addresses. Unset uses DNS, and does not resolve IP literals. */
  resolveUrl?: (hostname: string) => Promise<string[]>;
  uploadPollMs?: number;
  jobLimit?: number;
  jobTtlMs?: number;
}

// ============================================================================
// Input Validation Helpers
// ============================================================================

/**
 * Validate that a value is a string, returning undefined if not
 */
function validateString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate that a value is a string and non-empty, throwing if required but missing
 */
function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Validate and clamp a number to bounds, returning undefined if not a number
 */
function validateNumber(value: unknown, min?: number, max?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

/**
 * Validate that a value is a number, throwing if required but missing
 */
function requireNumber(value: unknown, fieldName: string, min?: number, max?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} is required and must be a number`);
  }
  let result = value;
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
}

/**
 * Validate that a value is a boolean
 */
function validateBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Validate that a value is an array of strings with at least one element
 */
function requireStringArray(value: unknown, fieldName: string, minLength = 1): string[] {
  if (!Array.isArray(value) || value.length < minLength) {
    throw new Error(`${fieldName} must be an array with at least ${minLength} element(s)`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName} must contain only strings`);
    }
    result.push(item);
  }
  return result;
}

/**
 * Validate optional string array
 */
function validateStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Validate enum value
 */
function validateEnum<T extends string>(value: unknown, allowed: readonly T[], defaultValue: T): T {
  if (typeof value === 'string' && allowed.includes(value as T)) {
    return value as T;
  }
  return defaultValue;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], fieldName: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${fieldName} must be one of: ${allowed.join(', ')}`);
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

/** expectImage may be "" when the drive has no image selected. */
function requireText(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} is required and must be a string`);
  }
  return value;
}

const VALID_BUTTONS = ['left', 'right', 'middle', 'up', 'down'] as const;
const VALID_KEY_STATES = ['press', 'release', 'click'] as const;

// ============================================================================
// HID Arm-Gate
// ============================================================================

/**
 * Every tool that mutates HID state on the remote machine (keyboard, mouse,
 * or calibration flows that move the cursor). In HTTP mode these are
 * disarmed unless PIKVM_MCP_ARM_HID=1 so a remote session can't drive real
 * hardware without an explicit arming step. Read-only tools (screenshot,
 * resolution, calibration get/set/clear — local state only) stay ungated,
 * as do the skill_* guidance tools.
 */
export const ARM_GATED_TOOLS = new Set([
  'pikvm_click_text',
  'pikvm_keep_awake',
  'pikvm_type',
  'pikvm_key',
  'pikvm_shortcut',
  'pikvm_mouse_move',
  'pikvm_mouse_click',
  'pikvm_mouse_scroll',
  'pikvm_calibrate',
  'pikvm_auto_calibrate',
]);

/**
 * MSD tools that stay available while the MSD arm-gate is enforced.
 * Every other name starting with pikvm_msd_ is gated, including tools
 * added later. Not part of ARM_GATED_TOOLS: arming HID does not arm MSD.
 */
export const MSD_READ_ONLY_TOOLS = new Set([
  'pikvm_msd_status',
  'pikvm_msd_job',
]);

export function msdToolRequiresArm(name: string): boolean {
  return name.startsWith('pikvm_msd_') && !MSD_READ_ONLY_TOOLS.has(name);
}

/**
 * Tool failure text. KvmdError keeps status, type, message, and endpoint.
 * MsdExpectImageError names the snapshot image. MsdImageTransferError
 * names the image with an active transfer. MsdPreflightError,
 * MsdUploadBusyError, and MsdUrlPolicyError keep their type. URL userinfo
 * is removed from every message. Other errors stay `Error: <message>`.
 */
export function formatToolError(error: unknown, password = '', otherPasswords: readonly string[] = []): string {
  // Every password is removed from each field before it is serialized: a
  // password with a quote or backslash is escaped in JSON, and a pass over
  // the finished text would miss it there.
  const redact = (value: string) => {
    let text = redactUrl(redactSecrets(value, password));
    for (const other of otherPasswords) text = redactSecrets(text, other);
    return text;
  };
  if (error instanceof MsdExpectImageError || error instanceof MsdImageTransferError) {
    const message = redact(error.message);
    const image = redact(error.image);
    const details = JSON.stringify({ type: error.type, image, message });
    return `Error [${error.type}]: ${message}\n${details}`;
  }
  if (
    error instanceof MsdPreflightError
    || error instanceof MsdUploadBusyError
    || error instanceof MsdUrlPolicyError
    || error instanceof OcrUnavailableError
    || error instanceof UnknownFrameError
  ) {
    const message = redact(error.message);
    const details = JSON.stringify({ type: error.type, message });
    return `Error [${error.type}]: ${message}\n${details}`;
  }
  if (error instanceof IntentError) {
    const message = redact(error.message);
    const redactValue = (value: unknown): unknown => {
      if (typeof value === 'string') return redact(value);
      if (Array.isArray(value)) return value.map(redactValue);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactValue(inner)]));
      }
      return value;
    };
    const details = JSON.stringify({ type: error.type, message, ...(redactValue(error.details) as object) });
    return `Error [${error.type}]: ${message}\n${details}`;
  }
  if (error instanceof OcrError) {
    const message = redact(error.message);
    const details = JSON.stringify({ type: error.type, message, engine: error.engine });
    return `Error [${error.type}]: ${message}\n${details}`;
  }
  if (error instanceof KvmdError) {
    const details = kvmdErrorDetails(error, password, otherPasswords);
    // A type this server raises leads with the situation. kvmd's own
    // errors keep the endpoint and status, which help debugging.
    const summary = SERVER_ERROR_TYPES.has(error.type)
      ? `Error [${details.type}]: ${details.message}`
      : `Error [${details.type}] ${details.endpoint} (HTTP ${details.status}): ${details.message}`;
    const next = details.next ? `\nNext: ${details.next.tool} ${JSON.stringify(details.next.args)}` : '';
    // Fields are already redacted. A second pass over the JSON would treat
    // the closing quote as part of X-KVMD-Passwd=[REDACTED] and break the block.
    return `${summary}${next}\n${JSON.stringify(details)}`;
  }
  if (error instanceof Error) {
    return `Error: ${redact(error.message)}`;
  }
  return 'Error: An unexpected error occurred';
}

/** Redacted KvmdError fields, for the JSON line and structuredContent. */
export function kvmdErrorDetails(error: KvmdError, password = '', otherPasswords: readonly string[] = []) {
  const redact = (value: string) => {
    let text = redactUrl(redactSecrets(value, password));
    for (const other of otherPasswords) text = redactSecrets(text, other);
    return text;
  };
  return {
    status: error.status,
    type: redact(error.type),
    message: redact(error.message),
    endpoint: redact(error.endpoint),
    ...(error.reason !== undefined ? { cause: error.reason } : {}),
    ...(error.next !== undefined ? { next: error.next } : {}),
  };
}

/** Tool calls that do not suspend keep-awake: keep-awake itself and state reads. */
const KEEP_AWAKE_NEUTRAL_TOOLS = new Set(['pikvm_keep_awake', 'pikvm_devices', 'pikvm_status']);

function requireIntegerIn(value: unknown, fieldName: string, range: { default: number; min: number; max: number }): number {
  if (value === undefined) return range.default;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${fieldName} must be an integer from ${range.min} to ${range.max}`);
  }
  return value;
}

function keepAwakeText(state: KeepAwakeState): string {
  if (!state.enabled) {
    return `Keep-awake is off. It sent ${state.actions} input(s).\n${JSON.stringify(state)}`;
  }
  const mouse = `a small mouse move near the centre of the ${state.quadrant} quadrant`;
  const key = `the ${KEEP_AWAKE_KEY} key, which applications ignore`;
  const input = state.mode === 'mouse' ? mouse : state.mode === 'keyboard' ? key : `${mouse} and ${key}, in turn`;
  return `Keep-awake is on: ${input}, whenever the computer has had no keyboard or mouse input for `
    + `${state.intervalSeconds} s. Other tool calls on this device pause it while they run and for `
    + `${state.suspendSeconds} s after; then it resumes. It stays on until pikvm_keep_awake is called with `
    + `enabled false, or the server restarts.\n${JSON.stringify(state)}`;
}

function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}

/** A refusal or miss from an intent tool: text not found, ambiguous, a wait that timed out. */
export class IntentError extends Error {
  readonly type: string;
  readonly details: Record<string, unknown>;

  constructor(type: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IntentError';
    this.type = type;
    this.details = details;
  }
}

/** After a wake key, how long to wait for the signal. */
const WAKE_SIGNAL_WAIT_MS = 7000;
/** With wake, a capture the screenshot starts waits this long before the key. */
const WAKE_FIRST_WAIT_MS = 3000;
/** Default settle time before an observe screenshot. */
const OBSERVE_DELAY_MS = 500;
/** The longest an observe screenshot waits for typing to finish. */
const OBSERVE_TYPE_MAX_MS = 30_000;

type ResultBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Text and image for one screenshot, the same for every tool that returns one. */
export function screenshotBlocks(result: ScreenshotResult, lead = ''): ResultBlock[] {
  const meta = {
    frameId: result.frameId,
    width: result.width,
    height: result.height,
    actualWidth: result.actualWidth,
    actualHeight: result.actualHeight,
    scaleX: result.scaleX,
    scaleY: result.scaleY,
    ...(result.region ? { region: result.region } : {}),
    calibration: result.calibration,
    hid: result.hid,
  };
  const screen = `the ${result.actualWidth}x${result.actualHeight} screen`;
  let infoText = result.region
    ? `Screenshot: ${result.screenshotWidth}x${result.screenshotHeight} crop at (${result.region.x}, ${result.region.y}) `
      + `of the full image of ${screen}. To click in this crop, pass its frameId to the mouse tool; `
      + 'without frameId, mouse x and y stay pixels of the last full screenshot.'
    : `Screenshot: ${result.screenshotWidth}x${result.screenshotHeight} image of ${screen}. `
      + 'Mouse x and y are pixels in this image.';
  infoText = `${lead}${infoText}\n${JSON.stringify(meta)}`;
  return [
    { type: 'text', text: infoText },
    { type: 'image', data: result.buffer.toString('base64'), mimeType: 'image/jpeg' },
  ];
}

/** Lower case, inner whitespace collapsed, surrounding punctuation dropped from each word. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

interface TextMatch {
  text: string;
  /** Centre in screen pixels. */
  screen: { x: number; y: number };
}

/** Phrase matches over consecutive OCR words, in reading order. */
export function findTextMatches(
  words: ReadonlyArray<{ text: string; bbox: { left: number; top: number; width: number; height: number } }>,
  phrase: string,
  crop: { left: number; top: number } | null,
): TextMatch[] {
  const tokens = phrase.split(/\s+/).map(normalizeWord).filter((token) => token !== '');
  if (tokens.length === 0) return [];
  // Punctuation-only words ("&", "-") are skipped, as they are in the phrase.
  const kept = words.map((word, index) => ({ index, norm: normalizeWord(word.text) })).filter((w) => w.norm !== '');
  const matches: TextMatch[] = [];
  for (let i = 0; i + tokens.length <= kept.length; i += 1) {
    if (!tokens.every((token, k) => kept[i + k].norm === token)) continue;
    // The words as on screen, punctuation included, from the first match to the last.
    const group = words.slice(kept[i].index, kept[i + tokens.length - 1].index + 1);
    const left = Math.min(...group.map((w) => w.bbox.left));
    const top = Math.min(...group.map((w) => w.bbox.top));
    const right = Math.max(...group.map((w) => w.bbox.left + w.bbox.width));
    const bottom = Math.max(...group.map((w) => w.bbox.top + w.bbox.height));
    matches.push({
      text: group.map((w) => w.text).join(' '),
      screen: {
        x: Math.round((crop?.left ?? 0) + (left + right) / 2),
        y: Math.round((crop?.top ?? 0) + (top + bottom) / 2),
      },
    });
  }
  return matches;
}

/** Share of pixels that differ visibly between two screenshots, compared small and grey. */
async function changedShare(before: Buffer, after: Buffer): Promise<number> {
  const small = (image: Buffer) => sharp(image).resize(64, 36, { fit: 'fill' }).greyscale().raw().toBuffer();
  const [a, b] = await Promise.all([small(before), small(after)]);
  let changed = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > 32) changed += 1;
  return changed / a.length;
}

/** A screenshot counts as changed when this share of its pixels changed. */
const CHANGED_SHARE = 0.005;

function agoText(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  return `${durationText((now - Date.parse(iso)) / 1000)} ago`;
}

const PICTURE_TEXT: Record<string, string> = {
  display_asleep: 'dark (the display is off or asleep)',
  usb_offline: 'no picture (USB offline)',
  no_signal: 'no picture (USB state unknown)',
  capture_stopped: 'capture stopped',
  unknown: 'unknown',
};

/** The device's situation in one phrase, and what to do about it. */
function statusVerdict(reading: DeviceStatusReading): string {
  if (!reading.reachable) return `unreachable: ${reading.error?.type ?? 'error'}`;
  const usbOffline = reading.input.keyboardOnline === false && reading.input.mouseOnline === false;
  switch (reading.picture.state) {
    case 'visible':
      return usbOffline ? 'picture visible, but its USB keyboard and mouse are offline: input will not reach it' : 'ready';
    case 'no_signal': return 'no picture, and the USB state could not be read';
    case 'capture_stopped': return 'ready; capture is stopped and starts on the next screenshot';
    case 'display_asleep': return 'display asleep: pikvm_screenshot with wake: true wakes it';
    case 'usb_offline': return 'no computer: its USB keyboard and mouse are offline (off, suspended or unplugged)';
    default: return 'unknown picture state';
  }
}

interface DeviceStatus extends DeviceStatusReading {
  device: string;
  verdict: string;
  armed: { hid: boolean; msd: boolean };
}

function deviceStatusText(status: DeviceStatus, now: number): string {
  const lines = [`${status.device}: ${status.verdict}.`];
  if (!status.reachable) {
    if (status.error) lines.push(`  ${status.error.message}`);
    return lines.join('\n');
  }
  const picture = status.picture;
  const screen = status.screen;
  let screenLine = picture.state === 'visible'
    ? `  Screen: on, ${picture.width}x${picture.height}${picture.fps !== undefined ? ` at ${picture.fps} fps` : ''}`
    : `  Screen: ${PICTURE_TEXT[picture.state] ?? picture.state}`;
  if (screen) {
    screenLine += screen.since === screen.lastChecked
      ? `; ${screen.state}, first seen just now by this server`
      : `; ${screen.state} for ${durationText((now - Date.parse(screen.since)) / 1000)}, as seen by this server`;
  }
  lines.push(`${screenLine}.`);
  const input = status.input;
  const online = (value: boolean | null) => (value === null ? 'unknown' : value ? 'online' : 'offline');
  lines.push(`  Input: keyboard ${online(input.keyboardOnline)}, mouse ${online(input.mouseOnline)}`
    + `${input.mouse ? ` (${input.mouse})` : ''}; ${input.held.length ? `held: ${input.held.join(', ')}` : 'nothing held'}`
    + `; HID ${status.armed.hid ? 'armed' : 'disarmed'}.`);
  const idle = status.idle;
  lines.push(`  Idle: ${idle.anyInputSeconds === null ? 'unknown' : durationText(idle.anyInputSeconds)} since any input (kvmd, all sources); `
    + `this server's last keyboard input ${agoText(idle.lastToolKeyboardInput, now)}, last mouse input ${agoText(idle.lastToolMouseInput, now)}.`);
  const keep = status.keepAwake;
  lines.push(keep.enabled
    ? `  Keep-awake: on, ${keep.mode}${keep.mode !== 'keyboard' ? ` in the ${keep.quadrant} quadrant` : ''}, after ${keep.intervalSeconds} s idle; `
      + `${keep.suspendedUntil ? `paused (${keep.suspendedUntil === 'while a tool call runs' ? 'a tool call is running' : `until ${keep.suspendedUntil}`})` : 'active'}`
      + `; ${keep.actions} input(s) sent, last ${keep.lastAction ? `${agoText(keep.lastAction.at, now)} (${keep.lastAction.input}${keep.lastAction.ok ? '' : ', failed'})` : 'none'}.`
    : '  Keep-awake: off.');
  const session = status.captureSession;
  if (session.open) lines.push(`  Capture session: open${session.closesAt ? `, closes at ${session.closesAt}` : ', in use'}.`);
  const media = status.media as { drive?: { image?: { name?: string } | null; connected?: boolean } | null; error?: string } | null;
  if (media && 'error' in media && media.error) lines.push(`  Media: unknown (${media.error}).`);
  else if (media?.drive) {
    lines.push(`  Media: ${media.drive.image?.name ? media.drive.image.name : 'no image selected'}, `
      + `${media.drive.connected ? 'connected' : 'not connected'}; MSD ${status.armed.msd ? 'armed' : 'disarmed'}.`);
  }
  return lines.join('\n');
}

function disarmedResult(tool: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `HID arm-gate: "${tool}" is blocked. Keyboard/mouse control is DISARMED ` +
          `(default in HTTP mode).\n` +
          `To arm: set PIKVM_MCP_ARM_HID=1 in the server's environment and restart. ` +
          `Read-only tools (screenshot, resolution, calibration state) remain available.`,
      },
    ],
    isError: true,
  };
}

function msdDisarmedResult(tool: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          `MSD arm-gate: "${tool}" is blocked. Mass-storage changes are DISARMED ` +
          `(default in HTTP mode).\n` +
          `To arm: set PIKVM_MCP_ARM_MSD=1 in the server's environment and restart. ` +
          `pikvm_msd_status and pikvm_msd_job stay available. PIKVM_MCP_ARM_HID=1 does not arm MSD.`,
      },
    ],
    isError: true,
  };
}

function jsonText(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

function withFrame(text: string, echo: FrameEcho): string {
  return `${text}\n${JSON.stringify(echo)}`;
}

function parseFrameId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '') {
    throw new UnknownFrameError(typeof value === 'string' ? value : typeof value);
  }
  return value;
}

/** Tool-output origin. A legacy host may still carry userinfo, a path, and a query. */
function outputOrigin(host: string): string {
  return new URL(host).origin;
}

function implicitFleet(deps: McpServerDeps): Fleet {
  const legacyClient = deps.pikvm;
  const legacyLock = deps.lock;
  const password = redactionPassword(legacyClient);
  const device: FleetDevice = {
    name: 'default',
    host: outputOrigin(legacyClient.configuredHost()),
    client: legacyClient,
    lock: legacyLock,
    armHid: !deps.armGateEnforced,
    armMsd: deps.msdArmGateEnforced !== true,
    hwTest: false,
    tlsMode: legacyClient.tlsMode(),
    screenshot: deps.screenshot ?? defaultScreenshotSettings(),
  };
  return {
    registryActive: false,
    defaultName: 'default',
    devices: new Map([['default', device]]),
    passwords: password ? [password] : [],
  };
}

function redactToolText(error: unknown, passwords: readonly string[]): string {
  let text = formatToolError(error, passwords[0] ?? '', passwords.slice(1));
  for (const password of passwords.slice(1)) {
    text = redactSecrets(text, password);
  }
  return text;
}

function listFleetDevices(fleet: Fleet) {
  const devices = [...fleet.devices.values()].map((device) => ({
    name: device.name,
    host: outputOrigin(device.host),
    tls: device.tlsMode,
    armHid: device.armHid,
    armMsd: device.armMsd,
    hwTest: device.hwTest,
  }));
  devices.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { default: fleet.defaultName, devices };
}

/** Results whose text is recognized screen text: never parsed as JSON for tagging. */
const plainTextResults = new WeakSet<object>();

function tagFleetResult<T extends {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}>(
  result: T,
  ctx: FleetDevice | undefined,
  registryActive: boolean,
): T {
  if (!registryActive || !ctx) return result;
  // Read before the structuredContent copy below replaces the object.
  const plainText = plainTextResults.has(result);
  if (result.structuredContent) {
    result = { ...result, structuredContent: { ...result.structuredContent, device: ctx.name } };
  }
  const content = result.content;
  if (!content || content.length === 0) return result;
  const first = content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    return {
      ...result,
      content: [{ type: 'text', text: `Device: ${ctx.name}.` }, ...content],
    };
  }
  let text = first.text;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && !plainText) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        text = JSON.stringify({ ...(parsed as Record<string, unknown>), device: ctx.name });
        return { ...result, content: [{ ...first, text }, ...content.slice(1)] };
      }
    } catch {
      // The text is not a JSON object.
    }
  }
  return {
    ...result,
    content: [{ ...first, text: `${text}\nDevice: ${ctx.name}.` }, ...content.slice(1)],
  };
}

const OBSERVE_PROPERTIES = {
  observe: {
    type: 'boolean',
    description: 'Also return a screenshot taken after the action, so no separate pikvm_screenshot is needed.',
  },
  observeDelayMs: {
    type: 'number',
    description: 'Wait before that screenshot, 0-10000 ms (default 500; for typing, until kvmd has typed the text).',
  },
} as const;

/** Input tools that accept observe. */
const OBSERVE_TOOLS = new Set([
  'pikvm_key',
  'pikvm_shortcut',
  'pikvm_type',
  'pikvm_mouse_move',
  'pikvm_mouse_click',
  'pikvm_mouse_scroll',
]);

const OCR_BOX_PROPERTIES = {
  left: { type: 'number', description: 'Left edge of a box to read, in pixels of the last screenshot.' },
  top: { type: 'number', description: 'Top edge of that box.' },
  right: { type: 'number', description: 'Right edge of that box.' },
  bottom: { type: 'number', description: 'Bottom edge of that box.' },
} as const;

// Define available tools
const tools: Tool[] = [
  {
    name: 'pikvm_screenshot',
    description: 'Capture a screenshot from the PiKVM video stream. Mouse x and y are pixels in the returned image, not screen pixels. Returns a JPEG plus coordinate metadata, including frameId. Defaults are PIKVM_SCREENSHOT_MAX_WIDTH 960, PIKVM_SCREENSHOT_MAX_HEIGHT 600, and PIKVM_SCREENSHOT_QUALITY 70, unless the device registry sets screenshot. A per-call value wins. region crops the captured image locally and must lie inside it. The default click frame is the last full preview, in request order rather than completion order. A crop does not change it. Pass that capture\'s frameId to a mouse tool to click in the crop.',
    inputSchema: {
      type: 'object',
      properties: {
        wake: {
          type: 'boolean',
          description: `When the display is dark but the computer is connected, press ${WAKE_KEY} once (ignored by applications), wait for the picture and return it. Needs HID armed. Never presses when the computer's USB is offline.`,
        },
        maxWidth: {
          type: 'number',
          description: 'Maximum preview width in pixels (1-10000). Omitted uses the device default.',
        },
        maxHeight: {
          type: 'number',
          description: 'Maximum preview height in pixels (1-10000). Omitted uses the device default.',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100. Omitted uses the device default (70 unless configured).',
        },
        region: {
          type: 'object',
          description: 'Crop in screenshot pixels: x, y, width, height. Must lie fully inside the captured image.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
    },
  },
  {
    name: 'pikvm_read_text',
    description: 'Read on-screen text. The result is the plain text; structuredContent carries the engine, crop, source size and timings. detail "words" returns the full JSON instead, with every word, its confidence, box and click point. engine is host (the system tesseract binary) or kvmd. Unset PIKVM_OCR_ENGINE uses host when tesseract was found at startup, and is off otherwise. kvmd is never the unset default and is never a fallback after a host failure. Host is listed when the binary was found. kvmd is listed while any device is enabled or not yet probed. off is hidden. A host call needs a box unless fullFrame is true and PIKVM_OCR_ALLOW_FULL_FRAME=1. The region is refused before a snapshot when it is above the pixel cap. words[].click is the word centre in this frameId. Text is capped at 64 KiB.',
    inputSchema: {
      type: 'object',
      properties: {
        engine: {
          type: 'string',
          description: 'host or kvmd. Omitted uses the process engine after a device narrowing. kvmd still requires the device probe.',
        },
        langs: {
          type: 'string',
          description: 'Comma-separated languages. Host uses the process list (default eng) when omitted. kvmd uses the device default when omitted.',
        },
        left: { type: 'number', description: 'Left edge of the OCR box in preview-frame pixels.' },
        top: { type: 'number', description: 'Top edge of the OCR box in preview-frame pixels.' },
        right: { type: 'number', description: 'Right edge of the OCR box in preview-frame pixels.' },
        bottom: { type: 'number', description: 'Bottom edge of the OCR box in preview-frame pixels.' },
        fullFrame: {
          type: 'boolean',
          description: 'Host only: recognize the whole source. Requires PIKVM_OCR_ALLOW_FULL_FRAME=1 and stays within about 8.3 megapixels.',
        },
        frameId: {
          type: 'string',
          description: 'Capture whose pixels the box is in. Omitted uses the default click frame. Unknown sends no OCR request.',
        },
        detail: {
          type: 'string',
          enum: ['text', 'words'],
          description: 'text (default): the recognized text. words: the full JSON result with per-word boxes and click points.',
        },
      },
    },
  },
  {
    name: 'pikvm_get_resolution',
    description: 'Get the remote screen resolution in screen pixels. Mouse tools do not take screen pixels: their x and y are pixels of the last screenshot image. Use this to understand the scale between the two.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_type',
    description: 'Type text on the remote machine using PiKVM. Handles special characters correctly via keymap conversion.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OBSERVE_PROPERTIES,
        text: {
          type: 'string',
          description: 'The text to type',
        },
        keymap: {
          type: 'string',
          description: 'Keyboard layout (default: en-us)',
        },
        slow: {
          type: 'boolean',
          description: 'Use slow typing mode for compatibility',
        },
        delay: {
          type: 'number',
          description: 'Delay between keystrokes in milliseconds (0-200). Sent to kvmd as seconds.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'pikvm_key',
    description: 'Send a key or key combination to the remote machine. Use JavaScript key codes (e.g., KeyA, Enter, ControlLeft).',
    inputSchema: {
      type: 'object',
      properties: {
        ...OBSERVE_PROPERTIES,
        key: {
          type: 'string',
          description: 'Key code (e.g., KeyA, Enter, Escape, F1)',
        },
        modifiers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifier keys to hold (e.g., ["ControlLeft", "AltLeft"])',
        },
        state: {
          type: 'string',
          enum: ['press', 'release', 'click'],
          description: 'Key state: press (hold), release, or click (press+release, default)',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'pikvm_shortcut',
    description: 'Send a keyboard shortcut (multiple keys pressed simultaneously). Example: Ctrl+Alt+Delete',
    inputSchema: {
      type: 'object',
      properties: {
        ...OBSERVE_PROPERTIES,
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of key codes to press together (e.g., ["ControlLeft", "AltLeft", "Delete"])',
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'pikvm_mouse_move',
    description: 'Move the mouse cursor. x and y are pixels in the last screenshot image (see its width and height), not screen pixels. In detail: absolute coordinates are pixels in the default click frame, which is the last full preview in request order. Pass frameId to use that capture, including a crop: the point is mapped with that frame\'s scale, crop origin, and calibration. An unknown, evicted, or other-device frameId is PIKVM_UNKNOWN_FRAME and sends no HID event. Relative deltas are clamped to -127 to 127 and are not mapped through the frame. The result echoes frameId or default, width, height, scale, and origin.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OBSERVE_PROPERTIES,
        x: {
          type: 'number',
          description: 'X coordinate in pixels (absolute) or delta pixels (relative)',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in pixels (absolute) or delta pixels (relative)',
        },
        relative: {
          type: 'boolean',
          description: 'If true, move relative to current position (delta -127 to 127). Default: false (absolute pixel position)',
        },
        frameId: {
          type: 'string',
          description: 'Capture whose pixels x and y are in. Omitted uses the default click frame (last full preview, request order).',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pikvm_mouse_click',
    description: 'Click a mouse button. Optional x and y are pixels in the last screenshot image (see its width and height), not screen pixels; that is the default click frame (the last full preview, in request order). Pass frameId to move in that capture, including a crop. An unknown, evicted, or other-device frameId is PIKVM_UNKNOWN_FRAME and sends no HID event. The result echoes frameId or default, width, height, scale, and origin.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OBSERVE_PROPERTIES,
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle', 'up', 'down'],
          description: 'Mouse button to click (default: left). "up" and "down" are scroll wheel buttons.',
        },
        x: {
          type: 'number',
          description: 'X pixel coordinate to move to before clicking (optional)',
        },
        y: {
          type: 'number',
          description: 'Y pixel coordinate to move to before clicking (optional)',
        },
        state: {
          type: 'string',
          enum: ['press', 'release', 'click'],
          description: 'Button state: press (hold), release, or click (default)',
        },
        frameId: {
          type: 'string',
          description: 'Capture whose pixels x and y are in. Omitted uses the default click frame (last full preview, request order).',
        },
      },
    },
  },
  {
    name: 'pikvm_mouse_scroll',
    description: 'Scroll the mouse wheel. frameId is checked when given: an unknown, evicted, or other-device id is PIKVM_UNKNOWN_FRAME and sends no HID event. The result echoes frameId or default, width, height, scale, and origin.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OBSERVE_PROPERTIES,
        deltaX: {
          type: 'number',
          description: 'Horizontal scroll amount (negative = left, positive = right)',
        },
        deltaY: {
          type: 'number',
          description: 'Vertical scroll amount (negative = up, positive = down)',
        },
        frameId: {
          type: 'string',
          description: 'Checked when given. Omitted echoes the default click frame.',
        },
      },
      required: ['deltaY'],
    },
  },
  {
    name: 'pikvm_calibrate',
    description: 'Start mouse coordinate calibration. Moves cursor to screen center and returns expected position. Take a screenshot after calling this to visually verify actual cursor position, then call pikvm_set_calibration with calculated factors.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_set_calibration',
    description: 'Set mouse coordinate calibration factors. Calculate factors as: factorX = expected_x / actual_x, factorY = expected_y / actual_y. For example, if calibration moved cursor to expected (960, 540) but it landed at (720, 405), factors would be 960/720=1.33 and 540/405=1.33.',
    inputSchema: {
      type: 'object',
      properties: {
        factorX: {
          type: 'number',
          description: 'X-axis calibration factor (typically 1.0-1.5)',
        },
        factorY: {
          type: 'number',
          description: 'Y-axis calibration factor (typically 1.0-1.5)',
        },
      },
      required: ['factorX', 'factorY'],
    },
  },
  {
    name: 'pikvm_get_calibration',
    description: 'Get current mouse calibration state. Returns null if not calibrated.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_clear_calibration',
    description: 'Clear mouse calibration, reverting to uncalibrated mode.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pikvm_auto_calibrate',
    description: 'Automatically calibrate mouse coordinates by detecting the cursor position via screenshot diffing. This is more accurate than manual calibration. Moves the mouse multiple times, compares screenshots to find the cursor, and computes calibration factors. Other tools are blocked during calibration.',
    inputSchema: {
      type: 'object',
      properties: {
        rounds: {
          type: 'number',
          description: 'Number of sampling rounds (default: 5)',
        },
        verifyRounds: {
          type: 'number',
          description: 'Number of verification rounds (default: 5)',
        },
        moveDelayMs: {
          type: 'number',
          description: 'Delay in ms after each mouse move for capture to settle (default: 300). Increase if calibration fails on slow connections.',
        },
        mergeRadius: {
          type: 'number',
          description: 'Radius in pixels for merging nearby clusters (e.g., cursor + drop shadow). Default: 30.',
        },
        minSamples: {
          type: 'number',
          description: 'Minimum valid samples required for calibration to succeed. Default: 3.',
        },
        maxRatioDivergence: {
          type: 'number',
          description: 'Maximum allowed divergence between X and Y ratios within a single round. Rejects noisy rounds where ratios are incoherent. Default: 0.5.',
        },
        verbose: {
          type: 'boolean',
          description: 'Log per-round debug data (centroid positions, accept/reject reasons). Default: false.',
        },
      },
    },
  },
  {
    name: 'pikvm_msd_status',
    description: 'Read PiKVM mass-storage state (GET /api/msd). Does not change the drive. Returns online, busy, drive, images, parts, free, uploading, and downloading.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Registry device name. Omitted means the default device.',
        },
      },
    },
  },
  {
    name: 'pikvm_msd_mount',
    description: 'Select a mass-storage image and, by default, connect the virtual drive. confirmImage must equal image. Refuses while that image has an active upload or fetch, and makes no POST. When a drive is already connected, expectImage must equal that image name or the mount is refused and nothing is ejected. mode is cdrom or flash. rw is for flash and defaults to false; kvmd may force rw false, and the returned drive is a re-read after the change. On failure the previous drive selection is restored. rollbackError is one entry per failed step, including the re-read. An NBD or URL image in that snapshot cannot be restored, because set_params refuses names containing ://, and that refusal is one of those entries.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Registry device name. Omitted means the default device.',
        },
        image: {
          type: 'string',
          description: 'Storage image name to select.',
        },
        mode: {
          type: 'string',
          enum: ['cdrom', 'flash'],
          description: 'cdrom or flash.',
        },
        rw: {
          type: 'boolean',
          description: 'Request a writable flash drive. Default false. Flash only; cdrom is reported from the re-read after kvmd applies it.',
        },
        confirmImage: {
          type: 'string',
          description: 'Must equal image. The mount is refused when it does not.',
        },
        expectImage: {
          type: 'string',
          description: 'Required when the virtual drive is already connected. Must equal the connected image name. A value supplied while the drive is disconnected must also equal the snapshot image. The mount does not disconnect a different image.',
        },
        connect: {
          type: 'boolean',
          description: 'Connect the drive after selecting the image. Default true.',
        },
      },
      required: ['image', 'mode', 'confirmImage'],
    },
  },
  {
    name: 'pikvm_msd_eject',
    description: 'Disconnect the virtual drive. expectImage must equal the current drive image name, or an empty string when none is selected. A mismatch is MsdExpectImageError and does not change the drive. Safe to repeat: a second eject returns alreadyDisconnected.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Registry device name. Omitted means the default device.',
        },
        expectImage: {
          type: 'string',
          description: 'Current drive image name, or an empty string when no image is selected.',
        },
      },
      required: ['expectImage'],
    },
  },
  {
    name: 'pikvm_msd_upload',
    description: 'Upload a local image into PiKVM storage and return a jobId immediately after the file is confined. Hashing and the kvmd pre-check run in the job, which is hashing, then running, then awaiting_catalog. A sha256 mismatch fails the job and uploads nothing. A hash read that is still going when PIKVM_MSD_JOB_TIMEOUT_MS ends fails the job with PIKVM_MSD_HASH_TIMEOUT, releases the upload slot without waiting for the file to close, and uploads nothing. The descriptor is closed from that read callback, or immediately when no hash read is in flight. A close error on that path is logged and does not replace the job error. PIKVM_MSD_JOB_TIMEOUT_MS is only a last-resort safety cap, on the hash and again on the upload POST. A hash that is still running when the cap ends stays PIKVM_MSD_HASH_TIMEOUT (hash timeout after <ms>ms) and does not use phase job_timeout. When the cap ends the upload after the POST has been sent, on the body, during finalise, or while reading the response after headers, the job fails with PIKVM_MSD_STATE_UNKNOWN and phase job_timeout. The message is job timeout after <ms>ms (PIKVM_MSD_JOB_TIMEOUT_MS); image may be partial or complete; re-read /api/msd; do not resend. The slot is released and the image is not removed. An idle abort has no phase. A finalise abort keeps phase finalise. PIKVM_MSD_IDLE_TIMEOUT_MS bounds each hash read and the upload body. The upload finalise window is twice that idle value, from when the request has been sent until kvmd answers. The client sees bytes handed to the socket, so the OS send buffer and the peer receive window can still be draining, and the 2× window allows for that. If the buffered bytes take longer than 2× PIKVM_MSD_IDLE_TIMEOUT_MS to drain, the upload ends with PIKVM_MSD_STATE_UNKNOWN, phase finalise, while bytes may still be in flight; re-read /api/msd and do not resend. nginx\'s 60s proxy_read_timeout starts only after the whole body has gone upstream, so it bounds kvmd\'s own finish (a 504, reported as PIKVM_MSD_STATE_UNKNOWN), not the drain, which can use the full 120s. PIKVM_MSD_JOB_TIMEOUT_MS stays a last-resort safety cap. A hash read that does not return within that limit, including time queued on the threadpool, fails the job with PIKVM_MSD_HASH_IDLE_TIMEOUT. A read that returns 0 bytes ends the hash. The timer resets when a read returns and does not cap total hash time. The message names the file, the limit in milliseconds, and PIKVM_MSD_IDLE_TIMEOUT_MS. The upload slot is released the same way, and nothing is uploaded. After kvmd accepts the bytes the job waits for that image to be present, complete, and the expected size. The catalog wait uses PIKVM_MSD_READY_TIMEOUT_MS. PIKVM_MSD_CATALOG_TIMEOUT means the write was accepted and the image may still appear. PIKVM_MSD_IMAGE_INCOMPLETE means the row stayed incomplete until the deadline. The catalog wait and the removal confirm are monotonic elapsed time, so a step of the realtime clock does not shorten or extend them. A catalog read is not started when less than 1 ms remains. PIKVM_MSD_SIZE_MISMATCH means a complete row has the wrong size and fails at once. An incomplete row whose size already differs keeps waiting. PIKVM_MSD_CANCELLED means the wait was cancelled. PIKVM_MSD_REMOVAL_UNCONFIRMED means cleanup could not prove the image is gone. The upload POST is not repeated. Catalog-failure cleanup holds the MSD lock until that check finishes. A file-close failure after the image is in the catalog removes it before the job is failed. A second upload while one is running is refused. file is a bare name under PIKVM_MSD_LOCAL_DIR. confirmImage must equal file. The drive is not changed. Poll pikvm_msd_job. Hidden while PIKVM_MSD_LOCAL_DIR is unset.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Registry device name. Omitted means the default device.',
        },
        file: {
          type: 'string',
          description: 'Bare file name inside PIKVM_MSD_LOCAL_DIR. No directory separators.',
        },
        confirmImage: {
          type: 'string',
          description: 'Must equal file.',
        },
        sha256: {
          type: 'string',
          description: 'Optional expected sha256 hex digest of the file. A mismatch fails the job before any upload POST.',
        },
      },
      required: ['file', 'confirmImage'],
    },
  },
  {
    name: 'pikvm_msd_fetch_url',
    description: 'Download an image from an allowlisted https URL into PiKVM storage and return a jobId immediately. The URL must be https, have no userinfo, and match PIKVM_MSD_URL_ALLOWLIST. image defaults to the last path segment. confirmImage must equal the final name. DNS, the address check, the kvmd pre-check, and the download run in the job. PIKVM_MSD_JOB_TIMEOUT_MS is only the last-resort cap. When that cap ends write_remote after the request has been sent, on the header window or the NDJSON stream, the job fails with PIKVM_MSD_STATE_UNKNOWN and phase job_timeout. The message is job timeout after <ms>ms (PIKVM_MSD_JOB_TIMEOUT_MS); image may be partial or complete; re-read /api/msd; do not resend. The image is not removed. A header-window abort keeps phase write_remote_headers. An idle gap in the stream has no phase. PIKVM_MSD_IDLE_TIMEOUT_MS bounds write_remote response headers together with the connect timeout, and then each gap in the NDJSON stream. The catalog wait uses PIKVM_MSD_READY_TIMEOUT_MS. After write_remote accepts the bytes the job waits for that image to be complete in the catalog. Cleanup after that wait fails holds the MSD lock until it finishes, with the same PIKVM_MSD_CATALOG_TIMEOUT, PIKVM_MSD_IMAGE_INCOMPLETE, PIKVM_MSD_SIZE_MISMATCH, PIKVM_MSD_CANCELLED, and PIKVM_MSD_REMOVAL_UNCONFIRMED results as an upload. The remote write is not repeated. A second transfer while one is running is refused. The drive is not changed. Poll pikvm_msd_job. Hidden while the allowlist has no https entry.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Registry device name. Omitted means the default device.',
        },
        url: {
          type: 'string',
          description: 'https URL whose host and path match PIKVM_MSD_URL_ALLOWLIST. No userinfo.',
        },
        image: {
          type: 'string',
          description: 'Storage name. Defaults to the URL path last segment. Same bare-name rules as upload.',
        },
        confirmImage: {
          type: 'string',
          description: 'Must equal the final image name.',
        },
      },
      required: ['url', 'confirmImage'],
    },
  },
  {
    name: 'pikvm_msd_job',
    description: 'Read an in-memory MSD upload or URL fetch job. Returns state hashing, running, awaiting_catalog, done, or failed, plus bytes, total, and sha256 when known. awaiting_catalog means the write was accepted and the job is waiting for that image in the catalog. A failed transfer that stored the wrong or incomplete bytes includes removed, except PIKVM_MSD_STATE_UNKNOWN, which skips cleanup. Finished jobs are dropped after 24 hours. Does not change the drive.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Job id returned by pikvm_msd_upload or pikvm_msd_fetch_url.',
        },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'pikvm_msd_remove',
    description: 'Remove an image from PiKVM storage. confirmImage must equal image. Refuses while the virtual drive is connected, and does not disconnect it. Returns the drive re-read after the removal.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Registry device name. Omitted means the default device.',
        },
        image: {
          type: 'string',
          description: 'Storage image name to remove.',
        },
        confirmImage: {
          type: 'string',
          description: 'Must equal image.',
        },
      },
      required: ['image', 'confirmImage'],
    },
  },
  {
    name: 'pikvm_wait_for',
    description: 'Wait until something happens on screen, then return the screenshot: text appears (text), text disappears (gone), anything visibly changes (changed: true), or a picture appears (signal: true). Give exactly one. Text uses OCR on a box (left, top, right, bottom in pixels of the last screenshot) or, without a box, the whole screen when PIKVM_OCR_ALLOW_FULL_FRAME=1. A timeout is PIKVM_WAIT_TIMEOUT with the last screenshot. Read-only unless wake is true.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Wait until this text is on screen (case-insensitive).' },
        gone: { type: 'string', description: 'Wait until this text is no longer on screen.' },
        changed: { type: 'boolean', description: 'true: wait until the screen visibly changes from the first look (a clock counts).' },
        signal: { type: 'boolean', description: 'true: wait until there is a picture.' },
        timeoutSeconds: { type: 'number', description: 'Give up after this long, 1-300 (default 30).' },
        intervalMs: { type: 'number', description: 'Time between looks, 250-10000 (default 1000).' },
        ...OCR_BOX_PROPERTIES,
        wake: { type: 'boolean', description: `If the display goes dark while connected, press ${WAKE_KEY} once. Needs HID armed.` },
      },
    },
  },
  {
    name: 'pikvm_click_text',
    description: 'Click on text: find it with OCR, click its centre and return the screenshot after. Matches whole words in reading order, case-insensitive, so "Update Windows" matches a label split over two lines. Several matches are refused with their positions unless nth picks one. Needs host OCR (word boxes) and HID armed. Reads a box (left, top, right, bottom in pixels of the last screenshot) or, without one, the whole screen when PIKVM_OCR_ALLOW_FULL_FRAME=1.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to click, one or more words.' },
        nth: { type: 'number', description: 'Which match to click, from 1, in reading order. Needed when there are several.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
        double: { type: 'boolean', description: 'Double-click.' },
        observe: { type: 'boolean', description: 'Return the screenshot after the click (default true).' },
        observeDelayMs: OBSERVE_PROPERTIES.observeDelayMs,
        ...OCR_BOX_PROPERTIES,
      },
      required: ['text'],
    },
  },
  {
    name: 'pikvm_status',
    description: 'What state each device is in, read-only: a one-line verdict (ready, display asleep, no computer, unreachable), the picture (visible, display asleep, capture stopped, resolution, fps), screen on-time as seen by this server, keyboard and mouse online and absolute or relative, held input, idle timers (kvmd\'s time since any input, and this server\'s last keyboard and mouse input), keep-awake state, the capture session and media. Starts no capture and sends no input. Omit device for every device.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'One device. Omitted reports every device.' },
      },
    },
  },
  {
    name: 'pikvm_keep_awake',
    description: 'Keep the computer awake until stopped: a toggle. Whenever the computer has had no keyboard or mouse input from anyone for intervalSeconds, send one harmless input: mouse moves near the centre of a screen quadrant (never the screen centre or an edge), the F15 key (ignored by applications), or both in turn. Any other tool call on this device pauses it while the call runs and for suspendSeconds after, then it resumes by itself. Needs HID armed. State is in memory; a server restart stops it.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true starts (or restarts with new options), false stops.' },
        mode: {
          type: 'string',
          enum: [...KEEP_AWAKE_MODES],
          description: 'mouse (default), keyboard (F15), or mixed (both in turn).',
        },
        quadrant: {
          type: 'string',
          enum: [...KEEP_AWAKE_QUADRANTS],
          description: 'Where mouse moves happen: near the centre of this quadrant. Default bottom-right.',
        },
        intervalSeconds: {
          type: 'number',
          description: `Act after this many seconds without any input (${KEEP_AWAKE_INTERVAL.min}-${KEEP_AWAKE_INTERVAL.max}, default ${KEEP_AWAKE_INTERVAL.default}). Keep it below the computer's screen timeout.`,
        },
        suspendSeconds: {
          type: 'number',
          description: `Pause after another tool call on this device (${KEEP_AWAKE_SUSPEND.min}-${KEEP_AWAKE_SUSPEND.max}, default ${KEEP_AWAKE_SUSPEND.default}).`,
        },
      },
      required: ['enabled'],
    },
  },
  {
    name: 'pikvm_devices',
    description: 'List devices: name, normalised origin, TLS mode, and arm state. Passwords and secret file paths are not included.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  ...skillTools,
];

for (const tool of tools) {
  if (!tool.name.startsWith('pikvm_') || tool.name === 'pikvm_devices') continue;
  if (tool.inputSchema.type !== 'object') continue;
  tool.inputSchema.properties ??= {};
  tool.inputSchema.properties.device = {
    type: 'string',
    description: 'Registry device name. Omitted means the default device.',
  };
}

/**
 * Build a fresh MCP Server with all handlers registered.
 *
 * `deps` are shared across all instances. The fleet has one PiKVMClient
 * and one BusyLock per device. Per-HTTP-session instances exist to satisfy
 * the Streamable HTTP session model, which requires one transport (and
 * therefore one Server) per session.
 */
export function createMcpServer(deps: McpServerDeps): Server {
  const ocrRuntime = deps.ocr ?? offOcr();
  const fleet = deps.fleet ?? implicitFleet(deps);
  const server = new Server(
    {
      name: 'pikvm-mcp-server',
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    }
  );

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: allPrompts.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      })),
    };
  });

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = getPromptByName(name, args);
    if (!result) {
      throw new Error(`Unknown prompt: ${name}`);
    }
    return {
      description: result.definition.description,
      messages: result.messages,
    };
  });

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const fetchReady = (deps.msd?.urlAllow?.entries.length ?? 0) > 0;
    const uploadReady = Boolean(deps.msd?.localDir)
      || [...fleet.devices.values()].some((device) => Boolean(device.msdLocalDir));
    const visible = tools.filter((tool) => {
      if (tool.name === 'pikvm_msd_upload' && !uploadReady) return false;
      if (tool.name === 'pikvm_msd_fetch_url' && !fetchReady) return false;
      if (tool.name === 'pikvm_read_text') {
        return ocrToolVisible(ocrRuntime, [...fleet.devices.values()].map((device) => ({
          ocr: device.ocr,
          ocrStatus: device.client.ocrState().status,
        })));
      }
      return true;
    });
    return { tools: visible };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let ctx: FleetDevice | undefined;
    // Read-only and never blocked: it reports auto-calibration and keep-awake too.
    if (name === 'pikvm_status') {
      try {
        const chosen = args.device === undefined
          ? [...fleet.devices.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          : [resolveFleetDevice(args, fleet)];
        const now = Date.now();
        // Every device's password, so one device's error cannot carry another's.
        const scrub = (value: string) => {
          let text = redactUrl(value);
          for (const password of fleet.passwords) text = redactSecrets(text, password);
          return text;
        };
        const devices: DeviceStatus[] = await Promise.all(chosen.map(async (device) => {
          const reading = await device.client.status();
          if (reading.error) reading.error = { type: scrub(reading.error.type), message: scrub(reading.error.message) };
          const mediaError = (reading.media as { error?: unknown } | null)?.error;
          if (typeof mediaError === 'string') reading.media = { error: scrub(mediaError) };
          return {
            device: device.name,
            verdict: statusVerdict(reading),
            armed: { hid: device.armHid, msd: device.armMsd },
            ...reading,
            media: reading.media && typeof reading.media === 'object' && !('error' in (reading.media as object))
              ? publicMsdState(reading.media as Parameters<typeof publicMsdState>[0])
              : reading.media,
          };
        }));
        const text = devices.map((device) => deviceStatusText(device, now)).join('\n\n');
        const body = { devices };
        return {
          content: [{ type: 'text', text: `${text}\n${JSON.stringify(body)}` }],
          structuredContent: body,
        };
      } catch (error) {
        return { content: [{ type: 'text', text: redactToolText(error, fleet.passwords) }], isError: true };
      }
    }
    if (name !== 'pikvm_devices' && !isSkillTool(name)) {
      try {
        ctx = resolveFleetDevice(args, fleet);
      } catch (error) {
        return {
          content: [{ type: 'text', text: redactToolText(error, fleet.passwords) }],
          isError: true,
        };
      }
    }
    const deviceClient = ctx?.client ?? fleet.devices.get(fleet.defaultName)!.client;
    const deviceLock = ctx?.lock ?? fleet.devices.get(fleet.defaultName)!.lock;

    // Block other tools on this device while its auto-calibration is in progress.
    if (deviceLock.isBusy && name !== 'pikvm_auto_calibrate') {
      return tagFleetResult({
        content: [{ type: 'text', text: `Error: ${deviceLock.holder} in progress, please wait.` }],
        isError: true,
      }, ctx, fleet.registryActive);
    }

    // HID arm-gate: the device arm already includes the process ceiling.
    if (ctx && !ctx.armHid && ARM_GATED_TOOLS.has(name)) {
      return tagFleetResult(disarmedResult(name), ctx, fleet.registryActive);
    }

    // MSD arm-gate: every pikvm_msd_* tool except the read-only allowlist.
    if (ctx && !ctx.armMsd && msdToolRequiresArm(name)) {
      return tagFleetResult(msdDisarmedResult(name), ctx, fleet.registryActive);
    }

    try {
      if (isSkillTool(name)) {
        return handleSkillToolCall(name, args);
      }
      if (name === 'pikvm_devices') {
        return jsonText(listFleetDevices(fleet));
      }
      if (!ctx) throw new Error(`Unknown tool: ${name}`);
      const active = ctx;

      const deviceScreenshot = (signalWaitMs?: number) => deviceClient.screenshot({
        maxWidth: active.screenshot.maxWidth,
        maxHeight: active.screenshot.maxHeight,
        quality: active.screenshot.quality,
        ...(signalWaitMs !== undefined ? { signalWaitMs } : {}),
      });
      /**
       * After PIKVM_NO_SIGNAL with a connected computer: press the wake
       * key once and wait for the picture. Rethrows anything else, and
       * never presses when USB is offline or HID is disarmed.
       */
      const wakeDisplay = async (error: unknown, maxWaitMs = WAKE_SIGNAL_WAIT_MS): Promise<string> => {
        if (!(error instanceof KvmdError) || error.type !== 'PIKVM_NO_SIGNAL' || error.reason === 'usb_offline') throw error;
        if (!active.armHid) {
          error.message += '. wake did not press a key: HID is disarmed';
          // Repeating the wake cannot help.
          error.next = undefined;
          throw error;
        }
        return deviceClient.holdingCapture(async () => {
          await deviceClient.sendKey(WAKE_KEY);
          const signal = await deviceClient.waitForSignal(maxWaitMs);
          if (!signal.online) {
            error.message += `. Pressed ${WAKE_KEY}; still no picture after ${Math.round(maxWaitMs / 100) / 10} s`;
            error.next = undefined;
            throw error;
          }
          return `Woke the display: pressed ${WAKE_KEY}, picture after ${signal.afterMs} ms. `;
        });
      };
      /** Host or kvmd OCR as configured, over a box in screenshot pixels or the whole screen. */
      const runOcr = (box: ReturnType<typeof parseOcrBox>, budgetMs?: number) => {
        const described = deviceClient.describeFrame();
        const calibration = deviceClient.getCalibration();
        return executeOcr({
          deviceName: active.name,
          // A wait gives each look only the time it has left.
          runtime: budgetMs === undefined
            ? ocrRuntime
            : { ...ocrRuntime, timeoutMs: Math.max(1, Math.min(ocrRuntime.timeoutMs, Math.round(budgetMs))) },
          override: active.ocr,
          engineArg: undefined,
          langsArg: undefined,
          box,
          frame: described.frame,
          frameId: described.echo.frameId,
          fullFrame: box === undefined,
          getSource: () => deviceClient.getResolution(true),
          calibration: calibration ? { factorX: calibration.factorX, factorY: calibration.factorY } : null,
          fetchSnapshot: (timeoutMs) => deviceClient.fetchFullSnapshot(timeoutMs),
          readKvmd: (langs) => deviceClient.readText({ langs, box }),
          ensureKvmd: async () => {
            let state = deviceClient.ocrState();
            if (state.status === 'unknown') state = await deviceClient.probeOcr(active.name);
            if (state.status !== 'enabled') throw new OcrUnavailableError(active.name);
            return state;
          },
        });
      };
      const observeBlocks = async (delayMs: number): Promise<ResultBlock[]> => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          return screenshotBlocks(await deviceScreenshot(), 'After the action: ');
        } catch (error) {
          return [{ type: 'text', text: `After the action, no screenshot: ${redactToolText(error, fleet.passwords)}` }];
        }
      };
      const observeDelay = (fallbackMs: number) => {
        const requested = validateNumber(args.observeDelayMs, 0, 10_000);
        return requested === undefined ? fallbackMs : Math.round(requested);
      };
      let typedQueuedMs = 0;

      // Every other tool call on this device pauses keep-awake while it runs
      // and for its suspendSeconds after.
      const suspends = !KEEP_AWAKE_NEUTRAL_TOOLS.has(name);
      if (suspends) active.client.keepAwake.callStarted();
      const produced = await (async () => {
      switch (name) {
        case 'pikvm_keep_awake': {
          const enabled = requireBoolean(args.enabled, 'enabled');
          if (!enabled) {
            const state = deviceClient.keepAwake.stop();
            return { content: [{ type: 'text', text: keepAwakeText(state) }], structuredContent: { ...state } };
          }
          const options: KeepAwakeOptions = {
            mode: args.mode === undefined ? 'mouse' : requireEnum(args.mode, KEEP_AWAKE_MODES, 'mode'),
            quadrant: args.quadrant === undefined
              ? 'bottom-right'
              : requireEnum(args.quadrant, KEEP_AWAKE_QUADRANTS, 'quadrant'),
            intervalSeconds: requireIntegerIn(args.intervalSeconds, 'intervalSeconds', KEEP_AWAKE_INTERVAL),
            suspendSeconds: requireIntegerIn(args.suspendSeconds, 'suspendSeconds', KEEP_AWAKE_SUSPEND),
          };
          const state = deviceClient.keepAwake.start(options, () => deviceLock.isBusy);
          return { content: [{ type: 'text', text: keepAwakeText(state) }], structuredContent: { ...state } };
        }

        case 'pikvm_screenshot': {
          const settings = active.screenshot;
          const maxWidth = args.maxWidth === undefined
            ? settings.maxWidth
            : requireScreenshotInteger(args.maxWidth, 'maxWidth', 1, SCREENSHOT_DIMENSION_MAX);
          const maxHeight = args.maxHeight === undefined
            ? settings.maxHeight
            : requireScreenshotInteger(args.maxHeight, 'maxHeight', 1, SCREENSHOT_DIMENSION_MAX);
          const quality = args.quality === undefined
            ? settings.quality
            : requireScreenshotInteger(args.quality, 'quality', 1, 100);
          const region = parseRegion(args.region);
          const wake = validateBoolean(args.wake) === true;
          const shoot = () => deviceClient.screenshot({
            maxWidth,
            maxHeight,
            quality,
            region,
            ...(wake ? { signalWaitMs: WAKE_FIRST_WAIT_MS } : {}),
          });
          try {
            return { content: screenshotBlocks(await shoot()) };
          } catch (error) {
            if (!wake) throw error;
            const lead = await wakeDisplay(error);
            return { content: screenshotBlocks(await deviceClient.holdingCapture(shoot), lead) };
          }
        }

        case 'pikvm_wait_for': {
          const conditions = ['text', 'gone', 'changed', 'signal'].filter((key) => args[key] !== undefined);
          if (conditions.length !== 1) throw new Error('give exactly one of text, gone, changed or signal');
          const condition = conditions[0];
          const wanted = condition === 'text' || condition === 'gone' ? requireString(args[condition], condition) : '';
          if ((condition === 'changed' || condition === 'signal') && args[condition] !== true) {
            throw new Error(`${condition} must be true`);
          }
          const timeoutSeconds = requireIntegerIn(args.timeoutSeconds, 'timeoutSeconds', { default: 30, min: 1, max: 300 });
          const intervalMs = requireIntegerIn(args.intervalMs, 'intervalMs', { default: 1000, min: 250, max: 10_000 });
          const wake = validateBoolean(args.wake) === true;
          const box = parseOcrBox({ left: args.left, top: args.top, right: args.right, bottom: args.bottom });
          const started = Date.now();
          const deadline = started + timeoutSeconds * 1000;
          const left = () => Math.max(0, deadline - Date.now());
          let checks = 0;
          let woke = '';
          let wakeTried = false;
          let baseline: Buffer | null = null;
          let lastShot: ScreenshotResult | null = null;
          let lastText = '';
          // Each look gets only the time left, so the wait ends near its deadline.
          // A look that started in time and matched still counts.
          for (;;) {
            checks += 1;
            let matched = false;
            let at: { x: number; y: number } | undefined;
            try {
              if (condition === 'text' || condition === 'gone') {
                const ocr = await runOcr(box, Math.max(1000, left()));
                lastText = ocr.text;
                const present = normalizeText(ocr.text).includes(normalizeText(wanted));
                matched = condition === 'text' ? present : !present;
                if (condition === 'text' && present) {
                  const found = findTextMatches(ocr.words, wanted, ocr.crop);
                  if (found.length > 0) at = found[0].screen;
                }
              } else {
                lastShot = await deviceScreenshot(Math.max(250, left()));
                if (condition === 'signal') matched = true;
                else if (baseline === null) baseline = lastShot.buffer;
                else matched = (await changedShare(baseline, lastShot.buffer)) >= CHANGED_SHARE;
              }
            } catch (error) {
              // A dark screen is a look without an answer. With wake, one key
              // press at most; a wake that brings no picture does not end the wait.
              if (!(error instanceof KvmdError && error.type === 'PIKVM_NO_SIGNAL')) throw error;
              if (wake && !wakeTried && error.reason !== 'usb_offline' && left() > 0) {
                wakeTried = true;
                try {
                  woke = await wakeDisplay(error, Math.min(WAKE_SIGNAL_WAIT_MS, left()));
                } catch (wakeError) {
                  woke = `Wake did not bring a picture: ${wakeError instanceof Error ? wakeError.message : String(wakeError)}. `;
                }
              }
            }
            if (matched) {
              const seconds = ((Date.now() - started) / 1000).toFixed(1);
              const what = condition === 'text'
                ? `"${wanted}" is on screen${at ? ` at screen (${at.x}, ${at.y})` : ''}`
                : condition === 'gone' ? `"${wanted}" is gone` : condition === 'signal' ? 'there is a picture' : 'the screen changed';
              const shot = condition === 'signal' || condition === 'changed' ? lastShot! : await deviceScreenshot(1000);
              return { content: screenshotBlocks(shot, `${woke}Waited ${seconds} s (${checks} looks): ${what}. `) };
            }
            if (left() <= 0) break;
            await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, left())));
          }
          const details: Record<string, unknown> = { condition, checks, timeoutSeconds };
          if (condition === 'text' || condition === 'gone') details.lastText = lastText.slice(0, 2000);
          if (woke) details.wake = woke.trim();
          const missed = new IntentError(
            'PIKVM_WAIT_TIMEOUT',
            `${condition === 'text' ? `"${wanted}" did not appear` : condition === 'gone' ? `"${wanted}" did not go away`
              : condition === 'signal' ? 'no picture appeared' : 'the screen did not change'} within ${timeoutSeconds} s (${checks} looks)`,
            details,
          );
          const text = redactToolText(missed, fleet.passwords);
          let image: ResultBlock[] = [];
          try {
            // The last look's image, or one short look: the deadline has passed.
            image = screenshotBlocks(lastShot ?? await deviceScreenshot(250), 'Last look: ').slice(1);
          } catch {
            // No picture to show.
          }
          return { content: [{ type: 'text', text }, ...image], isError: true };
        }

        case 'pikvm_click_text': {
          const wanted = requireString(args.text, 'text');
          const box = parseOcrBox({ left: args.left, top: args.top, right: args.right, bottom: args.bottom });
          const button = validateEnum(args.button, ['left', 'right', 'middle'] as const, 'left');
          const ocr = await runOcr(box);
          if (ocr.engine !== 'host') {
            throw new IntentError('PIKVM_OCR_NO_WORDS', 'pikvm_click_text needs host OCR: kvmd OCR returns text without word positions');
          }
          const matches = findTextMatches(ocr.words, wanted, ocr.crop);
          const listed = matches.slice(0, 10).map((m, i) => ({ nth: i + 1, text: m.text, screen: m.screen }));
          if (matches.length === 0) {
            throw new IntentError('PIKVM_TEXT_NOT_FOUND', `"${wanted}" is not on screen`, { recognized: ocr.text.slice(0, 2000) });
          }
          let nth = 1;
          if (args.nth !== undefined) {
            nth = requireIntegerIn(args.nth, 'nth', { default: 1, min: 1, max: matches.length });
          } else if (matches.length > 1) {
            throw new IntentError(
              'PIKVM_TEXT_AMBIGUOUS',
              `"${wanted}" is on screen ${matches.length} times; pass nth to choose`,
              { matches: listed },
            );
          }
          const target = matches[nth - 1];
          await deviceClient.mouseMoveScreen(target.screen.x, target.screen.y);
          await deviceClient.mouseClick(button);
          if (validateBoolean(args.double) === true) await deviceClient.mouseClick(button);
          const clicked = `${validateBoolean(args.double) === true ? 'Double-clicked' : 'Clicked'} "${target.text}" `
            + `at screen (${target.screen.x}, ${target.screen.y})${matches.length > 1 ? ` (match ${nth} of ${matches.length})` : ''}.`;
          const blocks: ResultBlock[] = [{ type: 'text', text: clicked }];
          if (validateBoolean(args.observe) !== false) blocks.push(...await observeBlocks(observeDelay(OBSERVE_DELAY_MS)));
          return { content: blocks };
        }

        case 'pikvm_read_text': {
          const box = parseOcrBox({
            left: args.left,
            top: args.top,
            right: args.right,
            bottom: args.bottom,
          });
          const frameId = parseFrameId(args.frameId);
          const described = deviceClient.describeFrame(frameId);
          const calibration = deviceClient.getCalibration();
          const result = await executeOcr({
            deviceName: active.name,
            runtime: ocrRuntime,
            override: active.ocr,
            engineArg: parseOcrEngineArg(args.engine),
            langsArg: args.langs,
            box,
            frame: described.frame,
            frameId: described.echo.frameId,
            fullFrame: parseFullFrame(args.fullFrame),
            getSource: () => deviceClient.getResolution(true),
            calibration: calibration
              ? { factorX: calibration.factorX, factorY: calibration.factorY }
              : null,
            fetchSnapshot: (timeoutMs) => deviceClient.fetchFullSnapshot(timeoutMs),
            readKvmd: (langs) => deviceClient.readText({ langs, box, frameId }),
            ensureKvmd: async () => {
              let state = deviceClient.ocrState();
              if (state.status === 'unknown') state = await deviceClient.probeOcr(active.name);
              if (state.status !== 'enabled') throw new OcrUnavailableError(active.name);
              return state;
            },
          });
          const detail = validateEnum(args.detail, ['text', 'words'] as const, 'text');
          if (detail === 'words') {
            return { ...jsonText(result), structuredContent: { ...result } };
          }
          const { words: _words, ...summary } = result;
          const plain = {
            content: [{ type: 'text' as const, text: result.text === '' ? '(no text recognized)' : result.text }],
            structuredContent: { ...summary },
          };
          plainTextResults.add(plain);
          return plain;
        }

        case 'pikvm_get_resolution': {
          const resolution = await deviceClient.getResolution(true); // force refresh
          const last = deviceClient.describeFrame().echo;
          const mouse = last.width !== null && last.height !== null
            ? `Mouse x and y are pixels of the last screenshot (${last.width}x${last.height}), not screen pixels.`
            : 'Mouse x and y are pixels of the last screenshot, not screen pixels; take a screenshot first.';
          return {
            content: [
              {
                type: 'text',
                text: `Screen resolution: ${resolution.width}x${resolution.height} pixels. ${mouse}`,
              },
            ],
          };
        }

        case 'pikvm_type': {
          const text = requireString(args.text, 'text');
          const typed = await deviceClient.type(text, {
            keymap: validateString(args.keymap),
            slow: validateBoolean(args.slow),
            delay: validateNumber(args.delay, 0, 200),
          });
          // Don't echo full text in response to avoid leaking sensitive input
          const displayText = text.length > 50 ? `${text.substring(0, 50)}...` : text;
          typedQueuedMs = typed.queuedMs;
          // kvmd answers a fast print before it has typed it.
          const pending = typed.queuedMs >= 1000
            ? ` kvmd is still typing; it finishes in about ${Math.ceil(typed.queuedMs / 1000)} s.`
            : '';
          return {
            content: [{ type: 'text', text: `Typed ${text.length} character(s): "${displayText}".${pending}` }],
          };
        }

        case 'pikvm_key': {
          const key = requireString(args.key, 'key');
          const modifiers = validateStringArray(args.modifiers);
          const state = validateEnum(args.state, VALID_KEY_STATES, 'click');

          // Press modifiers
          for (const mod of modifiers) {
            await deviceClient.sendKey(mod, { state: true });
          }

          // Send main key
          if (state === 'press') {
            await deviceClient.sendKey(key, { state: true });
          } else if (state === 'release') {
            await deviceClient.sendKey(key, { state: false });
          } else {
            await deviceClient.sendKey(key); // click
          }

          // Release modifiers (in reverse order)
          for (const mod of [...modifiers].reverse()) {
            await deviceClient.sendKey(mod, { state: false });
          }

          return {
            content: [
              {
                type: 'text',
                text: modifiers.length > 0
                  ? `Sent key: ${modifiers.join('+')}+${key}`
                  : `Sent key: ${key}`,
              },
            ],
          };
        }

        case 'pikvm_shortcut': {
          const keys = requireStringArray(args.keys, 'keys', 1);
          if (keys.length > 10) {
            throw new Error('keys array must have at most 10 elements');
          }
          await deviceClient.sendShortcut(keys);
          return {
            content: [{ type: 'text', text: `Sent shortcut: ${keys.join('+')}` }],
          };
        }

        case 'pikvm_mouse_move': {
          const x = requireNumber(args.x, 'x');
          const y = requireNumber(args.y, 'y');
          const relative = validateBoolean(args.relative) ?? false;
          const frameId = parseFrameId(args.frameId);
          const described = deviceClient.describeFrame(frameId);
          let calibrationWarning = '';
          if (relative) {
            // Relative moves are clamped to -127 to 127 in the client.
            // The frame is checked and echoed, and the delta is not scaled.
            await deviceClient.mouseMoveRelative(x, y);
          } else {
            // Absolute moves should be positive pixel coordinates
            const clampedX = Math.max(0, Math.round(x));
            const clampedY = Math.max(0, Math.round(y));
            const result = await deviceClient.mouseMove(clampedX, clampedY, described);
            if (result.calibrationInvalidated) {
              calibrationWarning = '\n⚠️ Resolution changed - calibration has been cleared. Recalibrate with pikvm_auto_calibrate (preferred) or pikvm_calibrate.';
            }
          }
          return {
            content: [
              {
                type: 'text',
                text: withFrame((relative
                  ? `Moved mouse by (${x}, ${y})`
                  : `Moved mouse to pixel (${Math.max(0, Math.round(x))}, ${Math.max(0, Math.round(y))})`) + calibrationWarning, described.echo),
              },
            ],
          };
        }

        case 'pikvm_mouse_click': {
          const button = validateEnum(args.button, VALID_BUTTONS, 'left');
          const clickX = validateNumber(args.x, 0);
          const clickY = validateNumber(args.y, 0);
          const frameId = parseFrameId(args.frameId);
          const described = deviceClient.describeFrame(frameId);

          // Move to position first if specified. Same resolved frame as the echo.
          if (clickX !== undefined && clickY !== undefined) {
            await deviceClient.mouseMove(Math.round(clickX), Math.round(clickY), described);
          }

          const state = validateEnum(args.state, VALID_KEY_STATES, 'click');
          if (state === 'press') {
            await deviceClient.mouseClick(button, { state: true });
          } else if (state === 'release') {
            await deviceClient.mouseClick(button, { state: false });
          } else {
            await deviceClient.mouseClick(button);
          }

          return {
            content: [{ type: 'text', text: withFrame(`${button} click`, described.echo) }],
          };
        }

        case 'pikvm_mouse_scroll': {
          const deltaY = requireNumber(args.deltaY, 'deltaY');
          const deltaX = validateNumber(args.deltaX) ?? 0;
          const frameId = parseFrameId(args.frameId);
          const described = deviceClient.describeFrame(frameId);
          await deviceClient.mouseScroll(deltaX, deltaY);
          return {
            content: [
              {
                type: 'text',
                text: withFrame(`Scrolled (${deltaX}, ${deltaY})`, described.echo),
              },
            ],
          };
        }

        case 'pikvm_calibrate': {
          const result = await deviceClient.calibrate();
          return {
            content: [
              {
                type: 'text',
                text: `Calibration started.\n` +
                  `Resolution: ${result.resolution.width}x${result.resolution.height}\n` +
                  `Expected cursor position: (${result.expectedPosition.x}, ${result.expectedPosition.y})\n` +
                  `Normalized coordinates sent: (${result.requestedNormalized.x}, ${result.requestedNormalized.y})\n\n` +
                  `${result.message}`,
              },
            ],
          };
        }

        case 'pikvm_set_calibration': {
          const factorX = requireNumber(args.factorX, 'factorX');
          const factorY = requireNumber(args.factorY, 'factorY');
          deviceClient.setCalibrationFactors(factorX, factorY);
          const calibration = deviceClient.getCalibration();
          return {
            content: [
              {
                type: 'text',
                text: `Calibration set: factorX=${factorX.toFixed(4)}, factorY=${factorY.toFixed(4)}\n` +
                  `Resolution at calibration: ${calibration?.resolution.width}x${calibration?.resolution.height}\n` +
                  `Note: Calibration will be automatically cleared if resolution changes.`,
              },
            ],
          };
        }

        case 'pikvm_get_calibration': {
          const calibration = deviceClient.getCalibration();
          if (calibration) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Current calibration:\n` +
                    `  factorX: ${calibration.factorX.toFixed(4)}\n` +
                    `  factorY: ${calibration.factorY.toFixed(4)}\n` +
                    `  Resolution at calibration: ${calibration.resolution.width}x${calibration.resolution.height}`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Not calibrated. Mouse coordinates use default 1.0 factor (no correction).',
                },
              ],
            };
          }
        }

        case 'pikvm_clear_calibration': {
          deviceClient.clearCalibration();
          return {
            content: [
              {
                type: 'text',
                text: 'Calibration cleared. Mouse coordinates now use default 1.0 factor (no correction).',
              },
            ],
          };
        }

        case 'pikvm_auto_calibrate': {
          if (deviceLock.isBusy) {
            return {
              content: [{ type: 'text', text: 'Auto-calibration is already in progress.' }],
              isError: true,
            };
          }

          deviceLock.acquire('Auto-calibration');
          try {
            const result = await autoCalibrateWithRetries(deviceClient, {
              rounds: validateNumber(args.rounds, 2, 20) ?? deps.calibrationConfig.rounds,
              verifyRounds: validateNumber(args.verifyRounds, 1, 20) ?? deps.calibrationConfig.verifyRounds,
              moveDelayMs: validateNumber(args.moveDelayMs, 50, 2000) ?? deps.calibrationConfig.moveDelayMs,
              mergeRadius: validateNumber(args.mergeRadius, 0, 200),
              minSamples: validateNumber(args.minSamples, 1, 20),
              maxRatioDivergence: validateNumber(args.maxRatioDivergence, 0, 1),
              verbose: validateBoolean(args.verbose),
            });

            return {
              content: [
                {
                  type: 'text',
                  text: `Auto-calibration ${result.success ? 'succeeded' : 'failed'}.\n` +
                    `Resolution: ${result.resolution.width}x${result.resolution.height}\n` +
                    `Factors: X=${result.factorX.toFixed(4)}, Y=${result.factorY.toFixed(4)}\n` +
                    `Confidence: ${(result.confidence * 100).toFixed(0)}%\n` +
                    `Verification score: ${result.verificationScore}\n` +
                    `Valid samples: ${result.validSamples}/${result.totalRounds}\n\n` +
                    result.message,
                },
              ],
            };
          } finally {
            deviceLock.release();
          }
        }

        case 'pikvm_msd_status': {
          const state = await active.client.getMsdState();
          return jsonText(publicMsdState(state));
        }

        case 'pikvm_msd_mount': {
          const image = requireString(args.image, 'image');
          const confirmImage = requireString(args.confirmImage, 'confirmImage');
          const mode = requireEnum(args.mode, ['cdrom', 'flash'] as const, 'mode');
          const rw = args.rw === undefined ? false : requireBoolean(args.rw, 'rw');
          const connect = args.connect === undefined ? true : requireBoolean(args.connect, 'connect');
          const expectImage = args.expectImage === undefined
            ? undefined
            : requireText(args.expectImage, 'expectImage');
          const outcome = await mountMsd(active.client, {
            device: active.name,
            image,
            confirmImage,
            mode,
            rw,
            connect,
            expectImage,
          });
          if ('error' in outcome) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
              isError: true,
            };
          }
          return jsonText(outcome);
        }

        case 'pikvm_msd_eject': {
          const expectImage = requireText(args.expectImage, 'expectImage');
          const outcome = await ejectMsd(active.client, expectImage, active.name);
          return jsonText(outcome);
        }

        case 'pikvm_msd_upload': {
          const localDir = active.msdLocalDir ?? deps.msd?.localDir;
          if (!localDir) {
            throw new Error('pikvm_msd_upload is unavailable until PIKVM_MSD_LOCAL_DIR is set');
          }
          const file = requireString(args.file, 'file');
          const confirmImage = requireString(args.confirmImage, 'confirmImage');
          const sha256 = args.sha256 === undefined ? undefined : requireString(args.sha256, 'sha256');
          const outcome = await startMsdUpload(active.client, {
            device: active.name,
            localDir,
            maxBytes: deps.msd?.maxBytes ?? MSD_MAX_BYTES_DEFAULT,
            extensions: deps.msd?.extensions ?? MSD_EXTENSIONS_DEFAULT,
            file,
            confirmImage,
            sha256,
            beforeHash: deps.msd?.beforeHash,
            beforeUploadStream: deps.msd?.beforeUploadStream,
            beforeSlotRelease: deps.msd?.beforeSlotRelease,
            closeFile: deps.msd?.closeFile,
            uploadPollMs: deps.msd?.uploadPollMs,
            jobLimit: deps.msd?.jobLimit,
            jobTtlMs: deps.msd?.jobTtlMs,
            readyTimeoutMs: deps.msd?.readyTimeoutMs,
          });
          return jsonText(outcome);
        }

        case 'pikvm_msd_fetch_url': {
          const allow = deps.msd?.urlAllow;
          if (!allow || allow.entries.length === 0) {
            throw new Error('pikvm_msd_fetch_url is unavailable until PIKVM_MSD_URL_ALLOWLIST is set');
          }
          const url = requireString(args.url, 'url');
          const confirmImage = requireString(args.confirmImage, 'confirmImage');
          const image = args.image === undefined ? undefined : requireString(args.image, 'image');
          const outcome = await startMsdFetch(active.client, {
            device: active.name,
            url,
            image,
            confirmImage,
            extensions: deps.msd?.extensions ?? MSD_EXTENSIONS_DEFAULT,
            allow,
            allowPrivate: deps.msd?.allowPrivate === true,
            connectTimeoutSec: deps.msd?.connectTimeoutSec ?? MSD_URL_CONNECT_TIMEOUT_DEFAULT_SEC,
            resolveUrl: deps.msd?.resolveUrl,
            beforeFetch: deps.msd?.beforeFetch,
            jobLimit: deps.msd?.jobLimit,
            jobTtlMs: deps.msd?.jobTtlMs,
            readyTimeoutMs: deps.msd?.readyTimeoutMs,
          });
          return jsonText(outcome);
        }

        case 'pikvm_msd_job': {
          const jobId = requireString(args.jobId, 'jobId');
          const job = readMsdJob(jobId, {
            device: active.name,
            jobLimit: deps.msd?.jobLimit,
            jobTtlMs: deps.msd?.jobTtlMs,
          });
          if (!job) throw new Error('unknown job');
          return jsonText(job);
        }

        case 'pikvm_msd_remove': {
          const image = requireString(args.image, 'image');
          const confirmImage = requireString(args.confirmImage, 'confirmImage');
          const outcome = await removeMsd(active.client, image, confirmImage, active.name);
          return jsonText(outcome);
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      })().then(async (result) => {
        // observe: the screenshot after the action, in the same call.
        const failed = (result as { isError?: boolean }).isError === true;
        if (!OBSERVE_TOOLS.has(name) || validateBoolean(args.observe) !== true || failed) return result;
        const settle = name === 'pikvm_type'
          ? Math.min(OBSERVE_TYPE_MAX_MS, Math.max(OBSERVE_DELAY_MS, typedQueuedMs + 250))
          : OBSERVE_DELAY_MS;
        const content = [...((result as { content?: ResultBlock[] }).content ?? []), ...await observeBlocks(observeDelay(settle))];
        return { ...result, content };
      }).finally(() => {
        if (suspends) active.client.keepAwake.callEnded();
      });
      return tagFleetResult(produced, active, fleet.registryActive);
    } catch (error) {
      // A next step must act on the device that failed, not the default one.
      if (error instanceof KvmdError && error.next && ctx && fleet.registryActive) {
        error.next = { ...error.next, args: { ...error.next.args, device: ctx.name } };
      }
      return tagFleetResult({
        content: [{ type: 'text' as const, text: redactToolText(error, fleet.passwords) }],
        ...(error instanceof KvmdError
          ? { structuredContent: { error: kvmdErrorDetails(error, fleet.passwords[0] ?? '', fleet.passwords.slice(1)) } }
          : {}),
        isError: true as const,
      }, ctx, fleet.registryActive);
    }
  });

  return server;
}
