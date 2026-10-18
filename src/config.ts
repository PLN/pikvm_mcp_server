// Modified 2026-10 by PLN: PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: MSD upload deadlines (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: cap MSD job at 7 days and idle at 1 hour (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_MCP_ARM_MSD (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: PIKVM_MSD_LOCAL_DIR and PIKVM_MSD_MAX_BYTES (GPL-3.0; see NOTICE).
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
  parseMsdTimeoutMs,
  parseRequestTimeoutMs,
} from './request-timeout.js';

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
}

export interface Config {
  pikvm: {
    host: string;
    username: string;
    password: string;
    verifySsl: boolean;
    defaultKeymap: string;
    /** Abort deadline for one ordinary kvmd call, from PIKVM_REQUEST_TIMEOUT_MS. */
    requestTimeoutMs: number;
    /** Wall clock for one MSD upload, from PIKVM_MSD_JOB_TIMEOUT_MS. Default 6 hours, max 7 days. */
    msdJobTimeoutMs: number;
    /** Idle gap for an MSD upload, from PIKVM_MSD_IDLE_TIMEOUT_MS. Default 60 seconds, max 1 hour. */
    msdIdleTimeoutMs: number;
  };
  calibration: {
    rounds: number;
    verifyRounds: number;
    moveDelayMs: number;
  };
  msd: MsdConfig;
  /** Present only when PIKVM_MCP_PORT is set (HTTP mode). */
  http?: HttpConfig;
}

export function loadConfig(): Config {
  const host = process.env.PIKVM_HOST;
  if (!host) {
    throw new Error('PIKVM_HOST environment variable is required');
  }

  const password = process.env.PIKVM_PASSWORD;
  if (!password) {
    throw new Error('PIKVM_PASSWORD environment variable is required');
  }

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

  const port = parseInt(process.env.PIKVM_MCP_PORT || '', 10);
  const http: HttpConfig | undefined = Number.isFinite(port) && port > 0
    ? {
        port,
        host: process.env.PIKVM_MCP_HOST || '127.0.0.1',
        bearerToken: process.env.PIKVM_MCP_BEARER,
        armHid: process.env.PIKVM_MCP_ARM_HID === '1',
        armMsd: process.env.PIKVM_MCP_ARM_MSD === '1',
      }
    : undefined;

  return {
    pikvm: {
      host,
      username: process.env.PIKVM_USERNAME || 'admin',
      password,
      verifySsl: process.env.PIKVM_VERIFY_SSL === 'true',
      defaultKeymap: process.env.PIKVM_DEFAULT_KEYMAP || 'en-us',
      requestTimeoutMs,
      msdJobTimeoutMs,
      msdIdleTimeoutMs,
    },
    calibration: {
      rounds: parseInt(process.env.PIKVM_CALIBRATION_ROUNDS || '5', 10),
      verifyRounds: parseInt(process.env.PIKVM_CALIBRATION_VERIFY_ROUNDS || '5', 10),
      moveDelayMs: parseInt(process.env.PIKVM_CALIBRATION_MOVE_DELAY || '300', 10),
    },
    msd: {
      localDir: parseMsdLocalDir(process.env.PIKVM_MSD_LOCAL_DIR),
      maxBytes: parseMsdMaxBytes(process.env.PIKVM_MSD_MAX_BYTES),
      extensions: parseMsdExtensions(process.env.PIKVM_MSD_EXTENSIONS),
    },
    http,
  };
}
