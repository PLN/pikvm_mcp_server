// Modified 2026-10 by PLN: secret files and LoadCredential (GPL-3.0; see NOTICE).
// The resolution order follows dvaerum/pikvm_mcp_server src/config.ts
// resolveSecret at afbe454d42a5b994bf903883a2712c0e77e84a7b (GPL-3.0, a fork
// of KultivatorConsulting/pikvm_mcp_server). This file is written fresh.

/**
 * Resolve one secret from the environment, a file, or systemd LoadCredential.
 *
 * Order, per secret: the direct env var, then <NAME>_FILE, then
 * $CREDENTIALS_DIRECTORY/<credName> when CREDENTIALS_DIRECTORY is set.
 * An empty direct value and an empty <NAME>_FILE are unset, so the next
 * source is tried. A missing credential file means unset, not a read error.
 * A missing <NAME>_FILE path is an error.
 *
 * Direct env values are kept verbatim, including a trailing newline.
 * File bytes lose one trailing newline (LF or CRLF) and a leading UTF-8
 * BOM. No other whitespace is removed. Empty file content is an error.
 * A NUL byte in the file is an error that names the variable and the path.
 * The file is opened O_RDONLY|O_NONBLOCK and then fstat'd, so a FIFO does
 * not block. Symlinks are followed. The opened target must be a regular
 * file, so a directory, FIFO, socket, or device is rejected. A mode with
 * any group or other bits (looser than 0600) is warned on stderr. The
 * value is never logged. The mode check is skipped on Windows. Files
 * larger than SECRET_MAX_BYTES are rejected before the body is read.
 *
 * TODO(registry): Phase B item 10's passwordFile should call resolveSecret
 * instead of reading a device password on its own.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from 'node:fs';
import path from 'node:path';

/** A wrong path must not be read into memory. */
export const SECRET_MAX_BYTES = 64 * 1024;

/** Follow symlinks. O_NONBLOCK so a FIFO open returns instead of waiting. */
const SECRET_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export interface ResolveSecretSpec {
  /** Env var that holds the secret directly, such as PIKVM_PASSWORD. */
  name: string;
  /** LoadCredential name, a single path segment such as pikvm-password. */
  credName: string;
  /** When true, an unresolved secret throws. A bearer is required only for HTTP. */
  required?: boolean;
  /** Defaults to process.env. Tests pass a plain object. */
  env?: NodeJS.ProcessEnv;
}

interface RequiredSecret extends ResolveSecretSpec {
  required: true;
}

function stripOneTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

function assertCredName(credName: string): void {
  if (
    typeof credName !== 'string'
    || credName.length === 0
    || credName.length > 128
    || !/^[A-Za-z0-9._-]+$/.test(credName)
    || credName === '.'
    || credName === '..'
  ) {
    throw new Error('credential name must be a single path segment');
  }
}

function credentialPath(directory: string, credName: string): string {
  assertCredName(credName);
  const root = path.resolve(directory);
  const full = path.resolve(root, credName);
  if (path.dirname(full) !== root) {
    throw new Error('credential name must be a single path segment');
  }
  return full;
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return 'unknown';
}

function warnLooseMode(label: string, filePath: string, mode: number): void {
  if (process.platform === 'win32') return;
  if ((mode & 0o077) === 0) return;
  const octal = (mode & 0o777).toString(8).padStart(4, '0');
  console.error(`${label} (${filePath}) is mode ${octal}; group or other bits are set`);
}

function decodeSecretFile(bytes: Buffer, label: string, filePath: string): string {
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }
  if (body.includes(0)) {
    throw new Error(`${label} (${filePath}): contains a NUL byte`);
  }
  const text = stripOneTrailingNewline(body.toString('utf8'));
  if (text.length === 0) {
    throw new Error(`${label} (${filePath}): empty`);
  }
  return text;
}

/**
 * Read a secret file. `label` is the env var name and is the only
 * identifier included in errors, together with the path.
 * The open is non-blocking. Kind, size, and mode come from that fd.
 */
function readSecretFile(filePath: string, label: string, missingIsUnset: boolean): string | undefined {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, SECRET_OPEN_FLAGS);
    } catch (err) {
      if (missingIsUnset && errorCode(err) === 'ENOENT') return undefined;
      throw new Error(`${label} (${filePath}): cannot read (${errorCode(err)})`);
    }
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`${label} (${filePath}): not a regular file`);
    }
    if (opened.size > SECRET_MAX_BYTES) {
      throw new Error(`${label} (${filePath}): larger than ${SECRET_MAX_BYTES} bytes`);
    }
    warnLooseMode(label, filePath, opened.mode);
    const buf = Buffer.alloc(opened.size);
    let off = 0;
    while (off < opened.size) {
      const n = readSync(fd, buf, off, opened.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return decodeSecretFile(buf.subarray(0, off), label, filePath);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${label} (`)) throw err;
    throw new Error(`${label} (${filePath}): cannot read (${errorCode(err)})`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A present, non-empty variable. "" is unset so the next source can run. */
function presentEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, key)) return undefined;
  const value = env[key];
  if (value === undefined || value === '') return undefined;
  return value;
}

export function resolveSecret(spec: RequiredSecret): string;
export function resolveSecret(spec: ResolveSecretSpec): string | undefined;
export function resolveSecret(spec: ResolveSecretSpec): string | undefined {
  const env = spec.env ?? process.env;
  const name = spec.name;
  const fileVar = `${name}_FILE`;
  assertCredName(spec.credName);

  const direct = presentEnv(env, name);
  const filePath = presentEnv(env, fileVar);
  if (direct !== undefined) {
    if (filePath !== undefined) {
      console.error(`${fileVar} is set and was ignored because ${name} is set`);
    }
    return direct;
  }

  if (filePath !== undefined) {
    const fromFile = readSecretFile(filePath, fileVar, false);
    if (fromFile === undefined) {
      throw new Error(`${fileVar} (${filePath}): cannot read (ENOENT)`);
    }
    return fromFile;
  }

  const credDir = env.CREDENTIALS_DIRECTORY;
  if (credDir !== undefined && credDir !== '') {
    const full = credentialPath(credDir, spec.credName);
    const fromCred = readSecretFile(full, `${name} from CREDENTIALS_DIRECTORY`, true);
    if (fromCred !== undefined) return fromCred;
  }

  if (spec.required) {
    throw new Error(
      `${name} is required (set ${name}, ${fileVar}, or CREDENTIALS_DIRECTORY/${spec.credName})`,
    );
  }
  return undefined;
}
