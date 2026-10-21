// Modified 2026-10 by PLN: a sub-ms catalog remainder starts no GET (GPL-3.0; see NOTICE).

/**
 * The catalog read returns deadline when under 1 ms remains.
 * 0.5 ms is still above 0, so `left <= 0` would start the GET.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMsdState } from '../dist/msd.js';

test('a remainder under 1 ms is deadline and starts no GET', async () => {
  const real = performance.now;
  const now = 5_000;
  performance.now = () => now;
  let gets = 0;
  const client = {
    getMsdState() {
      gets += 1;
      return Promise.resolve({ images: {} });
    },
  };
  try {
    const read = await readMsdState(client, now + 0.5);
    assert.equal(read, 'deadline');
    assert.equal(gets, 0);
  } finally {
    performance.now = real;
  }
});
