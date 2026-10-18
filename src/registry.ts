// Modified 2026-10 by PLN: device registry (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: reject a duplicate device key and a shared origin (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: http and https on one host are the same device (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: per-device screenshot preview defaults (GPL-3.0; see NOTICE).
// Host normalisation follows the idea of dtrukr/pikvm_mcp_server
// normalizeHost at 097b529 (GPL-3.0, a fork of
// KultivatorConsulting/pikvm_mcp_server). This file is written fresh.
// There is no IP-range allow or deny.

/**
 * PIKVM_DEVICES_FILE or PIKVM_DEVICES. One registry, or neither.
 * The file is not a secret: the open matches a secret file, without a
 * mode warning. Passwords come from passwordFile or passwordCredential.
 * An inline password key is rejected.
 */

import { readCappedFile, readSecretAtPath, credentialFilePath, SECRET_MAX_BYTES } from './secrets.js';
import { readPinnedCert, type DeviceTls, type TlsMode } from './tls.js';
import {
  mergeScreenshot,
  parseScreenshotEnv,
  parseScreenshotOverride,
  type ScreenshotSettings,
} from './screenshot.js';

export const REGISTRY_MAX_BYTES = SECRET_MAX_BYTES;

const DEVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const TOP_KEYS = ['default', 'devices'] as const;

const DEVICE_KEYS = [
  'host',
  'username',
  'passwordFile',
  'passwordCredential',
  'tls',
  'armHid',
  'armMsd',
  'msdLocalDir',
  'hwTest',
  'screenshot',
] as const;

export interface RegistryDevice {
  host: string;
  username: string;
  password: string;
  tls: DeviceTls;
  /** Omitted means the process ceiling is left as it is. */
  armHid?: boolean;
  armMsd?: boolean;
  msdLocalDir?: string;
  hwTest: boolean;
  /** Environment defaults with this device's screenshot fields applied. */
  screenshot: ScreenshotSettings;
}

export interface DeviceRegistry {
  defaultName: string;
  devices: Map<string, RegistryDevice>;
}

export interface LoadRegistryOptions {
  /**
   * When false, pin mode keeps certFile and does not read it.
   * `pikvm-mcp-server pin` uses that so the file can be created.
   */
  requirePinnedCert?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function present(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  const value = env[key];
  if (value === undefined || value === '') return undefined;
  return value;
}

function unknownField(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return key;
  }
  return undefined;
}

/**
 * An http(s) origin. A path, query, or fragment is dropped.
 * Userinfo is an error and is not copied into the message.
 */
export function normalizeHost(raw: string, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label}: host must be an http or https origin`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}: host must be an http or https origin`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}: host must be an http or https origin`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${label}: host must not include userinfo`);
  }
  if (url.hostname === '') {
    throw new Error(`${label}: host must be an http or https origin`);
  }
  return url.origin;
}

function optionalBoolean(device: string, field: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`device ${device} ${field}: must be a boolean`);
  }
  return value;
}

function resolvePassword(device: string, raw: Record<string, unknown>, env: NodeJS.ProcessEnv): string {
  if (Object.prototype.hasOwnProperty.call(raw, 'password')) {
    throw new Error(`device ${device}: password is not accepted. Use passwordFile or passwordCredential`);
  }
  const hasFile = raw.passwordFile !== undefined;
  const hasCred = raw.passwordCredential !== undefined;
  if (hasFile && hasCred) {
    throw new Error(`device ${device}: set passwordFile or passwordCredential, not both`);
  }
  if (!hasFile && !hasCred) {
    throw new Error(`device ${device}: set passwordFile or passwordCredential`);
  }
  if (hasFile) {
    if (typeof raw.passwordFile !== 'string' || raw.passwordFile === '') {
      throw new Error(`device ${device} passwordFile: must be a non-empty string`);
    }
    return readSecretAtPath(raw.passwordFile, `device ${device} passwordFile`);
  }
  if (typeof raw.passwordCredential !== 'string' || raw.passwordCredential === '') {
    throw new Error(`device ${device} passwordCredential: must be a single path segment`);
  }
  const directory = env.CREDENTIALS_DIRECTORY;
  if (directory === undefined || directory === '') {
    throw new Error(`device ${device} passwordCredential: CREDENTIALS_DIRECTORY is unset`);
  }
  let full: string;
  try {
    full = credentialFilePath(directory, raw.passwordCredential);
  } catch {
    throw new Error(`device ${device} passwordCredential: must be a single path segment`);
  }
  return readSecretAtPath(full, `device ${device} passwordCredential`);
}

function resolveDeviceTls(
  device: string,
  host: string,
  raw: unknown,
  requirePinnedCert: boolean,
): DeviceTls {
  let mode: TlsMode | undefined;
  let certFile: string | undefined;
  if (raw !== undefined) {
    if (!isPlainObject(raw)) throw new Error(`device ${device}: tls must be an object`);
    const extra = unknownField(raw, ['mode', 'certFile']);
    if (extra !== undefined) {
      throw new Error(`device ${device} tls: unknown field ${JSON.stringify(extra)}`);
    }
    if (raw.mode !== undefined) {
      if (raw.mode !== 'verify' && raw.mode !== 'pin' && raw.mode !== 'insecure') {
        throw new Error(`device ${device} tls.mode must be verify, pin, or insecure`);
      }
      mode = raw.mode;
    }
    if (raw.certFile !== undefined) {
      if (typeof raw.certFile !== 'string' || raw.certFile === '') {
        throw new Error(`device ${device} tls.certFile must be a non-empty string`);
      }
      certFile = raw.certFile;
    }
  }
  if (mode === undefined) {
    console.error(
      `PIKVM_TLS_MODE=insecure for device ${device} because tls.mode is unset. Pin the certificate with: pikvm-mcp-server pin ${device}`,
    );
    mode = 'insecure';
  } else if (mode === 'insecure') {
    console.error(
      `PIKVM_TLS_MODE=insecure for device ${device} (certificate checks are off). Pin the certificate with: pikvm-mcp-server pin ${device}`,
    );
  }
  if (certFile !== undefined && mode !== 'pin') {
    throw new Error(`device ${device} tls.certFile is only valid when tls.mode is pin`);
  }
  if (mode === 'pin' && certFile === undefined) {
    throw new Error(`device ${device} tls.certFile is required when tls.mode is pin`);
  }
  if ((mode === 'pin' || mode === 'verify') && !host.startsWith('https:')) {
    throw new Error(`device ${device}: tls.mode ${mode} requires an https host`);
  }
  if (mode !== 'pin' || certFile === undefined) {
    return { device, mode };
  }
  if (!requirePinnedCert) {
    return { device, mode, certFile };
  }
  try {
    const pinned = readPinnedCert(certFile);
    return {
      device,
      mode,
      certFile,
      certPem: pinned.pem,
      spkiSha256: pinned.spkiSha256,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'cannot read';
    throw new Error(`device ${device} tls.certFile: ${message}`);
  }
}

function parseDevice(name: string, raw: unknown, env: NodeJS.ProcessEnv, requirePinnedCert: boolean): RegistryDevice {
  if (!isPlainObject(raw)) throw new Error(`device ${name}: must be an object`);
  if (Object.prototype.hasOwnProperty.call(raw, 'password')) {
    throw new Error(`device ${name}: password is not accepted. Use passwordFile or passwordCredential`);
  }
  const extra = unknownField(raw, DEVICE_KEYS);
  if (extra !== undefined) {
    throw new Error(`device ${name}: unknown field ${JSON.stringify(extra)}`);
  }
  if (typeof raw.host !== 'string') throw new Error(`device ${name}: host is required`);
  const host = normalizeHost(raw.host, `device ${name} host`);
  if (typeof raw.username !== 'string' || raw.username.length === 0) {
    throw new Error(`device ${name}: username is required`);
  }
  if (raw.username.includes('\n') || raw.username.includes('\r')) {
    throw new Error(`device ${name}: username must not contain a newline`);
  }
  const password = resolvePassword(name, raw, env);
  const tls = resolveDeviceTls(name, host, raw.tls, requirePinnedCert);
  let msdLocalDir: string | undefined;
  if (raw.msdLocalDir !== undefined) {
    if (typeof raw.msdLocalDir !== 'string' || raw.msdLocalDir.trim() === '') {
      throw new Error(`device ${name} msdLocalDir: must be a non-empty string`);
    }
    msdLocalDir = raw.msdLocalDir;
  }
  const hwTest = optionalBoolean(name, 'hwTest', raw.hwTest) === true;
  const screenshot = mergeScreenshot(parseScreenshotEnv(env), parseScreenshotOverride(name, raw.screenshot));
  return {
    host,
    username: raw.username,
    password,
    tls,
    armHid: optionalBoolean(name, 'armHid', raw.armHid),
    armMsd: optionalBoolean(name, 'armMsd', raw.armMsd),
    msdLocalDir,
    hwTest,
    screenshot,
  };
}

export function parseDeviceRegistry(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: LoadRegistryOptions = {},
): DeviceRegistry {
  if (!isPlainObject(value)) throw new Error('registry must be a JSON object');
  const extra = unknownField(value, TOP_KEYS);
  if (extra !== undefined) {
    throw new Error(`registry: unknown field ${JSON.stringify(extra)}`);
  }
  if (!isPlainObject(value.devices)) throw new Error('registry devices must be an object');
  // Duplicate device names are rejected from the raw JSON before parse.
  const names = Object.keys(value.devices);
  if (names.length === 0) throw new Error('registry devices must name at least one device');
  for (const name of names) {
    if (!DEVICE_NAME.test(name)) {
      throw new Error(`registry device name ${JSON.stringify(name)} is not a safe slug`);
    }
  }
  let defaultName: string | undefined;
  if (value.default !== undefined) {
    if (typeof value.default !== 'string' || !DEVICE_NAME.test(value.default)) {
      throw new Error('registry default must name a device');
    }
    defaultName = value.default;
  } else if (names.length === 1) {
    defaultName = names[0];
  } else {
    throw new Error('registry default is required when more than one device is set');
  }
  if (!Object.prototype.hasOwnProperty.call(value.devices, defaultName)) {
    throw new Error(`registry default ${JSON.stringify(defaultName)} is not a device`);
  }
  const requirePinnedCert = options.requirePinnedCert !== false;
  const devices = new Map<string, RegistryDevice>();
  for (const name of names) {
    devices.set(name, parseDevice(name, value.devices[name], env, requirePinnedCert));
  }
  const seen = new Map<string, { name: string; origin: string }>();
  for (const [name, device] of devices) {
    const key = deviceEndpointKey(device.host);
    const previous = seen.get(key);
    if (previous !== undefined) {
      const why = previous.origin === device.host ? 'use the same origin' : 'use the same host';
      throw new Error(
        `registry devices ${JSON.stringify(previous.name)} and ${JSON.stringify(name)} ${why}`,
      );
    }
    seen.set(key, { name, origin: device.host });
  }
  return { defaultName, devices };
}

/**
 * Hostname plus an explicit port. A scheme-default port is omitted, so
 * http://h and https://h share a key. The same explicit port shares a
 * key across schemes.
 */
function deviceEndpointKey(origin: string): string {
  const url = new URL(origin);
  if (url.port === '') return url.hostname;
  return `${url.hostname}:${url.port}`;
}

/** Repeated device name in the raw devices object, if there is one. */
function duplicateDeviceName(text: string): string | undefined {
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    while (i < n && text.charCodeAt(i) <= 32) i += 1;
  }

  function fail(): never {
    throw new Error('registry scan');
  }

  function parseString(): string {
    if (text[i] !== '"') fail();
    i += 1;
    let out = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i += 1;
        return out;
      }
      if (c === '\\') {
        i += 1;
        if (i >= n) fail();
        const e = text[i];
        i += 1;
        if (e === 'u') {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          continue;
        }
        if (e === '"' || e === '\\' || e === '/') {
          out += e;
          continue;
        }
        if (e === 'b') { out += '\b'; continue; }
        if (e === 'f') { out += '\f'; continue; }
        if (e === 'n') { out += '\n'; continue; }
        if (e === 'r') { out += '\r'; continue; }
        if (e === 't') { out += '\t'; continue; }
        fail();
      }
      out += c;
      i += 1;
    }
    fail();
  }

  function skipValue(): void {
    skipWs();
    const c = text[i];
    if (c === '"') {
      parseString();
      return;
    }
    if (c === '{') {
      skipObject();
      return;
    }
    if (c === '[') {
      skipArray();
      return;
    }
    if (c === 't' || c === 'f' || c === 'n' || c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
      while (i < n) {
        const code = text.charCodeAt(i);
        if (code <= 32 || text[i] === ',' || text[i] === ']' || text[i] === '}') break;
        i += 1;
      }
      return;
    }
    fail();
  }

  function skipObject(): void {
    if (text[i] !== '{') fail();
    i += 1;
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return;
    }
    for (;;) {
      skipWs();
      parseString();
      skipWs();
      if (text[i] !== ':') fail();
      i += 1;
      skipValue();
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return;
      }
      fail();
    }
  }

  function skipArray(): void {
    if (text[i] !== '[') fail();
    i += 1;
    skipWs();
    if (text[i] === ']') {
      i += 1;
      return;
    }
    for (;;) {
      skipValue();
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return;
      }
      fail();
    }
  }

  function deviceNames(): string | undefined {
    if (text[i] !== '{') fail();
    i += 1;
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return undefined;
    }
    const seen = new Set<string>();
    for (;;) {
      skipWs();
      const name = parseString();
      if (seen.has(name)) return name;
      seen.add(name);
      skipWs();
      if (text[i] !== ':') fail();
      i += 1;
      skipValue();
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return undefined;
      }
      fail();
    }
  }

  function scan(): string | undefined {
    skipWs();
    if (text[i] !== '{') return undefined;
    i += 1;
    skipWs();
    if (text[i] === '}') return undefined;
    for (;;) {
      skipWs();
      const key = parseString();
      skipWs();
      if (text[i] !== ':') fail();
      i += 1;
      skipWs();
      if (key === 'devices' && text[i] === '{') {
        const duplicate = deviceNames();
        if (duplicate !== undefined) return duplicate;
      } else {
        skipValue();
      }
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') return undefined;
      fail();
    }
  }

  try {
    return scan();
  } catch {
    return undefined;
  }
}

/** Undefined when neither registry variable is set. Both set is an error. */
export function loadDeviceRegistry(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadRegistryOptions = {},
): DeviceRegistry | undefined {
  const file = present(env, 'PIKVM_DEVICES_FILE');
  const inline = present(env, 'PIKVM_DEVICES');
  if (file !== undefined && inline !== undefined) {
    throw new Error('set PIKVM_DEVICES_FILE or PIKVM_DEVICES, not both');
  }
  if (file === undefined && inline === undefined) return undefined;
  let text: string;
  let label: string;
  if (file !== undefined) {
    label = 'PIKVM_DEVICES_FILE';
    text = readCappedFile(file, label, REGISTRY_MAX_BYTES, false).toString('utf8');
  } else {
    label = 'PIKVM_DEVICES';
    text = inline ?? '';
    if (Buffer.byteLength(text) > REGISTRY_MAX_BYTES) {
      throw new Error(`${label}: larger than ${REGISTRY_MAX_BYTES} bytes`);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const duplicate = duplicateDeviceName(text);
  if (duplicate !== undefined) {
    throw new Error(`registry device name ${JSON.stringify(duplicate)} is duplicated`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
  return parseDeviceRegistry(parsed, env, options);
}
