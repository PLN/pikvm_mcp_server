// Modified 2026-10 by PLN: password and bearer secret files (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: empty secret vars are unset (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: bearer whitespace is HTTP-only (GPL-3.0; see NOTICE).

/**
 * resolveSecret order and file rules. Temp directories are removed.
 * A sentinel value must not appear on a started server's stdout or stderr.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { redactConfig, loadConfig } from '../dist/config.js';
import { SECRET_MAX_BYTES, resolveSecret } from '../dist/secrets.js';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const SENTINEL = 'sentinel-9f3a2c7b-secret';

function capture(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    const value = fn();
    return { value, lines };
  } finally {
    console.error = orig;
  }
}

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'pikvm-secret-'));
}

describe('resolveSecret', () => {
  test('env beats _FILE beats CREDENTIALS_DIRECTORY', async () => {
    const dir = await tempDir();
    try {
      const filePath = join(dir, 'from-file');
      const credDir = join(dir, 'creds');
      mkdirSync(credDir);
      writeFileSync(filePath, 'from-file-secret\n', { mode: 0o600 });
      writeFileSync(join(credDir, 'pikvm-password'), 'from-cred-secret\n', { mode: 0o600 });
      const env = {
        PIKVM_PASSWORD: 'from-env-secret',
        PIKVM_PASSWORD_FILE: filePath,
        CREDENTIALS_DIRECTORY: credDir,
      };
      const { value, lines } = capture(() => resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env,
      }));
      assert.equal(value, 'from-env-secret');
      assert.equal(lines.length, 1);
      assert.match(lines[0], /PIKVM_PASSWORD_FILE is set and was ignored because PIKVM_PASSWORD is set/);
      assert.equal(lines[0].includes('from-env-secret'), false);
      assert.equal(lines[0].includes('from-file-secret'), false);
      assert.equal(lines[0].includes('from-cred-secret'), false);

      const fileOnly = capture(() => resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD_FILE: filePath, CREDENTIALS_DIRECTORY: credDir },
      }));
      assert.equal(fileOnly.value, 'from-file-secret');
      assert.deepEqual(fileOnly.lines, []);

      const credOnly = capture(() => resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { CREDENTIALS_DIRECTORY: credDir },
      }));
      assert.equal(credOnly.value, 'from-cred-secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('one trailing newline is stripped and other whitespace stays', async () => {
    const dir = await tempDir();
    try {
      const cases = [
        ['lf', 'secret\n', 'secret'],
        ['crlf', 'secret\r\n', 'secret'],
        ['second newline', 'secret\n\n', 'secret\n'],
        ['internal space', 'sec ret\n', 'sec ret'],
        ['trailing space', 'secret \n', 'secret '],
        ['lone cr', 'secret\r', 'secret\r'],
      ];
      for (const [label, raw, expected] of cases) {
        const filePath = join(dir, label);
        writeFileSync(filePath, raw, { mode: 0o600 });
        const value = resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: filePath },
        });
        assert.equal(value, expected, label);
      }
      const fromEnv = resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD: 'env-secret\r\n' },
      });
      assert.equal(fromEnv, 'env-secret\r\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an empty direct value falls through to the file and then the credential', async () => {
    const dir = await tempDir();
    try {
      const filePath = join(dir, 'from-file');
      writeFileSync(filePath, 'from-file-secret\n', { mode: 0o600 });
      const fromFile = resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD: '', PIKVM_PASSWORD_FILE: filePath },
      });
      assert.equal(fromFile, 'from-file-secret');

      const credDir = join(dir, 'creds');
      mkdirSync(credDir);
      writeFileSync(join(credDir, 'pikvm-password'), 'from-cred-secret\n', { mode: 0o600 });
      const fromCred = resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: {
          PIKVM_PASSWORD: '',
          PIKVM_PASSWORD_FILE: '',
          CREDENTIALS_DIRECTORY: credDir,
        },
      });
      assert.equal(fromCred, 'from-cred-secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a leading BOM is removed and a NUL byte is rejected', async () => {
    const dir = await tempDir();
    try {
      const bom = join(dir, 'bom');
      writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('secret\n')]), { mode: 0o600 });
      assert.equal(resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD_FILE: bom },
      }), 'secret');

      const nul = join(dir, 'nul');
      writeFileSync(nul, 'alpha\0omega\n', { mode: 0o600 });
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: nul },
        }),
        (err) => {
          assert.match(err.message, /PIKVM_PASSWORD_FILE/);
          assert.match(err.message, /NUL/);
          assert.equal(err.message.includes(nul), true);
          assert.equal(err.message.includes('alpha'), false);
          assert.equal(err.message.includes('omega'), false);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an empty file is an error', async () => {
    const dir = await tempDir();
    try {
      const filePath = join(dir, 'empty');
      writeFileSync(filePath, '\n', { mode: 0o600 });
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: filePath },
        }),
        (err) => {
          assert.match(err.message, /PIKVM_PASSWORD_FILE/);
          assert.match(err.message, /empty/);
          assert.equal(err.message.includes(filePath), true);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing file names the variable and the path', async () => {
    const dir = await tempDir();
    try {
      const filePath = join(dir, 'missing');
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: filePath },
        }),
        (err) => {
          assert.match(err.message, /PIKVM_PASSWORD_FILE/);
          assert.match(err.message, /cannot read/);
          assert.equal(err.message.includes(filePath), true);
          return true;
        },
      );
      const credDir = join(dir, 'creds');
      mkdirSync(credDir);
      assert.equal(resolveSecret({
        name: 'PIKVM_MCP_BEARER',
        credName: 'pikvm-mcp-bearer',
        env: { CREDENTIALS_DIRECTORY: credDir },
      }), undefined);
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { CREDENTIALS_DIRECTORY: credDir },
        }),
        /PIKVM_PASSWORD is required/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a directory or FIFO is rejected and a symlink to a file is ok', async () => {
    const dir = await tempDir();
    try {
      const asDir = join(dir, 'not-a-file');
      mkdirSync(asDir);
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: asDir },
        }),
        /not a regular file/,
      );
      if (process.platform !== 'win32') {
        assert.throws(
          () => resolveSecret({
            name: 'PIKVM_PASSWORD',
            credName: 'pikvm-password',
            required: true,
            env: { PIKVM_PASSWORD_FILE: '/dev/null' },
          }),
          /not a regular file/,
        );
      }
      const fifo = join(dir, 'fifo');
      execFileSync('mkfifo', [fifo]);
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: fifo },
        }),
        /not a regular file/,
      );
      const real = join(dir, 'real');
      writeFileSync(real, 'by-symlink\n', { mode: 0o600 });
      const link = join(dir, 'link');
      symlinkSync(real, link);
      assert.equal(resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD_FILE: link },
      }), 'by-symlink');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('opening a FIFO does not block', async () => {
    if (process.platform === 'win32') return;
    const dir = await tempDir();
    const fifo = join(dir, 'fifo');
    const script = join(dir, 'open-fifo.mjs');
    try {
      execFileSync('mkfifo', [fifo]);
      await writeFile(script, `
        import { resolveSecret } from ${JSON.stringify(join(REPO, 'dist/secrets.js'))};
        try {
          resolveSecret({
            name: 'PIKVM_PASSWORD',
            credName: 'pikvm-password',
            required: true,
            env: { PIKVM_PASSWORD_FILE: ${JSON.stringify(fifo)} },
          });
          process.exit(2);
        } catch (err) {
          process.exit(String(err && err.message).includes('not a regular file') ? 0 : 3);
        }
      `);
      const child = spawn(process.execPath, [script], { stdio: 'ignore' });
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve('blocked');
        }, 1000);
        child.once('exit', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      assert.equal(code, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('mode 0644 warns and 0600 does not', async () => {
    if (process.platform === 'win32') return;
    const dir = await tempDir();
    try {
      const loose = join(dir, 'loose');
      writeFileSync(loose, 'loose-secret\n');
      chmodSync(loose, 0o644);
      const warned = capture(() => resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD_FILE: loose },
      }));
      assert.equal(warned.value, 'loose-secret');
      assert.equal(warned.lines.length, 1);
      assert.match(warned.lines[0], /0644/);
      assert.match(warned.lines[0], /PIKVM_PASSWORD_FILE/);
      assert.equal(warned.lines[0].includes('loose-secret'), false);

      const tight = join(dir, 'tight');
      writeFileSync(tight, 'tight-secret\n');
      chmodSync(tight, 0o600);
      const quiet = capture(() => resolveSecret({
        name: 'PIKVM_PASSWORD',
        credName: 'pikvm-password',
        required: true,
        env: { PIKVM_PASSWORD_FILE: tight },
      }));
      assert.equal(quiet.value, 'tight-secret');
      assert.deepEqual(quiet.lines, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an oversize file is rejected without its body', async () => {
    const dir = await tempDir();
    try {
      const filePath = join(dir, 'big');
      writeFileSync(filePath, Buffer.alloc(SECRET_MAX_BYTES + 1, 0x61), { mode: 0o600 });
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: 'pikvm-password',
          required: true,
          env: { PIKVM_PASSWORD_FILE: filePath },
        }),
        (err) => {
          assert.match(err.message, /larger than/);
          assert.equal(err.message.includes('a'.repeat(32)), false);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a credential name cannot leave the directory', async () => {
    const dir = await tempDir();
    try {
      writeFileSync(join(dir, 'escaped'), 'escaped-secret\n', { mode: 0o600 });
      const credDir = join(dir, 'creds');
      mkdirSync(credDir);
      assert.throws(
        () => resolveSecret({
          name: 'PIKVM_PASSWORD',
          credName: '../escaped',
          required: true,
          env: { CREDENTIALS_DIRECTORY: credDir },
        }),
        /single path segment/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig secrets', () => {
  const keys = [
    'PIKVM_HOST',
    'PIKVM_PASSWORD',
    'PIKVM_PASSWORD_FILE',
    'PIKVM_MCP_BEARER',
    'PIKVM_MCP_BEARER_FILE',
    'PIKVM_MCP_PORT',
    'CREDENTIALS_DIRECTORY',
  ];

  function withProcessEnv(extra, fn) {
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, extra);
    try {
      return fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test('a bearer with surrounding whitespace is rejected in HTTP mode by name only', () => {
    const token = ' bearer-with-space ';
    assert.throws(
      () => withProcessEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD: 'testpw',
        PIKVM_MCP_PORT: '8974',
        PIKVM_MCP_BEARER: token,
      }, () => loadConfig()),
      (err) => {
        assert.match(err.message, /PIKVM_MCP_BEARER/);
        assert.match(err.message, /whitespace/);
        assert.equal(err.message.includes(token.trim()), false);
        assert.equal(err.message.includes('bearer-with-space'), false);
        return true;
      },
    );
  });

  test('stdio accepts a bearer with surrounding whitespace', () => {
    const token = ' bearer-with-space ';
    const config = withProcessEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_MCP_BEARER: token,
    }, () => loadConfig());
    assert.equal(config.http, undefined);
  });

  test('redactConfig hides the password and the bearer', async () => {
    const dir = await tempDir();
    try {
      const passwordFile = join(dir, 'password');
      const bearerFile = join(dir, 'bearer');
      await writeFile(passwordFile, `${SENTINEL}\n`, { mode: 0o600 });
      await writeFile(bearerFile, 'bearer-from-file\n', { mode: 0o600 });
      const config = withProcessEnv({
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_PASSWORD_FILE: passwordFile,
        PIKVM_MCP_BEARER_FILE: bearerFile,
        PIKVM_MCP_PORT: '8675',
      }, () => loadConfig());
      assert.equal(config.pikvm.password, SENTINEL);
      assert.equal(config.http.bearerToken, 'bearer-from-file');
      const shown = JSON.stringify(redactConfig(config));
      assert.equal(shown.includes(SENTINEL), false);
      assert.equal(shown.includes('bearer-from-file'), false);
      assert.match(shown, /\[REDACTED\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a bearer file authenticates an HTTP request', async () => {
    const dir = await tempDir();
    const token = 'bearer-from-file-token';
    const mock = await startKvmdMock();
    let httpServer;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      const bearerFile = join(dir, 'bearer');
      await writeFile(bearerFile, `${token}\n`, { mode: 0o600 });
      for (const key of keys) delete process.env[key];
      process.env.PIKVM_HOST = mock.url;
      process.env.PIKVM_PASSWORD = 'testpw';
      process.env.PIKVM_MCP_BEARER_FILE = bearerFile;
      process.env.PIKVM_MCP_PORT = '8675';
      const config = loadConfig();
      assert.equal(config.http.bearerToken, token);
      const pikvm = new PiKVMClient(config.pikvm);
      httpServer = await startHttpServer({
        port: 0,
        host: '127.0.0.1',
        bearerToken: config.http.bearerToken,
        createServer: () => createMcpServer({
          pikvm,
          lock: new BusyLock(),
          calibrationConfig: { rounds: 1, verifyRounds: 1, moveDelayMs: 0 },
          armGateEnforced: true,
          msdArmGateEnforced: true,
          msd: config.msd,
        }),
      });
      const address = httpServer.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'secret-test', version: '1.0' },
        },
      });
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      const ok = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body,
      });
      assert.equal(ok.status, 200);
      const denied = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { ...headers, Authorization: 'Bearer wrong-token' },
        body,
      });
      assert.equal(denied.status, 401);
      await pikvm.close();
    } finally {
      if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
      await mock.close();
      await rm(dir, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

function childEnv(extra) {
  const env = { ...process.env };
  for (const key of [
    'PIKVM_PASSWORD',
    'PIKVM_PASSWORD_FILE',
    'PIKVM_MCP_BEARER',
    'PIKVM_MCP_BEARER_FILE',
    'PIKVM_MCP_PORT',
    'PIKVM_MCP_ARM_HID',
    'CREDENTIALS_DIRECTORY',
  ]) {
    delete env[key];
  }
  env.PIKVM_MCP_NO_DOTENV = '1';
  return { ...env, ...extra };
}

function spawnServer(env) {
  const child = spawn(process.execPath, [join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, output: () => `${stdout}\n${stderr}` };
}

test('a sentinel secret never appears in startup, auth failure, or error output', async () => {
  const dir = await tempDir();
  const passwordFile = join(dir, 'password');
  await writeFile(passwordFile, `${SENTINEL}\n`, { mode: 0o600 });
  const chunks = [];
  try {
    const okMock = await startKvmdMock();
    try {
      const started = spawnServer(childEnv({
        PIKVM_HOST: okMock.url,
        PIKVM_PASSWORD_FILE: passwordFile,
      }));
      const running = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('startup did not reach running')), 12000);
        started.child.stderr.on('data', () => {
          if (started.output().includes('PiKVM MCP Server running')) {
            clearTimeout(timer);
            resolve();
          }
        });
        started.child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`startup exited early: ${started.output()}`));
        });
      });
      void running;
      started.child.kill('SIGTERM');
      await new Promise((resolve) => started.child.once('exit', resolve));
      chunks.push(started.output());
    } finally {
      await okMock.close();
    }

    const authMock = await startKvmdMock({
      routes: { 'GET /api/auth/check': { status: 401, body: SENTINEL } },
    });
    try {
      const failed = spawnServer(childEnv({
        PIKVM_HOST: authMock.url,
        PIKVM_PASSWORD_FILE: passwordFile,
      }));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('auth failure did not log')), 12000);
        failed.child.stderr.on('data', () => {
          if (failed.output().includes('Could not authenticate')) {
            clearTimeout(timer);
            resolve();
          }
        });
        failed.child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`auth process exited early: ${failed.output()}`));
        });
      });
      failed.child.kill('SIGTERM');
      await new Promise((resolve) => failed.child.once('exit', resolve));
      chunks.push(failed.output());
    } finally {
      await authMock.close();
    }

    const big = join(dir, 'big');
    const body = Buffer.alloc(SECRET_MAX_BYTES + 1);
    body.write(SENTINEL);
    await writeFile(big, body, { mode: 0o600 });
    const errored = spawnServer(childEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net',
      PIKVM_PASSWORD_FILE: big,
    }));
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        errored.child.kill('SIGKILL');
        reject(new Error('error path did not exit'));
      }, 12000);
      errored.child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.notEqual(exit, 0);
    const errorOutput = errored.output();
    assert.match(errorOutput, /PIKVM_PASSWORD_FILE/);
    assert.match(errorOutput, /larger than/);
    chunks.push(errorOutput);

    const combined = chunks.join('\n');
    assert.equal(combined.includes(SENTINEL), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
