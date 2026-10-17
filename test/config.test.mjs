/**
 * Modified 2026-10 by PLN: PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE).
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
import { clampRequestTimeoutMs } from '../dist/request-timeout.js';

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

test('clampRequestTimeoutMs keeps an integer in 1..600000', () => {
  assert.equal(clampRequestTimeoutMs(Number.NaN), 5000);
  assert.equal(clampRequestTimeoutMs(Number.POSITIVE_INFINITY), 5000);
  assert.equal(clampRequestTimeoutMs(0), 1);
  assert.equal(clampRequestTimeoutMs(-4), 1);
  assert.equal(clampRequestTimeoutMs(1.9), 1);
  assert.equal(clampRequestTimeoutMs(1500), 1500);
  assert.equal(clampRequestTimeoutMs(600000), 600000);
  assert.equal(clampRequestTimeoutMs(600001), 600000);
});

test('PIKVM_REQUEST_TIMEOUT_MS is an integer clamped to 1..600000', () => {
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
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 1);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '0';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 1);
    process.env.PIKVM_REQUEST_TIMEOUT_MS = '-4';
    assert.equal(loadConfig().pikvm.requestTimeoutMs, 1);
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
