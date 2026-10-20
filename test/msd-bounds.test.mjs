// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).

/**
 * The MSD bound helper. A hang rejects with the operation name, the
 * timer does not outlive the call, and a later step still runs.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { describe } from 'node:test';
import {
  MSD_FETCH_TIMEOUT_MS,
  MSD_FILE_TIMEOUT_MS,
  MSD_SUBTEST_TIMEOUT_MS,
  MSD_TEARDOWN_TIMEOUT_MS,
  MSD_UPLOAD_SUITE_TIMEOUT_MS,
  bounded,
  boundedFetch,
  closed,
  finishWith,
  msdTest,
  runBounded,
} from './msd-bounds.mjs';

describe('MSD test bounds', { timeout: MSD_FILE_TIMEOUT_MS }, () => {
  msdTest('ceilings stay ordered', () => {
    assert.ok(MSD_TEARDOWN_TIMEOUT_MS < MSD_SUBTEST_TIMEOUT_MS);
    assert.ok(MSD_FETCH_TIMEOUT_MS < MSD_SUBTEST_TIMEOUT_MS);
    assert.ok(MSD_SUBTEST_TIMEOUT_MS < MSD_UPLOAD_SUITE_TIMEOUT_MS);
    assert.ok(MSD_UPLOAD_SUITE_TIMEOUT_MS < MSD_FILE_TIMEOUT_MS);
    assert.equal(MSD_UPLOAD_SUITE_TIMEOUT_MS, 120_000);
    assert.equal(MSD_SUBTEST_TIMEOUT_MS, 30_000);
  });

  msdTest('a resolved bound clears its timer', async () => {
    const value = await bounded('fixture cleanup', Promise.resolve('done'), 1000);
    assert.equal(value, 'done');
  });

  msdTest('a rejected bound is not swallowed', async () => {
    await assert.rejects(
      () => bounded('fixture cleanup', Promise.reject(new Error('rm failed')), 1000),
      (err) => {
        assert.equal(err.message, 'rm failed');
        return true;
      },
    );
  });

  msdTest('a hung bound names the operation', async () => {
    await assert.rejects(
      () => bounded('withSession mock close', new Promise(() => {}), 20),
      (err) => {
        assert.equal(err.message, 'withSession mock close timed out after 20ms');
        return true;
      },
    );
  });

  msdTest('a timed-out step does not skip the next one', async () => {
    const seen = [];
    await assert.rejects(
      () => runBounded([
        () => bounded('withSession mock close', new Promise(() => {}), 20),
        async () => { seen.push('next'); },
      ]),
      /withSession mock close timed out after 20ms/,
    );
    assert.deepEqual(seen, ['next']);
  });

  msdTest('finishWith keeps the body error when teardown works', async () => {
    await assert.rejects(
      () => finishWith(
        () => Promise.reject(new Error('body failed')),
        () => Promise.resolve(),
      ),
      (err) => {
        assert.equal(err.message, 'body failed');
        return true;
      },
    );
  });

  msdTest('finishWith reports a teardown hang and the body error', async () => {
    await assert.rejects(
      () => finishWith(
        () => Promise.reject(new Error('body failed')),
        () => bounded('fixture cleanup', new Promise(() => {}), 20),
      ),
      (err) => {
        assert.match(err.message, /body failed/);
        assert.match(err.message, /fixture cleanup timed out after 20ms/);
        assert.equal(err.cause.message, 'body failed');
        return true;
      },
    );
  });

  msdTest('server close names a hang and drops connections', async () => {
    let dropped = false;
    const server = {
      close() {},
      closeAllConnections() { dropped = true; },
    };
    await assert.rejects(
      () => closed(server, 'withSession http server close', 20),
      (err) => {
        assert.equal(err.message, 'withSession http server close timed out after 20ms');
        return true;
      },
    );
    assert.equal(dropped, true);
  });

  msdTest('server close surfaces a close error', async () => {
    const server = {
      close(cb) { cb(new Error('not running')); },
      closeAllConnections() {},
    };
    await assert.rejects(
      () => closed(server, 'listen server close', 1000),
      (err) => {
        assert.equal(err.message, 'not running');
        return true;
      },
    );
  });

  msdTest('a stalled fetch names the call and keeps the abort cause', async () => {
    const server = http.createServer(() => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      await assert.rejects(
        () => boundedFetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' }, 'mcp initialize', 50),
        (err) => {
          assert.equal(err.message, 'mcp initialize timed out after 50ms');
          assert.equal(err.cause.name, 'TimeoutError');
          return true;
        },
      );
    } finally {
      server.closeAllConnections();
      await closed(server, 'listen server close');
    }
  });

  msdTest('a refused fetch is not reported as a timeout', async () => {
    await assert.rejects(
      () => boundedFetch('http://127.0.0.1:1/mcp', { method: 'POST' }, 'mcp initialize', 1000),
      (err) => {
        assert.notEqual(err.message, 'mcp initialize timed out after 1000ms');
        assert.equal(err.name, 'TypeError');
        return true;
      },
    );
  });
});
