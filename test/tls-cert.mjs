// Modified 2026-10 by PLN: test-only self-signed certificates (GPL-3.0; see NOTICE).

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

function bitString(buf) {
  return tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

/** Leaf certificate whose name does not match 127.0.0.1. */
export function mintCert(cn = 'pikvm.example.ts.net') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f;
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
