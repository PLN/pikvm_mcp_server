// Modified 2026-10 by PLN: screenshot defaults, crop bounds, and OCR state (GPL-3.0; see NOTICE).

/**
 * Preview defaults, crop checks, and OCR state for one device.
 * Cropping with sharp().extract follows the technique in
 * dvaerum/pikvm_mcp_server src/pikvm/snapshot.ts at 2d6fa16 (GPL-3.0).
 * This file is written fresh. No other code from that file was copied.
 */

export const SCREENSHOT_DEFAULT_MAX_WIDTH = 960;
export const SCREENSHOT_DEFAULT_MAX_HEIGHT = 600;
export const SCREENSHOT_DEFAULT_QUALITY = 70;
export const SCREENSHOT_DIMENSION_MAX = 10000;
export const OCR_PROBE_TIMEOUT_MS = 2000;

export interface ScreenshotSettings {
  maxWidth: number;
  maxHeight: number;
  quality: number;
}

export interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type OcrStatus = 'enabled' | 'disabled' | 'unknown';

export interface OcrState {
  status: OcrStatus;
  langs: string[];
}

export class OcrUnavailableError extends Error {
  readonly type: string;

  constructor(device: string) {
    super(`OCR is not available on device ${JSON.stringify(device)}`);
    this.name = 'OcrUnavailableError';
    this.type = 'PIKVM_OCR_UNAVAILABLE';
  }
}

export function defaultScreenshotSettings(): ScreenshotSettings {
  return {
    maxWidth: SCREENSHOT_DEFAULT_MAX_WIDTH,
    maxHeight: SCREENSHOT_DEFAULT_MAX_HEIGHT,
    quality: SCREENSHOT_DEFAULT_QUALITY,
  };
}

function integerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function envInteger(name: string, raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Environment defaults. An empty value is the built-in default. */
export function parseScreenshotEnv(env: NodeJS.ProcessEnv = process.env): ScreenshotSettings {
  return {
    maxWidth: envInteger(
      'PIKVM_SCREENSHOT_MAX_WIDTH',
      env.PIKVM_SCREENSHOT_MAX_WIDTH,
      1,
      SCREENSHOT_DIMENSION_MAX,
      SCREENSHOT_DEFAULT_MAX_WIDTH,
    ),
    maxHeight: envInteger(
      'PIKVM_SCREENSHOT_MAX_HEIGHT',
      env.PIKVM_SCREENSHOT_MAX_HEIGHT,
      1,
      SCREENSHOT_DIMENSION_MAX,
      SCREENSHOT_DEFAULT_MAX_HEIGHT,
    ),
    quality: envInteger(
      'PIKVM_SCREENSHOT_QUALITY',
      env.PIKVM_SCREENSHOT_QUALITY,
      1,
      100,
      SCREENSHOT_DEFAULT_QUALITY,
    ),
  };
}

const SCREENSHOT_KEYS = ['maxWidth', 'maxHeight', 'quality'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Optional registry screenshot object. Omitted fields stay unset so the
 * environment default applies. Unknown keys are an error.
 */
export function parseScreenshotOverride(device: string, raw: unknown): Partial<ScreenshotSettings> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new Error(`device ${device} screenshot: must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!SCREENSHOT_KEYS.includes(key as typeof SCREENSHOT_KEYS[number])) {
      throw new Error(`device ${device} screenshot: unknown field ${JSON.stringify(key)}`);
    }
  }
  const out: Partial<ScreenshotSettings> = {};
  if (raw.maxWidth !== undefined) {
    if (!integerInRange(raw.maxWidth, 1, SCREENSHOT_DIMENSION_MAX)) {
      throw new Error(`device ${device} screenshot.maxWidth: must be an integer from 1 to ${SCREENSHOT_DIMENSION_MAX}`);
    }
    out.maxWidth = raw.maxWidth as number;
  }
  if (raw.maxHeight !== undefined) {
    if (!integerInRange(raw.maxHeight, 1, SCREENSHOT_DIMENSION_MAX)) {
      throw new Error(`device ${device} screenshot.maxHeight: must be an integer from 1 to ${SCREENSHOT_DIMENSION_MAX}`);
    }
    out.maxHeight = raw.maxHeight as number;
  }
  if (raw.quality !== undefined) {
    if (!integerInRange(raw.quality, 1, 100)) {
      throw new Error(`device ${device} screenshot.quality: must be an integer from 1 to 100`);
    }
    out.quality = raw.quality as number;
  }
  return out;
}

export function mergeScreenshot(base: ScreenshotSettings, override: Partial<ScreenshotSettings>): ScreenshotSettings {
  return {
    maxWidth: override.maxWidth ?? base.maxWidth,
    maxHeight: override.maxHeight ?? base.maxHeight,
    quality: override.quality ?? base.quality,
  };
}

export function requireScreenshotInteger(value: unknown, field: string, min: number, max: number): number {
  if (!integerInRange(value, min, max)) {
    throw new Error(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

const REGION_KEYS = ['x', 'y', 'width', 'height'] as const;

/** Per-call crop. Bounds against the captured image are checked after the fetch. */
export function parseRegion(raw: unknown): ScreenshotRegion | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new Error('region must be an object');
  for (const key of Object.keys(raw)) {
    if (!REGION_KEYS.includes(key as typeof REGION_KEYS[number])) {
      throw new Error(`region: unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of REGION_KEYS) {
    if (raw[key] === undefined) throw new Error(`region.${key} is required`);
  }
  const x = requireScreenshotInteger(raw.x, 'region.x', 0, SCREENSHOT_DIMENSION_MAX);
  const y = requireScreenshotInteger(raw.y, 'region.y', 0, SCREENSHOT_DIMENSION_MAX);
  const width = requireScreenshotInteger(raw.width, 'region.width', 1, SCREENSHOT_DIMENSION_MAX);
  const height = requireScreenshotInteger(raw.height, 'region.height', 1, SCREENSHOT_DIMENSION_MAX);
  return { x, y, width, height };
}

export function assertRegionInside(region: ScreenshotRegion, width: number, height: number): void {
  if (region.x + region.width > width || region.y + region.height > height) {
    throw new Error(
      `region ${region.x},${region.y} ${region.width}x${region.height} is outside the captured image (${width}x${height})`,
    );
  }
}

/** Languages kvmd should use. Omitted means kvmd's default list. */
export function parseOcrLangs(raw: unknown, available: readonly string[], device: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`langs must be a comma-separated list of languages on device ${JSON.stringify(device)}`);
  }
  const langs = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (langs.length === 0) {
    throw new Error(`langs must be a comma-separated list of languages on device ${JSON.stringify(device)}`);
  }
  for (const lang of langs) {
    if (!available.includes(lang)) {
      throw new Error(`OCR language ${JSON.stringify(lang)} is not available on device ${JSON.stringify(device)}`);
    }
  }
  return langs;
}

/** OCR box in image pixels. Omitted means the whole image. */
export function parseOcrBox(args: {
  left?: unknown;
  top?: unknown;
  right?: unknown;
  bottom?: unknown;
}): OcrBox | undefined {
  const present = [args.left, args.top, args.right, args.bottom].filter((value) => value !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== 4) {
    throw new Error('OCR box requires left, top, right, and bottom');
  }
  const left = requireScreenshotInteger(args.left, 'left', 0, SCREENSHOT_DIMENSION_MAX);
  const top = requireScreenshotInteger(args.top, 'top', 0, SCREENSHOT_DIMENSION_MAX);
  const right = requireScreenshotInteger(args.right, 'right', 0, SCREENSHOT_DIMENSION_MAX);
  const bottom = requireScreenshotInteger(args.bottom, 'bottom', 0, SCREENSHOT_DIMENSION_MAX);
  if (right <= left || bottom <= top) {
    throw new Error('OCR box must have right greater than left and bottom greater than top');
  }
  return { left, top, right, bottom };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/** kvmd GET /streamer/ocr. A body that is not the documented shape is unknown. */
export function parseOcrState(body: unknown): OcrState {
  if (body === null || typeof body !== 'object') return { status: 'unknown', langs: [] };
  const result = (body as { result?: unknown }).result;
  const ocr = result !== null && typeof result === 'object'
    ? (result as { ocr?: unknown }).ocr
    : undefined;
  if (ocr === null || typeof ocr !== 'object') return { status: 'unknown', langs: [] };
  const enabled = (ocr as { enabled?: unknown }).enabled;
  const langs = (ocr as { langs?: unknown }).langs;
  const available = langs !== null && typeof langs === 'object'
    ? stringList((langs as { available?: unknown }).available)
    : [];
  if (enabled === true) return { status: 'enabled', langs: available };
  if (enabled === false) return { status: 'disabled', langs: available };
  return { status: 'unknown', langs: [] };
}
