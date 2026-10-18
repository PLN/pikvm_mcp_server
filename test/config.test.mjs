/**
 * Modified 2026-10 by PLN: PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).
 * Modified 2026-10 by PLN: MSD upload deadlines (GPL-3.0; see NOTICE).
 * Modified 2026-10 by PLN: cap MSD job at 7 days and idle at 1 hour (GPL-3.0; see NOTICE).
 * Modified 2026-10 by PLN: PIKVM_MCP_ARM_MSD (GPL-3.0; see NOTICE).
 * Modified 2026-10 by PLN: PIKVM_MSD_LOCAL_DIR and PIKVM_MSD_MAX_BYTES (GPL-3.0; see NOTICE).
 *
 * loadEnvFile unit tests — verify PIKVM_MCP_NO_DOTENV=1 makes .env lose to
 * explicitly-set process env (the gateway systemd landmine fix).
 *
 * Note: importing dist/config.js runs the real top-level loadEnvFile() against
 * the repo .env (if present) into THIS test process — harmless here because
 * the assertions use fresh variable names that don't exist in the real .env.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile, loadConfig } from '../dist/config.js';
import {
  MSD_IDLE_TIMEOUT_DEFAULT_MS,
  MSD_IDLE_TIMEOUT_MAX_MS,
  MSD_JOB_TIMEOUT_DEFAULT_MS,
  MSD_JOB_TIMEOUT_MAX_MS,
  clampRequestTimeoutMs,
  parseRequestTimeoutMs,
} from '../dist/request-timeout.js';

async function withEnvFile(contents, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pikvm-env-'));
  const file = join(dir, '.env');
  await writeFile(file, contents);
  try {
    await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('NO_DOTENV=1: .env does NOT override an explicitly set env var', async () => {
  await withEnvFile('PIKVM_MCP_TEST_A=fromdotenv\n', async (file) => {
    process.env.PIKVM_MCP_TEST_A = 'fromprocess';
    process.env.PIKVM_MCP_NO_DOTENV = '1';
    try {
      loadEnvFile(file);
      assert.equal(process.env.PIKVM_MCP_TEST_A, 'fromprocess');
    } finally {
      delete process.env.PIKVM_MCP_TEST_A;
      delete process.env.PIKVM_MCP_NO_DOTENV;
    }
  });
});

test('without NO_DOTENV: explicitly-set process env wins over .env (override:false)', async () => {
  await withEnvFile('PIKVM_MCP_TEST_B=fromdotenv\n', async (file) => {
    process.env.PIKVM_MCP_TEST_B = 'fromprocess';
    try {
      loadEnvFile(file);
      assert.equal(process.env.PIKVM_MCP_TEST_B, 'fromprocess',
        'explicit process env must always win over .env values');
    } finally {
      delete process.env.PIKVM_MCP_TEST_B;
    }
  });
});

test('without NO_DOTENV: .env still fills variables absent from process env', async () => {
  await withEnvFile('PIKVM_MCP_TEST_D=fromdotenv\n', async (file) => {
    delete process.env.PIKVM_MCP_TEST_D;
    try {
      loadEnvFile(file);
      assert.equal(process.env.PIKVM_MCP_TEST_D, 'fromdotenv',
        '.env must remain the source for vars the caller did not set');
    } finally {
      delete process.env.PIKVM_MCP_TEST_D;
    }
  });
});

test('NO_DOTENV=1: .env-only variables are not introduced at all', async () => {
  await withEnvFile('PIKVM_MCP_TEST_C=fromdotenv\n', async (file) => {
    delete process.env.PIKVM_MCP_TEST_C;
    process.env.PIKVM_MCP_NO_DOTENV = '1';
    try {
      loadEnvFile(file);
      assert.equal(process.env.PIKVM_MCP_TEST_C, undefined);
    } finally {
      delete process.env.PIKVM_MCP_TEST_C;
      delete process.env.PIKVM_MCP_NO_DOTENV;
    }
  });
});

test('HTTP config: bind host defaults to 127.0.0.1, PIKVM_MCP_HOST overrides', () => {
  const saved = {
    PIKVM_HOST: process.env.PIKVM_HOST,
    PIKVM_PASSWORD: process.env.PIKVM_PASSWORD,
    PIKVM_MCP_PORT: process.env.PIKVM_MCP_PORT,
    PIKVM_MCP_HOST: process.env.PIKVM_MCP_HOST,
  };
  // Explicit sets must win over the repo's real .env (override:false).
  process.env.PIKVM_HOST = 'http://mock.test';
  process.env.PIKVM_PASSWORD = 'testpw';
  process.env.PIKVM_MCP_PORT = '8675';
  delete process.env.PIKVM_MCP_HOST;
  try {
    assert.equal(loadConfig().http.host, '127.0.0.1', 'bind must default to loopback');
    process.env.PIKVM_MCP_HOST = '10.66.0.7';
    assert.equal(loadConfig().http.host, '10.66.0.7', 'bridge gateway IP must be settable');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('clampRequestTimeoutMs uses 5000 for non-positive values and clamps the top', () => {
  assert.equal(clampRequestTimeoutMs(Number.NaN), 5000);
  assert.equal(clampRequestTimeoutMs(Number.POSITIVE_INFINITY), 5000);
  assert.equal(clampRequestTimeoutMs(0), 5000);
  assert.equal(clampRequestTimeoutMs(-4), 5000);
  assert.equal(clampRequestTimeoutMs(0.4), 5000);
  assert.equal(clampRequestTimeoutMs(1.9), 1);
  assert.equal(clampRequestTimeoutMs(1500), 1500);
  assert.equal(clampRequestTimeoutMs(600000), 600000);
  assert.equal(clampRequestTimeoutMs(600001), 600000);
});

test('parseRequestTimeoutMs accepts digits only', () => {
  assert.equal(parseRequestTimeoutMs(undefined), 5000);
  assert.equal(parseRequestTimeoutMs(''), 5000);
  assert.equal(parseRequestTimeoutMs('1500'), 1500);
  assert.equal(parseRequestTimeoutMs('600000'), 600000);
  assert.equal(parseRequestTimeoutMs('600001'), 600000);
  assert.equal(parseRequestTimeoutMs('0'), 5000);
  assert.equal(parseRequestTimeoutMs('5000abc'), 5000);
  assert.equal(parseRequestTimeoutMs('1e3'), 5000);
  assert.equal(parseRequestTimeoutMs(' 5000 '), 5000);
  assert.equal(parseRequestTimeoutMs('5.5'), 5000);
  assert.equal(parseRequestTimeoutMs('-4'), 5000);
  assert.equal(parseRequestTimeoutMs('1.9'), 5000);
});

test('PIKVM_REQUEST_TIMEOUT_MS is digits only, else 5000, and clamps above 600000', () => {
  const saved = {
    PIKVM_HOST: process.env.PIKVM_HOST,
    PIKVM_PASSWORD: process.env.PIKVM_PASSWORD,
    PIKVM_REQUEST_TIMEOUT_MS: process.env.PIKVM_REQUEST_TIMEOUT_MS,
  };
  process.env.PIKVM_HOST = 'http://mock.test';
  process.env.PIKVM_PASSWORD = 'testpw';
  try {
    delete process.env.PIKVM_REQUEST_TIMEOUT_MS;
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '1500';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 1500);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '1.9';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '0';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '-4';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '5000abc';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '1e3';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = ' 5000 ';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '5.5';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '600000';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 600000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '600001';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 600000);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = 'nope';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 5000);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('MSD upload deadlines default to 6 hours and 60 seconds', () => {
  const saved = {
    PIKVM_HOST: process.env.PIKVM_HOST,
    PIKVM_PASSWORD: process.env.PIKVM_PASSWORD,
    PIKVM_MSD_JOB_TIMEOUT_MS: process.env.PIKVM_MSD_JOB_TIMEOUT_MS,
    PIKVM_MSD_IDLE_TIMEOUT_MS: process.env.PIKVM_MSD_IDLE_TIMEOUT_MS,
  };
  process.env.PIKVM_HOST = 'http://mock.test';
  process.env.PIKVM_PASSWORD = 'testpw';
  try {
    delete process.env.PIKVM_MSD_JOB_TIMEOUT_MS;
    delete process.env.PIKVM_MSD_IDLE_TIMEOUT_MS;
    assert.equal(loadConfig().pikvm.msdJobTimeoutMs, MSD_JOB_TIMEOUT_DEFAULT_MS);
    assert.equal(loadConfig().pikvm.msdIdleTimeoutMs, MSD_IDLE_TIMEOUT_DEFAULT_MS);
    assert.equal(MSD_JOB_TIMEOUT_DEFAULT_MS, 6 * 60 * 60 * 1000);
    assert.equal(MSD_IDLE_TIMEOUT_DEFAULT_MS, 60 * 1000);
    process.env.PIKVM_MSD_JOB_TIMEOUT_MS = '90000';
    process.env.PIKVM_MSD_IDLE_TIMEOUT_MS = '1500';
    assert.equal(loadConfig().pikvm.msdJobTimeoutMs, 90000);
    assert.equal(loadConfig().pikvm.msdIdleTimeoutMs, 1500);
    process.env.PIKVM_MSD_JOB_TIMEOUT_MS = '0';
    process.env.PIKVM_MSD_IDLE_TIMEOUT_MS = 'nope';
    assert.equal(loadConfig().pikvm.msdJobTimeoutMs, MSD_JOB_TIMEOUT_DEFAULT_MS);
    assert.equal(loadConfig().pikvm.msdIdleTimeoutMs, MSD_IDLE_TIMEOUT_DEFAULT_MS);
    process.env.PIKVM_MSD_JOB_TIMEOUT_MS = '21600001';
    assert.equal(loadConfig().pikvm.msdJobTimeoutMs, 21600001);
    process.env.PIKVM_MSD_JOB_TIMEOUT_MS = '99999999999';
    process.env.PIKVM_MSD_IDLE_TIMEOUT_MS = '99999999999';
    assert.equal(loadConfig().pikvm.msdJobTimeoutMs, MSD_JOB_TIMEOUT_MAX_MS);
    assert.equal(loadConfig().pikvm.msdIdleTimeoutMs, MSD_IDLE_TIMEOUT_MAX_MS);
    assert.equal(MSD_JOB_TIMEOUT_MAX_MS, 604800000);
    assert.equal(MSD_IDLE_TIMEOUT_MAX_MS, 3600000);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('PIKVM_MSD_LOCAL_DIR stays unset and PIKVM_MSD_MAX_BYTES defaults to 16 GiB', () => {
  const keys = ['PIKVM_HOST', 'PIKVM_PASSWORD', 'PIKVM_MSD_LOCAL_DIR', 'PIKVM_MSD_MAX_BYTES', 'PIKVM_MSD_EXTENSIONS'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PIKVM_HOST = 'http://mock.test';
  process.env.PIKVM_PASSWORD = 'testpw';
  try {
    delete process.env.PIKVM_MSD_LOCAL_DIR;
    delete process.env.PIKVM_MSD_MAX_BYTES;
    delete process.env.PIKVM_MSD_EXTENSIONS;
    assert.equal(loadConfig().msd.localDir, undefined);
    assert.equal(loadConfig().msd.maxBytes, 16 * 1024 * 1024 * 1024);
    assert.deepEqual(loadConfig().msd.extensions, ['.iso', '.img']);
    process.env.PIKVM_MSD_LOCAL_DIR = '  ';
    process.env.PIKVM_MSD_MAX_BYTES = '0';
    process.env.PIKVM_MSD_EXTENSIONS = 'iso, .IMG';
    assert.equal(loadConfig().msd.localDir, undefined);
    assert.equal(loadConfig().msd.maxBytes, 16 * 1024 * 1024 * 1024);
    assert.deepEqual(loadConfig().msd.extensions, ['.iso', '.img']);
    process.env.PIKVM_MSD_LOCAL_DIR = '/srv/iso';
    process.env.PIKVM_MSD_MAX_BYTES = '4096';
    assert.equal(loadConfig().msd.localDir, '/srv/iso');
    assert.equal(loadConfig().msd.maxBytes, 4096);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('PIKVM_MCP_ARM_MSD defaults off and ARM_HID does not arm it', () => {
  const keys = [
    'PIKVM_HOST',
    'PIKVM_PASSWORD',
    'PIKVM_MCP_PORT',
    'PIKVM_MCP_ARM_HID',
    'PIKVM_MCP_ARM_MSD',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.PIKVM_HOST = 'http://mock.test';
  process.env.PIKVM_PASSWORD = 'testpw';
  process.env.PIKVM_MCP_PORT = '8675';
  try {
    delete process.env.PIKVM_MCP_ARM_HID;
    delete process.env.PIKVM_MCP_ARM_MSD;
    assert.equal(loadConfig().http.armHid, false);
    assert.equal(loadConfig().http.armMsd, false);
    process.env.PIKVM_MCP_ARM_HID = '1';
    assert.equal(loadConfig().http.armHid, true);
    assert.equal(loadConfig().http.armMsd, false);
    process.env.PIKVM_MCP_ARM_MSD = '1';
    assert.equal(loadConfig().http.armMsd, true);
    process.env.PIKVM_MCP_ARM_MSD = 'true';
    assert.equal(loadConfig().http.armMsd, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
