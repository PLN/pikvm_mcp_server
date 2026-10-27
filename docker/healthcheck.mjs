// Modified 2026-10 by PLN: Docker image (GPL-3.0; see NOTICE).

/**
 * Container healthcheck. stdio mode has no listener, so it is healthy.
 * HTTP mode must answer GET /healthz with "ok" within 2 s. /healthz
 * needs no bearer and does not call kvmd.
 */

import http from 'node:http';

const port = process.env.PIKVM_MCP_PORT ?? '';
if (port.trim() === '') process.exit(0);

let host = process.env.PIKVM_MCP_HOST || '127.0.0.1';
if (host === '0.0.0.0') host = '127.0.0.1';
if (host === '::') host = '::1';

const req = http.get(
  { host, port: Number.parseInt(port, 10), path: '/healthz', timeout: 2000 },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => process.exit(res.statusCode === 200 && body === 'ok' ? 0 : 1));
  },
);
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', (err) => {
  console.error(`healthcheck: ${err.message}`);
  process.exit(1);
});
