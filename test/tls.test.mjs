// Modified 2026-10 by PLN: TLS verify, pin, and insecure modes (GPL-3.0; see NOTICE).

/**
 * Self-signed server minted in this process. No committed key.
 * A wrong pin must fail closed, once, on every kvmd path.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/config.js';
import { KvmdError, PiKVMClient } from '../dist/pikvm/client.js';
import {
  TLS_CERT_MAX_BYTES,
  assertPinNotInsecure,
  kvmdConnectOptions,
  readPinnedCert,
} from '../dist/tls.js';
import { kvmdGet } from './hw/session.mjs';
import { mintCert } from './tls-cert.mjs';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const right = mintCert();
const wrong = mintCert('other.example.ts.net');

function errorText(err) {
  const parts = [];
  const seen = new Set();
  let current = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current.type) parts.push(String(current.type));
    if (current.code) parts.push(String(current.code));
    if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  return parts.join('\n');
}

function pinSpec(material) {
  return {
    device: 'default',
    mode: 'pin',
    certPem: material.cert,
    spkiSha256: material.spkiSha256,
  };
}

function clientFor(port, tlsDevice, extra = {}) {
  return new PiKVMClient({
    host: `https://127.0.0.1:${port}`,
    username: 'admin',
    password: 'not-a-real-password',
    tls: { default: tlsDevice },
    requestTimeoutMs: 3000,
    msdJobTimeoutMs: 3000,
    msdIdleTimeoutMs: 1000,
    ...extra,
  });
}

function assertMismatch(err) {
  assert.ok(err instanceof KvmdError);
  assert.equal(err.type, 'PIKVM_TLS_PIN_MISMATCH');
  assert.match(err.message, /device default/);
  assert.match(err.message, new RegExp(wrong.spkiSha256));
  assert.match(err.message, new RegExp(right.spkiSha256));
  assert.match(err.message, /pikvm-mcp-server pin default/);
  assert.equal(err.type === 'PIKVM_UNREACHABLE', false);
  return true;
}

describe('pin dispatcher', { concurrency: false }, () => {
  let server;
  let port;
  let connections = 0;

  before(async () => {
    server = tls.createServer({ key: right.key, cert: right.cert }, (socket) => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 11\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{"ok":true}');
    });
    const sockets = new Set();
    server.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.unrefSockets = sockets;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    for (const socket of server.unrefSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  test('verify fails against a self-signed certificate', async () => {
    const client = clientFor(port, { device: 'default', mode: 'verify' });
    try {
      await assert.rejects(() => client.getMsdState(), (err) => {
        assert.ok(err instanceof KvmdError);
        assert.equal(err.type, 'PIKVM_TLS_VERIFY_FAILED');
        assert.match(err.message, /DEPTH_ZERO_SELF_SIGNED_CERT/);
        assert.match(err.message, /device default/);
        assert.equal(err.type === 'PIKVM_TLS_PIN_MISMATCH', false);
        assert.equal(err.type === 'PIKVM_UNREACHABLE', false);
        return true;
      });
    } finally {
      await client.close();
    }
  });

  test('the right pin passes for an IP whose name is not on the certificate', async () => {
    const client = clientFor(port, pinSpec(right));
    try {
      assert.equal(await client.checkAuth(), true);
    } finally {
      await client.close();
    }
  });

  test('a wrong pin fails with both fingerprints and is not unreachable', async () => {
    const client = clientFor(port, pinSpec(wrong));
    try {
      await assert.rejects(() => client.getMsdState(), assertMismatch);
    } finally {
      await client.close();
    }
  });

  test('a pin failure is one handshake and is not retried insecure', async () => {
    const client = clientFor(port, pinSpec(wrong));
    const before = connections;
    try {
      await assert.rejects(() => client.getMsdState(), assertMismatch);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(connections - before, 1);
    } finally {
      await client.close();
    }
  });

  test('a wrong pin fails GET, POST, HID, msdWrite, msdWriteRemote, and kvmdGet', async () => {
    const tlsDevice = pinSpec(wrong);
    const client = clientFor(port, tlsDevice);
    const calls = [
      () => client.getMsdState(),
      () => client.msdSetConnected(false),
      () => client.type('a'),
      () => client.msdWrite('mcp-hwtest.iso', Readable.from([Buffer.from('x')]), 1),
      async () => {
        const gen = client.msdWriteRemote('https://images.example/mcp-hwtest.iso');
        await gen.next();
      },
    ];
    try {
      for (const call of calls) {
        const before = connections;
        await assert.rejects(call, assertMismatch);
        assert.equal(connections - before, 1);
      }
      const before = connections;
      await assert.rejects(
        () => kvmdGet({
          host: `https://127.0.0.1:${port}`,
          username: 'admin',
          password: 'not-a-real-password',
          tls: { default: tlsDevice },
          requestTimeoutMs: 3000,
        }, '/api/auth/check'),
        (err) => {
          const text = errorText(err);
          assert.match(text, /PIKVM_TLS_PIN_MISMATCH/);
          assert.match(text, new RegExp(wrong.spkiSha256));
          assert.match(text, new RegExp(right.spkiSha256));
          return true;
        },
      );
      assert.equal(connections - before, 1);
    } finally {
      await client.close();
    }
  });

  test('insecure reaches the self-signed server', async () => {
    const client = clientFor(port, { device: 'default', mode: 'insecure' });
    try {
      assert.equal(await client.checkAuth(), true);
    } finally {
      await client.close();
    }
  });
});

test('pin connect options keep rejectUnauthorized true', () => {
  assert.throws(
    () => assertPinNotInsecure({
      rejectUnauthorized: false,
      checkServerIdentity() {
        return undefined;
      },
    }),
    /rejectUnauthorized true/,
  );
  const options = kvmdConnectOptions(pinSpec(right));
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(typeof options.checkServerIdentity, 'function');
  assert.doesNotThrow(() => assertPinNotInsecure(options));
  const identity = options.checkServerIdentity;
  const mismatch = identity('127.0.0.1', { raw: right.raw });
  assert.equal(mismatch, undefined);
  const rejected = identity('127.0.0.1', { raw: wrong.raw });
  assert.equal(rejected.code, 'PIKVM_TLS_PIN_MISMATCH');
});

describe('TLS config', () => {
  const keys = [
    'PIKVM_HOST',
    'PIKVM_PASSWORD',
    'PIKVM_TLS_MODE',
    'PIKVM_TLS_CERT_FILE',
    'PIKVM_VERIFY_SSL',
  ];

  function withEnv(extra) {
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, extra);
    const logged = [];
    const orig = console.error;
    console.error = (line) => {
      logged.push(String(line));
    };
    return {
      logged,
      restore() {
        console.error = orig;
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      },
    };
  }

  test('legacy PIKVM_VERIFY_SSL maps to verify or insecure', () => {
    const verify = withEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_VERIFY_SSL: 'true',
    });
    try {
      const config = loadConfig();
      assert.equal(config.pikvm.tls.default.mode, 'verify');
      assert.equal(config.pikvm.tls.default.device, 'default');
      assert.equal(config.pikvm.verifySsl, true);
      assert.equal(verify.logged.length, 0);
    } finally {
      verify.restore();
    }

    const insecure = withEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_VERIFY_SSL: 'false',
    });
    try {
      const config = loadConfig();
      assert.equal(config.pikvm.tls.default.mode, 'insecure');
      assert.equal(insecure.logged.length, 1);
      assert.match(insecure.logged[0], /PIKVM_TLS_MODE=insecure/);
      assert.match(insecure.logged[0], /pikvm-mcp-server pin default/);
    } finally {
      insecure.restore();
    }
  });

  test('an explicit mode wins over a contradicting PIKVM_VERIFY_SSL', () => {
    const ctx = withEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_TLS_MODE: 'verify',
      PIKVM_VERIFY_SSL: 'false',
    });
    try {
      const config = loadConfig();
      assert.equal(config.pikvm.tls.default.mode, 'verify');
      assert.equal(ctx.logged.length, 1);
      assert.match(ctx.logged[0], /PIKVM_TLS_MODE=verify overrides PIKVM_VERIFY_SSL/);
    } finally {
      ctx.restore();
    }
  });

  test('explicit insecure warns and an unknown mode is a startup error', () => {
    const insecure = withEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_TLS_MODE: 'insecure',
      PIKVM_VERIFY_SSL: 'true',
    });
    try {
      assert.equal(loadConfig().pikvm.tls.default.mode, 'insecure');
      assert.equal(insecure.logged.length, 2);
      assert.ok(insecure.logged.some((line) => line.includes('overrides')));
      assert.ok(insecure.logged.some((line) => line.includes('PIKVM_TLS_MODE=insecure') && line.includes('pikvm-mcp-server pin default')));
    } finally {
      insecure.restore();
    }

    const unknown = withEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_TLS_MODE: 'trust-on-first-use',
    });
    try {
      assert.throws(() => loadConfig(), /PIKVM_TLS_MODE must be verify, pin, or insecure/);
      assert.equal(unknown.logged.length, 0);
    } finally {
      unknown.restore();
    }
  });

  test('pin requires a readable regular certificate and does not warn about mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pikvm-tls-'));
    try {
      const missing = withEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'pin',
      });
      try {
        assert.throws(() => loadConfig(), /PIKVM_TLS_CERT_FILE is required when PIKVM_TLS_MODE=pin/);
      } finally {
        missing.restore();
      }

      const absent = join(dir, 'missing.pem');
      const gone = withEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'pin',
        PIKVM_TLS_CERT_FILE: absent,
      });
      try {
        assert.throws(() => loadConfig(), (err) => {
          assert.match(err.message, /PIKVM_TLS_CERT_FILE/);
          assert.match(err.message, new RegExp(absent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
          return true;
        });
      } finally {
        gone.restore();
      }

      const asDir = join(dir, 'dir');
      mkdirSync(asDir);
      const directory = withEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'pin',
        PIKVM_TLS_CERT_FILE: asDir,
      });
      try {
        assert.throws(() => loadConfig(), /not a regular file/);
      } finally {
        directory.restore();
      }

      const big = join(dir, 'big.pem');
      writeFileSync(big, Buffer.alloc(TLS_CERT_MAX_BYTES + 1, 0x61));
      const oversize = withEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'pin',
        PIKVM_TLS_CERT_FILE: big,
      });
      try {
        assert.throws(() => loadConfig(), /larger than/);
      } finally {
        oversize.restore();
      }

      if (process.platform !== 'win32') {
        const fifo = join(dir, 'fifo');
        execFileSync('mkfifo', [fifo]);
        const started = Date.now();
        assert.throws(() => readPinnedCert(fifo), /not a regular file/);
        assert.ok(Date.now() - started < 1000);
      }

      const file = join(dir, 'leaf.pem');
      writeFileSync(file, right.cert, { mode: 0o644 });
      const link = join(dir, 'leaf-link.pem');
      symlinkSync(file, link);
      const pinned = withEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'pin',
        PIKVM_TLS_CERT_FILE: link,
        PIKVM_VERIFY_SSL: 'false',
      });
      try {
        const config = loadConfig();
        assert.equal(config.pikvm.tls.default.mode, 'pin');
        assert.equal(config.pikvm.tls.default.spkiSha256, right.spkiSha256);
        assert.equal(config.pikvm.tls.default.device, 'default');
        assert.equal(pinned.logged.some((line) => line.includes('mode ')), false);
        assert.equal(pinned.logged.length, 1);
        assert.match(pinned.logged[0], /overrides/);
      } finally {
        pinned.restore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pin CLI', { concurrency: false }, () => {
  let server;
  let port;
  let received = Buffer.alloc(0);
  let connections = 0;

  before(async () => {
    const sockets = new Set();
    server = tls.createServer({ key: right.key, cert: right.cert }, (socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
    });
    server.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.unrefSockets = sockets;
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    for (const socket of server.unrefSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  function runPin(args, env) {
    const child = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'pin', ...args], {
      cwd: REPO,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`pin did not exit\n${stdout}\n${stderr}`));
      }, 10000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        setTimeout(() => resolve({ code, stdout, stderr }), 30);
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function pinEnv(extra = {}) {
    return {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? '/tmp',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      PIKVM_MCP_NO_DOTENV: '1',
      PIKVM_HOST: `https://127.0.0.1:${port}`,
      PIKVM_PASSWORD: 'sentinel-pin-9f3a2c7b',
      PIKVM_USERNAME: 'sentinel-user',
      ...extra,
    };
  }

  test('a non-TTY without --yes writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pikvm-pin-'));
    const dest = join(dir, 'default.pem');
    try {
      const result = await runPin(['default', '--out', dest], pinEnv());
      assert.notEqual(result.code, 0);
      assert.match(`${result.stdout}\n${result.stderr}`, /refusing to write/);
      assert.match(result.stdout, /SPKI sha256: /);
      assert.equal(existsSync(dest), false);
      assert.equal(received.includes('sentinel-pin-9f3a2c7b'), false);
      assert.equal(received.includes('X-KVMD-'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--yes writes the leaf PEM atomically and sends no credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pikvm-pin-'));
    const dest = join(dir, 'default.pem');
    const before = connections;
    try {
      const result = await runPin(['default', '--yes', '--out', dest], pinEnv());
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /subject: CN=pikvm\.example\.ts\.net/);
      assert.match(result.stdout, /issuer: CN=pikvm\.example\.ts\.net/);
      assert.match(result.stdout, /valid from: /);
      assert.match(result.stdout, /valid to: /);
      assert.match(result.stdout, /SHA-256 fingerprint: [0-9a-f]{64}/);
      assert.match(result.stdout, new RegExp(`SPKI sha256: ${right.spkiSha256}`));
      const written = readPinnedCert(dest);
      assert.equal(written.spkiSha256, right.spkiSha256);
      assert.equal(new crypto.X509Certificate(written.pem).raw.equals(right.raw), true);
      assert.equal(statSync(dest).mode & 0o777, 0o644);
      assert.equal(readdirSync(dir).some((name) => name.includes('.tmp')), false);
      assert.equal(connections - before, 1);
      assert.equal(received.length, 0);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes('sentinel-pin-9f3a2c7b'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a re-pin shows the old and new SPKI and --yes replaces the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pikvm-pin-'));
    const dest = join(dir, 'default.pem');
    writeFileSync(dest, wrong.cert, { mode: 0o644 });
    chmodSync(dest, 0o644);
    try {
      const refused = await runPin(['default', '--out', dest], pinEnv());
      assert.notEqual(refused.code, 0);
      assert.match(refused.stdout, new RegExp(`old SPKI sha256: ${wrong.spkiSha256}`));
      assert.match(refused.stdout, new RegExp(`new SPKI sha256: ${right.spkiSha256}`));
      assert.equal(readPinnedCert(dest).spkiSha256, wrong.spkiSha256);

      const replaced = await runPin(['default', '--yes', '--out', dest], pinEnv());
      assert.equal(replaced.code, 0, replaced.stderr);
      assert.match(replaced.stdout, new RegExp(`old SPKI sha256: ${wrong.spkiSha256}`));
      assert.match(replaced.stdout, new RegExp(`new SPKI sha256: ${right.spkiSha256}`));
      assert.equal(readPinnedCert(dest).spkiSha256, right.spkiSha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a device other than default is refused before a connection', async () => {
    const before = connections;
    const result = await runPin(['lab1', '--yes', '--out', join(tmpdir(), 'unused.pem')], pinEnv());
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /only device "default"/);
    assert.match(result.stderr, /Phase B item 10/);
    assert.equal(connections, before);
  });
});
