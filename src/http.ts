/**
 * Streamable HTTP transport for the MCP server
 *
 * Serves MCP over plain node:http (no framework dependency) with mandatory
 * bearer-token auth. Session handling follows the MCP Streamable HTTP spec:
 *
 * - POST with no mcp-session-id and an initialize request -> new session
 *   (fresh transport + fresh MCP Server instance, since the SDK's Server
 *   binds to exactly one transport).
 * - POST/GET/DELETE with mcp-session-id -> routed to that session's transport.
 * - DELETE terminates the session; the transport's onclose removes it here.
 *
 * POST responses are always JSON (enableJsonResponse) — no SSE streams.
 * Cloudflare's edge kills long-lived SSE connections, which would break
 * remote MCP through a CF-fronted gateway; JSON responses keep every request
 * a plain HTTP round-trip. The standalone GET SSE stream (server-initiated
 * notifications) is refused with 405, which is spec-allowed and handled
 * gracefully by MCP clients. DELETE still terminates sessions.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

// Tool-call payloads are small JSON; reject anything bigger before parsing.
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpTransportOptions {
  port: number;
  /** Bearer token required on every request except /healthz. */
  bearerToken: string;
  /** Builds a fresh MCP Server per session. */
  createServer: () => McpServer;
  /** Bind address (default: all interfaces — auth is mandatory anyway). */
  host?: string;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Constant-time bearer token check. Both sides are hashed first so the
 * compared buffers are always the same length (timingSafeEqual throws on a
 * length mismatch, which would itself leak length information).
 */
function bearerTokenMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const spaceIdx = header.indexOf(' ');
  if (spaceIdx === -1) return false;
  const scheme = header.slice(0, spaceIdx).toLowerCase();
  const token = header.slice(spaceIdx + 1).trim();
  if (scheme !== 'bearer' || !token) return false;
  return timingSafeEqual(sha256(token), sha256(expected));
}

function jsonError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Unauthorized: Authorization: Bearer <token> required' },
    id: null,
  }));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Request body too large') as Error & { statusCode?: number };
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON body') as Error & { statusCode?: number };
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Start the HTTP transport. Resolves once the server is listening.
 *
 * Callers that embed this behind a reverse proxy must forward the
 * Authorization and mcp-session-id headers unchanged.
 */
export function startHttpServer(options: HttpTransportOptions): Promise<HttpServer> {
  const { port, bearerToken, createServer, host } = options;
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // Unauthenticated liveness probe for supervision scripts.
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (!bearerTokenMatches(req.headers.authorization, bearerToken)) {
        unauthorized(res);
        return;
      }

      if (url.pathname !== '/mcp') {
        jsonError(res, 404, -32000, 'Not found: MCP endpoint is /mcp');
        return;
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          const status = (err as Error & { statusCode?: number }).statusCode ?? 400;
          jsonError(res, status, -32700, `Bad Request: ${(err as Error).message}`);
          return;
        }

        const sessionId = req.headers['mcp-session-id'];
        const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        if (existing) {
          await existing.handleRequest(req, res, body);
          return;
        }

        if (sessionId === undefined && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, transport);
            },
            enableJsonResponse: true,
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              sessions.delete(transport.sessionId);
            }
          };
          const mcpServer = createServer();
          try {
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, body);
          } catch (err) {
            // Don't leak a half-initialized session into the map.
            await transport.close().catch(() => {});
            throw err;
          }
          return;
        }

        // Mirror the SDK's own session validation wording:
        // 400 for missing session id on non-initialize, 404 for unknown id.
        if (sessionId === undefined) {
          jsonError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required (send initialize first)');
        } else {
          jsonError(res, 404, -32001, 'Session not found');
        }
        return;
      }

      if (req.method === 'GET') {
        // No server-initiated SSE stream (CF edge kills long-lived
        // connections). 405 is the spec-allowed answer; clients treat it as
        // "no server-initiated notifications" and keep using POST.
        res.writeHead(405, {
          'Content-Type': 'application/json',
          Allow: 'POST, DELETE',
        });
        res.end(JSON.stringify({ error: 'Method not allowed: GET SSE streams are disabled; use POST JSON-RPC' }));
        return;
      }

      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'];
        const transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        if (!transport) {
          jsonError(res, 404, -32001, 'Session not found');
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, {
        'Content-Type': 'application/json',
        Allow: 'POST, DELETE',
      });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    } catch (err) {
      // Token never logged: scrub the bearer token out of whatever the error
      // machinery produced before it reaches stderr.
      const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error('HTTP transport error:', raw.split(bearerToken).join('[REDACTED]'));
      if (!res.headersSent) {
        jsonError(res, 500, -32603, 'Internal server error');
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
