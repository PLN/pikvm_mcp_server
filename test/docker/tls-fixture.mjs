// Modified 2026-10 by PLN: Docker image smoke test (GPL-3.0; see NOTICE).

/**
 * Host-side HTTPS endpoint for the image smoke test (S11 pin, S19 private CA).
 * Usage: node test/docker/tls-fixture.mjs <dir>
 * Mints a test CA and a leaf for kvm.test signed by it (nothing real), and
 * listens on 127.0.0.1 only. Writes <dir>/ca.pem, <dir>/port once listening,
 * and one line per HTTP request to <dir>/requests.log. Every request gets a
 * kvmd-shaped reply with a 1920x1080 streamer source. Runs until killed.
 */

import https from 'node:https';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mintNode } from '../tls-cert.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node test/docker/tls-fixture.mjs <dir>');
  process.exit(64);
}

const ca = mintNode({ cn: 'pikvm smoke test CA', ca: true });
const leaf = mintNode({ cn: 'kvm.test', ca: false, dns: 'kvm.test', issuer: ca });
writeFileSync(path.join(dir, 'ca.pem'), ca.cert);

const reply = JSON.stringify({
  ok: true,
  result: { streamer: { source: { online: true, resolution: { width: 1920, height: 1080 } } } },
});

const server = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
  appendFileSync(path.join(dir, 'requests.log'), `${req.method} ${req.url}\n`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(reply);
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(path.join(dir, 'port'), String(server.address().port));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
