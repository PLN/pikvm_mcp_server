// Modified 2026-10 by PLN: reject fetch bad ports (GPL-3.0; see NOTICE).

/**
 * The closed-port probe must not hand fetch a blocklisted port.
 * This runs in npm test. It does not open a socket.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unreachableProbePort } from './hw/probe-port.mjs';

test('the default closed port is 65000', () => {
  assert.deepEqual(unreachableProbePort(undefined), { skip: false, port: 65000 });
  assert.deepEqual(unreachableProbePort(''), { skip: false, port: 65000 });
  assert.deepEqual(unreachableProbePort('65001'), { skip: false, port: 65001 });
});

test('0 and skip disable the closed-port probe', () => {
  assert.equal(unreachableProbePort('0').skip, true);
  assert.equal(unreachableProbePort('skip').skip, true);
});

test('fetch bad ports are rejected before a connection', () => {
  for (const raw of ['1', '7', '9', '22', '80']) {
    if (raw === '80') {
      assert.deepEqual(unreachableProbePort(raw), { skip: false, port: 80 });
      continue;
    }
    assert.throws(
      () => unreachableProbePort(raw),
      (err) => {
        assert.match(err.message, /PIKVM_HW_TEST_UNREACHABLE_PORT/);
        assert.match(err.message, /bad-port/);
        assert.match(err.message, new RegExp(`=${raw}\\b`));
        return true;
      },
    );
  }
  assert.throws(() => unreachableProbePort('65536'), /must be a port/);
  assert.throws(() => unreachableProbePort('nope'), /must be a port/);
});
