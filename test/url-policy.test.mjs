// Modified 2026-10 by PLN: URL allowlist and SSRF address policy tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: metadata embeddings, Tailscale services, reserved ranges (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: local NAT64 and non-global wrapped IPv4 (GPL-3.0; see NOTICE).

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

test('redactUrlUserinfo drops userinfo at the last at and drops the query', () => {
  const text = 'failed https://alice:p@ss@images.example/disk.img?token=keep#frag';
  const redacted = redactUrlUserinfo(text);
  assert.equal(redacted.includes('p@ss'), false);
  assert.equal(redacted.includes('alice'), false);
  assert.equal(redacted.includes('token'), false);
  assert.equal(redacted.includes('keep'), false);
  assert.equal(redacted.includes('frag'), false);
  assert.equal(redacted, 'failed https://images.example/disk.img');
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
  assert.equal(parseUrlAllowlist('https://images.example./iso').entries[0].host, 'images.example');
  assert.throws(() => parseUrlAllowlist('10.0.0.0/8'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('169.254.0.0/16'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('http://images.example/iso'), /https/);
  assert.throws(() => parseUrlAllowlist('100.64.0.0/ 24'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('100.64.0.0/1e1'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('100.64.0.0/0x18'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('100.101.102.103/16'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('fd7a:115c:a1e0::50/48'), /tailscale opt-in/);
  assert.throws(() => parseUrlAllowlist('https://169.254.169.254/iso'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://[fe80::1]/'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://[fd00:ec2::254]/'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://100.100.100.100/'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://[fd7a:115c:a1e0::53]/'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://203.0.113.10/iso'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://[64:ff9b:1::a9fe:a9fe]/'), /always denied/);
  assert.throws(() => parseUrlAllowlist('https://[64:ff9b:1::1]/'), /always denied/);
  assert.equal(parseUrlAllowlist('https://100.101.102.103/').entries[0].host, '100.101.102.103');
  assert.equal(parseUrlAllowlist('https://[64:ff9b::808:808]/').entries[0].host, '[64:ff9b::808:808]');
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
  assert.equal(denied('192.0.3.10'), undefined);
  assert.match(denied('203.0.113.10', plain, true), /reserved or documentation/);
  assert.throws(() => assertResolvedAddresses(['192.0.3.10', '127.0.0.1'], plain, false), /private/);
  assert.equal(denied('::1', plain, true), undefined);
  assert.match(denied('::1'), /private/);

  const wide = opted;
  for (const address of [
    'fd00:ec2::254',
    '100.100.100.100',
    '100.100.100.200',
    'fd7a:115c:a1e0::53',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::',
    '::a9fe:a9fe',
    '64:ff9b:1:a9fe:00a9:fe00::',
    '::ffff:100.100.100.100',
  ]) {
    assert.match(denied(address, wide, true), /always denied/, address);
  }
  assert.match(denied('64:ff9b::7f00:1', wide, false), /non-global/);
  assert.match(denied('64:ff9b::7f00:1', wide, true), /non-global/);
  assert.match(denied('64:ff9b:1::a9fe:a9fe', wide, true), /always denied/);
  assert.match(denied('64:ff9b:1::1', wide, true), /always denied/);
  assert.match(denied('64:ff9b::6440:1', wide, true), /non-global/);
  assert.match(denied('2002:6440:0001::', wide, true), /non-global/);
  assert.match(denied('::0a01:0203', wide, true), /non-global/);
  assert.equal(denied('64:ff9b::808:808', wide, false), undefined);
  assert.equal(denied('2002:0808:0808::', plain, true), undefined);
  assert.equal(denied('::0808:0808', plain, false), undefined);
  assert.match(denied('240.0.0.1', plain, true), /reserved or documentation/);
  assert.match(denied('198.18.0.1', plain, true), /reserved or documentation/);
  assert.match(denied('192.0.0.1', plain, true), /reserved or documentation/);
  assert.match(denied('192.0.2.1', plain, true), /reserved or documentation/);
  assert.match(denied('198.51.100.1', plain, true), /reserved or documentation/);
  assert.match(denied('2001:db8::1', plain, true), /reserved or documentation/);
  assert.match(denied('fec0::1', plain, true), /reserved or documentation/);
  assert.equal(denied('64:ff9b::c000:30a', plain, false), undefined);
});

test('inspectFetchUrl accepts an allowlisted https URL and rejects the rest', () => {
  const allow = parseUrlAllowlist(HOST);
  const ok = inspectFetchUrl('https://images.example/iso/disk.img?token=keep', allow);
  assert.equal(ok.imageFromPath, 'disk.img');
  assert.equal(ok.hostname, 'images.example');
  assert.match(ok.href, /token=keep/);
  assert.doesNotMatch(ok.href, /#/);
  const hashed = inspectFetchUrl('https://images.example/iso/disk.img?token=keep#frag', allow);
  assert.equal(hashed.href.includes('frag'), false);
  assert.match(hashed.href, /token=keep/);
  const dotted = inspectFetchUrl('https://images.example./iso/disk.img', allow);
  assert.equal(dotted.hostname, 'images.example');
  const explicitPort = inspectFetchUrl('https://images.example:443/iso/disk.img', allow);
  assert.equal(explicitPort.hostname, 'images.example');
  assert.equal(explicitPort.href.includes(':443'), false);
  assert.equal(inspectFetchUrl('https://images.example/iso/%2e%2e%2fsecret.img', allow).imageFromPath, '../secret.img');
  assert.equal(inspectFetchUrl('https://images.example/iso/foo%2Fbar.img', allow).imageFromPath, 'foo/bar.img');
  assert.equal(inspectFetchUrl('https://images.example/iso', allow).imageFromPath, 'iso');
  const loop = parseUrlAllowlist('https://127.0.0.1/');
  assert.equal(inspectFetchUrl('https://2130706433/disk.img', loop).hostname, '127.0.0.1');
  assert.equal(inspectFetchUrl('https://0177.0.0.1/disk.img', loop).hostname, '127.0.0.1');
  assert.equal(inspectFetchUrl('https://0x7f.0.0.1/disk.img', loop).hostname, '127.0.0.1');
  assert.throws(() => inspectFetchUrl('http://images.example/iso/disk.img', allow), /https/);
  assert.throws(() => inspectFetchUrl('https://alice:s3cret@images.example/iso/disk.img', allow), /userinfo/);
  assert.throws(() => inspectFetchUrl('https://other.example/iso/disk.img', allow), /not allowlisted/);
  assert.throws(() => inspectFetchUrl('https://images.example/isotope/disk.img', allow), /not allowlisted/);
  assert.throws(() => inspectFetchUrl('https://images.example:8443/iso/disk.img', allow), /not allowlisted/);
});
