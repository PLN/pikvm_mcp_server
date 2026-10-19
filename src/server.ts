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

/**
 * MCP server factory for PiKVM tools
 *
 * Builds a fresh MCP Server instance with all tool/prompt handlers registered.
 * stdio mode uses one instance; each HTTP session gets its own (per the
 * Streamable HTTP session model), sharing the single PiKVMClient and BusyLock
 * below them.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { type PiKVMClient, type FrameEcho, KvmdError, redactionPassword } from './pikvm/client.js';
import { redactSecrets } from './redact.js';
import type { BusyLock } from './pikvm/lock.js';
import { type Fleet, type FleetDevice, resolveFleetDevice } from './devices.js';
import {
  defaultScreenshotSettings,
  OcrUnavailableError,
  UnknownFrameError,
  parseOcrBox,
  parseOcrLangs,
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
}

/**
 * MsdConfig plus optional knobs the production entrypoint leaves unset.
 * Tests use them to pause a job, shorten the uploading poll, and cap jobs.
 */
export interface MsdServerConfig extends MsdConfig {
  beforeHash?: () => Promise<void>;
  beforeUploadStream?: () => Promise<void>;
  beforeSlotRelease?: () => Promise<void>;
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
 * MsdExpectImageError names the connected image. MsdImageTransferError
 * names the image with an active transfer. MsdPreflightError,
 * MsdUploadBusyError, and MsdUrlPolicyError keep their type. URL userinfo
 * is removed from every message. Other errors stay `Error: <message>`.
 */
export function formatToolError(error: unknown, password = ''): string {
  const redact = (value: string) => redactUrl(redactSecrets(value, password));
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
  if (error instanceof KvmdError) {
    const message = redact(error.message);
    const endpoint = redact(error.endpoint);
    const type = redact(error.type);
    const summary = `Error [${type}] ${endpoint} (HTTP ${error.status}): ${message}`;
    const details = JSON.stringify({
      status: error.status,
      type,
      message,
      endpoint,
    });
    // Fields are already redacted. A second pass over the JSON would treat
    // the closing quote as part of X-KVMD-Passwd=[REDACTED] and break the block.
    return `${summary}\n${details}`;
  }
  if (error instanceof Error) {
    return `Error: ${redact(error.message)}`;
  }
  return 'Error: An unexpected error occurred';
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
  let text = formatToolError(error, passwords[0] ?? '');
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

function tagFleetResult<T extends { content?: Array<{ type?: string; text?: string }> }>(
  result: T,
  ctx: FleetDevice | undefined,
  registryActive: boolean,
): T {
  if (!registryActive || !ctx) return result;
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
  if (trimmed.startsWith('{')) {
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

// Define available tools
const tools: Tool[] = [
  {
    name: 'pikvm_screenshot',
    description: 'Capture a screenshot from the PiKVM video stream. Returns a JPEG plus coordinate metadata, including frameId. Defaults are PIKVM_SCREENSHOT_MAX_WIDTH 960, PIKVM_SCREENSHOT_MAX_HEIGHT 600, and PIKVM_SCREENSHOT_QUALITY 70, unless the device registry sets screenshot. A per-call value wins. region crops the captured image locally and must lie inside it. The default click frame is the last full preview, in request order rather than completion order. A crop does not change it. Pass that capture\'s frameId to a mouse tool to click in the crop.',
    inputSchema: {
      type: 'object',
      properties: {
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
    description: 'Read text from the PiKVM screen with kvmd OCR (GET /streamer/snapshot?ocr=1). Listed while any device is enabled or not yet probed. A disabled device returns PIKVM_OCR_UNAVAILABLE and does not fetch an image. Slow on small boards. langs must be a language that device reported. left, top, right, and bottom are an optional box in preview-frame pixels (the default click frame, or frameId). They are converted to full resolution for kvmd. Text is capped at 64 KiB.',
    inputSchema: {
      type: 'object',
      properties: {
        langs: {
          type: 'string',
          description: 'Comma-separated OCR languages, each one reported by the device. Omitted uses the kvmd default.',
        },
        left: { type: 'number', description: 'Left edge of the OCR box in preview-frame pixels.' },
        top: { type: 'number', description: 'Top edge of the OCR box in preview-frame pixels.' },
        right: { type: 'number', description: 'Right edge of the OCR box in preview-frame pixels.' },
        bottom: { type: 'number', description: 'Bottom edge of the OCR box in preview-frame pixels.' },
        frameId: {
          type: 'string',
          description: 'Capture whose pixels the box is in. Omitted uses the default click frame. Unknown sends no OCR request.',
        },
      },
    },
  },
  {
    name: 'pikvm_get_resolution',
    description: 'Get the current screen resolution of the remote machine. Useful for knowing valid coordinate ranges for mouse operations.',
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
    description: 'Move the mouse cursor. Absolute coordinates are pixels in the default click frame, which is the last full preview in request order. Pass frameId to use that capture, including a crop: the point is mapped with that frame\'s scale, crop origin, and calibration. An unknown, evicted, or other-device frameId is PIKVM_UNKNOWN_FRAME and sends no HID event. Relative deltas are clamped to -127 to 127 and are not mapped through the frame. The result echoes frameId or default, width, height, scale, and origin.',
    inputSchema: {
      type: 'object',
      properties: {
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
    description: 'Click a mouse button. Optional x and y are pixels in the default click frame (the last full preview, in request order). Pass frameId to move in that capture, including a crop. An unknown, evicted, or other-device frameId is PIKVM_UNKNOWN_FRAME and sends no HID event. The result echoes frameId or default, width, height, scale, and origin.',
    inputSchema: {
      type: 'object',
      properties: {
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
          description: 'Device name. Ignored until more than one device exists; the server uses the single configured device.',
        },
      },
    },
  },
  {
    name: 'pikvm_msd_mount',
    description: 'Select a mass-storage image and, by default, connect the virtual drive. confirmImage must equal image. Refuses while that image has an active upload or fetch, and makes no POST. When a drive is already connected, expectImage must equal that image name or the mount is refused and nothing is ejected. mode is cdrom or flash. rw is for flash and defaults to false; kvmd may force rw false, and the returned drive is a re-read after the change. On failure the previous drive selection is restored. An NBD or URL image in that snapshot cannot be restored, because set_params refuses names containing ://.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Device name. Ignored until more than one device exists.',
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
    description: 'Disconnect the virtual drive. expectImage must equal the current drive image name, or an empty string when none is selected. Safe to repeat: a second eject returns alreadyDisconnected.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Device name. Ignored until more than one device exists.',
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
    description: 'Upload a local image into PiKVM storage and return a jobId immediately after the file is confined. Hashing and the kvmd pre-check run in the job, which is hashing, then running, then awaiting_catalog. A sha256 mismatch fails the job and uploads nothing. After kvmd accepts the bytes the job waits for that image to be present, complete, and the expected size. PIKVM_MSD_CATALOG_TIMEOUT means the write was accepted and the image may still appear. PIKVM_MSD_IMAGE_INCOMPLETE means the row stayed incomplete until the deadline. PIKVM_MSD_SIZE_MISMATCH means a complete row has the wrong size and fails at once. PIKVM_MSD_CANCELLED means the wait was cancelled. PIKVM_MSD_REMOVAL_UNCONFIRMED means cleanup could not prove the image is gone. The upload POST is not repeated. A second upload while one is running is refused. file is a bare name under PIKVM_MSD_LOCAL_DIR. confirmImage must equal file. The drive is not changed. Poll pikvm_msd_job. Hidden while PIKVM_MSD_LOCAL_DIR is unset.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Device name. Ignored until more than one device exists.',
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
    description: 'Download an image from an allowlisted https URL into PiKVM storage and return a jobId immediately. The URL must be https, have no userinfo, and match PIKVM_MSD_URL_ALLOWLIST. image defaults to the last path segment. confirmImage must equal the final name. DNS, the address check, the kvmd pre-check, and the download run in the job. After write_remote accepts the bytes the job waits for that image to be complete in the catalog, with the same PIKVM_MSD_CATALOG_TIMEOUT, PIKVM_MSD_IMAGE_INCOMPLETE, PIKVM_MSD_SIZE_MISMATCH, PIKVM_MSD_CANCELLED, and PIKVM_MSD_REMOVAL_UNCONFIRMED results as an upload. The remote write is not repeated. A second transfer while one is running is refused. The drive is not changed. Poll pikvm_msd_job. Hidden while the allowlist has no https entry.',
    inputSchema: {
      type: 'object',
      properties: {
        device: {
          type: 'string',
          description: 'Device name. Ignored until more than one device exists.',
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
          description: 'Device name. Ignored until more than one device exists.',
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
 * `deps` are shared across all instances (one PiKVM device, one busy-lock);
 * per-HTTP-session instances exist to satisfy the Streamable HTTP session
 * model, which requires one transport (and therefore one Server) per session.
 */
export function createMcpServer(deps: McpServerDeps): Server {
  const fleet = deps.fleet ?? implicitFleet(deps);
  const server = new Server(
    {
      name: 'pikvm-mcp-server',
      version: '0.2.0',
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
        // Probes run after listen, so startup sees unknown. Hide the tool
        // only once every device has reported disabled. A call still
        // returns PIKVM_OCR_UNAVAILABLE when that device is disabled.
        return [...fleet.devices.values()].some((device) => {
          const status = device.client.ocrState().status;
          return status === 'enabled' || status === 'unknown';
        });
      }
      return true;
    });
    return { tools: visible };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let ctx: FleetDevice | undefined;
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

      const produced = await (async () => {
      switch (name) {
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
          const result = await deviceClient.screenshot({ maxWidth, maxHeight, quality, region });
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

          let infoText = `Screenshot captured (${result.screenshotWidth}x${result.screenshotHeight}`;
          if (result.scaleX !== 1 || result.scaleY !== 1) {
            infoText += `, scaled from ${result.actualWidth}x${result.actualHeight}`;
            infoText += `, scale factor: ${result.scaleX.toFixed(2)}x${result.scaleY.toFixed(2)}`;
          }
          infoText += result.region
            ? '). This crop does not change the default click frame. Pass frameId to click in this image.'
            : '). This full preview is the default click frame, in request order.';
          infoText += `\n${JSON.stringify(meta)}`;

          return {
            content: [
              {
                type: 'text',
                text: infoText,
              },
              {
                type: 'image',
                data: result.buffer.toString('base64'),
                mimeType: 'image/jpeg',
              },
            ],
          };
        }

        case 'pikvm_read_text': {
          let ocr = deviceClient.ocrState();
          if (ocr.status === 'unknown') {
            ocr = await deviceClient.probeOcr(active.name);
          }
          if (ocr.status !== 'enabled') {
            throw new OcrUnavailableError(active.name);
          }
          const langs = parseOcrLangs(args.langs, ocr.langs, active.name);
          const box = parseOcrBox({
            left: args.left,
            top: args.top,
            right: args.right,
            bottom: args.bottom,
          });
          const frameId = parseFrameId(args.frameId);
          const text = await deviceClient.readText({ langs, box, frameId });
          return {
            content: [{ type: 'text', text }],
          };
        }

        case 'pikvm_get_resolution': {
          const resolution = await deviceClient.getResolution(true); // force refresh
          return {
            content: [
              {
                type: 'text',
                text: `Screen resolution: ${resolution.width}x${resolution.height} pixels. Valid mouse coordinates: x=0-${resolution.width - 1}, y=0-${resolution.height - 1}`,
              },
            ],
          };
        }

        case 'pikvm_type': {
          const text = requireString(args.text, 'text');
          await deviceClient.type(text, {
            keymap: validateString(args.keymap),
            slow: validateBoolean(args.slow),
            delay: validateNumber(args.delay, 0, 200),
          });
          // Don't echo full text in response to avoid leaking sensitive input
          const displayText = text.length > 50 ? `${text.substring(0, 50)}...` : text;
          return {
            content: [{ type: 'text', text: `Typed ${text.length} character(s): "${displayText}"` }],
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
      })();
      return tagFleetResult(produced, active, fleet.registryActive);
    } catch (error) {
      return tagFleetResult({
        content: [{ type: 'text' as const, text: redactToolText(error, fleet.passwords) }],
        isError: true as const,
      }, ctx, fleet.registryActive);
    }
  });

  return server;
}
