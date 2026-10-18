// Modified 2026-10 by PLN: hardware skip must not open a socket (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: ESM dns lookup sees the same patch (GPL-3.0; see NOTICE).

/**
 * Loaded with node --import for the CI self-skip check.
 * A connect or a DNS lookup prints a marker the parent test rejects.
 * node --test copies a child file's stderr onto TAP stdout as
 * "# HW_NET_CALL ...", so the parent checks both streams.
 */

import dns from 'node:dns';
import { lookup as lookupPromise } from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

function mark(kind) {
  process.stderr.write(`HW_NET_CALL ${kind}\n`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  mark('connect');
  return connect.apply(this, args);
};

for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const orig = dns[name];
  if (typeof orig !== 'function') continue;
  dns[name] = function patchedDns(...args) {
    mark(name);
    return orig.apply(this, args);
  };
}

dns.promises.lookup = function patchedLookup(...args) {
  mark('promises.lookup');
  return lookupPromise.apply(dns.promises, args);
};

// import { lookup } from 'node:dns' keeps the binding taken at load.
// Copy the patched CJS exports onto that module namespace.
syncBuiltinESMExports();
