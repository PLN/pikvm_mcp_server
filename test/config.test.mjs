/**
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
import { loadEnvFile } from '../dist/config.js';

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

test('without NO_DOTENV: .env override behavior is unchanged (still wins)', async () => {
  await withEnvFile('PIKVM_MCP_TEST_B=fromdotenv\n', async (file) => {
    process.env.PIKVM_MCP_TEST_B = 'fromprocess';
    try {
      loadEnvFile(file);
      assert.equal(process.env.PIKVM_MCP_TEST_B, 'fromdotenv',
        'default path must keep the pre-existing override:true behavior');
    } finally {
      delete process.env.PIKVM_MCP_TEST_B;
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
