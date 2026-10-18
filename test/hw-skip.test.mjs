// Modified 2026-10 by PLN: hardware suite self-skip (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the net marker is on TAP stdout (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: TLS mode check is skipped with the suite (GPL-3.0; see NOTICE).

/**
 * The hardware files must not run during npm test, and with
 * PIKVM_HW_TEST_DEVICE unset they skip without a socket or a DNS lookup.
 * CI runs npm test only. It does not call test:hw.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { resolveDevice } from '../dist/msd.js';
import { hwDeviceRequest } from './hw/gate.mjs';

const repo = join(fileURLToPath(import.meta.url), '..', '..');

function summaryCount(output, label) {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
  assert.ok(match, `missing # ${label} in\n${output}`);
  return Number(match[1]);
}

test('npm test and CI do not run the hardware suite', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/);
  assert.doesNotMatch(pkg.scripts.test, /test:hw|test\/hw/);
  assert.match(pkg.scripts['test:hw'], /test\/hw\/\*\.hw\.test\.mjs/);
  assert.match(pkg.scripts['test:hw'], /--test-concurrency=1/);
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm test/);
  assert.doesNotMatch(ci, /test:hw/);
});

test('only the legacy default device is accepted', async () => {
  const previous = process.env.PIKVM_HW_TEST_DEVICE;
  try {
    delete process.env.PIKVM_HW_TEST_DEVICE;
    assert.equal(hwDeviceRequest().skip, true);
    process.env.PIKVM_HW_TEST_DEVICE = 'other';
    assert.throws(() => hwDeviceRequest(), /Only "default" is accepted/);
    process.env.PIKVM_HW_TEST_DEVICE = 'default';
    assert.deepEqual(hwDeviceRequest(), { skip: false, name: 'default' });
    const client = new PiKVMClient({
      host: 'https://pikvm.example.ts.net',
      username: 'admin',
      password: 'not-sent',
      verifySsl: true,
    });
    const resolved = resolveDevice({ device: 'default' }, client);
    assert.equal(resolved.name, 'default');
    assert.equal(resolved.client, client);
    await client.close();
  } finally {
    if (previous === undefined) delete process.env.PIKVM_HW_TEST_DEVICE;
    else process.env.PIKVM_HW_TEST_DEVICE = previous;
  }
});

describe('hardware suite process', () => {
  test('unset device skips every hardware test with no network', async () => {
    const guard = join(repo, 'test', 'hw-net-guard.mjs');
    const discovered = join(repo, 'test', 'hw-discovered-reporter.mjs');
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      PIKVM_MCP_NO_DOTENV: '1',
    };
    // Node 22.14 treats `node --test test/hw` as a directory import when
    // package.json says "type": "module", so the files are not discovered.
    // `node --test` with this directory as cwd finds *.hw.test.mjs.
    // --import is an argv so a path with spaces is one argument.
    // The stock TAP reporter does not name discovered files. This reporter
    // lists them and still emits the "# tests N" summary, including a
    // child file's stderr (where the net marker is written).
    const child = spawn(process.execPath, [
      '--import', guard,
      '--test',
      '--test-reporter', discovered,
      '--test-concurrency=1',
    ], {
      cwd: join(repo, 'test', 'hw'),
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const combined = `${stdout}\n${stderr}`;
    assert.equal(combined.includes('HW_NET_CALL'), false, combined);
    assert.equal(code, 0, combined);
    assert.equal(summaryCount(stdout, 'fail'), 0);
    assert.equal(summaryCount(stdout, 'cancelled'), 0);
    assert.equal(summaryCount(stdout, 'pass'), 0);
    assert.equal(summaryCount(stdout, 'tests'), 8);
    assert.equal(summaryCount(stdout, 'skipped'), 8);
    for (const name of ['readonly.hw.test.mjs', 'msd.hw.test.mjs', 'hid.hw.test.mjs']) {
      assert.match(stdout, new RegExp(name));
    }
    assert.match(stdout, /PIKVM_HW_TEST_DEVICE is unset/);
  });
});
