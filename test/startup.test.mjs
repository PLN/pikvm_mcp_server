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

test('fail-closed: PIKVM_MCP_PORT without PIKVM_MCP_BEARER exits non-zero with fatal message', { timeout: 15000 }, async () => {
  const env = { ...process.env };
  delete env.PIKVM_MCP_BEARER;
  delete env.PIKVM_MCP_ARM_HID;
  env.PIKVM_MCP_NO_DOTENV = '1'; // repo .env must not inject a bearer
  env.PIKVM_HOST = 'http://127.0.0.1:9'; // closed port: checkAuth warns, startup continues
  env.PIKVM_PASSWORD = 'testpw';
  env.PIKVM_MCP_PORT = '8974';

  const child = spawn('node', [join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });

  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fail-closed process did not exit in time. stderr so far: ${stderr}`));
    }, 12000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  assert.ok(exit.code !== 0, `expected non-zero exit, got code=${exit.code} signal=${exit.signal}`);
  assert.match(stderr, /PIKVM_MCP_BEARER must be set/, 'stderr must carry the fail-closed reason');
});
