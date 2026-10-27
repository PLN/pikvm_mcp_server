// Modified 2026-10 by PLN: serverInfo.version follows package.json (GPL-3.0; see NOTICE).

/**
 * stdio smoke test — spawns `node dist/index.js` exactly like PC-Control does
 * (probes/pikvm_acceptance.py: StdioServerParameters(command="node",
 * args=[<repo>/dist/index.js])) and speaks newline-delimited JSON-RPC over
 * stdin/stdout.
 *
 * Safety: the child gets PIKVM_MCP_NO_DOTENV=1 and PIKVM_HOST=<mock>, so the
 * repo's real .env can neither override the mock host nor send HID events to
 * the real device. This doubles as the end-to-end NO_DOTENV assertion: if
 * dotenv won, the mock would receive zero calls and the test would fail.
 *
 * stdio mode must show NO arm-gate (behavior unchanged): pikvm_mouse_click
 * is expected to dispatch even though PIKVM_MCP_ARM_HID is unset.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { startKvmdMock } from './kvmd-mock.mjs';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');

test('stdio: initialize works and mouse click dispatches (no arm-gate in stdio)', { timeout: 20000 }, async (t) => {
  const mock = await startKvmdMock();

  const env = { ...process.env };
  // Belt and braces: force stdio + mock host, whatever the parent env has.
  delete env.PIKVM_MCP_PORT;
  delete env.PIKVM_MCP_BEARER;
  delete env.PIKVM_MCP_ARM_HID;
  env.PIKVM_MCP_NO_DOTENV = '1';
  env.PIKVM_HOST = mock.url;
  env.PIKVM_PASSWORD = 'testpw';

  const child = spawn('node', [join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    const responses = new Map();
    const lineBuffer = [];
    let wakeup = null;
    let closed = false;

    child.stdout.setEncoding('utf8');
    let carry = '';
    child.stdout.on('data', (d) => {
      carry += d;
      let idx;
      while ((idx = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, idx).trim();
        carry = carry.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
          lineBuffer.push(msg);
        } catch {
          // Non-JSON stdout would corrupt MCP protocol — surface it.
          assert.fail(`stdout is not newline-delimited JSON: ${line.slice(0, 100)}`);
        }
      }
      if (wakeup) { wakeup(); wakeup = null; }
    });
    child.on('exit', () => { closed = true; if (wakeup) { wakeup(); wakeup = null; } });

    async function waitForResponse(id, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (!responses.has(id)) {
        if (closed) throw new Error(`child exited early. stderr: ${stderr}`);
        if (Date.now() > deadline) throw new Error(`timed out waiting for id=${id}. stderr: ${stderr}`);
        await new Promise((r) => { wakeup = r; setTimeout(r, 500); });
      }
      return responses.get(id);
    }

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wp1-test', version: '1.0' } },
    }) + '\n');

    const init = await waitForResponse(1);
    assert.equal(init.result.serverInfo.name, 'pikvm-mcp-server');
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    assert.equal(init.result.serverInfo.version, pkg.version);
    assert.ok(init.result.protocolVersion, 'protocolVersion negotiated');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'pikvm_mouse_click', arguments: { button: 'left' } },
    }) + '\n');

    const click = await waitForResponse(2);
    assert.equal(click.result.isError, undefined, JSON.stringify(click.result));
    assert.doesNotMatch(click.result.content[0].text, /arm-gate/, 'stdio mode must NOT be arm-gated');
    assert.equal(click.result.content[0].text.split('\n')[0], 'left click');
    assert.equal(JSON.parse(click.result.content[0].text.split('\n')[1]).frameId, 'default');

    const buttons = mock.calls.filter((c) => c.path === '/api/hid/events/send_mouse_button');
    assert.equal(buttons.length, 2, 'click dispatched to the mock (press + release)');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    await mock.close();
  }
});
