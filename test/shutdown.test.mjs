// Modified 2026-10 by PLN: graceful shutdown tests (GPL-3.0; see NOTICE).

/**
 * In-process shutdown and external upload abort. Spawned-server cases
 * send a real signal. They are skipped on Windows because
 * process.kill(pid, 'SIGTERM') there terminates the process without
 * running the signal handler. SIGINT is the same.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { shutdownTargetsForTests } from '../dist/index.js';
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

  test('destroyDispatcher tears down a request that has no abort signal', async (t) => {
    arm(t);
    const mock = await startKvmdMock({ holdSnapshots: 1 });
    const client = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
      requestTimeoutMs: 30000,
      msdJobTimeoutMs: 120000,
      msdIdleTimeoutMs: 60000,
    });
    t.after(() => mock.close());
    const pending = capture(client.fetchFullSnapshot(30000));
    await waitFor(
      'snapshot held',
      () => mock.calls.some((call) => call.path.startsWith('/api/streamer/snapshot')),
    );
    const started = performance.now();
    client.destroyDispatcher();
    const outcome = await within(pending, 3000);
    assert.equal(outcome.ok, false);
    assert.ok(!(outcome.err instanceof Error && outcome.err.message.startsWith('timed out')));
    assert.ok(performance.now() - started < 3000);
  });

  test('shutdown targets abort an upload and destroy a non-abortable request', async (t) => {
    arm(t);
    const mock = await startKvmdMock({ pauseWrite: true, holdSnapshots: 1 });
    const client = makeClient(mock);
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-shutdown-'));
    t.after(async () => {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(join(dir, 'disk.iso'), Buffer.from('shutdown-image'));
    const { jobId } = await startMsdUpload(client, {
      device: 'wiring-shutdown',
      localDir: dir,
      maxBytes: 1024 * 1024,
      extensions: ['.iso'],
      file: 'disk.iso',
      confirmImage: 'disk.iso',
      uploadPollMs: 60000,
    });
    await waitFor('upload POST', () => mock.calls.some((call) => call.path === '/api/msd/write'));
    const shot = capture(client.fetchFullSnapshot(30000));
    await waitFor(
      'snapshot held',
      () => mock.calls.some((call) => call.path.startsWith('/api/streamer/snapshot')),
    );
    const codes = [];
    const started = performance.now();
    requestShutdown({
      ...shutdownTargetsForTests([client]),
      exit(code) {
        codes.push(code);
      },
    });
    await waitFor('wiring exit', () => codes.length > 0, 2000);
    assert.deepEqual(codes, [0]);
    assert.ok(performance.now() - started < 2000);
    const shotOutcome = await within(shot, 3000);
    assert.equal(shotOutcome.ok, false);
    assert.ok(!(shotOutcome.err instanceof Error && shotOutcome.err.message.startsWith('timed out')));
    await waitFor('upload job failed', () => readMsdJob(jobId)?.state === 'failed');
    assert.equal(readMsdJob(jobId).error.type, 'PIKVM_MSD_STATE_UNKNOWN');
  });

  test('shutdown targets kill a tracked OCR child', async (t) => {
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
    requestShutdown({
      ...shutdownTargetsForTests([]),
      exit(code) {
        codes.push(code);
      },
    });
    await waitFor('ocr wiring exit', () => codes.length > 0, 1000);
    assert.deepEqual(codes, [0]);
    await waitFor('ocr child exit', () => child.exitCode !== null || child.signalCode !== null);
    assert.equal(ocrChildCountForTests(), 0);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    ctrl.abort();
  });

  test('an idle connection and an open request do not hold shutdown', async (t) => {
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
    const idle = await openKeepAlive(address.port);
    const active = await openHalfRequest(address.port);
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const idleClosed = closedFlag(idle);
    const activeClosed = closedFlag(active);
    // server.close() also closes idle sockets. Count the later call.
    let insideClose = false;
    let idleCalls = 0;
    let allCalls = 0;
    const close = httpServer.close.bind(httpServer);
    const closeIdle = httpServer.closeIdleConnections.bind(httpServer);
    const closeAll = httpServer.closeAllConnections.bind(httpServer);
    httpServer.close = (callback) => {
      insideClose = true;
      try {
        return close(callback);
      } finally {
        insideClose = false;
      }
    };
    httpServer.closeIdleConnections = () => {
      if (!insideClose) idleCalls += 1;
      closeIdle();
    };
    httpServer.closeAllConnections = () => {
      allCalls += 1;
      closeAll();
    };
    const codes = [];
    const started = performance.now();
    requestShutdown(noopTargets({
      httpServer,
      exit(code) {
        codes.push(code);
      },
      deadlineMs: 8000,
    }));
    assert.equal(idleCalls, 1);
    assert.equal(allCalls, 1);
    await waitFor('held sockets closed', () => idleClosed() && activeClosed(), 1000);
    await waitFor('held shutdown exit', () => codes.length > 0, 1000);
    assert.deepEqual(codes, [0]);
    assert.ok(performance.now() - started < 1000);
  });

  test('a throwing shutdown step still runs the later steps', async (t) => {
    arm(t);
    const order = [];
    const codes = [];
    requestShutdown({
      httpServer: {
        close() {
          order.push('close');
          throw new Error('close failed');
        },
        closeIdleConnections() {
          order.push('idle');
        },
        closeAllConnections() {
          order.push('all');
        },
      },
      abortTransfers() {
        order.push('abort');
        throw new Error('abort failed');
      },
      destroyDispatchers() {
        order.push('destroy');
      },
      killOcrChildren() {
        order.push('kill');
      },
      exit(code) {
        codes.push(code);
      },
    });
    await waitFor('throwing shutdown', () => codes.length > 0, 1000);
    assert.deepEqual(order, ['close', 'idle', 'abort', 'destroy', 'kill', 'all']);
    assert.deepEqual(codes, [1]);
  });

  test('OCR drops the abort listener after success and after a failed spawn', async (t) => {
    arm(t);
    setOcrSpawnForTests((file, args, options, callback) => {
      void file;
      void args;
      return execFile(process.execPath, ['-e', 'process.exit(0)'], options, callback);
    });
    const engine = createTesseractEngine({ bin: 'unused', timeoutMs: 5000 });
    const okCtrl = new AbortController();
    const recognized = await engine.recognize(Buffer.from('png'), {
      langs: 'eng',
      psm: 6,
      signal: okCtrl.signal,
    });
    assert.ok(Array.isArray(recognized.words));
    assert.equal(ocrChildCountForTests(), 0);
    assert.equal(getEventListeners(okCtrl.signal, 'abort').length, 0);

    setOcrSpawnForTests();
    const missing = join(tmpdir(), 'pikvm-ocr-missing-binary');
    const failed = createTesseractEngine({ bin: missing, timeoutMs: 5000 });
    for (let i = 0; i < 50; i += 1) {
      const ctrl = new AbortController();
      const outcome = await capture(failed.recognize(Buffer.from('png'), {
        langs: 'eng',
        psm: 6,
        signal: ctrl.signal,
      }));
      assert.equal(outcome.ok, false);
      assert.ok(outcome.err instanceof OcrError);
      assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
    }
    assert.equal(ocrChildCountForTests(), 0);
  });

  // Windows process.kill(pid, 'SIGTERM') terminates the process without
  // running the signal handler, so a spawned server cannot show shutdown.
  test('HTTP SIGTERM exits 0 and the port is closed', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGTERM) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const started = await launchHttp(t);
    const probe = await signalAndProbe(started, 'SIGTERM');
    assert.equal(probe.code, 0, started.stderr());
    assert.equal(probe.signal, null, started.stderr());
    assert.ok(probe.ms < 2000, `exit took ${probe.ms}ms`);
    const observed = probe.refusedWhileAlive + probe.openedWhileAlive;
    if (observed > 0) {
      assert.ok(
        probe.refusedWhileAlive >= 1 && probe.refusedWhileAlive >= probe.openedWhileAlive,
        JSON.stringify(probe),
      );
    }
    await assertPortClosed(started.port);
    assertQuiet(started.stderr());
  });

  // Windows process.kill(pid, 'SIGINT') terminates the process without
  // running the signal handler, so this cannot observe the SIGINT handler.
  test('HTTP SIGINT exits 0 and the port is closed', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGINT) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const started = await launchHttp(t);
    const probe = await signalAndProbe(started, 'SIGINT');
    assert.equal(probe.code, 0, started.stderr());
    assert.equal(probe.signal, null, started.stderr());
    assert.ok(probe.ms < 2000, `exit took ${probe.ms}ms`);
    await assertPortClosed(started.port);
    assertQuiet(started.stderr());
  });

  // Windows process.kill(pid, 'SIGTERM') terminates the process without
  // running the signal handler.
  test('HTTP SIGTERM during an upload exits 0 within the bound', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGTERM) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const mock = await startKvmdMock({ pauseWrite: true });
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-shutdown-'));
    t.after(async () => {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    });
    await writeFile(join(dir, 'disk.iso'), Buffer.alloc(1024, 7));
    const started = await launchHttp(t, mock, {
      PIKVM_MSD_LOCAL_DIR: dir,
      PIKVM_MSD_MAX_BYTES: String(1024 * 1024),
      PIKVM_MCP_ARM_MSD: '1',
    });
    const sessionId = await openMcpSession(started);
    const call = mcpCall(started, sessionId, 'tools/call', {
      name: 'pikvm_msd_upload',
      arguments: { file: 'disk.iso', confirmImage: 'disk.iso' },
    });
    await call;
    await waitFor('upload POST', () => mock.calls.some((entry) => entry.path === '/api/msd/write'));
    await waitFor('upload paused', () => mock.state.uploading !== null);
    const result = await signalChild(started, 'SIGTERM', 2000);
    assert.equal(result.code, 0, started.stderr());
    assert.equal(result.signal, null, started.stderr());
    assert.ok(result.ms < 2000, `exit took ${result.ms}ms`);
    assert.equal(mock.state.uploading, null);
    assertQuiet(started.stderr());
  });

  // Windows process.kill(pid, 'SIGTERM') terminates the process without
  // running the signal handler. The preload is written into a temp
  // directory for this test and is not part of the tree.
  test('a second signal exits 1 when close never finishes', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGTERM) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-shutdown-'));
    const preload = join(dir, 'hold-close.cjs');
    await writeFile(preload, [
      "const http = require('node:http');",
      'http.Server.prototype.close = function close() {',
      "  console.error('shutdown close held');",
      '  return this;',
      '};',
      'http.Server.prototype.closeAllConnections = function closeAllConnections() {};',
      'http.Server.prototype.closeIdleConnections = function closeIdleConnections() {};',
      '',
    ].join('\n'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const started = await launchHttp(t, undefined, {}, ['--require', preload]);
    started.child.kill('SIGTERM');
    await waitFor('close held', () => started.stderr().includes('shutdown close held'), 2000);
    assert.equal(started.child.exitCode, null);
    const result = await signalChild(started, 'SIGTERM', 1000);
    assert.equal(result.code, 1, started.stderr());
    assert.equal(result.signal, null, started.stderr());
    assert.ok(result.ms < 1000, `second signal took ${result.ms}ms`);
    assertQuiet(started.stderr());
  });

  // Windows process.kill(pid, 'SIGTERM') terminates the process without
  // running the signal handler. The hold is an injected startup delay so
  // the signal arrives before listen.
  test('a signal during startup exits 0', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGTERM) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const port = await freePort();
    const env = baseEnv({
      PIKVM_HOST: 'http://127.0.0.1:9',
      PIKVM_MCP_PORT: String(port),
      PIKVM_MCP_HOST: '127.0.0.1',
      PIKVM_MCP_BEARER: 'test-bearer-token',
      PIKVM_MCP_STARTUP_HOLD_MS: '30000',
    });
    const started = await spawnServer(t, env);
    await waitFor('startup hold', () => started.stderr().includes('startup hold'), 2000);
    assert.equal(started.stderr().includes('PiKVM MCP Server running'), false);
    const result = await signalChild(started, 'SIGTERM', 2000);
    assert.equal(result.code, 0, started.stderr());
    assert.equal(result.signal, null, started.stderr());
    assert.ok(result.ms < 2000, `startup signal took ${result.ms}ms`);
    assert.equal(started.stderr().includes('PiKVM MCP Server running'), false);
    assertQuiet(started.stderr());
  });

  // Windows process.kill(pid, 'SIGTERM') terminates the process without
  // running the signal handler. The fake tesseract is written into a temp
  // directory for this test and is not part of the tree.
  test('SIGTERM kills the OCR child', {
    skip: process.platform === 'win32'
      ? 'Windows process.kill(pid, SIGTERM) terminates the process without running the signal handler'
      : false,
  }, async (t) => {
    arm(t);
    const mock = await startKvmdMock();
    const dir = await mkdtemp(join(tmpdir(), 'pikvm-shutdown-'));
    const bin = join(dir, 'tesseract');
    await writeFile(bin, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      'if (args.includes("--list-langs")) {',
      '  process.stdout.write("List of available languages (1):\\neng\\n");',
      '  process.exit(0);',
      '}',
      'if (args.includes("--version")) {',
      '  process.stdout.write("tesseract 5.0.0\\n");',
      '  process.exit(0);',
      '}',
      'fs.writeFileSync(path.join(path.dirname(process.argv[1]), "ocr.pid"), String(process.pid));',
      'setInterval(() => {}, 1000000);',
      '',
    ].join('\n'));
    await chmod(bin, 0o755);
    t.after(async () => {
      await mock.close();
      const pidFile = join(dir, 'ocr.pid');
      try {
        const pid = Number(await readFile(pidFile, 'utf8'));
        if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) process.kill(pid, 'SIGKILL');
      } catch {
        // The child already exited, or the recognize path never spawned it.
      }
      await rm(dir, { recursive: true, force: true });
    });
    const started = await launchHttp(t, mock, {
      PIKVM_OCR_ENGINE: 'host',
      PIKVM_OCR_TESSERACT_BIN: bin,
      PIKVM_OCR_ALLOW_FULL_FRAME: '1',
      PIKVM_OCR_TIMEOUT_MS: '60000',
    });
    const sessionId = await openMcpSession(started);
    const pending = mcpCall(started, sessionId, 'tools/call', {
      name: 'pikvm_read_text',
      arguments: { fullFrame: true },
    }).then(() => {}, () => {});
    const pidFile = join(dir, 'ocr.pid');
    await waitFor('ocr pid', async () => {
      try {
        const text = await readFile(pidFile, 'utf8');
        return Number(text) > 0;
      } catch {
        return false;
      }
    }, 5000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    const result = await signalChild(started, 'SIGTERM', 2000);
    assert.equal(result.code, 0, started.stderr());
    assert.equal(result.signal, null, started.stderr());
    assert.ok(result.ms < 2000, `exit took ${result.ms}ms`);
    await waitFor('ocr child dead', () => !pidAlive(pid), 2000);
    await pending;
    assertQuiet(started.stderr());
  });
});

function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, err: new Error(`timed out after ${ms}ms`) }), ms);
  });
  return Promise.race([promise, timeout]).then((result) => {
    clearTimeout(timer);
    return result;
  });
}

function assertQuiet(stderr) {
  assert.equal(/uncaughtException|unhandledRejection/.test(stderr), false, stderr);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') return false;
    if (err && err.code === 'EPERM') return true;
    throw err;
  }
}

function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.PIKVM_MCP_PORT;
  delete env.PIKVM_MCP_BEARER;
  delete env.PIKVM_MCP_STARTUP_HOLD_MS;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  env.PIKVM_MCP_NO_DOTENV = '1';
  env.PIKVM_PASSWORD = env.PIKVM_PASSWORD || 'testpw';
  env.PIKVM_USERNAME = env.PIKVM_USERNAME || 'admin';
  return env;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function spawnServer(t, env, args = []) {
  const child = spawn(process.execPath, [...args, join(REPO, 'dist', 'index.js')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal, at: performance.now() }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return {
    child,
    exit,
    stderr: () => stderr,
  };
}

async function launchHttp(t, mock, extra = {}, args = []) {
  const port = await freePort();
  const env = baseEnv({
    PIKVM_HOST: mock ? mock.url : 'http://127.0.0.1:9',
    PIKVM_MCP_PORT: String(port),
    PIKVM_MCP_HOST: '127.0.0.1',
    PIKVM_MCP_BEARER: 'test-bearer-token',
    ...extra,
  });
  const started = await spawnServer(t, env, args);
  await waitFor('http ready', () => started.stderr().includes('PiKVM MCP Server running'), 8000);
  return { ...started, port };
}

function probePort(child, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.once('connect', () => {
      const alive = child.exitCode === null && child.signalCode === null;
      sock.destroy();
      resolve({ open: true, alive });
    });
    sock.once('error', (err) => {
      const alive = child.exitCode === null && child.signalCode === null;
      resolve({ open: false, code: err.code, alive });
    });
  });
}

async function signalAndProbe(started, signal) {
  const began = performance.now();
  const seen = [];
  const inflight = new Set();
  const launch = () => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) return;
    let pending;
    pending = probePort(started.child, started.port).then((item) => {
      inflight.delete(pending);
      seen.push(item);
    });
    inflight.add(pending);
  };
  started.child.kill(signal);
  while (started.child.exitCode === null && started.child.signalCode === null && performance.now() - began < 2000) {
    for (let i = 0; i < 8; i += 1) launch();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
  await Promise.all([...inflight]);
  const result = await waitForExit(started.exit, 2000);
  return {
    code: result.code,
    signal: result.signal,
    ms: result.at - began,
    refusedWhileAlive: seen.filter((item) => item.code === 'ECONNREFUSED' && item.alive).length,
    openedWhileAlive: seen.filter((item) => item.open && item.alive).length,
  };
}

async function signalChild(started, signal, ms) {
  const began = performance.now();
  started.child.kill(signal);
  const result = await waitForExit(started.exit, ms);
  return { code: result.code, signal: result.signal, ms: result.at - began };
}

function assertPortClosed(port) {
  return new Promise((resolve, reject) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      reject(new Error('port still open'));
    });
    probe.once('error', (err) => {
      if (err.code === 'ECONNREFUSED') resolve();
      else reject(err);
    });
  });
}

const MCP_BEARER = 'test-bearer-token';

function mcpHeaders(sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${MCP_BEARER}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

async function mcpCall(started, sessionId, method, params) {
  const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(sessionId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mcp ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return { res, text, sessionId: sessionId || res.headers.get('mcp-session-id') };
}

async function openMcpSession(started) {
  const init = await mcpCall(started, undefined, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'shutdown-test', version: '1' },
  });
  assert.ok(init.sessionId, init.text);
  await fetch(`http://127.0.0.1:${started.port}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(init.sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }).then((res) => res.text());
  return init.sessionId;
}

function openKeepAlive(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.on('error', () => {});
    sock.once('connect', () => {
      sock.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
    });
    sock.once('data', () => resolve(sock));
    sock.once('error', reject);
  });
}

function openHalfRequest(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.on('error', () => {});
    sock.once('connect', () => {
      sock.write('POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100000\r\nContent-Type: application/json\r\n\r\n{"a"');
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

function closedFlag(sock) {
  let closed = false;
  sock.on('close', () => {
    closed = true;
  });
  sock.on('error', () => {});
  return () => closed || sock.destroyed === true;
}

function waitForExit(exit, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), ms);
    exit.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
