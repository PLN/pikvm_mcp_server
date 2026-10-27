// Modified 2026-10 by PLN: Docker image smoke test (GPL-3.0; see NOTICE).

/**
 * Minimal MCP stdio client for the image smoke test.
 * Usage: node test/docker/mcp-stdio.mjs tools -- docker run -i ...
 *        node test/docker/mcp-stdio.mjs call <tool> <json-args> -- docker run -i ...
 * Sends initialize, then tools/list or one tools/call, prints the result,
 * closes stdin and waits for the server to exit. `tools` prints one name
 * per line. `call` prints the text content, then a line isError=<bool>.
 * The server's stderr passes through. The exit code is the server's, or
 * 124 when no answer or exit came within 60 s.
 */

import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
if (sep < 0) {
  console.error('usage: mcp-stdio.mjs tools|call <tool> <json-args> -- <command...>');
  process.exit(64);
}
const [mode, toolName, toolArgs] = process.argv.slice(2, sep);
const command = process.argv.slice(sep + 1);

const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
const timer = setTimeout(() => {
  console.error('mcp-stdio: no answer or exit within 60 s');
  child.kill('SIGKILL');
  process.exit(124);
}, 60_000);

function send(message) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function done(result) {
  if (mode === 'tools') {
    for (const tool of result.tools) console.log(tool.name);
  } else {
    for (const part of result.content ?? []) if (part.type === 'text') console.log(part.text);
    console.log(`isError=${result.isError === true}`);
  }
  child.stdin.end();
}

let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim() === '') continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ method: 'notifications/initialized' });
      if (mode === 'tools') send({ id: 2, method: 'tools/list' });
      else send({ id: 2, method: 'tools/call', params: { name: toolName, arguments: JSON.parse(toolArgs ?? '{}') } });
    } else if (message.id === 2) {
      if (message.error) {
        console.error(`mcp-stdio: ${JSON.stringify(message.error)}`);
        child.stdin.end();
      } else {
        done(message.result);
      }
    }
  }
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  process.exit(code ?? (signal ? 128 : 1));
});

send({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pikvm-smoke', version: '0' } },
});
