// Modified 2026-10 by PLN: TLS verify, pin, and insecure modes (GPL-3.0; see NOTICE).
// The pin options follow the design's undici check: ca is the pinned PEM,
// rejectUnauthorized stays true, and checkServerIdentity compares SPKI
// sha256. This file is written fresh.

/**
 * TLS for one kvmd device.
 *
 * verify uses the system trust store and the hostname check.
 * pin trusts only the pinned leaf and compares its SPKI sha256. The
 * hostname is not the identity. rejectUnauthorized is true: Node skips
 * checkServerIdentity when that flag is false, so a wrong pin would pass.
 * insecure leaves certificate checks off.
 *
 * A pin or verify failure is terminal. Nothing retries it as insecure.
 *
 * TODO(registry): Phase B item 10 copies this per device. The only key
 * today is "default".
 */

import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import tls from 'node:tls';
import { Agent, buildConnector } from 'undici';

export const TLS_PIN_MISMATCH = 'PIKVM_TLS_PIN_MISMATCH';
export const TLS_VERIFY_FAILED = 'PIKVM_TLS_VERIFY_FAILED';

/** A PEM certificate is small. Reject anything larger before reading it. */
export const TLS_CERT_MAX_BYTES = 64 * 1024;

/** Same open as a secret file: non-blocking, then fstat the fd. Not a secret, so a loose mode is not warned. */
const CERT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const TLS_VERIFY_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export type TlsMode = 'verify' | 'pin' | 'insecure';

export interface DeviceTls {
  /** Registry key. Only "default" until Phase B item 10. */
  device: string;
  mode: TlsMode;
  certFile?: string;
  certPem?: string;
  spkiSha256?: string;
}

export interface TlsDeviceMap {
  default: DeviceTls;
}

export interface KvmdTlsSource {
  host?: string;
  verifySsl?: boolean;
  tls?: { default?: DeviceTls };
}

interface CodedError {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

export function spkiSha256Of(cert: crypto.X509Certificate): string {
  const der = cert.publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export function pemFromDer(der: Buffer): string {
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function pinMismatchMessage(device: string, expected: string, presented: string): string {
  return `TLS pin mismatch for device ${device}: expected SPKI sha256 ${expected}, presented SPKI sha256 ${presented}. Verify the new certificate out of band and re-run \`pikvm-mcp-server pin ${device}\`.`;
}

export function pinMismatchError(device: string, expected: string, presented: string): NodeJS.ErrnoException {
  const err = new Error(pinMismatchMessage(device, expected, presented)) as NodeJS.ErrnoException;
  err.code = TLS_PIN_MISMATCH;
  return err;
}

/**
 * Pin must not be built on rejectUnauthorized:false. Node does not call
 * checkServerIdentity in that case, so the SPKI compare would be skipped.
 */
export function assertPinNotInsecure(options: {
  rejectUnauthorized?: boolean;
  checkServerIdentity?: unknown;
}): void {
  if (options.rejectUnauthorized !== true || typeof options.checkServerIdentity !== 'function') {
    throw new Error(
      'pin mode must set rejectUnauthorized true and checkServerIdentity; a false flag skips the pin',
    );
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'unknown';
}

function walk(err: unknown, pred: (item: CodedError) => boolean): CodedError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const coded = current as CodedError;
    if (pred(coded)) return coded;
    current = coded.cause;
  }
  return undefined;
}

export function isTlsVerifyCode(code: unknown): boolean {
  return typeof code === 'string' && TLS_VERIFY_CODES.has(code);
}

/** Pin and verify failures. Undefined when the error is some other transport failure. */
export function classifyTlsFailure(err: unknown, device: string): { type: string; message: string } | undefined {
  const pin = walk(err, (item) => {
    if (item.code === TLS_PIN_MISMATCH) return true;
    return typeof item.message === 'string' && item.message.startsWith('TLS pin mismatch for device ');
  });
  if (pin && typeof pin.message === 'string') {
    return { type: TLS_PIN_MISMATCH, message: pin.message };
  }
  const verify = walk(err, (item) => isTlsVerifyCode(item.code));
  if (verify && typeof verify.code === 'string') {
    return {
      type: TLS_VERIFY_FAILED,
      message: `TLS verification failed for device ${device} (${verify.code}): the certificate chain or hostname was rejected. This does not fall back to insecure. Run \`pikvm-mcp-server pin ${device}\` after out-of-band verification, or use verify mode with a certificate this host trusts.`,
    };
  }
  return undefined;
}

export function readPinnedCert(filePath: string): { pem: string; spkiSha256: string } {
  const label = 'PIKVM_TLS_CERT_FILE';
  let fd: number | undefined;
  try {
    try {
      fd = openSync(filePath, CERT_OPEN_FLAGS);
    } catch (err) {
      throw new Error(`${label} (${filePath}): cannot read (${errorCode(err)})`);
    }
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`${label} (${filePath}): not a regular file`);
    }
    if (opened.size > TLS_CERT_MAX_BYTES) {
      throw new Error(`${label} (${filePath}): larger than ${TLS_CERT_MAX_BYTES} bytes`);
    }
    if (opened.size === 0) {
      throw new Error(`${label} (${filePath}): empty`);
    }
    const buf = Buffer.alloc(opened.size);
    let off = 0;
    while (off < opened.size) {
      const n = readSync(fd, buf, off, opened.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const pem = buf.subarray(0, off).toString('utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error(`${label} (${filePath}): not a certificate`);
    }
    try {
      const parsed = new crypto.X509Certificate(pem);
      return { pem, spkiSha256: spkiSha256Of(parsed) };
    } catch {
      throw new Error(`${label} (${filePath}): not a certificate`);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeCertAtomic(filePath: string, pem: string): void {
  const tmp = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    writeSync(fd, pem);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o644);
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o644);
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file was already renamed, or it was never created.
    }
    throw err;
  }
}

function presentedFromPeer(cert: tls.PeerCertificate): string {
  return spkiSha256Of(new crypto.X509Certificate(cert.raw));
}

function comparePin(spec: DeviceTls, cert: tls.PeerCertificate): Error | undefined {
  const expected = spec.spkiSha256 ?? '';
  let presented: string;
  try {
    presented = presentedFromPeer(cert);
  } catch {
    return pinMismatchError(spec.device, expected, 'unreadable');
  }
  if (presented !== expected) return pinMismatchError(spec.device, expected, presented);
  return undefined;
}

/** Options passed to TLS. Pin always sets rejectUnauthorized true. */
export function kvmdConnectOptions(spec: DeviceTls): tls.ConnectionOptions {
  if (spec.mode === 'verify') return { rejectUnauthorized: true };
  if (spec.mode === 'insecure') return { rejectUnauthorized: false };
  if (spec.mode !== 'pin') {
    throw new Error('PIKVM_TLS_MODE must be verify, pin, or insecure');
  }
  if (!spec.certPem || !spec.spkiSha256) {
    throw new Error(`PIKVM_TLS_CERT_FILE is required when PIKVM_TLS_MODE=pin`);
  }
  const options: tls.ConnectionOptions = {
    rejectUnauthorized: true,
    ca: spec.certPem,
    checkServerIdentity(_hostname, cert) {
      return comparePin(spec, cert);
    },
  };
  assertPinNotInsecure(options);
  return options;
}

function armPresentedPin(socket: tls.TLSSocket, spec: DeviceTls): void {
  const expected = spec.spkiSha256;
  if (!expected) return;
  const orig = socket.destroy.bind(socket);
  let once = false;
  socket.destroy = ((err?: Error) => {
    if (!once && err) {
      once = true;
      const coded = err as NodeJS.ErrnoException;
      if (coded.code !== TLS_PIN_MISMATCH && isTlsVerifyCode(coded.code)) {
        try {
          const peer = socket.getPeerCertificate(true);
          if (peer?.raw) {
            const presented = spkiSha256Of(new crypto.X509Certificate(peer.raw));
            if (presented !== expected) {
              err = pinMismatchError(spec.device, expected, presented);
            }
          }
        } catch {
          // The chain error still fails the request. It is not retried as insecure.
        }
      }
    }
    return orig(err);
  }) as typeof socket.destroy;
}

function kvmdConnector(spec: DeviceTls): tls.ConnectionOptions | buildConnector.connector {
  const options = kvmdConnectOptions(spec);
  if (spec.mode !== 'pin') return options;
  assertPinNotInsecure(options);
  const inner = buildConnector({
    rejectUnauthorized: true,
    ca: options.ca,
    checkServerIdentity: options.checkServerIdentity,
  });
  const connect: buildConnector.connector = (connectOptions, callback) => {
    const socket = (inner as (
      options: buildConnector.Options,
      cb: buildConnector.Callback,
    ) => tls.TLSSocket)(connectOptions, callback);
    if (socket && typeof socket.getPeerCertificate === 'function') {
      armPresentedPin(socket, spec);
    }
  };
  return connect;
}

export function deviceTlsFrom(config: KvmdTlsSource): DeviceTls {
  const configured = config.tls?.default;
  if (configured?.mode === 'verify' || configured?.mode === 'pin' || configured?.mode === 'insecure') {
    return {
      device: configured.device || 'default',
      mode: configured.mode,
      certFile: configured.certFile,
      certPem: configured.certPem,
      spkiSha256: configured.spkiSha256,
    };
  }
  return {
    device: 'default',
    mode: config.verifySsl ? 'verify' : 'insecure',
  };
}

export function createKvmdAgent(
  config: KvmdTlsSource,
  timeouts?: { headersTimeout?: number; bodyTimeout?: number },
): Agent {
  const spec = deviceTlsFrom(config);
  if ((spec.mode === 'pin' || spec.mode === 'verify') && config.host && !config.host.startsWith('https:')) {
    throw new Error(`PIKVM_TLS_MODE=${spec.mode} requires an https PIKVM_HOST`);
  }
  return new Agent({
    connect: kvmdConnector(spec),
    headersTimeout: timeouts?.headersTimeout ?? 0,
    bodyTimeout: timeouts?.bodyTimeout ?? 0,
  });
}

export interface ProbedCertificate {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  certSha256: string;
  spkiSha256: string;
  pem: string;
}

/**
 * One TLS handshake. Verification is off only for this probe.
 * No HTTP request is written and no credential is sent.
 */
export function probeLeafCertificate(hostUrl: string): Promise<ProbedCertificate> {
  const url = new URL(hostUrl);
  if (url.protocol !== 'https:') {
    return Promise.reject(new Error('PIKVM_HOST must be an https URL'));
  }
  const hostname = url.hostname;
  const port = url.port === '' ? 443 : Number(url.port);
  const servername = hostname.includes(':') || netIsIp(hostname) ? undefined : hostname;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: hostname,
      port,
      servername,
      rejectUnauthorized: false,
    });
    const fail = (err: unknown) => {
      socket.destroy();
      reject(err instanceof Error ? err : new Error('TLS handshake failed'));
    };
    socket.setTimeout(10_000, () => fail(new Error('TLS handshake timed out')));
    socket.once('error', fail);
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate();
        if (!peer?.raw) throw new Error('the server presented no certificate');
        const parsed = new crypto.X509Certificate(peer.raw);
        const probed: ProbedCertificate = {
          subject: parsed.subject,
          issuer: parsed.issuer,
          validFrom: parsed.validFrom,
          validTo: parsed.validTo,
          certSha256: crypto.createHash('sha256').update(parsed.raw).digest('hex'),
          spkiSha256: spkiSha256Of(parsed),
          pem: pemFromDer(parsed.raw),
        };
        socket.destroy();
        resolve(probed);
      } catch (err) {
        fail(err);
      }
    });
  });
}

function netIsIp(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}
