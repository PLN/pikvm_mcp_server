// Modified 2026-10 by PLN: TLS verify, pin, and insecure modes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: classify TLS from the socket, and trust a pinned leaf (GPL-3.0; see NOTICE).
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
 * allowPartialTrustChain lets that leaf be a CA-signed certificate, which
 * is what `pin default` writes for a Tailscale or public-CA cert. Pin the
 * leaf, not a CA or intermediate: those keys do not match the leaf, so
 * the result is a pin mismatch. insecure leaves certificate checks off.
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
import net from 'node:net';
import { basename, dirname, join } from 'node:path';
import tls from 'node:tls';
import { Agent, buildConnector } from 'undici';

export const TLS_PIN_MISMATCH = 'PIKVM_TLS_PIN_MISMATCH';
export const TLS_VERIFY_FAILED = 'PIKVM_TLS_VERIFY_FAILED';

/** A PEM certificate is small. Reject anything larger before reading it. */
export const TLS_CERT_MAX_BYTES = 64 * 1024;

/** Same open as a secret file: non-blocking, then fstat the fd. Not a secret, so a loose mode is not warned. */
const CERT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Backstop only. A handshake that reached a certificate is classified
 * from socket.authorized and the peer cert, including codes that are
 * not in this set. These names are the OpenSSL X509 verify codes Node
 * surfaces, plus Node's own hostname error.
 */
const TLS_VERIFY_CODES = new Set([
  'UNSPECIFIED',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'OUT_OF_MEM',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'NO_ISSUER_PUBLIC_KEY',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'SUBJECT_ISSUER_MISMATCH',
  'AKID_SKID_MISMATCH',
  'AKID_ISSUER_SERIAL_MISMATCH',
  'KEYUSAGE_NO_CERTSIGN',
  'UNABLE_TO_GET_CRL_ISSUER',
  'UNHANDLED_CRITICAL_EXTENSION',
  'KEYUSAGE_NO_CRL_SIGN',
  'UNHANDLED_CRITICAL_CRL_EXTENSION',
  'INVALID_NON_CA',
  'PROXY_PATH_LENGTH_EXCEEDED',
  'KEYUSAGE_NO_DIGITAL_SIGNATURE',
  'PROXY_CERTIFICATES_NOT_ALLOWED',
  'INVALID_EXTENSION',
  'INVALID_POLICY_EXTENSION',
  'NO_EXPLICIT_POLICY',
  'DIFFERENT_CRL_SCOPE',
  'UNSUPPORTED_EXTENSION_FEATURE',
  'UNNESTED_RESOURCE',
  'PERMITTED_VIOLATION',
  'EXCLUDED_VIOLATION',
  'SUBTREE_MINMAX',
  'APPLICATION_VERIFICATION',
  'UNSUPPORTED_CONSTRAINT_TYPE',
  'UNSUPPORTED_CONSTRAINT_SYNTAX',
  'UNSUPPORTED_NAME_SYNTAX',
  'CRL_PATH_VALIDATION_ERROR',
  'PATH_LOOP',
  'SUITE_B_INVALID_VERSION',
  'SUITE_B_INVALID_ALGORITHM',
  'SUITE_B_INVALID_CURVE',
  'SUITE_B_INVALID_SIGNATURE_ALGORITHM',
  'SUITE_B_LOS_NOT_ALLOWED',
  'SUITE_B_CANNOT_SIGN_P_384_WITH_P_256',
  'HOSTNAME_MISMATCH',
  'EMAIL_MISMATCH',
  'IP_ADDRESS_MISMATCH',
  'INVALID_CALL',
  'STORE_LOOKUP',
  'NO_VALID_SCTS',
  'PROXY_SUBJECT_NAME_VIOLATION',
  'OCSP_VERIFY_NEEDED',
  'OCSP_VERIFY_FAILED',
  'OCSP_CERT_UNKNOWN',
  'UNSUPPORTED_SIGNATURE_ALGORITHM',
  'SIGNATURE_ALGORITHM_MISMATCH',
  'SIGNATURE_ALGORITHMS_ERROR',
  'INVALID_CA',
  'EC_KEY_EXPLICIT_PARAMS',
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

function genericVerifyDetail(device: string): string {
  return `the certificate chain or hostname was rejected. This does not fall back to insecure. Run \`pikvm-mcp-server pin ${device}\` after out-of-band verification, or use verify mode with a certificate this host trusts.`;
}

/** An expired pin must not send the operator back to pin the same certificate. */
function expiredVerifyDetail(device: string): string {
  return `the certificate has expired. Regenerate or renew the kvmd certificate, then pin the new certificate with \`pikvm-mcp-server pin ${device}\`.`;
}

function verifyFailedError(device: string, code: string, detail: string): NodeJS.ErrnoException {
  const err = new Error(`TLS verification failed for device ${device} (${code}): ${detail}`) as NodeJS.ErrnoException;
  err.code = TLS_VERIFY_FAILED;
  return err;
}

function certificateExpired(raw: Buffer, code: string): boolean {
  if (code === 'CERT_HAS_EXPIRED') return true;
  try {
    const until = Date.parse(new crypto.X509Certificate(raw).validTo);
    return Number.isFinite(until) && until <= Date.now();
  } catch {
    return false;
  }
}

/**
 * The handshake reached a certificate and the socket is not authorized.
 * Pin mode compares the leaf SPKI first. A different key is a pin
 * mismatch, including when the chain error is not in the X509 backstop.
 * The same key, and every verify-mode failure, is a verify failure.
 */
export function classifyUnauthorizedPeer(
  spec: DeviceTls,
  peerRaw: Buffer,
  code: string,
): NodeJS.ErrnoException {
  if (spec.mode === 'pin' && spec.spkiSha256) {
    try {
      const presented = spkiSha256Of(new crypto.X509Certificate(peerRaw));
      if (presented !== spec.spkiSha256) {
        return pinMismatchError(spec.device, spec.spkiSha256, presented);
      }
      if (certificateExpired(peerRaw, code)) {
        return verifyFailedError(spec.device, 'CERT_HAS_EXPIRED', expiredVerifyDetail(spec.device));
      }
    } catch {
      return pinMismatchError(spec.device, spec.spkiSha256, 'unreadable');
    }
  }
  if (code === 'CERT_HAS_EXPIRED') {
    return verifyFailedError(spec.device, code, expiredVerifyDetail(spec.device));
  }
  const shown = code || 'unknown';
  return verifyFailedError(spec.device, shown, genericVerifyDetail(spec.device));
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
  const rewritten = walk(err, (item) => item.code === TLS_VERIFY_FAILED && typeof item.message === 'string');
  if (rewritten && typeof rewritten.message === 'string') {
    return { type: TLS_VERIFY_FAILED, message: rewritten.message };
  }
  const verify = walk(err, (item) => isTlsVerifyCode(item.code));
  if (verify && typeof verify.code === 'string') {
    const detail = verify.code === 'CERT_HAS_EXPIRED' ? expiredVerifyDetail(device) : genericVerifyDetail(device);
    return {
      type: TLS_VERIFY_FAILED,
      message: `TLS verification failed for device ${device} (${verify.code}): ${detail}`,
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

/**
 * Temp file, then rename, mode 0644.
 * rename replaces a symlink at filePath. It does not follow the link
 * or write through it. On POSIX the parent directory is fsynced after
 * the rename. That fsync is best-effort: a failure leaves the rename
 * in place.
 */
export function writeCertAtomic(filePath: string, pem: string): void {
  const dir = dirname(filePath);
  const tmp = join(
    dir,
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
    fsyncDirectory(dir);
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

function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Best-effort. The renamed file is already in the directory.
  } finally {
    if (fd !== undefined) closeSync(fd);
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
    // Node >= 22.9. A non-self-signed leaf is not a trust anchor unless
    // this is set, so `pin default` of a Tailscale or Let's Encrypt
    // certificate would never succeed.
    allowPartialTrustChain: true,
    checkServerIdentity(_hostname, cert) {
      return comparePin(spec, cert);
    },
  };
  assertPinNotInsecure(options);
  return options;
}

function armTlsFailure(socket: tls.TLSSocket, spec: DeviceTls): void {
  const orig = socket.destroy.bind(socket);
  let once = false;
  socket.destroy = ((err?: Error) => {
    if (!once && err) {
      once = true;
      const coded = err as NodeJS.ErrnoException;
      if (coded.code !== TLS_PIN_MISMATCH && coded.code !== TLS_VERIFY_FAILED) {
        let peer: tls.PeerCertificate | undefined;
        try {
          peer = socket.getPeerCertificate(true);
        } catch {
          peer = undefined;
        }
        if (peer?.raw && socket.authorized === false) {
          const code = typeof coded.code === 'string' ? coded.code : 'unknown';
          err = classifyUnauthorizedPeer(spec, peer.raw, code);
        } else if (isTlsVerifyCode(coded.code)) {
          const code = coded.code as string;
          const detail = code === 'CERT_HAS_EXPIRED' ? expiredVerifyDetail(spec.device) : genericVerifyDetail(spec.device);
          err = verifyFailedError(spec.device, code, detail);
        }
      }
    }
    return orig(err);
  }) as typeof socket.destroy;
}

function kvmdConnector(spec: DeviceTls): tls.ConnectionOptions | buildConnector.connector {
  const options = kvmdConnectOptions(spec);
  if (spec.mode === 'insecure') return options;
  if (spec.mode === 'pin') assertPinNotInsecure(options);
  const inner = buildConnector(options);
  const connect: buildConnector.connector = (connectOptions, callback) => {
    const socket = (inner as (
      options: buildConnector.Options,
      cb: buildConnector.Callback,
    ) => tls.TLSSocket)(connectOptions, callback);
    if (socket && typeof socket.getPeerCertificate === 'function') {
      armTlsFailure(socket, spec);
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
  const hostname = hostnameLiteral(url.hostname);
  const port = url.port === '' ? 443 : Number(url.port);
  const servername = net.isIP(hostname) === 0 ? hostname : undefined;
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

/** `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`). */
function hostnameLiteral(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname;
}
