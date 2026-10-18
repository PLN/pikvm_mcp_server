// Modified 2026-10 by PLN: URL allowlist and SSRF address policy tests (GPL-3.0; see NOTICE).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addressDenial,
  assertResolvedAddresses,
  inspectFetchUrl,
  parseUrlAllowlist,
  redactUrlUserinfo,
} from '../dist/url-policy.js';

const HOST = 'https://images.example/iso';

test('redactUrlUserinfo drops userinfo and keeps the query', () => {
  const text = 'failed https://alice:s3cret@images.example/disk.img?token=keep';
  const redacted = redactUrlUserinfo(text);
  assert.equal(redacted.includes('s3cret'), false);
  assert.equal(redacted.includes('alice'), false);
  assert.match(redacted, /https:\/\/images\.example\/disk\.img\?token=keep/);
});

test('allowlist parses https prefixes and tailscale CIDRs', () => {
  const allow = parseUrlAllowlist('https://images.example:8443/iso/, 100.101.102.103/32, fd7a:115c:a1e0::/48');
  assert.equal(allow.entries.length, 1);
  assert.equal(allow.entries[0].host, 'images.example');
  assert.equal(allow.entries[0].port, 8443);
  assert.equal(allow.entries[0].pathPrefix, '/iso');
  assert.equal(allow.tailscale.check('100.101.102.103', 'ipv4'), true);
  assert.equal(allow.tailscale.check('100.101.102.104', 'ipv4'), false);
  assert.equal(allow.tailscale.check('fd7a:115c:a1e0::50', 'ipv6'), true);
  assert.equal(parseUrlAllowlist(undefined).entries.length, 0);
  assert.throws(() => parseUrlAllowlist('10.0.0.0/8'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('169.254.0.0/16'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('http://images.example/iso'), /https/);
});

test('address policy denies private, tailscale, and metadata ranges', () => {
  const plain = parseUrlAllowlist(HOST);
  const opted = parseUrlAllowlist(`${HOST},100.64.0.0/10,fd7a:115c:a1e0::/48`);
  const denied = (address, allow = plain, allowPrivate = false) => addressDenial(address, allow, allowPrivate);
  assert.match(denied('127.0.0.1'), /private/);
  assert.match(denied('10.1.2.3'), /private/);
  assert.match(denied('192.168.1.9'), /private/);
  assert.match(denied('100.101.102.103'), /tailscale/);
  assert.match(denied('fd7a:115c:a1e0::50'), /tailscale/);
  assert.match(denied('169.254.169.254', plain, true), /link-local or metadata/);
  assert.match(denied('fe80::1', plain, true), /link-local or metadata/);
  assert.match(denied('::ffff:169.254.169.254', opted, true), /link-local or metadata/);
  assert.match(denied('::ffff:a9fe:a9fe', opted, true), /link-local or metadata/);
  assert.match(denied('::ffff:10.1.2.3'), /private/);
  assert.equal(denied('10.1.2.3', plain, true), undefined);
  assert.equal(denied('100.101.102.103', opted, false), undefined);
  assert.equal(denied('fd7a:115c:a1e0::50', opted, false), undefined);
  assert.equal(denied('::ffff:100.101.102.103', opted, false), undefined);
  assert.match(denied('100.101.102.103', plain, true), /tailscale/);
  assert.equal(denied('203.0.113.10'), undefined);
  assert.throws(() => assertResolvedAddresses(['203.0.113.10', '127.0.0.1'], plain, false), /private/);
});

test('inspectFetchUrl accepts an allowlisted https URL and rejects the rest', () => {
  const allow = parseUrlAllowlist(HOST);
  const ok = inspectFetchUrl('https://images.example/iso/disk.img?token=keep', allow);
  assert.equal(ok.imageFromPath, 'disk.img');
  assert.equal(ok.hostname, 'images.example');
  assert.match(ok.href, /token=keep/);
  assert.throws(() => inspectFetchUrl('http://images.example/iso/disk.img', allow), /https/);
  assert.throws(() => inspectFetchUrl('https://alice:s3cret@images.example/iso/disk.img', allow), /userinfo/);
  assert.throws(() => inspectFetchUrl('https://other.example/iso/disk.img', allow), /not allowlisted/);
  assert.throws(() => inspectFetchUrl('https://images.example/isotope/disk.img', allow), /not allowlisted/);
});
