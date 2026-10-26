// Modified 2026-10 by PLN: graceful shutdown tests (GPL-3.0; see NOTICE).

/**
 * In-process shutdown and external upload abort. The stdio case is the
 * only one that sends a real signal, and it is skipped on Windows because
 * process.kill(pid, 'SIGTERM') there terminates the process without
 * running the signal handler.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { KvmdError, PiKVMClient } from '../dist/pikvm/client.js';
import {
  abortInFlightTransfers,
  inFlightTransferCountForTests,
  msdUploadSlotsFree,
  readMsdJob,
  startMsdFetch,
  startMsdUpload,
} from '../dist/msd.js';
import {
  createTesseractEngine,
  killOcrChildren,
  ocrChildCountForTests,
  OcrError,
  setOcrSpawnForTests,
} from '../dist/ocr.js';
import { startHttpServer } from '../dist/http.js';
import {
  requestShutdown,
  resetShutdownForTests,
  shutdownTimerHasRefForTests,
} from '../dist/shutdown.js';
import { parseUrlAllowlist } from '../dist/url-policy.js';
import { startKvmdMock } from './kvmd-mock.mjs';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const MSD_UNKNOWN = 'image may be partial or complete; re-read /api/msd; do not resend';
const ALLOW = parseUrlAllowlist('https://images.example/iso');

function crashText(err) {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function arm(t) {
  resetShutdownForTests();
  const crashes = [];
  const onException = (err) => {
    crashes.push(err);
  };
  const onRejection = (err) => {
    crashes.push(err);
  };
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  t.after(() => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
    resetShutdownForTests();
    setOcrSpawnForTests();
    assert.equal(crashes.length, 0, crashes.map(crashText).join('\n\n'));
  });
}

function makeClient(mock) {
  return new PiKVMClient({
    host: mock.url,
    username: 'admin',
    password: 'testpw',
    verifySsl: false,
    requestTimeoutMs: 1000,
    msdJobTimeoutMs: 120000,
    msdIdleTimeoutMs: 60000,
  });
}

async function waitFor(label, fn, ms = 2000) {
  const start = performance.now();
  for (;;) {
    if (await fn()) return;
    if (performance.now() - start > ms) throw new Error(`${label} timed out after ${ms}ms`);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function assertStateUnknown(err, endpoint) {
  assert.ok(err instanceof KvmdError);
  assert.equal(err.type, 'PIKVM_MSD_STATE_UNKNOWN');
  assert.equal(err.message, MSD_UNKNOWN);
  assert.equal(err.phase, undefined);
  assert.equal(err.endpoint, endpoint);
  return true;
}

function capture(promise) {
  return promise.then((value) => ({ ok: true, value }), (err) => ({ ok: false, err }));
}

function stalledBody() {
  return new Readable({
    read() {
      this.push(Buffer.alloc(64 * 1024, 1));
    },
  });
}

function noopTargets(extra = {}) {
  return {
    abortTransfers() {},
    destroyDispatchers() {},
    killOcrChildren() {},
    ...extra,
  };
}

describe('shutdown', { concurrency: 1 }, () => {
  test('an external abort of msdWrite is PIKVM_MSD_STATE_UNKNOWN', async (t) => {
    arm(t);
    const mock = await startKvmdMock({ pauseWrite: true });
    const client = makeClient(mock);
    t.after(() => mock.close());
    const ctrl = new AbortController();
    const pending = capture(client.msdWrite('stall.img', stalledBody(), 8 * 1024 * 1024, {
      removeIncomplete: true,
      signal: ctrl.signal,
    }));
    await waitFor('upload POST', () => mock.calls.some((call) => call.path === '/api/msd/write'));
    const started = performance.now();
    ctrl.abort();
    ctrl.abort();
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assertStateUnknown(outcome.err, 'POST /api/msd/write');
    assert.ok(performance.now() - started < 1000);
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
    assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
    assert.equal(mock.state.images['stall.img'], undefined);
    const write = mock.calls.find((call) => call.path === '/api/msd/write');
    assert.match(write.query, /remove_incomplete=1/);
    await client.close();
  });

  test('an external abort of msdWriteRemote is PIKVM_MSD_STATE_UNKNOWN', async (t) => {
    arm(t);
    const mock = await startKvmdMock({
      remote: { stallAfterLines: 0, stallMs: 120000 },
    });
    const client = makeClient(mock);
    t.after(() => mock.close());
    const ctrl = new AbortController();
    const pending = capture((async () => {
      for await (const row of client.msdWriteRemote('https://images.example/iso/disk.img', {
        image: 'disk.img',
        removeIncomplete: true,
        signal: ctrl.signal,
      })) {
        void row;
      }
    })());
    await waitFor(
      'write_remote POST',
      () => mock.calls.some((call) => call.path === '/api/msd/write_remote'),
    );
    const started = performance.now();
    ctrl.abort();
    ctrl.abort();
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assertStateUnknown(outcome.err, 'POST /api/msd/write_remote');
    assert.ok(performance.now() - started < 1000);
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
    assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
    assert.equal(mock.state.images['disk.img'], undefined);
    const write = mock.calls.find((call) => call.path === '/api/msd/write_remote');
    assert.match(write.query, /remove_incomplete=1/);
    await client.close();
  });

  test('shutdown aborts an in-flight upload and does not hang', async (t) => {
    arm(t);
    const mock = await startKvmdMock({ pauseWrite: true });
    const client = makeClient(mock);
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-shutdown-'));
    t.after(async () => {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(join(dir, 'disk.iso'), Buffer.from('shutdown-image'));
    const { jobId } = await startMsdUpload(client, {
      device: 'upload-shutdown',
      localDir: dir,
      maxBytes: 1024 * 1024,
      extensions: ['.iso'],
      file: 'disk.iso',
      confirmImage: 'disk.iso',
      uploadPollMs: 60000,
    });
    await waitFor('upload POST', () => mock.calls.some((call) => call.path === '/api/msd/write'));
    assert.equal(inFlightTransferCountForTests(), 1);
    const codes = [];
    const started = performance.now();
    requestShutdown(noopTargets({
      destroyDispatchers() {
        client.destroyDispatcher();
      },
      abortTransfers: abortInFlightTransfers,
      exit(code) {
        codes.push(code);
      },
    }));
    await waitFor('shutdown exit', () => codes.length > 0, 2000);
    assert.deepEqual(codes, [0]);
    assert.ok(performance.now() - started < 2000);
    await waitFor('upload job failed', () => readMsdJob(jobId)?.state === 'failed');
    const job = readMsdJob(jobId);
    assert.equal(job.error.type, 'PIKVM_MSD_STATE_UNKNOWN');
    assert.equal(job.error.phase, undefined);
    assert.equal(job.removed, undefined);
    assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
    assert.equal(mock.state.images['disk.iso'], undefined);
    await waitFor('upload slot', () => msdUploadSlotsFree());
    assert.equal(inFlightTransferCountForTests(), 0);
    abortInFlightTransfers();
    abortInFlightTransfers();
  });

  test('shutdown aborts an in-flight fetch-URL write', async (t) => {
    arm(t);
    const mock = await startKvmdMock({
      remote: { stallAfterLines: 0, stallMs: 120000 },
    });
    const client = makeClient(mock);
    t.after(() => mock.close());
    const { jobId } = await startMsdFetch(client, {
      device: 'fetch-shutdown',
      url: 'https://images.example/iso/disk.img',
      image: 'disk.img',
      confirmImage: 'disk.img',
      extensions: ['.img'],
      allow: ALLOW,
      allowPrivate: false,
      connectTimeoutSec: 30,
      resolveUrl: async () => ['192.0.3.10'],
    });
    await waitFor(
      'write_remote POST',
      () => mock.calls.some((call) => call.path === '/api/msd/write_remote'),
    );
    assert.equal(inFlightTransferCountForTests(), 1);
    const codes = [];
    const started = performance.now();
    requestShutdown(noopTargets({
      destroyDispatchers() {
        client.destroyDispatcher();
      },
      abortTransfers: abortInFlightTransfers,
      exit(code) {
        codes.push(code);
      },
    }));
    await waitFor('shutdown exit', () => codes.length > 0, 2000);
    assert.deepEqual(codes, [0]);
    assert.ok(performance.now() - started < 2000);
    await waitFor('fetch job failed', () => readMsdJob(jobId)?.state === 'failed');
    const job = readMsdJob(jobId);
    assert.equal(job.error.type, 'PIKVM_MSD_STATE_UNKNOWN');
    assert.equal(job.removed, undefined);
    assert.equal(mock.calls.some((call) => call.path === '/api/msd/remove'), false);
    await waitFor('fetch slot', () => msdUploadSlotsFree());
    assert.equal(inFlightTransferCountForTests(), 0);
  });

  test('shutdown with nothing in flight exits 0 quickly', async (t) => {
    arm(t);
    const codes = [];
    const started = performance.now();
    requestShutdown(noopTargets({
      stdioTransport: { close() {} },
      exit(code) {
        codes.push(code);
      },
    }));
    await waitFor('idle shutdown', () => codes.length > 0, 1000);
    assert.deepEqual(codes, [0]);
    assert.ok(performance.now() - started < 500);
  });

  test('shutdown kills a tracked OCR child', async (t) => {
    arm(t);
    let child;
    setOcrSpawnForTests((file, args, options, callback) => {
      void file;
      void args;
      child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], options, callback);
      return child;
    });
    const engine = createTesseractEngine({ bin: 'unused', timeoutMs: 60000 });
    const ctrl = new AbortController();
    const pending = capture(engine.recognize(Buffer.from('png'), {
      langs: 'eng',
      psm: 6,
      signal: ctrl.signal,
    }));
    await waitFor('ocr child', () => ocrChildCountForTests() === 1);
    const codes = [];
    requestShutdown(noopTargets({
      killOcrChildren,
      exit(code) {
        codes.push(code);
      },
    }));
    await waitFor('ocr shutdown', () => codes.length > 0, 1000);
    assert.deepEqual(codes, [0]);
    await waitFor('ocr child exit', () => child.exitCode !== null || child.signalCode !== null);
    assert.equal(ocrChildCountForTests(), 0);
    killOcrChildren();
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.ok(outcome.err instanceof OcrError);
    ctrl.abort();
  });

  test('a second signal exits 1 and does not start a second shutdown', async (t) => {
    arm(t);
    const codes = [];
    let closes = 0;
    let aborts = 0;
    requestShutdown(noopTargets({
      httpServer: {
        close() {
          closes += 1;
        },
        closeIdleConnections() {},
        closeAllConnections() {},
      },
      abortTransfers() {
        aborts += 1;
      },
      exit(code) {
        codes.push(code);
      },
      deadlineMs: 5000,
    }), 'signal');
    assert.equal(shutdownTimerHasRefForTests(), false);
    assert.equal(closes, 1);
    assert.equal(aborts, 1);
    requestShutdown(noopTargets({
      httpServer: {
        close() {
          closes += 1;
        },
        closeIdleConnections() {},
        closeAllConnections() {},
      },
      abortTransfers() {
        aborts += 1;
      },
      exit(code) {
        codes.push(code);
      },
    }), 'signal');
    assert.deepEqual(codes, [1]);
    assert.equal(closes, 1);
    assert.equal(aborts, 1);
    requestShutdown(noopTargets(), 'eof');
    assert.deepEqual(codes, [1]);
  });

  test('the hard deadline exits 1 without waiting 8 seconds', async (t) => {
    arm(t);
    const codes = [];
    const started = performance.now();
    requestShutdown(noopTargets({
      httpServer: {
        close() {},
        closeIdleConnections() {},
        closeAllConnections() {},
      },
      exit(code) {
        codes.push(code);
      },
      deadlineMs: 40,
    }));
    assert.equal(shutdownTimerHasRefForTests(), false);
    await waitFor('deadline exit', () => codes.length > 0, 1000);
    assert.deepEqual(codes, [1]);
    assert.ok(performance.now() - started < 1000);
  });

  test('HTTP shutdown stops accepting connections', async (t) => {
    arm(t);
    const httpServer = await startHttpServer({
      port: 0,
      host: '127.0.0.1',
      bearerToken: 'test-bearer-token',
      createServer: () => {
        throw new Error('not used');
      },
    });
    const address = httpServer.address();
    assert.ok(address && typeof address === 'object');
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok');
    const codes = [];
    requestShutdown(noopTargets({
      httpServer,
      exit(code) {
        codes.push(code);
      },
    }));
    await waitFor('http shutdown', () => codes.length > 0, 2000);
    assert.deepEqual(codes, [0]);
    const refused = await new Promise((resolve, reject) => {
      const probe = net.connect({ host: '127.0.0.1', port: address.port });
      probe.once('connect', () => {
        probe.destroy();
        reject(new Error('server accepted a connection after shutdown'));
      });
      probe.once('error', (err) => resolve(err.code));
    });
    assert.equal(refused, 'ECONNREFUSED');
  });

  test('stdio exits 0 when stdin ends', async (t) => {
    arm(t);
    const mock = await startKvmdMock();
    t.after(() => mock.close());
    const env = { ...process.env };
    delete env.PIKVM_MCP_PORT;
    delete env.PIKVM_MCP_BEARER;
    env.PIKVM_MCP_NO_DOTENV = '1';
    env.PIKVM_HOST = mock.url;
    env.PIKVM_PASSWORD = 'testpw';
    env.PIKVM_USERNAME = 'admin';
    const child = spawn(process.execPath, [join(REPO, 'dist', 'index.js')], {
      cwd: REPO,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await waitFor('stdio ready', () => stderr.includes('PiKVM MCP Server running'), 5000);
    const exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end();
    const result = await waitForExit(exit);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
  });

  // Windows process.kill(pid, 'SIGTERM') terminates the process without
  // running the signal handler, so this test cannot observe shutdown.
  test('stdio exits 0 on SIGTERM', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGTERM) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const mock = await startKvmdMock();
    t.after(() => mock.close());
    const env = { ...process.env };
    delete env.PIKVM_MCP_PORT;
    delete env.PIKVM_MCP_BEARER;
    env.PIKVM_MCP_NO_DOTENV = '1';
    env.PIKVM_HOST = mock.url;
    env.PIKVM_PASSWORD = 'testpw';
    env.PIKVM_USERNAME = 'admin';
    const child = spawn(process.execPath, [join(REPO, 'dist', 'index.js')], {
      cwd: REPO,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    await waitFor('stdio ready', () => stderr.includes('PiKVM MCP Server running'), 5000);
    const exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.kill('SIGTERM');
    const result = await waitForExit(exit);
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null, stderr);
  });
});

function waitForExit(exit) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdio child did not exit')), 4000);
    exit.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
