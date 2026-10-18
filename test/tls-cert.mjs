// Modified 2026-10 by PLN: test-only self-signed certificates (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: CA, path length, and expired test certificates (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: minimal certificate serial and keyUsage bits (GPL-3.0; see NOTICE).

/**
 * A self-signed certificate minted at test time with node:crypto.
 * Nothing here is a real host key. The PEM is not committed.
 */

import crypto from 'node:crypto';

function lenBytes(n) {
  if (n < 128) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body]);
}

function seq(...parts) {
  return tlv(0x30, Buffer.concat(parts));
}

function oid(hex) {
  return tlv(0x06, Buffer.from(hex, 'hex'));
}

function utc(date) {
  const p = (n) => String(n).padStart(2, '0');
  const text = `${String(date.getUTCFullYear()).slice(-2)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text));
}

const NULL_ALG = Buffer.from([0x05, 0x00]);
const SHA256_RSA = seq(oid('2a864886f70d01010b'), NULL_ALG);

function dn(cn) {
  const atv = seq(oid('550403'), tlv(0x0c, Buffer.from(cn)));
  return seq(tlv(0x31, atv));
}

function sanDns(dns) {
  const names = seq(tlv(0x82, Buffer.from(dns)));
  const ext = seq(oid('551d11'), tlv(0x04, names));
  return tlv(0xa3, seq(ext));
}

function bitString(buf, unused = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
}

function extension(oidHex, critical, value) {
  const parts = [oid(oidHex)];
  if (critical) parts.push(tlv(0x01, Buffer.from([0xff])));
  parts.push(tlv(0x04, value));
  return seq(...parts);
}

function basicCa(ca, pathLen) {
  const parts = [tlv(0x01, Buffer.from([ca ? 0xff : 0x00]))];
  if (pathLen !== undefined) parts.push(tlv(0x02, Buffer.from([pathLen])));
  return seq(...parts);
}

/**
 * Positive minimal INTEGER. A leading 0x00 before a byte below 0x80
 * is non-minimal DER, and OpenSSL rejects it as illegal padding.
 * The high bit stays clear so the value is not negative.
 */
export function certificateSerial(raw) {
  const serial = Buffer.from(raw ?? crypto.randomBytes(8));
  if (serial.length === 0) throw new Error('certificate serial is empty');
  serial[0] = (serial[0] & 0x7f) | 0x40;
  return serial;
}

/** Leaf certificate whose name does not match 127.0.0.1. */
export function mintCert(cn = 'pikvm.example.ts.net') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = certificateSerial();
  const now = Date.now();
  const tbs = seq(
    Buffer.from('a003020102', 'hex'),
    tlv(0x02, serial),
    SHA256_RSA,
    dn(cn),
    seq(utc(new Date(now - 86_400_000)), utc(new Date(now + 365 * 86_400_000))),
    dn(cn),
    spki,
    sanDns(cn),
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, SHA256_RSA, bitString(signature));
  const body = der.toString('base64').match(/.{1,64}/g).join('\n');
  const cert = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const parsed = new crypto.X509Certificate(cert);
  const spkiSha256 = crypto.createHash('sha256')
    .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return { cert, key, spkiSha256, raw: parsed.raw };
}

/**
 * A certificate with basicConstraints and keyUsage.
 * Pass `issuer` to sign with that CA's key. `ca: true` marks a CA.
 * `pathLen` is the basicConstraints path length. Dates default to a
 * year of validity. Nothing here is a real host key.
 */
export function mintNode(opts = {}) {
  const cn = opts.cn ?? 'pikvm.example.ts.net';
  const keys = opts.keys ?? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const subject = dn(cn);
  const issuerSubject = opts.issuer ? opts.issuer.subject : subject;
  const signer = opts.issuer ? opts.issuer.privateKey : keys.privateKey;
  const extensions = [];
  if (opts.ca === true) {
    extensions.push(extension('551d13', true, basicCa(true, opts.pathLen)));
    extensions.push(extension('551d0f', true, bitString(Buffer.from([0x06]), 1)));
  } else if (opts.ca === false) {
    extensions.push(extension('551d13', true, basicCa(false)));
    // 0xa0 is digitalSignature and keyEncipherment. Five trailing zeros are unused.
    extensions.push(extension('551d0f', true, bitString(Buffer.from([0xa0]), 5)));
  }
  if (opts.dns) {
    extensions.push(extension('551d11', false, seq(tlv(0x82, Buffer.from(opts.dns)))));
  }
  const notBefore = opts.notBefore ?? new Date(Date.now() - 86_400_000);
  const notAfter = opts.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  const serial = certificateSerial(opts.serial);
  const extra = extensions.length ? tlv(0xa3, seq(...extensions)) : Buffer.alloc(0);
  const tbs = seq(
    Buffer.from('a003020102', 'hex'),
    tlv(0x02, serial),
    SHA256_RSA,
    issuerSubject,
    seq(utc(notBefore), utc(notAfter)),
    subject,
    spki,
    extra,
  );
  const signature = crypto.sign('sha256', tbs, signer);
  const der = seq(tbs, SHA256_RSA, bitString(signature));
  const body = der.toString('base64').match(/.{1,64}/g).join('\n');
  const cert = `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  const parsed = new crypto.X509Certificate(cert);
  const spkiSha256 = crypto.createHash('sha256')
    .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return {
    cert,
    key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    privateKey: keys.privateKey,
    subject,
    spkiSha256,
    raw: parsed.raw,
    ca: parsed.ca,
  };
}

/** A self-signed leaf whose notAfter is yesterday. */
export function mintExpired(cn = 'pikvm.example.ts.net') {
  return mintNode({
    cn,
    ca: false,
    dns: cn,
    notBefore: new Date(Date.now() - 30 * 86_400_000),
    notAfter: new Date(Date.now() - 86_400_000),
  });
}
