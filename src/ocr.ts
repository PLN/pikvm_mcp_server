// Modified 2026-10 by PLN: host OCR with the system tesseract binary (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the OCR remaining budget is monotonic (GPL-3.0; see NOTICE).

/**
 * Host OCR. The recognizer is the tesseract binary on PATH, or
 * PIKVM_OCR_TESSERACT_BIN. tesseract.js is not used. Traineddata and
 * Leptonica stay operating-system packages and are not vendored.
 * An unset PIKVM_OCR_ENGINE uses host when the startup probe finds the
 * binary, and is off otherwise. kvmd is never that default and is never
 * called because host failed.
 */

import { execFile } from 'node:child_process';
import { pixelToNormalized } from './pikvm/client.js';
import type { ClickFrame } from './pikvm/client.js';
import {
  capOcrText,
  limitedSharp,
  OCR_PROBE_TIMEOUT_MS,
  OCR_TEXT_MAX_BYTES,
  ocrBoxToSource,
  parseOcrLangs,
  parseOcrTimeoutMs,
  OcrUnavailableError,
  type OcrBox,
  type OcrState,
} from './screenshot.js';

/** Default crop cap. A larger region needs fullFrame and the allow flag. */
export const OCR_MAX_PIXELS_DEFAULT = 1_048_576;
/** fullFrame ceiling, about 8.3 megapixels (3840×2160 is 8,294,400). */
export const OCR_FULL_FRAME_MAX_PIXELS = 8_300_000;
export const OCR_MIN_CONF_DEFAULT = 60;
export const OCR_MAX_CONCURRENCY_DEFAULT = 1;
export const OCR_WORD_CAP = 2000;
export const OCR_MAX_BUFFER = 8 * 1024 * 1024;
export const OCR_DEFAULT_PSM = 6;

const LANG_TOKEN = /^[a-z_]+$/;
const LANG_ARG = /^[a-z_]+(\+[a-z_]+)*$/;

export type OcrEngineName = 'off' | 'host' | 'kvmd';
export type OcrRequested = 'unset' | OcrEngineName;

export interface OcrWordBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One word from a recognizer. block, par, and line rebuild the text. */
export interface OcrEngineWord {
  text: string;
  conf: number;
  bbox: OcrWordBox;
  block: number;
  par: number;
  line: number;
}

export interface OcrEngine {
  recognize(
    png: Buffer,
    options: { langs: string; psm: number; signal: AbortSignal },
  ): Promise<{ words: OcrEngineWord[] }>;
}

export class OcrError extends Error {
  readonly type: string;
  readonly engine: 'host' | 'kvmd';

  constructor(type: string, message: string, engine: 'host' | 'kvmd' = 'host') {
    super(message);
    this.name = 'OcrError';
    this.type = type;
    this.engine = engine;
  }
}

export interface OcrSettings {
  requested: OcrRequested;
  bin: string;
  tessdataDir?: string;
  langs: string[];
  maxConcurrency: number;
  timeoutMs: number;
  maxPixels: number;
  allowFullFrame: boolean;
  minConf: number;
}

/** A device may only narrow the process. host and the binary stay process-wide. */
export interface DeviceOcrOverride {
  engine?: 'off' | 'kvmd';
  langs?: string[];
  minConf?: number;
}

export interface ResolvedOcr {
  requested: OcrRequested;
  engine: OcrEngineName;
  bin: string;
  tessdataDir?: string;
  langs: string[];
  probedLangs: string[];
  maxConcurrency: number;
  timeoutMs: number;
  maxPixels: number;
  allowFullFrame: boolean;
  minConf: number;
  hostReady: boolean;
  semaphore: OcrSemaphore;
  recognize: OcrEngine['recognize'];
}

export interface OcrResultWord {
  text: string;
  conf: number;
  bbox: OcrWordBox;
  frameBox: OcrWordBox;
  click: { x: number; y: number };
  hid: { x: number; y: number };
}

export interface OcrResult {
  engine: 'host' | 'kvmd';
  frameId: string;
  text: string;
  crop: OcrBox | null;
  source: { width: number; height: number };
  minConf: number;
  droppedLowConf: number;
  words: OcrResultWord[];
  durationMs: { snapshot: number; ocr: number; total: number };
  truncated?: true;
}

interface ExecError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function integerEnv(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function langList(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return ['eng'];
  const langs = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (langs.length === 0 || langs.some((lang) => !LANG_TOKEN.test(lang))) {
    throw new Error('PIKVM_OCR_LANGS must be a comma-separated list of [a-z_] tokens');
  }
  return langs;
}

/** Process OCR settings. This does not spawn tesseract. */
export function parseOcrSettings(env: NodeJS.ProcessEnv = process.env): OcrSettings {
  const rawEngine = env.PIKVM_OCR_ENGINE;
  let requested: OcrRequested = 'unset';
  if (rawEngine !== undefined && rawEngine !== '') {
    if (rawEngine !== 'off' && rawEngine !== 'host' && rawEngine !== 'kvmd') {
      throw new Error('PIKVM_OCR_ENGINE must be off, host, or kvmd');
    }
    requested = rawEngine;
  }
  const bin = env.PIKVM_OCR_TESSERACT_BIN;
  if (bin !== undefined && (bin === '' || bin.includes('\0') || /[\r\n]/.test(bin))) {
    throw new Error('PIKVM_OCR_TESSERACT_BIN must be a command or an absolute path');
  }
  const tess = env.PIKVM_OCR_TESSDATA_DIR;
  if (tess !== undefined && (tess === '' || tess.includes('\0') || /[\r\n]/.test(tess))) {
    throw new Error('PIKVM_OCR_TESSDATA_DIR must be a directory path');
  }
  const allow = env.PIKVM_OCR_ALLOW_FULL_FRAME;
  let allowFullFrame = false;
  if (allow !== undefined && allow !== '') {
    if (allow !== '0' && allow !== '1') {
      throw new Error('PIKVM_OCR_ALLOW_FULL_FRAME must be 0 or 1');
    }
    allowFullFrame = allow === '1';
  }
  return {
    requested,
    bin: bin === undefined || bin === '' ? 'tesseract' : bin,
    ...(tess ? { tessdataDir: tess } : {}),
    langs: langList(env.PIKVM_OCR_LANGS),
    maxConcurrency: integerEnv(
      'PIKVM_OCR_MAX_CONCURRENCY',
      env.PIKVM_OCR_MAX_CONCURRENCY,
      OCR_MAX_CONCURRENCY_DEFAULT,
      1,
      4,
    ),
    timeoutMs: parseOcrTimeoutMs(env.PIKVM_OCR_TIMEOUT_MS),
    maxPixels: integerEnv(
      'PIKVM_OCR_MAX_PIXELS',
      env.PIKVM_OCR_MAX_PIXELS,
      OCR_MAX_PIXELS_DEFAULT,
      1,
      OCR_FULL_FRAME_MAX_PIXELS,
    ),
    allowFullFrame,
    minConf: integerEnv('PIKVM_OCR_MIN_CONF', env.PIKVM_OCR_MIN_CONF, OCR_MIN_CONF_DEFAULT, 0, 100),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const DEVICE_OCR_KEYS = ['engine', 'langs', 'minConf'] as const;

/** Registry `ocr` object. Unknown keys and engine host are errors. */
export function parseDeviceOcr(device: string, raw: unknown): DeviceOcrOverride | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw new Error(`device ${device} ocr: must be an object`);
  for (const key of Object.keys(raw)) {
    if (!DEVICE_OCR_KEYS.includes(key as typeof DEVICE_OCR_KEYS[number])) {
      throw new Error(`device ${device} ocr: unknown field ${JSON.stringify(key)}`);
    }
  }
  let engine: 'off' | 'kvmd' | undefined;
  if (raw.engine !== undefined) {
    if (raw.engine === 'host') {
      throw new Error(`device ${device} ocr.engine host is process-wide`);
    }
    if (raw.engine !== 'off' && raw.engine !== 'kvmd') {
      throw new Error(`device ${device} ocr.engine must be off or kvmd`);
    }
    engine = raw.engine;
  }
  let langs: string[] | undefined;
  if (raw.langs !== undefined) {
    if (!Array.isArray(raw.langs) || raw.langs.length === 0) {
      throw new Error(`device ${device} ocr.langs must be a non-empty array`);
    }
    langs = [];
    for (const lang of raw.langs) {
      if (typeof lang !== 'string' || !LANG_TOKEN.test(lang)) {
        throw new Error(`device ${device} ocr.langs entries must match [a-z_]+`);
      }
      langs.push(lang);
    }
  }
  let minConf: number | undefined;
  if (raw.minConf !== undefined) {
    if (typeof raw.minConf !== 'number' || !Number.isInteger(raw.minConf) || raw.minConf < 0 || raw.minConf > 100) {
      throw new Error(`device ${device} ocr.minConf must be an integer from 0 to 100`);
    }
    minConf = raw.minConf;
  }
  return { engine, langs, minConf };
}

export function parseOcrEngineArg(raw: unknown): 'host' | 'kvmd' | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'host' && raw !== 'kvmd') throw new Error('engine must be host or kvmd');
  return raw;
}

export function parseFullFrame(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') throw new Error('fullFrame must be a boolean');
  return raw;
}

/** Process-wide slot. Waiters take the slot from the holder that released it. */
export class OcrSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    settle: (err?: OcrError) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(private readonly max: number) {}

  async acquire(waitMs: number): Promise<() => void> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    if (waitMs <= 0) throw new OcrError('PIKVM_OCR_BUSY', 'OCR is busy', 'host');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const entry = {
        settle: (err?: OcrError) => {
          if (settled) return;
          settled = true;
          clearTimeout(entry.timer);
          if (err) reject(err);
          else resolve();
        },
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(entry);
          if (index >= 0) this.waiters.splice(index, 1);
          entry.settle(new OcrError('PIKVM_OCR_BUSY', 'OCR is busy', 'host'));
        }, waitMs),
      };
      this.waiters.push(entry);
    });
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.settle();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function childEnv(tessdataDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    OMP_THREAD_LIMIT: '1',
  };
  if (tessdataDir) env.TESSDATA_PREFIX = tessdataDir;
  return env;
}

function runFile(
  bin: string,
  args: string[],
  timeoutMs: number,
  input?: Buffer,
  tessdataDir?: string,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: OCR_MAX_BUFFER,
      encoding: 'buffer',
      env: childEnv(tessdataDir),
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, {
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ''),
        }));
        return;
      }
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ''),
      });
    });
    child.stdin?.on('error', () => {});
    if (input) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

function hostFailure(bin: string, err: ExecError): OcrError {
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new OcrError('PIKVM_OCR_FAILED', 'tesseract output exceeded 8 MiB', 'host');
  }
  if (err.killed || err.signal === 'SIGKILL') {
    return new OcrError('PIKVM_OCR_TIMEOUT', 'tesseract was killed after the OCR timeout', 'host');
  }
  if (err.code === 'ENOENT') {
    return new OcrError('PIKVM_OCR_FAILED', `tesseract binary ${JSON.stringify(bin)} was not found`, 'host');
  }
  const status = typeof err.code === 'number' ? String(err.code) : 'error';
  return new OcrError('PIKVM_OCR_FAILED', `tesseract exited ${status}`, 'host');
}

/** Languages named by `tesseract --list-langs`. The banner line is ignored. */
export function parseLangList(text: string): string[] {
  const langs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (LANG_TOKEN.test(trimmed)) langs.push(trimmed);
  }
  return langs;
}

export interface HostProbe {
  ok: boolean;
  langs: string[];
  error?: string;
}

/** `--version` and `--list-langs`, 2s each, SIGKILL. No shell. */
export async function probeTesseract(bin: string, tessdataDir?: string): Promise<HostProbe> {
  const versionArgs = tessdataDir ? ['--tessdata-dir', tessdataDir, '--version'] : ['--version'];
  const listArgs = tessdataDir ? ['--tessdata-dir', tessdataDir, '--list-langs'] : ['--list-langs'];
  try {
    await runFile(bin, versionArgs, OCR_PROBE_TIMEOUT_MS, undefined, tessdataDir);
  } catch (err) {
    const reason = err instanceof Error && (err as ExecError).code === 'ENOENT'
      ? 'not found'
      : 'version probe failed';
    return { ok: false, langs: [], error: reason };
  }
  try {
    const listed = await runFile(bin, listArgs, OCR_PROBE_TIMEOUT_MS, undefined, tessdataDir);
    const langs = parseLangList(`${listed.stdout.toString('utf8')}\n${listed.stderr.toString('utf8')}`);
    if (langs.length === 0) return { ok: false, langs: [], error: 'no languages' };
    return { ok: true, langs };
  } catch {
    return { ok: false, langs: [], error: 'list-langs probe failed' };
  }
}

function assertLangs(bin: string, wanted: readonly string[], available: readonly string[]): void {
  const missing = wanted.filter((lang) => !available.includes(lang));
  if (missing.length > 0) {
    throw new Error(
      `PIKVM_OCR_LANGS ${missing.join(',')} not reported by ${JSON.stringify(bin)} --list-langs`,
    );
  }
}

function disabledRecognize(): Promise<{ words: OcrEngineWord[] }> {
  return Promise.reject(new OcrError('PIKVM_OCR_FAILED', 'host OCR is not configured', 'host'));
}

function runtimeFrom(
  settings: OcrSettings,
  engine: OcrEngineName,
  hostReady: boolean,
  probedLangs: string[],
  recognize: OcrEngine['recognize'],
): ResolvedOcr {
  return {
    requested: settings.requested,
    engine,
    bin: settings.bin,
    ...(settings.tessdataDir ? { tessdataDir: settings.tessdataDir } : {}),
    langs: settings.langs,
    probedLangs,
    maxConcurrency: settings.maxConcurrency,
    timeoutMs: settings.timeoutMs,
    maxPixels: settings.maxPixels,
    allowFullFrame: settings.allowFullFrame,
    minConf: settings.minConf,
    hostReady,
    semaphore: new OcrSemaphore(settings.maxConcurrency),
    recognize,
  };
}

/**
 * Startup probe. ENGINE=host and a missing binary throws.
 * Unset and a missing binary is off, with a stderr warning. kvmd is not selected.
 */
export async function resolveOcr(settings: OcrSettings): Promise<ResolvedOcr> {
  if (settings.requested === 'off') {
    return runtimeFrom(settings, 'off', false, [], disabledRecognize);
  }
  if (settings.requested === 'kvmd') {
    return runtimeFrom(settings, 'kvmd', false, [], disabledRecognize);
  }
  const probe = await probeTesseract(settings.bin, settings.tessdataDir);
  if (!probe.ok) {
    if (settings.requested === 'host') {
      throw new Error(
        `PIKVM_OCR_ENGINE=host but ${JSON.stringify(settings.bin)} is not usable (${probe.error ?? 'probe failed'})`,
      );
    }
    console.error(
      `PIKVM_OCR_ENGINE is unset and ${JSON.stringify(settings.bin)} is not usable (${probe.error ?? 'probe failed'}). OCR is off.`,
    );
    return runtimeFrom(settings, 'off', false, [], disabledRecognize);
  }
  try {
    assertLangs(settings.bin, settings.langs, probe.langs);
  } catch (err) {
    if (settings.requested === 'host') throw err;
    const message = err instanceof Error ? err.message : 'languages missing';
    console.error(`${message}. OCR is off.`);
    return runtimeFrom(settings, 'off', false, probe.langs, disabledRecognize);
  }
  const engine = createTesseractEngine(settings);
  return runtimeFrom(settings, 'host', true, probe.langs, (png, options) => engine.recognize(png, options));
}

/** kvmd visibility, for tests that do not probe a binary. */
export function kvmdOcr(partial: Partial<ResolvedOcr> = {}): ResolvedOcr {
  const settings = parseOcrSettings({ PIKVM_OCR_ENGINE: 'kvmd' });
  return { ...runtimeFrom(settings, 'kvmd', false, [], disabledRecognize), ...partial };
}

/** Host runtime with an injected recognizer. The binary is not spawned. */
export function hostOcr(partial: Partial<ResolvedOcr> & { recognize: OcrEngine['recognize'] }): ResolvedOcr {
  const settings = parseOcrSettings({ PIKVM_OCR_ENGINE: 'host' });
  const runtime = runtimeFrom(settings, 'host', true, partial.probedLangs ?? ['eng'], partial.recognize);
  return { ...runtime, ...partial, engine: 'host', hostReady: true, recognize: partial.recognize };
}

/** Omitted server OCR is off, so tests do not spawn tesseract. */
export function offOcr(): ResolvedOcr {
  const settings = parseOcrSettings({ PIKVM_OCR_ENGINE: 'off' });
  return runtimeFrom(settings, 'off', false, [], disabledRecognize);
}

/** True when startup should probe GET /streamer/ocr. Host-only does not. */
export function ocrUsesKvmdProbe(
  runtime: ResolvedOcr,
  devices: Iterable<{ ocr?: DeviceOcrOverride }>,
): boolean {
  if (runtime.engine === 'kvmd') return true;
  for (const device of devices) {
    if (device.ocr?.engine === 'kvmd') return true;
  }
  return false;
}

/** Tool stays listed for host when the binary was found, and for kvmd while any device is enabled or unknown. */
export function ocrToolVisible(
  runtime: ResolvedOcr,
  devices: Iterable<{ ocr?: DeviceOcrOverride; ocrStatus: 'enabled' | 'disabled' | 'unknown' }>,
): boolean {
  const list = [...devices];
  if (runtime.engine === 'off') return false;
  if (runtime.engine === 'host') {
    return list.some((device) => device.ocr?.engine !== 'off');
  }
  return list.some((device) => {
    if (device.ocr?.engine === 'off') return false;
    return device.ocrStatus === 'enabled' || device.ocrStatus === 'unknown';
  });
}

function tesseractArgs(langs: string, psm: number, tessdataDir?: string): string[] {
  if (!LANG_ARG.test(langs)) throw new OcrError('PIKVM_OCR_FAILED', 'OCR langs are not an allowed list', 'host');
  if (!Number.isInteger(psm) || psm < 0 || psm > 13) {
    throw new OcrError('PIKVM_OCR_FAILED', 'OCR psm must be an integer from 0 to 13', 'host');
  }
  const args = ['stdin', 'stdout', '-l', langs, '--psm', String(psm)];
  if (tessdataDir) args.push('--tessdata-dir', tessdataDir);
  args.push('tsv');
  return args;
}

/**
 * Level-5 TSV words. conf=-1 and malformed rows are dropped.
 * minConf is applied by the caller so a device can raise it.
 */
export function parseTsv(tsv: string): OcrEngineWord[] {
  const words: OcrEngineWord[] = [];
  const lines = tsv.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    if (fields.length < 12) continue;
    if (fields[0] !== '5') continue;
    const block = Number(fields[2]);
    const par = Number(fields[3]);
    const lineNum = Number(fields[4]);
    const left = Number(fields[6]);
    const top = Number(fields[7]);
    const width = Number(fields[8]);
    const height = Number(fields[9]);
    const conf = Number(fields[10]);
    const text = fields.slice(11).join('\t');
    if (![block, par, lineNum, left, top, width, height].every((value) => Number.isInteger(value) && value >= 0)) {
      continue;
    }
    if (width < 1 || height < 1) continue;
    if (!Number.isFinite(conf) || conf < 0) continue;
    if (text === '') continue;
    words.push({
      text,
      conf,
      bbox: { left, top, width, height },
      block,
      par,
      line: lineNum,
    });
  }
  return words;
}

export function createTesseractEngine(settings: Pick<OcrSettings, 'bin' | 'tessdataDir' | 'timeoutMs'>): OcrEngine {
  return {
    async recognize(png, options) {
      const args = tesseractArgs(options.langs, options.psm, settings.tessdataDir);
      const env = childEnv(settings.tessdataDir);
      const result = await new Promise<{ stdout: Buffer }>((resolve, reject) => {
        let settled = false;
        const finish = (err: ExecError | undefined, stdout: Buffer) => {
          if (settled) return;
          settled = true;
          if (err) reject(hostFailure(settings.bin, err));
          else resolve({ stdout });
        };
        const child = execFile(settings.bin, args, {
          timeout: settings.timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: OCR_MAX_BUFFER,
          encoding: 'buffer',
          env,
          windowsHide: true,
        }, (err, stdout) => {
          const body = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          finish(err ?? undefined, body);
        });
        const onAbort = () => {
          child.kill('SIGKILL');
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
        child.stdin?.on('error', () => {});
        child.stdin?.end(png);
      });
      return { words: parseTsv(result.stdout.toString('utf8')) };
    },
  };
}

function area(box: OcrBox): number {
  return (box.right - box.left) * (box.bottom - box.top);
}

/** Crop pixels to source, then to the click frame. hid uses the source centre. */
export function mapHostWord(
  word: OcrEngineWord,
  sourceBox: OcrBox | null,
  frame: ClickFrame | null,
  source: { width: number; height: number },
  calibration: { factorX: number; factorY: number } | null,
): OcrResultWord {
  const originLeft = sourceBox?.left ?? 0;
  const originTop = sourceBox?.top ?? 0;
  const sourceLeft = word.bbox.left + originLeft;
  const sourceTop = word.bbox.top + originTop;
  const scaleX = frame?.scaleX ?? 1;
  const scaleY = frame?.scaleY ?? 1;
  const originX = frame?.originX ?? 0;
  const originY = frame?.originY ?? 0;
  const frameLeft = sourceLeft / scaleX - originX;
  const frameTop = sourceTop / scaleY - originY;
  const frameWidth = word.bbox.width / scaleX;
  const frameHeight = word.bbox.height / scaleY;
  const centreX = sourceLeft + word.bbox.width / 2;
  const centreY = sourceTop + word.bbox.height / 2;
  return {
    text: word.text,
    conf: word.conf,
    bbox: word.bbox,
    frameBox: { left: frameLeft, top: frameTop, width: frameWidth, height: frameHeight },
    click: {
      x: Math.round(frameLeft + frameWidth / 2),
      y: Math.round(frameTop + frameHeight / 2),
    },
    hid: pixelToNormalized(centreX, centreY, source, calibration),
  };
}

function rebuildText(words: OcrEngineWord[]): string {
  const groups = new Map<string, OcrEngineWord[]>();
  for (const word of words) {
    const key = `${word.block}:${word.par}:${word.line}`;
    const row = groups.get(key);
    if (row) row.push(word);
    else groups.set(key, [word]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [ab, ap, al] = a.split(':').map(Number);
    const [bb, bp, bl] = b.split(':').map(Number);
    return ab - bb || ap - bp || al - bl;
  });
  return keys.map((key) => {
    const row = groups.get(key) ?? [];
    row.sort((a, b) => a.bbox.left - b.bbox.left);
    return row.map((word) => word.text).join(' ');
  }).join('\n');
}

function logOcr(fields: {
  device: string;
  engine: string;
  pixels: number;
  durationMs: { snapshot: number; ocr: number; total: number };
  words: number;
  outcome: string;
}): void {
  console.error(JSON.stringify({ event: 'ocr', ...fields }));
}

function outcomeOf(err: unknown): string {
  if (err instanceof OcrError || err instanceof OcrUnavailableError) return err.type;
  if (err !== null && typeof err === 'object' && 'type' in err && typeof (err as { type: unknown }).type === 'string') {
    return (err as { type: string }).type;
  }
  return 'error';
}

function selectEngine(
  runtime: ResolvedOcr,
  override: DeviceOcrOverride | undefined,
  callEngine: 'host' | 'kvmd' | undefined,
  deviceName: string,
): 'host' | 'kvmd' {
  if (override?.engine === 'off') throw new OcrUnavailableError(deviceName);
  if (callEngine === 'host') {
    if (override?.engine === 'kvmd') {
      throw new OcrError('PIKVM_OCR_FAILED', `device ${JSON.stringify(deviceName)} OCR engine is kvmd`, 'host');
    }
    if (!runtime.hostReady) {
      throw new OcrError('PIKVM_OCR_FAILED', 'host tesseract is not available', 'host');
    }
    return 'host';
  }
  if (callEngine === 'kvmd') return 'kvmd';
  if (override?.engine === 'kvmd') {
    if (runtime.engine === 'off') {
      throw new OcrError(
        'PIKVM_OCR_UNAVAILABLE',
        `device ${JSON.stringify(deviceName)} ocr.engine kvmd widens a process whose OCR is off`,
        'kvmd',
      );
    }
    return 'kvmd';
  }
  if (runtime.engine === 'off') throw new OcrUnavailableError(deviceName);
  return runtime.engine;
}

function selectLangs(
  engine: 'host' | 'kvmd',
  runtime: ResolvedOcr,
  override: DeviceOcrOverride | undefined,
  langsArg: unknown,
  kvmdLangs: readonly string[],
  deviceName: string,
): { langs: string[] | undefined; minConf: number } {
  let minConf = runtime.minConf;
  if (override?.minConf !== undefined) {
    if (override.minConf < runtime.minConf) {
      throw new Error(
        `device ${JSON.stringify(deviceName)} ocr.minConf cannot be below ${runtime.minConf}`,
      );
    }
    minConf = override.minConf;
  }
  if (engine === 'kvmd') {
    const ceiling = override?.langs ?? kvmdLangs;
    if (override?.langs) {
      for (const lang of override.langs) {
        if (!kvmdLangs.includes(lang)) {
          throw new Error(`OCR language ${JSON.stringify(lang)} is not available on device ${JSON.stringify(deviceName)}`);
        }
      }
    }
    const langs = parseOcrLangs(langsArg, override?.langs ? ceiling : kvmdLangs, deviceName);
    if (langs && override?.langs) {
      for (const lang of langs) {
        if (!override.langs.includes(lang)) {
          throw new Error(`OCR language ${JSON.stringify(lang)} is not available on device ${JSON.stringify(deviceName)}`);
        }
      }
    }
    return { langs: langs ?? override?.langs, minConf };
  }
  const ceiling = override?.langs ?? runtime.langs;
  if (override?.langs) {
    for (const lang of override.langs) {
      if (!runtime.langs.includes(lang)) {
        throw new Error(`device ${JSON.stringify(deviceName)} ocr.langs ${JSON.stringify(lang)} is outside the process languages`);
      }
    }
  }
  for (const lang of ceiling) {
    if (runtime.probedLangs.length > 0 && !runtime.probedLangs.includes(lang)) {
      throw new Error(`OCR language ${JSON.stringify(lang)} is not available on device ${JSON.stringify(deviceName)}`);
    }
  }
  let selected = ceiling;
  if (langsArg !== undefined) {
    const parsed = parseOcrLangs(langsArg, ceiling, deviceName);
    if (!parsed) throw new Error(`langs must name a language on device ${JSON.stringify(deviceName)}`);
    selected = parsed;
  }
  return { langs: selected, minConf };
}

export interface ExecuteOcrInput {
  deviceName: string;
  runtime: ResolvedOcr;
  override?: DeviceOcrOverride;
  engineArg?: 'host' | 'kvmd';
  langsArg?: unknown;
  box?: OcrBox;
  frame: ClickFrame | null;
  frameId: string;
  fullFrame: boolean;
  getSource: () => Promise<{ width: number; height: number }>;
  calibration: { factorX: number; factorY: number } | null;
  fetchSnapshot: (timeoutMs: number) => Promise<Buffer>;
  readKvmd: (langs: string[] | undefined) => Promise<string>;
  ensureKvmd: () => Promise<OcrState>;
}

/** One OCR call. Host never falls through to kvmd. The image stays in memory. */
export async function executeOcr(input: ExecuteOcrInput): Promise<OcrResult> {
  const started = Date.now();
  const budgetAt = performance.now();
  const engine = selectEngine(input.runtime, input.override, input.engineArg, input.deviceName);
  let pixels = 0;
  let snapshotMs = 0;
  let ocrMs = 0;
  let wordsOut = 0;
  let logged = false;
  const duration = () => ({
    snapshot: snapshotMs,
    ocr: ocrMs,
    total: Date.now() - started,
  });
  const log = (outcome: string) => {
    if (logged) return;
    logged = true;
    logOcr({
      device: input.deviceName,
      engine,
      pixels,
      durationMs: duration(),
      words: wordsOut,
      outcome,
    });
  };
  try {
    if (engine === 'kvmd') {
      const state = await input.ensureKvmd();
      const selected = selectLangs('kvmd', input.runtime, input.override, input.langsArg, state.langs, input.deviceName);
      const source = await input.getSource();
      const sourceBox = input.box ? ocrBoxToSource(input.box, input.frame, source) : undefined;
      pixels = sourceBox ? area(sourceBox) : source.width * source.height;
      const snapStart = Date.now();
      const text = await input.readKvmd(selected.langs);
      snapshotMs = Date.now() - snapStart;
      const result: OcrResult = {
        engine: 'kvmd',
        frameId: input.frameId,
        text,
        crop: sourceBox ?? null,
        source: { width: source.width, height: source.height },
        minConf: selected.minConf,
        droppedLowConf: 0,
        words: [],
        durationMs: { snapshot: snapshotMs, ocr: 0, total: Date.now() - started },
      };
      log('ok');
      return result;
    }
    const selected = selectLangs('host', input.runtime, input.override, input.langsArg, [], input.deviceName);
    if (!input.box && !(input.fullFrame && input.runtime.allowFullFrame)) {
      log('PIKVM_OCR_BOX_REQUIRED');
      throw new OcrError(
        'PIKVM_OCR_BOX_REQUIRED',
        'OCR requires a box unless fullFrame is true and PIKVM_OCR_ALLOW_FULL_FRAME=1',
        'host',
      );
    }
    const source = await input.getSource();
    const sourceBox = input.box ? ocrBoxToSource(input.box, input.frame, source) : undefined;
    pixels = sourceBox ? area(sourceBox) : source.width * source.height;
    const cap = input.fullFrame && input.runtime.allowFullFrame
      ? OCR_FULL_FRAME_MAX_PIXELS
      : input.runtime.maxPixels;
    if (pixels > cap) {
      log('PIKVM_OCR_TOO_LARGE');
      throw new OcrError(
        'PIKVM_OCR_TOO_LARGE',
        `OCR region is ${pixels} pixels, above ${cap}`,
        'host',
      );
    }
    const remaining = () => input.runtime.timeoutMs - (performance.now() - budgetAt);
    if (remaining() <= 0) {
      log('PIKVM_OCR_TIMEOUT');
      throw new OcrError('PIKVM_OCR_TIMEOUT', 'OCR timed out', 'host');
    }
    const snapStart = Date.now();
    // AbortSignal.timeout rejects a fractional delay. Ceil keeps the
    // snapshot from ending before the budget; the overshoot is under 1 ms.
    const jpeg = await input.fetchSnapshot(Math.max(1, Math.ceil(remaining())));
    const crop = sourceBox
      ? {
        left: sourceBox.left,
        top: sourceBox.top,
        width: sourceBox.right - sourceBox.left,
        height: sourceBox.bottom - sourceBox.top,
      }
      : undefined;
    let image = limitedSharp(jpeg);
    if (crop) image = image.extract(crop);
    const png = Buffer.from(await image.greyscale().png().toBuffer());
    snapshotMs = Date.now() - snapStart;
    if (remaining() <= 0) {
      log('PIKVM_OCR_TIMEOUT');
      throw new OcrError('PIKVM_OCR_TIMEOUT', 'OCR timed out', 'host');
    }
    const release = await input.runtime.semaphore.acquire(Math.max(0, Math.ceil(remaining())));
    const ocrStart = Date.now();
    try {
      const recognized = await input.runtime.recognize(png, {
        langs: (selected.langs ?? input.runtime.langs).join('+'),
        psm: OCR_DEFAULT_PSM,
        signal: deadlineSignal(Math.max(1, Math.ceil(remaining()))),
      });
      let droppedLowConf = 0;
      const kept: OcrEngineWord[] = [];
      for (const word of recognized.words) {
        if (word.conf < selected.minConf) {
          droppedLowConf += 1;
          continue;
        }
        kept.push(word);
      }
      let truncated = false;
      let used = kept;
      if (used.length > OCR_WORD_CAP) {
        used = used.slice(0, OCR_WORD_CAP);
        truncated = true;
      }
      const rawText = rebuildText(used);
      const text = capOcrText(rawText);
      if (Buffer.byteLength(rawText) > OCR_TEXT_MAX_BYTES) truncated = true;
      const words = used.map((word) => mapHostWord(word, sourceBox ?? null, input.frame, source, input.calibration));
      wordsOut = words.length;
      ocrMs = Date.now() - ocrStart;
      const result: OcrResult = {
        engine: 'host',
        frameId: input.frameId,
        text,
        crop: sourceBox ?? null,
        source: { width: source.width, height: source.height },
        minConf: selected.minConf,
        droppedLowConf,
        words,
        durationMs: duration(),
        ...(truncated ? { truncated: true as const } : {}),
      };
      log('ok');
      return result;
    } finally {
      release();
    }
  } catch (err) {
    log(outcomeOf(err));
    throw err;
  }
}

/** Deadline that does not hold the process open after the call returns. */
function deadlineSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, ms));
  timer.unref();
  return controller.signal;
}
