// Modified 2026-10 by PLN: secret files and LoadCredential (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: skip the group-mode warning for a systemd credential (GPL-3.0; see NOTICE).
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
 * file, so a directory, FIFO, socket, or device is rejected. Other bits
 * (o+rwx) are warned on stderr. Group bits are warned the same way,
 * except for a direct child of $CREDENTIALS_DIRECTORY that is not a
 * symlink and whose directory realpath is under /run/credentials/<name>/.
 * systemd often leaves that file at mode 0440 because of an ACL mask.
 * The reader does not chmod, chown, or copy the file. The value is never
 * logged. The mode check is skipped on Windows. Files larger than
 * SECRET_MAX_BYTES are rejected before the body is read.
 *
 * A registry passwordFile uses readSecretAtPath, the same reader. The
 * registry JSON itself is not a secret: readCappedFile does not warn
 * about the mode.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

/** A wrong path must not be read into memory. */
export const SECRET_MAX_BYTES = 64 * 1024;

/**
 * Parent of systemd system-service credential directories.
 * Production uses this path. Tests pass a directory they can create.
 */
export const SYSTEMD_CREDENTIALS_ROOT = '/run/credentials';

export interface SecretModeOptions {
  /** Environment that may set CREDENTIALS_DIRECTORY. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * Stand-in for /run/credentials. Omitted in production.
   * An empty string is the production root.
   */
  credentialsRoot?: string;
}

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
  /** Stand-in for /run/credentials. Omitted in production. */
  credentialsRoot?: string;
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

function credentialsRootOf(value: string | undefined): string {
  if (value === undefined || value === '') return SYSTEMD_CREDENTIALS_ROOT;
  return value;
}

/**
 * Group-bit exemption for one systemd credential file.
 * The opened path must not be a symlink. Its real path must be a direct
 * child of the real CREDENTIALS_DIRECTORY, and that directory must sit
 * under /run/credentials/<name>/ rather than on /run/credentials itself.
 */
function isSystemdCredentialFile(
  filePath: string,
  env: NodeJS.ProcessEnv,
  credentialsRoot: string,
): boolean {
  const credDir = env.CREDENTIALS_DIRECTORY;
  if (credDir === undefined || credDir === '') return false;
  try {
    if (lstatSync(filePath).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let resolvedFile: string;
  let resolvedDir: string;
  let resolvedRoot: string;
  try {
    resolvedFile = realpathSync(filePath);
    resolvedDir = realpathSync(credDir);
    resolvedRoot = realpathSync(credentialsRoot);
  } catch {
    return false;
  }
  if (path.dirname(resolvedFile) !== resolvedDir) return false;
  if (resolvedDir === resolvedRoot) return false;
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (relative === '' || path.isAbsolute(relative)) return false;
  if (relative.split(path.sep).includes('..')) return false;
  return true;
}

function warnLooseMode(
  label: string,
  filePath: string,
  mode: number,
  env: NodeJS.ProcessEnv,
  credentialsRoot: string,
): void {
  if (process.platform === 'win32') return;
  const other = (mode & 0o007) !== 0;
  const group = (mode & 0o070) !== 0;
  if (!other && !group) return;
  // Other bits always warn. Group bits are skipped only for a systemd credential file.
  const groupWarn = group && !isSystemdCredentialFile(filePath, env, credentialsRoot);
  if (!other && !groupWarn) return;
  const octal = (mode & 0o777).toString(8).padStart(4, '0');
  let which: string;
  if (groupWarn && other) which = 'group or other bits are set';
  else if (other) which = 'other bits are set';
  else which = 'group bits are set';
  console.error(`${label} (${filePath}) is mode ${octal}; ${which}`);
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
 * Open a regular file without blocking on a FIFO. The size cap is
 * checked on the fd before the body is read. `warnMode` is for secrets.
 * A registry document passes false.
 */
export function readCappedFile(
  filePath: string,
  label: string,
  maxBytes: number,
  warnMode: boolean,
  options?: SecretModeOptions,
): Buffer {
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, SECRET_OPEN_FLAGS);
    } catch (err) {
      throw new Error(`${label} (${filePath}): cannot read (${errorCode(err)})`);
    }
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`${label} (${filePath}): not a regular file`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`${label} (${filePath}): larger than ${maxBytes} bytes`);
    }
    if (warnMode) {
      warnLooseMode(
        label,
        filePath,
        opened.mode,
        options?.env ?? process.env,
        credentialsRootOf(options?.credentialsRoot),
      );
    }
    const buf = Buffer.alloc(opened.size);
    let off = 0;
    while (off < opened.size) {
      const n = readSync(fd, buf, off, opened.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readSecretFile(
  filePath: string,
  label: string,
  missingIsUnset: boolean,
  options?: SecretModeOptions,
): string | undefined {
  let buf: Buffer;
  try {
    buf = readCappedFile(filePath, label, SECRET_MAX_BYTES, true, options);
  } catch (err) {
    if (missingIsUnset && err instanceof Error && err.message.endsWith('(ENOENT)')) return undefined;
    throw err;
  }
  return decodeSecretFile(buf, label, filePath);
}

/** passwordFile and a LoadCredential segment. Errors name `label` and the path, not the value. */
export function readSecretAtPath(
  filePath: string,
  label: string,
  options?: SecretModeOptions,
): string {
  const value = readSecretFile(filePath, label, false, options);
  if (value === undefined) {
    throw new Error(`${label} (${filePath}): cannot read (ENOENT)`);
  }
  return value;
}

export function credentialFilePath(directory: string, credName: string): string {
  return credentialPath(directory, credName);
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
  const modeOptions: SecretModeOptions = { env, credentialsRoot: spec.credentialsRoot };
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
    const fromFile = readSecretFile(filePath, fileVar, false, modeOptions);
    if (fromFile === undefined) {
      throw new Error(`${fileVar} (${filePath}): cannot read (ENOENT)`);
    }
    return fromFile;
  }

  const credDir = env.CREDENTIALS_DIRECTORY;
  if (credDir !== undefined && credDir !== '') {
    const full = credentialPath(credDir, spec.credName);
    const fromCred = readSecretFile(full, `${name} from CREDENTIALS_DIRECTORY`, true, modeOptions);
    if (fromCred !== undefined) return fromCred;
  }

  if (spec.required) {
    throw new Error(
      `${name} is required (set ${name}, ${fileVar}, or CREDENTIALS_DIRECTORY/${spec.credName})`,
    );
  }
  return undefined;
}
