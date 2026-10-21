// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: caller locations and labeled body timeouts (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: TAP locations and a Windows file URL (GPL-3.0; see NOTICE).

/**
 * The MSD bound helper. A hang rejects with the operation name, the
 * timer does not outlive the call, and a later step still runs.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { promisify } from 'node:util';
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
  stackFrameSite,
} from './msd-bounds.mjs';

const execFileAsync = promisify(execFile);
const BOUNDS = new URL('./msd-bounds.mjs', import.meta.url).href;

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

  msdTest('a stalled response body names the call', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const res = await boundedFetch(
        `http://127.0.0.1:${port}/mcp`,
        { method: 'GET' },
        'mcp initialize',
        80,
      );
      await assert.rejects(
        () => res.json(),
        (err) => {
          assert.equal(err.message, 'mcp initialize timed out after 80ms');
          assert.equal(err.cause.name, 'TimeoutError');
          return true;
        },
      );
    } finally {
      server.closeAllConnections();
      await closed(server, 'listen server close');
    }
  });

  msdTest('a windows stack frame keeps the drive letter', () => {
    const drive = stackFrameSite('    at msdTest (C:\\repo\\test\\loc.test.mjs:4:1)');
    assert.deepEqual(drive, {
      file: 'C:\\repo\\test\\loc.test.mjs',
      line: 4,
      column: 1,
    });
    const url = stackFrameSite('    at msdTest (file:///C:/repo/test/loc.test.mjs:7:1)');
    assert.equal(url.line, 7);
    assert.equal(url.column, 1);
    assert.match(url.file, /C:[\\/]repo[\\/]test[\\/]loc\.test\.mjs$/);
  });

  msdTest('a failure location is the caller, and a hung body still exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-msd-loc-'));
    const file = join(dir, 'loc.test.mjs');
    const source = [
      "import http from 'node:http';",
      "import assert from 'node:assert/strict';",
      `import { msdTest, onTestTeardown } from ${JSON.stringify(BOUNDS)};`,
      "msdTest('assert line', () => {",
      '  assert.equal(1, 2);',
      '});',
      "msdTest('timeout line', { timeout: 300 }, async () => {",
      "  const server = http.createServer((_req, res) => res.end('ok'));",
      "  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
      "  onTestTeardown(() => new Promise((resolve) => server.close(() => resolve())));",
      '  await new Promise(() => {});',
      '});',
      '',
    ].join('\n');
    await writeFile(file, source);
    let stdout = '';
    let code = 0;
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = await execFileAsync(process.execPath, [
        '--test',
        '--test-reporter=tap',
        '--test-concurrency=1',
        file,
      ], { encoding: 'utf8', timeout: 5000, env });
      stdout = result.stdout;
    } catch (err) {
      stdout = `${err.stdout || ''}\n${err.stderr || ''}`;
      code = err.code;
      assert.notEqual(err.killed, true, 'hung body kept the test process alive');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.equal(code, 1);
    const locations = [...stdout.matchAll(/^ {2}location: '([^']+)'/gm)].map((match) => match[1]);
    assert.deepEqual(locations.map((location) => location.replace(/.*loc\.test\.mjs/, 'loc.test.mjs')), [
      'loc.test.mjs:4:1',
      'loc.test.mjs:7:1',
    ]);
    assert.equal(locations.some((location) => location.includes('msd-bounds.mjs')), false);
    assert.match(stdout, /test timed out after 300ms/);
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
