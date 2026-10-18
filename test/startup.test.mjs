// Modified 2026-10 by PLN: empty bearer is unset (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: bearer whitespace is HTTP-only (GPL-3.0; see NOTICE).
/**
 * Startup-mode tests — real `node dist/index.js` spawns covering the
 * process-level behaviors the in-process tests can't reach.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');

function baseEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.PIKVM_MCP_ARM_HID;
  delete env.PIKVM_MCP_BEARER_FILE;
  delete env.CREDENTIALS_DIRECTORY;
  delete env.PIKVM_PASSWORD_FILE;
  env.PIKVM_MCP_NO_DOTENV = '1';
  env.PIKVM_HOST = 'http://127.0.0.1:9';
  env.PIKVM_PASSWORD = 'testpw';
  return env;
}

function spawnIndex(env) {
  const child = spawn(process.execPath, [join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  return {
    child,
    text: () => stderr,
  };
}

test('fail-closed: PIKVM_MCP_PORT without PIKVM_MCP_BEARER exits non-zero with fatal message', { timeout: 15000 }, async () => {
  const env = baseEnv({ PIKVM_MCP_PORT: '8974' });
  delete env.PIKVM_MCP_BEARER;
  const started = spawnIndex(env);
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      started.child.kill('SIGKILL');
      reject(new Error(`fail-closed process did not exit in time. stderr so far: ${started.text()}`));
    }, 12000);
    started.child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    started.child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  assert.ok(exit.code !== 0, `expected non-zero exit, got code=${exit.code} signal=${exit.signal}`);
  assert.match(started.text(), /PIKVM_MCP_BEARER must be set/);
  assert.match(started.text(), /PIKVM_MCP_BEARER_FILE/);
  assert.match(started.text(), /CREDENTIALS_DIRECTORY\/pikvm-mcp-bearer/);
});

test('an empty bearer in HTTP mode is refused', { timeout: 15000 }, async () => {
  const started = spawnIndex(baseEnv({
    PIKVM_MCP_PORT: '8974',
    PIKVM_MCP_BEARER: '',
  }));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      started.child.kill('SIGKILL');
      reject(new Error(`empty bearer did not exit. stderr so far: ${started.text()}`));
    }, 12000);
    started.child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.notEqual(exit, 0);
  assert.match(started.text(), /PIKVM_MCP_BEARER must be set/);
  assert.match(started.text(), /PIKVM_MCP_BEARER_FILE/);
  assert.match(started.text(), /CREDENTIALS_DIRECTORY\/pikvm-mcp-bearer/);
  assert.equal(started.text().includes('is empty'), false);
});

test('an empty bearer in stdio mode starts', { timeout: 15000 }, async () => {
  const env = baseEnv({ PIKVM_MCP_BEARER: '' });
  delete env.PIKVM_MCP_PORT;
  const started = spawnIndex(env);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      started.child.kill('SIGKILL');
      reject(new Error(`stdio did not start. stderr so far: ${started.text()}`));
    }, 12000);
    started.child.stderr.on('data', () => {
      if (started.text().includes('PiKVM MCP Server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    started.child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`stdio exited early: ${started.text()}`));
    });
  });
  started.child.kill('SIGTERM');
  await new Promise((resolve) => started.child.once('exit', resolve));
  assert.equal(started.text().includes('is empty'), false);
  assert.equal(started.text().includes('PIKVM_MCP_BEARER must be set'), false);
});

test('stdio starts when the bearer contains a trailing newline', { timeout: 15000 }, async () => {
  const env = baseEnv({ PIKVM_MCP_BEARER: 'tok\n' });
  delete env.PIKVM_MCP_PORT;
  const started = spawnIndex(env);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      started.child.kill('SIGKILL');
      reject(new Error(`stdio did not start. stderr so far: ${started.text()}`));
    }, 12000);
    started.child.stderr.on('data', () => {
      if (started.text().includes('PiKVM MCP Server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    started.child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`stdio exited early: ${started.text()}`));
    });
  });
  started.child.kill('SIGTERM');
  await new Promise((resolve) => started.child.once('exit', resolve));
  assert.equal(started.text().includes('whitespace'), false);
  assert.equal(started.text().includes('tok'), false);
});

test('HTTP mode refuses a bearer with a trailing newline', { timeout: 15000 }, async () => {
  const started = spawnIndex(baseEnv({
    PIKVM_MCP_PORT: '8974',
    PIKVM_MCP_BEARER: 'tok\n',
  }));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      started.child.kill('SIGKILL');
      reject(new Error(`whitespace bearer did not exit. stderr so far: ${started.text()}`));
    }, 12000);
    started.child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.notEqual(exit, 0);
  assert.match(started.text(), /PIKVM_MCP_BEARER/);
  assert.match(started.text(), /whitespace/);
  assert.equal(started.text().includes('tok'), false);
});
