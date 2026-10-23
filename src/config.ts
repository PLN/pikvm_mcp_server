// Modified 2026-10 by PLN: PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD upload deadlines (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: cap MSD job at 7 days and idle at 1 hour (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_MCP_ARM_MSD (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_MSD_LOCAL_DIR and PIKVM_MSD_MAX_BYTES (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_MSD_URL_ALLOWLIST and URL private opt-in (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_MSD_READY_TIMEOUT_MS (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: write_remote connect timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: warn on a junk connect timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: password and bearer secret files (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: empty secret vars are unset (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: bearer whitespace is HTTP-only (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: TLS verify, pin, and insecure modes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: device registry (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a logged host is an origin (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: screenshot preview defaults (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_OCR_TIMEOUT_MS (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: hash reads use the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD progress windows (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: finalise window arms on request sent (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: upload finalise window is twice the idle timeout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: nginx 60s bounds kvmd's finish, not the drain (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: host OCR settings (GPL-3.0; see NOTICE).
// Env read adapted from dtrukr/pikvm_mcp_server src/config.ts @ d120243 (GPL-3.0).

/**
 * Configuration management for PiKVM MCP Server
 *
 * Reads configuration from environment variables.
 * Supports .env file via dotenv (unless disabled).
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  MSD_IDLE_TIMEOUT_DEFAULT_MS,
  MSD_IDLE_TIMEOUT_MAX_MS,
  MSD_JOB_TIMEOUT_DEFAULT_MS,
  MSD_JOB_TIMEOUT_MAX_MS,
  MSD_READY_TIMEOUT_DEFAULT_MS,
  MSD_READY_TIMEOUT_MAX_MS,
  parseMsdTimeoutMs,
  parseRequestTimeoutMs,
} from './request-timeout.js';
import { resolveSecret } from './secrets.js';
import { loadDeviceRegistry, type DeviceRegistry } from './registry.js';
import { parseOcrTimeoutMs, parseScreenshotEnv, type ScreenshotSettings } from './screenshot.js';
import { parseOcrSettings, type OcrSettings } from './ocr.js';
import {
  readPinnedCert,
  type DeviceTls,
  type TlsMode,
} from './tls.js';
import { parseUrlAllowlist, redactUrl, type UrlAllowlist } from './url-policy.js';

// Load .env file from project root
// - quiet: true prevents stdout output that would corrupt MCP protocol
// - override: true ensures .env values take precedence over any existing env vars
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

/**
 * Load a .env file unless PIKVM_MCP_NO_DOTENV=1.
 *
 * Two independent belts:
 * 1. override is FALSE (dotenv default): explicitly-set process env always
 *    wins over .env values — a stray .env can only fill gaps.
 * 2. PIKVM_MCP_NO_DOTENV=1 skips .env loading entirely. The skip is checked
 *    BEFORE dotenv runs and only against the real process environment, so a
 *    .env file cannot enable the skip for itself. Gateway / systemd
 *    deployments export env directly and set this so no on-disk .env wins.
 */
export function loadEnvFile(path: string): void {
  if (process.env.PIKVM_MCP_NO_DOTENV === '1') {
    return;
  }
  // override: false — process env already set by the caller wins over .env.
  loadEnv({ path, quiet: true, override: false });
}

loadEnvFile(envPath);

export interface HttpConfig {
  port: number;
  /** Bind address. Default 127.0.0.1; the gateway may set a bridge IP. */
  host: string;
  /** Bearer token required on every HTTP request (mandatory in HTTP mode). */
  bearerToken?: string;
  /** 1 = HID tools armed in HTTP mode; otherwise arm-gate blocks them. */
  armHid: boolean;
  /** 1 = MSD mount/eject armed in HTTP mode; otherwise those tools are blocked. */
  armMsd: boolean;
}

/** 16 GiB. Local uploads and later URL downloads share this cap. */
export const MSD_MAX_BYTES_DEFAULT = 16 * 1024 * 1024 * 1024;

export const MSD_EXTENSIONS_DEFAULT = ['.iso', '.img'] as const;

export function parseMsdMaxBytes(raw: string | undefined): number {
  if (raw === undefined || raw === '' || !/^[0-9]+$/.test(raw)) return MSD_MAX_BYTES_DEFAULT;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return MSD_MAX_BYTES_DEFAULT;
  return n;
}

export function parseMsdExtensions(raw: string | undefined): string[] {
  const source = raw === undefined || raw.trim() === '' ? MSD_EXTENSIONS_DEFAULT.join(',') : raw;
  const out: string[] = [];
  for (const part of source.split(',')) {
    let ext = part.trim().toLowerCase();
    if (!ext) continue;
    if (!ext.startsWith('.')) ext = `.${ext}`;
    if (!/^\.[a-z0-9]+$/.test(ext)) continue;
    if (!out.includes(ext)) out.push(ext);
  }
  return out.length > 0 ? out : [...MSD_EXTENSIONS_DEFAULT];
}

export function parseMsdLocalDir(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface MsdConfig {
  /** Unset hides pikvm_msd_upload. */
  localDir?: string;
  maxBytes: number;
  extensions: readonly string[];
  /** No https entry hides pikvm_msd_fetch_url. */
  urlAllow: UrlAllowlist;
  /** Allows other private ranges. Never link-local, metadata, or Tailscale. */
  allowPrivate: boolean;
  /** kvmd write_remote connect timeout in seconds. Not the job cap. */
  connectTimeoutSec: number;
  /**
   * How long a successful write waits for that exact image to be
   * complete in the catalog. From PIKVM_MSD_READY_TIMEOUT_MS.
   * Default 30 seconds. The upload POST is not repeated.
   */
  readyTimeoutMs: number;
}

/** aiohttp sock_connect budget sent as write_remote timeout=. Default 30s. */
export const MSD_URL_CONNECT_TIMEOUT_DEFAULT_SEC = 30;
export const MSD_URL_CONNECT_TIMEOUT_MAX_SEC = 120;

export function parseUrlConnectTimeoutSec(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') {
    return MSD_URL_CONNECT_TIMEOUT_DEFAULT_SEC;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    console.error(JSON.stringify({
      event: 'msd_config',
      ok: false,
      error: 'PIKVM_MSD_URL_CONNECT_TIMEOUT_SEC is not a number of seconds; using the default',
    }));
    return MSD_URL_CONNECT_TIMEOUT_DEFAULT_SEC;
  }
  const sec = Number(trimmed);
  if (sec > MSD_URL_CONNECT_TIMEOUT_MAX_SEC) return MSD_URL_CONNECT_TIMEOUT_MAX_SEC;
  return sec;
}

export interface Config {
  pikvm: {
    host: string;
    username: string;
    password: string;
    verifySsl: boolean;
    /**
     * TLS for the default device. Each registry device has its own
     * client, built with that device's tls as this field.
     */
    tls: { default: DeviceTls };
    defaultKeymap: string;
    /** Abort deadline for one ordinary kvmd call, from PIKVM_REQUEST_TIMEOUT_MS. */
    requestTimeoutMs: number;
    /**
     * Last-resort safety cap for one MSD upload or write_remote, from
     * PIKVM_MSD_JOB_TIMEOUT_MS. Default 6 hours, max 7 days. 0 means the default.
     * It is not the progress bound. During hashing it is
     * PIKVM_MSD_HASH_TIMEOUT. After the request has been sent it is
     * PIKVM_MSD_STATE_UNKNOWN with phase job_timeout, on the upload body,
     * upload finalise, write_remote headers, and the write_remote stream.
     * The message names this variable and the millisecond value.
     */
    msdJobTimeoutMs: number;
    /**
     * Progress bound from PIKVM_MSD_IDLE_TIMEOUT_MS. Default 60 seconds,
     * max 1 hour. Covers each hash read (a read that does not return,
     * threadpool queueing included; a 0-byte read ends the hash), the
     * upload body, write_remote headers (connect timeout plus this value),
     * and the write_remote stream. Upload finalise, after the request is
     * sent, is twice this value. The OS send buffer and the peer's receive
     * window can still be draining after the bytes are handed to the socket,
     * and the client cannot see when kvmd has read them. nginx's 60s
     * proxy_read_timeout starts only after the whole body has gone
     * upstream, so it bounds kvmd's own finish (a 504, reported as
     * PIKVM_MSD_STATE_UNKNOWN), not the drain, which can use the full
     * 120s. The idle
     * timeout does not cap a phase that keeps making progress.
     * PIKVM_MSD_JOB_TIMEOUT_MS stays a last-resort safety cap. After the
     * request has been sent that cap is phase job_timeout. An idle abort
     * has no phase. Finalise stays phase finalise.
     * The catalog wait uses PIKVM_MSD_READY_TIMEOUT_MS.
     */
    msdIdleTimeoutMs: number;
    /** One OCR snapshot, from PIKVM_OCR_TIMEOUT_MS. Default 30s. Not retried on timeout. */
    ocrTimeoutMs: number;
  };
  calibration: {
    rounds: number;
    verifyRounds: number;
    moveDelayMs: number;
  };
  msd: MsdConfig;
  /** Preview defaults from PIKVM_SCREENSHOT_MAX_WIDTH, _MAX_HEIGHT, and _QUALITY. */
  screenshot: ScreenshotSettings;
  /** Process OCR settings. The binary is probed later, not while this is parsed. */
  ocr: OcrSettings;
  /** Present only when PIKVM_MCP_PORT is set (HTTP mode). */
  http?: HttpConfig;
  /**
   * Set only when PIKVM_DEVICES_FILE or PIKVM_DEVICES is set.
   * Absent on the legacy single-device path.
   */
  registry?: DeviceRegistry;
}

/**
 * D1 (a): an unset PIKVM_TLS_MODE follows PIKVM_VERIFY_SSL. Exactly "true"
 * means verify. Anything else, including unset, means insecure and warns.
 * Switching that default waits for a later major release.
 * An explicit mode wins over a contradicting PIKVM_VERIFY_SSL.
 */
function resolveDefaultTls(host: string): DeviceTls {
  const raw = process.env.PIKVM_TLS_MODE;
  const modeSet = raw !== undefined && raw.trim() !== '';
  const legacy = process.env.PIKVM_VERIFY_SSL;
  const legacySet = legacy !== undefined && legacy !== '';
  const legacyVerify = legacy === 'true';
  let mode: TlsMode;
  if (!modeSet) {
    mode = legacyVerify ? 'verify' : 'insecure';
    if (mode === 'insecure') {
      console.error(
        'PIKVM_TLS_MODE=insecure because PIKVM_TLS_MODE is unset and PIKVM_VERIFY_SSL is not true. Pin the certificate with: pikvm-mcp-server pin default',
      );
    }
  } else {
    const trimmed = (raw ?? '').trim();
    if (trimmed !== 'verify' && trimmed !== 'pin' && trimmed !== 'insecure') {
      throw new Error(`PIKVM_TLS_MODE must be verify, pin, or insecure (got ${JSON.stringify(trimmed)})`);
    }
    mode = trimmed;
    if (legacySet && (legacyVerify ? 'verify' : 'insecure') !== mode) {
      console.error(`PIKVM_TLS_MODE=${mode} overrides PIKVM_VERIFY_SSL`);
    }
    if (mode === 'insecure') {
      console.error(
        'PIKVM_TLS_MODE=insecure (certificate checks are off). Pin the certificate with: pikvm-mcp-server pin default',
      );
    }
  }
  if ((mode === 'pin' || mode === 'verify') && !host.startsWith('https:')) {
    throw new Error(`PIKVM_TLS_MODE=${mode} requires an https PIKVM_HOST`);
  }
  if (mode !== 'pin') {
    return { device: 'default', mode };
  }
  const certFile = process.env.PIKVM_TLS_CERT_FILE;
  if (certFile === undefined || certFile === '') {
    throw new Error('PIKVM_TLS_CERT_FILE is required when PIKVM_TLS_MODE=pin');
  }
  const pinned = readPinnedCert(certFile);
  return {
    device: 'default',
    mode,
    certFile,
    certPem: pinned.pem,
    spkiSha256: pinned.spkiSha256,
  };
}

interface RuntimeConfig {
  requestTimeoutMs: number;
  msdJobTimeoutMs: number;
  msdIdleTimeoutMs: number;
  ocrTimeoutMs: number;
  defaultKeymap: string;
  calibration: Config['calibration'];
  msd: MsdConfig;
  http?: HttpConfig;
}

function readRuntimeConfig(): RuntimeConfig {
  const requestTimeoutMs = parseRequestTimeoutMs(process.env.PIKVM_REQUEST_TIMEOUT_MS);
  const msdJobTimeoutMs = parseMsdTimeoutMs(
    process.env.PIKVM_MSD_JOB_TIMEOUT_MS,
    MSD_JOB_TIMEOUT_DEFAULT_MS,
    MSD_JOB_TIMEOUT_MAX_MS,
  );
  const msdIdleTimeoutMs = parseMsdTimeoutMs(
    process.env.PIKVM_MSD_IDLE_TIMEOUT_MS,
    MSD_IDLE_TIMEOUT_DEFAULT_MS,
    MSD_IDLE_TIMEOUT_MAX_MS,
  );

  const bearerToken = resolveSecret({
    name: 'PIKVM_MCP_BEARER',
    credName: 'pikvm-mcp-bearer',
  });
  const port = parseInt(process.env.PIKVM_MCP_PORT || '', 10);
  // stdio does not send the bearer. A whitespace token must not block it.
  let http: HttpConfig | undefined;
  if (Number.isFinite(port) && port > 0) {
    if (typeof bearerToken === 'string' && bearerToken !== bearerToken.trim()) {
      throw new Error('PIKVM_MCP_BEARER has leading or trailing whitespace');
    }
    http = {
      port,
      host: process.env.PIKVM_MCP_HOST || '127.0.0.1',
      bearerToken,
      armHid: process.env.PIKVM_MCP_ARM_HID === '1',
      armMsd: process.env.PIKVM_MCP_ARM_MSD === '1',
    };
  }

  return {
    requestTimeoutMs,
    msdJobTimeoutMs,
    msdIdleTimeoutMs,
    ocrTimeoutMs: parseOcrTimeoutMs(process.env.PIKVM_OCR_TIMEOUT_MS),
    defaultKeymap: process.env.PIKVM_DEFAULT_KEYMAP || 'en-us',
    calibration: {
      rounds: parseInt(process.env.PIKVM_CALIBRATION_ROUNDS || '5', 10),
      verifyRounds: parseInt(process.env.PIKVM_CALIBRATION_VERIFY_ROUNDS || '5', 10),
      moveDelayMs: parseInt(process.env.PIKVM_CALIBRATION_MOVE_DELAY || '300', 10),
    },
    msd: {
      localDir: parseMsdLocalDir(process.env.PIKVM_MSD_LOCAL_DIR),
      maxBytes: parseMsdMaxBytes(process.env.PIKVM_MSD_MAX_BYTES),
      extensions: parseMsdExtensions(process.env.PIKVM_MSD_EXTENSIONS),
      urlAllow: parseUrlAllowlist(process.env.PIKVM_MSD_URL_ALLOWLIST),
      allowPrivate: process.env.PIKVM_MSD_URL_ALLOW_PRIVATE === '1',
      connectTimeoutSec: parseUrlConnectTimeoutSec(process.env.PIKVM_MSD_URL_CONNECT_TIMEOUT_SEC),
      readyTimeoutMs: parseMsdTimeoutMs(
        process.env.PIKVM_MSD_READY_TIMEOUT_MS,
        MSD_READY_TIMEOUT_DEFAULT_MS,
        MSD_READY_TIMEOUT_MAX_MS,
      ),
    },
    http,
  };
}

function pikvmFrom(host: string, username: string, password: string, deviceTls: DeviceTls, runtime: RuntimeConfig): Config['pikvm'] {
  return {
    host,
    username,
    password,
    verifySsl: deviceTls.mode === 'verify',
    tls: { default: deviceTls },
    defaultKeymap: runtime.defaultKeymap,
    requestTimeoutMs: runtime.requestTimeoutMs,
    msdJobTimeoutMs: runtime.msdJobTimeoutMs,
    msdIdleTimeoutMs: runtime.msdIdleTimeoutMs,
    ocrTimeoutMs: runtime.ocrTimeoutMs,
  };
}

/** Legacy PIKVM_HOST path. Unchanged when no registry is set. */
function loadLegacyConfig(): Config {
  const host = process.env.PIKVM_HOST;
  if (!host) {
    throw new Error('PIKVM_HOST environment variable is required');
  }

  const password = resolveSecret({
    name: 'PIKVM_PASSWORD',
    credName: 'pikvm-password',
    required: true,
  });

  const runtime = readRuntimeConfig();
  const deviceTls = resolveDefaultTls(host);
  return {
    pikvm: pikvmFrom(host, process.env.PIKVM_USERNAME || 'admin', password, deviceTls, runtime),
    calibration: runtime.calibration,
    msd: runtime.msd,
    screenshot: parseScreenshotEnv(),
    ocr: parseOcrSettings(),
    http: runtime.http,
  };
}

function loadConfigFromRegistry(registry: DeviceRegistry): Config {
  const runtime = readRuntimeConfig();
  const device = registry.devices.get(registry.defaultName);
  if (!device) {
    throw new Error(`registry default ${JSON.stringify(registry.defaultName)} is not a device`);
  }
  return {
    pikvm: pikvmFrom(device.host, device.username, device.password, device.tls, runtime),
    calibration: runtime.calibration,
    msd: runtime.msd,
    screenshot: parseScreenshotEnv(),
    ocr: parseOcrSettings(),
    http: runtime.http,
    registry,
  };
}

export function loadConfig(): Config {
  const registry = loadDeviceRegistry();
  if (registry) {
    if (process.env.PIKVM_HOST !== undefined && process.env.PIKVM_HOST !== '') {
      console.error('PIKVM_HOST was ignored because the device registry is set');
    }
    return loadConfigFromRegistry(registry);
  }
  return loadLegacyConfig();
}

/** Origin for a log. An unparseable host still loses userinfo and the query. */
function loggedHost(host: string): string {
  try {
    return new URL(host).origin;
  } catch {
    return redactUrl(host);
  }
}

/** A copy safe to log. Passwords, bearer, and pinned PEMs are replaced. */
export function redactConfig(config: Config): Config {
  const copy: Config = {
    ...config,
    pikvm: {
      ...config.pikvm,
      host: loggedHost(config.pikvm.host),
      password: '[REDACTED]',
      tls: { default: { ...config.pikvm.tls.default, certPem: undefined } },
    },
  };
  if (config.http) {
    copy.http = {
      ...config.http,
      bearerToken: config.http.bearerToken === undefined ? undefined : '[REDACTED]',
    };
  }
  if (config.registry) {
    const devices = new Map(config.registry.devices);
    for (const [name, device] of config.registry.devices) {
      devices.set(name, {
        ...device,
        host: loggedHost(device.host),
        password: '[REDACTED]',
        tls: { ...device.tls, certPem: undefined },
      });
    }
    copy.registry = { defaultName: config.registry.defaultName, devices };
  }
  return copy;
}
