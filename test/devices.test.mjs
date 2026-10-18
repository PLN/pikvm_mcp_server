// Modified 2026-10 by PLN: device registry tests (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: legacy listed host is an origin (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: duplicate devices, shared origin, and per-device job cap (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: http and https on one host are the same device (GPL-3.0; see NOTICE).

/**
 * Registry parsing, per-device locks, and the hardware hwTest gate.
 * Hosts are documentation names or 127.0.0.1. No real PiKVM is contacted.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, redactConfig } from '../dist/config.js';
import { buildFleet, closeFleet } from '../dist/devices.js';
import { BusyLock } from '../dist/pikvm/lock.js';
import { PiKVMClient } from '../dist/pikvm/client.js';
import { createMcpServer } from '../dist/server.js';
import { startHttpServer } from '../dist/http.js';
import { normalizeHost } from '../dist/registry.js';
import { startKvmdMock } from './kvmd-mock.mjs';
import { mintCert } from './tls-cert.mjs';
import { hwDeviceRequest } from './hw/gate.mjs';

const REPO = join(fileURLToPath(import.meta.url), '..', '..');
const TOKEN = 'test-bearer-token-0123456789abcdef';
const SENTINEL = 'SENTINEL-password-9f3a';
const PATH_SENTINEL = 'secret-path-sentinel';
const CERT_SENTINEL = 'cert-path-sentinel';
const calibrationConfig = { rounds: 2, verifyRounds: 1, moveDelayMs: 20 };

const ENV_KEYS = [
  'PIKVM_HOST',
  'PIKVM_USERNAME',
  'PIKVM_PASSWORD',
  'PIKVM_PASSWORD_FILE',
  'PIKVM_TLS_MODE',
  'PIKVM_TLS_CERT_FILE',
  'PIKVM_VERIFY_SSL',
  'PIKVM_DEVICES',
  'PIKVM_DEVICES_FILE',
  'PIKVM_MCP_PORT',
  'PIKVM_MCP_BEARER',
  'CREDENTIALS_DIRECTORY',
];

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'pikvm-devices-'));
}

function writeSecret(dir, name, value) {
  const file = join(dir, name);
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return file;
}

function capture(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map((part) => String(part)).join(' '));
  };
  try {
    return { value: fn(), lines };
  } finally {
    console.error = orig;
  }
}

function withEnv(extra, fn) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, extra);
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function device(extra) {
  return {
    host: 'https://100.64.0.8',
    username: 'admin',
    ...extra,
  };
}

function registryJson(devices, defaultName) {
  const body = { devices };
  if (defaultName !== undefined) body.default = defaultName;
  return JSON.stringify(body);
}

describe('device registry', { concurrency: false }, () => {
  test('legacy env stays device default and is not normalised', () => {
    const logged = withEnv({
      PIKVM_HOST: 'https://pikvm.example.ts.net/kvm',
      PIKVM_PASSWORD: 'testpw',
      PIKVM_USERNAME: 'root',
      PIKVM_VERIFY_SSL: 'true',
    }, () => capture(() => loadConfig()));
    const config = logged.value;
    assert.equal(config.registry, undefined);
    assert.equal(config.pikvm.host, 'https://pikvm.example.ts.net/kvm');
    assert.equal(config.pikvm.username, 'root');
    assert.equal(config.pikvm.password, 'testpw');
    assert.equal(config.pikvm.tls.default.device, 'default');
    assert.equal(config.pikvm.tls.default.mode, 'verify');
    assert.equal(logged.lines.some((line) => line.includes('registry')), false);
  });

  test('a Tailscale address and a MagicDNS name are accepted origins', () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', 'pw-1');
      const body = registryJson({
        ts: device({
          host: 'https://100.64.0.8/kvm/?q=1#frag',
          passwordFile,
          tls: { mode: 'insecure' },
        }),
        magic: device({
          host: 'https://pikvm.example.ts.net',
          passwordFile,
          tls: { mode: 'verify' },
        }),
      }, 'ts');
      const { value, lines } = capture(() => withEnv({ PIKVM_DEVICES: body }, () => loadConfig()));
      assert.equal(value.pikvm.host, 'https://100.64.0.8');
      assert.equal(value.registry.devices.get('ts').host, 'https://100.64.0.8');
      assert.equal(value.registry.devices.get('magic').host, 'https://pikvm.example.ts.net');
      assert.equal(value.registry.defaultName, 'ts');
      assert.equal(lines.some((line) => line.includes('PIKVM_HOST was ignored')), false);
      assert.equal(normalizeHost('http://100.64.0.9:8080/x', 'device lab1 host'), 'http://100.64.0.9:8080');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('validation errors name the device and field and omit secrets', () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', SENTINEL);
      const cases = [
        [registryJson({ Lab1: device({ passwordFile }) }), /not a safe slug/],
        [registryJson({
          lab1: device({ passwordFile }),
          lab2: device({ passwordFile }),
        }), /default is required/],
        [registryJson({ lab1: device({ passwordFile }) }, 'missing'), /is not a device/],
        [registryJson({ lab1: { ...device({ passwordFile }), extra: SENTINEL } }), /unknown field "extra"/],
        [registryJson({ lab1: device({ password: SENTINEL }) }), /password is not accepted\. Use passwordFile or passwordCredential/],
        [registryJson({ lab1: device({ passwordFile, passwordCredential: 'pikvm-lab1' }) }), /not both/],
        [registryJson({ lab1: device({ host: 'https://user:pass@100.64.0.8', passwordFile, tls: { mode: 'insecure' } }) }), /must not include userinfo/],
        ['{"devices":{"lab1":{"host":"https://100.64.0.8","username":"admin","passwordFile":"/tmp/SENTINEL-password-9f3a"},"lab1":{"host":"https://100.64.0.9","username":"admin","passwordFile":"/tmp/SENTINEL-password-9f3a"}}}', /registry device name "lab1" is duplicated/],
        ['{"devices":{"lab1":{"host":"https://100.64.0.8","username":"admin","passwordFile":"/tmp/SENTINEL-password-9f3a"},"\\u006c\\u0061\\u0062\\u0031":{"host":"https://100.64.0.9","username":"admin","passwordFile":"/tmp/SENTINEL-password-9f3a"}}}', /registry device name "lab1" is duplicated/],
        [registryJson({
          lab1: device({ host: 'https://100.64.0.8/kvm', passwordFile, tls: { mode: 'insecure' } }),
          lab2: device({ host: 'https://100.64.0.8:443', passwordFile, tls: { mode: 'insecure' } }),
        }, 'lab1'), /registry devices "lab1" and "lab2" use the same origin/],
        [registryJson({
          lab1: device({ host: 'http://pikvm.example.ts.net', passwordFile, tls: { mode: 'insecure' } }),
          lab2: device({ host: 'https://pikvm.example.ts.net', passwordFile, tls: { mode: 'insecure' } }),
        }, 'lab1'), /registry devices "lab1" and "lab2" use the same host/],
        [registryJson({
          lab1: device({ host: 'http://100.64.0.8:8443', passwordFile, tls: { mode: 'insecure' } }),
          lab2: device({ host: 'https://100.64.0.8:8443/kvm', passwordFile, tls: { mode: 'insecure' } }),
        }, 'lab1'), /registry devices "lab1" and "lab2" use the same host/],
        ['{', /invalid JSON/],
      ];
      for (const [json, pattern] of cases) {
        assert.throws(
          () => withEnv({ PIKVM_DEVICES: json }, () => loadConfig()),
          (err) => {
            assert.match(err.message, pattern);
            assert.equal(err.message.includes(SENTINEL), false);
            assert.equal(err.message.includes('user:pass'), false);
            return true;
          },
        );
      }
      assert.throws(
        () => withEnv({
          PIKVM_DEVICES: registryJson({ lab1: device({ passwordFile }) }),
          PIKVM_DEVICES_FILE: join(dir, 'devices.json'),
        }, () => loadConfig()),
        /not both/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one device becomes the default, and a loose registry file is not a mode warning', () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, PATH_SENTINEL, 'pw-1');
      const file = join(dir, 'devices.json');
      writeFileSync(file, registryJson({
        lab1: device({ passwordFile, tls: { mode: 'verify' } }),
      }), { mode: 0o666 });
      chmodSync(file, 0o666);
      const { value, lines } = capture(() => withEnv({
        PIKVM_DEVICES_FILE: file,
        PIKVM_HOST: 'https://pikvm.example.ts.net',
        PIKVM_TLS_MODE: 'verify',
      }, () => loadConfig()));
      assert.equal(value.registry.defaultName, 'lab1');
      assert.equal(value.pikvm.host, 'https://100.64.0.8');
      assert.equal(value.pikvm.tls.default.mode, 'verify');
      assert.equal(lines.filter((line) => line.includes('PIKVM_HOST was ignored')).length, 1);
      assert.equal(lines.some((line) => line.includes('devices.json') && line.includes('mode')), false);
      const shown = JSON.stringify(redactConfig(value));
      assert.equal(shown.includes('pw-1'), false);
      assert.equal(shown.includes(PATH_SENTINEL), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('passwordCredential is one segment under CREDENTIALS_DIRECTORY', () => {
    const dir = tempDir();
    try {
      const credDir = join(dir, 'creds');
      mkdirSync(credDir);
      writeFileSync(join(credDir, 'pikvm-lab1'), 'from-cred\n', { mode: 0o600 });
      const config = withEnv({
        CREDENTIALS_DIRECTORY: credDir,
        PIKVM_DEVICES: registryJson({
          lab1: device({ passwordCredential: 'pikvm-lab1', tls: { mode: 'insecure' } }),
        }),
      }, () => loadConfig());
      assert.equal(config.registry.devices.get('lab1').password, 'from-cred');
      assert.throws(
        () => withEnv({
          CREDENTIALS_DIRECTORY: credDir,
          PIKVM_DEVICES: registryJson({
            lab1: device({ passwordCredential: 'a/b', tls: { mode: 'insecure' } }),
          }),
        }, () => loadConfig()),
        /single path segment/,
      );
      assert.throws(
        () => withEnv({
          PIKVM_DEVICES: registryJson({
            lab1: device({ passwordCredential: 'pikvm-lab1', tls: { mode: 'insecure' } }),
          }),
        }, () => loadConfig()),
        /CREDENTIALS_DIRECTORY is unset/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an omitted tls mode stays insecure and ignores PIKVM_TLS_MODE', () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', 'pw-1');
      const { value, lines } = capture(() => withEnv({
        PIKVM_DEVICES: registryJson({
          lab1: device({ passwordFile }),
        }),
        PIKVM_TLS_MODE: 'verify',
      }, () => loadConfig()));
      assert.equal(value.registry.devices.get('lab1').tls.mode, 'insecure');
      assert.ok(lines.some((line) => line.includes('device lab1') && line.includes('tls.mode is unset')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the arm ceiling can only be narrowed', () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', 'pw-1');
      const config = withEnv({
        PIKVM_DEVICES: registryJson({
          lab1: device({ passwordFile, tls: { mode: 'insecure' }, armHid: true, armMsd: true }),
          lab2: device({
            host: 'https://100.64.0.9',
            passwordFile,
            tls: { mode: 'insecure' },
            armHid: false,
            armMsd: false,
          }),
        }, 'lab1'),
      }, () => loadConfig());
      const disarmed = buildFleet(config, { hid: false, msd: false });
      assert.equal(disarmed.devices.get('lab1').armHid, false);
      assert.equal(disarmed.devices.get('lab1').armMsd, false);
      const armed = buildFleet(config, { hid: true, msd: true });
      assert.equal(armed.devices.get('lab1').armHid, true);
      assert.equal(armed.devices.get('lab2').armHid, false);
      assert.equal(armed.devices.get('lab2').armMsd, false);
      return Promise.all([closeFleet(disarmed), closeFleet(armed)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function rpcHeaders(sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${TOKEN}`,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  return headers;
}

async function rpc(base, sessionId, method, params) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function openSession(base) {
  const res = await rpc(base, undefined, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'devices-test', version: '1.0' },
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const sessionId = res.headers.get('mcp-session-id');
  await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: rpcHeaders(sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

async function callTool(base, sessionId, name, args = {}) {
  const res = await rpc(base, sessionId, 'tools/call', { name, arguments: args });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.result;
}

async function listen(createServer) {
  const httpServer = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    bearerToken: TOKEN,
    createServer,
  });
  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

describe('legacy tool output', { concurrency: false }, () => {
  test('a single device does not add a device line', async () => {
    const mock = await startKvmdMock();
    const pikvm = new PiKVMClient({
      host: mock.url,
      username: 'admin',
      password: 'testpw',
      verifySsl: false,
    });
    const srv = await listen(() => createMcpServer({
      pikvm,
      lock: new BusyLock(),
      calibrationConfig,
      armGateEnforced: false,
      msdArmGateEnforced: false,
    }));
    try {
      const sessionId = await openSession(srv.base);
      const result = await callTool(srv.base, sessionId, 'pikvm_get_calibration');
      assert.equal(result.isError, undefined);
      assert.equal(
        result.content[0].text,
        'Not calibrated. Mouse coordinates use default 1.0 factor (no correction).',
      );
      const listed = await callTool(srv.base, sessionId, 'pikvm_devices');
      const body = JSON.parse(listed.content[0].text);
      assert.equal(body.default, 'default');
      assert.equal(body.devices[0].name, 'default');
      assert.equal(body.devices[0].host, mock.url);
      assert.equal(Object.hasOwn(body.devices[0], 'password'), false);
    } finally {
      await srv.close();
      await pikvm.close();
      await mock.close();
    }
  });

  test('a legacy host with userinfo and a query is listed as an origin', async () => {
    const mock = await startKvmdMock();
    const rawHost = `http://admin:SECRETPW@127.0.0.1:${new URL(mock.url).port}/kvm?token=TOK`;
    const chunks = [];
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    function record(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    }
    process.stdout.write = function (chunk, encoding, cb) {
      record(chunk);
      return origOut.call(process.stdout, chunk, encoding, cb);
    };
    process.stderr.write = function (chunk, encoding, cb) {
      record(chunk);
      return origErr.call(process.stderr, chunk, encoding, cb);
    };
    let pikvm;
    let srv;
    try {
      const config = withEnv({
        PIKVM_HOST: rawHost,
        PIKVM_PASSWORD: 'testpw',
        PIKVM_TLS_MODE: 'insecure',
      }, () => loadConfig());
      assert.equal(config.pikvm.host, rawHost);
      const logged = JSON.stringify(redactConfig(config));
      assert.equal(logged.includes('SECRETPW'), false);
      assert.equal(logged.includes('TOK'), false);
      assert.match(logged, new RegExp(mock.url.replaceAll('.', '\\.')));
      pikvm = new PiKVMClient(config.pikvm);
      srv = await listen(() => createMcpServer({
        pikvm,
        lock: new BusyLock(),
        calibrationConfig,
        armGateEnforced: false,
        msdArmGateEnforced: false,
      }));
      const sessionId = await openSession(srv.base);
      const listed = await callTool(srv.base, sessionId, 'pikvm_devices');
      const failed = await callTool(srv.base, sessionId, 'pikvm_get_resolution');
      const status = await callTool(srv.base, sessionId, 'pikvm_msd_status');
      const calibration = await callTool(srv.base, sessionId, 'pikvm_get_calibration');
      const body = JSON.parse(listed.content[0].text);
      assert.equal(body.devices[0].host, mock.url);
      assert.equal(failed.isError, true);
      const blob = [
        listed.content[0].text,
        failed.content[0].text,
        status.content[0].text,
        calibration.content[0].text,
        chunks.join(''),
      ].join('\n');
      assert.equal(blob.includes('SECRETPW'), false);
      assert.equal(blob.includes('TOK'), false);
      assert.equal(blob.includes('/kvm'), false);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      if (srv) await srv.close();
      if (pikvm) await pikvm.close();
      await mock.close();
    }
  });
});

describe('two devices', { concurrency: false }, () => {
  test('an unknown device makes no connection', async () => {
    let connections = 0;
    const sockets = new Set();
    const server = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end('called');
    });
    server.on('connection', (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', SENTINEL);
      const config = withEnv({
        PIKVM_DEVICES: registryJson({
          lab1: device({
            host: `http://127.0.0.1:${port}`,
            passwordFile,
            tls: { mode: 'insecure' },
          }),
          lab2: device({
            host: 'https://100.64.0.9',
            passwordFile,
            tls: { mode: 'insecure' },
          }),
        }, 'lab1'),
      }, () => loadConfig());
      const fleet = buildFleet(config, { hid: true, msd: true });
      const fallback = fleet.devices.get('lab1');
      const srv = await listen(() => createMcpServer({
        pikvm: fallback.client,
        lock: fallback.lock,
        fleet,
        calibrationConfig,
        armGateEnforced: false,
        msdArmGateEnforced: false,
        msd: config.msd,
      }));
      try {
        const sessionId = await openSession(srv.base);
        const result = await callTool(srv.base, sessionId, 'pikvm_get_resolution', { device: 'nope' });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /unknown device "nope"/);
        assert.match(result.content[0].text, /Known devices: lab1, lab2/);
        assert.equal(result.content[0].text.includes(SENTINEL), false);
        assert.equal(connections, 0);
      } finally {
        await srv.close();
        await closeFleet(fleet);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('locks, arms, calibration, scale, and jobs stay on their device', async () => {
    const dir = tempDir();
    const mockA = await startKvmdMock({
      routes: {
        'POST /api/msd/write': { delayMs: 300, status: 204, body: '' },
      },
    });
    const mockB = await startKvmdMock();
    try {
      const passwordFile = writeSecret(dir, PATH_SENTINEL, SENTINEL);
      const certFile = join(dir, `${CERT_SENTINEL}.pem`);
      writeFileSync(certFile, 'not-a-cert\n', { mode: 0o644 });
      const iso = join(dir, 'disk.iso');
      writeFileSync(iso, Buffer.alloc(64, 7));
      const config = withEnv({
        PIKVM_MSD_IDLE_TIMEOUT_MS: '1500',
        PIKVM_DEVICES: registryJson({
          lab1: device({
            host: mockA.url,
            passwordFile,
            tls: { mode: 'insecure' },
            armHid: true,
            armMsd: true,
            msdLocalDir: dir,
            hwTest: true,
          }),
          lab2: device({
            host: mockB.url,
            passwordFile,
            tls: { mode: 'insecure' },
            armHid: false,
            armMsd: false,
            hwTest: false,
          }),
        }, 'lab1'),
      }, () => loadConfig());
      const fleet = buildFleet(config, { hid: true, msd: true });
      const lab1 = fleet.devices.get('lab1');
      const lab2 = fleet.devices.get('lab2');
      const srv = await listen(() => createMcpServer({
        pikvm: lab1.client,
        lock: lab1.lock,
        fleet,
        calibrationConfig,
        armGateEnforced: true,
        msdArmGateEnforced: true,
        msd: config.msd,
      }));
      try {
        const sessionId = await openSession(srv.base);
        const names = await rpc(srv.base, sessionId, 'tools/list', {});
        const listed = await names.json();
        const toolNames = listed.result.tools.map((tool) => tool.name);
        assert.equal(toolNames.includes('pikvm_msd_upload'), true);
        assert.equal(toolNames.includes('pikvm_devices'), true);

        const devices = await callTool(srv.base, sessionId, 'pikvm_devices');
        const shown = devices.content[0].text;
        assert.equal(shown.includes(SENTINEL), false);
        assert.equal(shown.includes(PATH_SENTINEL), false);
        assert.equal(shown.includes(CERT_SENTINEL), false);
        assert.equal(shown.includes(passwordFile), false);
        const parsed = JSON.parse(shown);
        assert.equal(parsed.default, 'lab1');
        assert.deepEqual(parsed.devices.map((item) => item.name), ['lab1', 'lab2']);
        assert.equal(parsed.devices[0].host, mockA.url);
        assert.equal(parsed.devices[0].tls, 'insecure');
        assert.equal(parsed.devices[0].armHid, true);
        assert.equal(parsed.devices[1].armHid, false);
        assert.equal(parsed.devices[0].hwTest, true);
        assert.equal(Object.hasOwn(parsed.devices[0], 'password'), false);
        assert.equal(Object.hasOwn(parsed.devices[0], 'passwordFile'), false);

        const blocked = await callTool(srv.base, sessionId, 'pikvm_type', { device: 'lab2', text: 'ab' });
        assert.equal(blocked.isError, true);
        assert.match(blocked.content[0].text, /HID arm-gate/);
        assert.match(blocked.content[0].text, /Device: lab2/);
        assert.equal(mockB.calls.some((call) => call.path.startsWith('/api/hid')), false);

        const typed = await callTool(srv.base, sessionId, 'pikvm_type', { device: 'lab1', text: 'ab' });
        assert.equal(typed.isError, undefined);
        assert.match(typed.content[0].text, /Device: lab1/);
        assert.equal(mockA.calls.some((call) => call.path === '/api/hid/print'), true);

        lab1.lock.acquire('HID');
        const resolutionB = await callTool(srv.base, sessionId, 'pikvm_get_resolution', { device: 'lab2' });
        assert.equal(resolutionB.isError, undefined, resolutionB.content?.[0]?.text);
        assert.match(resolutionB.content[0].text, /Device: lab2/);
        const statusB = await callTool(srv.base, sessionId, 'pikvm_msd_status', { device: 'lab2' });
        assert.equal(statusB.isError, undefined, statusB.content?.[0]?.text);
        const shotA = await callTool(srv.base, sessionId, 'pikvm_screenshot', { device: 'lab1' });
        assert.equal(shotA.isError, true);
        assert.match(shotA.content[0].text, /HID in progress/);
        assert.equal(mockA.calls.some((call) => call.path === '/api/streamer/snapshot'), false);
        lab1.lock.release();

        const set = await callTool(srv.base, sessionId, 'pikvm_set_calibration', {
          device: 'lab1',
          factorX: 1.1,
          factorY: 1.2,
        });
        assert.equal(set.isError, undefined, set.content[0].text);
        const gotA = await callTool(srv.base, sessionId, 'pikvm_get_calibration', { device: 'lab1' });
        assert.match(gotA.content[0].text, /factorX: 1\.1000/);
        const gotB = await callTool(srv.base, sessionId, 'pikvm_get_calibration', { device: 'lab2' });
        assert.match(gotB.content[0].text, /Not calibrated/);

        const beforeB = mockB.calls.length;
        await callTool(srv.base, sessionId, 'pikvm_screenshot', { device: 'lab1' });
        const moveA = await callTool(srv.base, sessionId, 'pikvm_mouse_move', { device: 'lab1', x: 1, y: 1 });
        assert.equal(moveA.isError, undefined, moveA.content[0].text);
        const moveB = await callTool(srv.base, sessionId, 'pikvm_mouse_move', { device: 'lab2', x: 1, y: 1 });
        assert.match(moveB.content[0].text, /HID arm-gate/);
        assert.equal(mockB.calls.length, beforeB);
        const moved = mockA.calls.filter((call) => call.path === '/api/hid/events/send_mouse_move');
        const last = new URLSearchParams(moved.at(-1).query);
        await lab2.client.mouseMove(1, 1);
        const movedB = mockB.calls.filter((call) => call.path === '/api/hid/events/send_mouse_move');
        const raw = new URLSearchParams(movedB.at(-1).query);
        assert.notEqual(last.get('to_x'), raw.get('to_x'));
        assert.notEqual(last.get('to_y'), raw.get('to_y'));

        const upload = await callTool(srv.base, sessionId, 'pikvm_msd_upload', {
          device: 'lab1',
          file: 'disk.iso',
          confirmImage: 'disk.iso',
        });
        const statusDuring = await callTool(srv.base, sessionId, 'pikvm_msd_status', { device: 'lab2' });
        assert.equal(statusDuring.isError, undefined, statusDuring.content?.[0]?.text);
        assert.equal(upload.isError, undefined, upload.content[0].text);
        const job = JSON.parse(upload.content[0].text);
        assert.equal(job.device, 'lab1');
        assert.match(job.jobId, /^[0-9a-f]{32}$/);
        const other = await callTool(srv.base, sessionId, 'pikvm_msd_job', {
          device: 'lab2',
          jobId: job.jobId,
        });
        assert.equal(other.isError, true);
        assert.match(other.content[0].text, /unknown job/);
        assert.equal(other.content[0].text.includes(job.jobId), false);
        const same = await callTool(srv.base, sessionId, 'pikvm_msd_job', {
          device: 'lab1',
          jobId: job.jobId,
        });
        assert.equal(same.isError, undefined, same.content[0].text);
        const view = JSON.parse(same.content[0].text);
        assert.equal(view.device, 'lab1');
        assert.ok(view.state === 'hashing' || view.state === 'running' || view.state === 'done' || view.state === 'failed');
      } finally {
        await srv.close();
        await closeFleet(fleet);
      }
    } finally {
      await mockA.close();
      await mockB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('one device can pin and another can stay insecure', async () => {
    const minted = mintCert();
    const dir = tempDir();
    const sockets = new Set();
    function listen() {
      const server = https.createServer({ key: minted.key, cert: minted.cert }, (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
    }
    const pinServer = await listen();
    const openServer = await listen();
    try {
      const passwordFile = writeSecret(dir, 'pw', 'pw-1');
      const certFile = join(dir, 'lab1.pem');
      writeFileSync(certFile, minted.cert, { mode: 0o644 });
      const config = withEnv({
        PIKVM_DEVICES: registryJson({
          pin1: device({
            host: `https://127.0.0.1:${pinServer.address().port}`,
            passwordFile,
            tls: { mode: 'pin', certFile },
          }),
          open1: device({
            host: `https://127.0.0.1:${openServer.address().port}`,
            passwordFile,
            tls: { mode: 'insecure' },
          }),
        }, 'pin1'),
      }, () => loadConfig());
      assert.equal(config.registry.devices.get('pin1').tls.mode, 'pin');
      assert.equal(config.registry.devices.get('pin1').tls.spkiSha256, minted.spkiSha256);
      assert.equal(config.registry.devices.get('open1').tls.mode, 'insecure');
      const fleet = buildFleet(config, { hid: true, msd: true });
      try {
        assert.equal(await fleet.devices.get('pin1').client.checkAuth(), true);
        assert.equal(await fleet.devices.get('open1').client.checkAuth(), true);
      } finally {
        await closeFleet(fleet);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      await Promise.all([pinServer, openServer].map((server) => new Promise((resolve) => {
        server.close(resolve);
      })));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a full device does not prune another device\'s finished jobs', async () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', 'pw-1');
      writeFileSync(join(dir, 'disk.iso'), Buffer.alloc(32, 3));
      const config = withEnv({
        PIKVM_DEVICES: registryJson({
          capa: device({
            host: 'https://100.64.0.8',
            passwordFile,
            tls: { mode: 'insecure' },
            msdLocalDir: dir,
          }),
          capb: device({
            host: 'https://100.64.0.9',
            passwordFile,
            tls: { mode: 'insecure' },
            msdLocalDir: dir,
          }),
        }, 'capa'),
      }, () => loadConfig());
      const fleet = buildFleet(config, { hid: true, msd: true });
      const capa = fleet.devices.get('capa');
      const srv = await listen(() => createMcpServer({
        pikvm: capa.client,
        lock: capa.lock,
        fleet,
        calibrationConfig,
        armGateEnforced: false,
        msdArmGateEnforced: false,
        msd: { ...config.msd, jobLimit: 1 },
      }));
      try {
        const sessionId = await openSession(srv.base);
        async function finish(device) {
          const started = await callTool(srv.base, sessionId, 'pikvm_msd_upload', {
            device,
            file: 'disk.iso',
            confirmImage: 'disk.iso',
            sha256: 'a'.repeat(64),
          });
          assert.equal(started.isError, undefined, started.content?.[0]?.text);
          const { jobId } = JSON.parse(started.content[0].text);
          let view;
          for (let i = 0; i < 40; i += 1) {
            const read = await callTool(srv.base, sessionId, 'pikvm_msd_job', { device, jobId });
            assert.equal(read.isError, undefined, read.content?.[0]?.text);
            view = JSON.parse(read.content[0].text);
            if (view.state === 'failed' || view.state === 'done') break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(view.state, 'failed');
          return jobId;
        }
        const kept = await finish('capb');
        const dropped = await finish('capa');
        const still = await callTool(srv.base, sessionId, 'pikvm_msd_job', { device: 'capb', jobId: kept });
        assert.equal(still.isError, undefined, still.content?.[0]?.text);
        assert.equal(JSON.parse(still.content[0].text).state, 'failed');
        const newest = await finish('capa');
        const gone = await callTool(srv.base, sessionId, 'pikvm_msd_job', { device: 'capa', jobId: dropped });
        assert.equal(gone.isError, true);
        assert.match(gone.content[0].text, /unknown job/);
        const capaKept = await callTool(srv.base, sessionId, 'pikvm_msd_job', { device: 'capa', jobId: newest });
        assert.equal(JSON.parse(capaKept.content[0].text).state, 'failed');
        const other = await callTool(srv.base, sessionId, 'pikvm_msd_job', { device: 'capb', jobId: kept });
        assert.equal(JSON.parse(other.content[0].text).state, 'failed');
      } finally {
        await srv.close();
        await closeFleet(fleet);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pin and hardware gate', { concurrency: false }, () => {
  test('pin writes the named device certFile', async () => {
    const minted = mintCert();
    const dir = tempDir();
    const sockets = new Set();
    let received = Buffer.alloc(0);
    const server = https.createServer({ key: minted.key, cert: minted.cert });
    server.on('secureConnection', (socket) => {
      sockets.add(socket);
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
      });
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const dest = join(dir, 'lab1.pem');
    const passwordFile = writeSecret(dir, 'pw', SENTINEL);
    const json = registryJson({
      lab1: device({
        host: `https://127.0.0.1:${port}`,
        passwordFile,
        tls: { mode: 'pin', certFile: dest },
      }),
    });
    try {
      const child = spawn(process.execPath, [join(REPO, 'dist', 'index.js'), 'pin', 'lab1', '--yes'], {
        cwd: REPO,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME ?? '/tmp',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          PIKVM_MCP_NO_DOTENV: '1',
          PIKVM_DEVICES: json,
        },
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
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`pin did not exit\n${stdout}\n${stderr}`));
        }, 10000);
        child.once('exit', (code) => {
          clearTimeout(timer);
          setTimeout(() => resolve({ code, stdout, stderr }), 30);
        });
      });
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`SPKI sha256: ${minted.spkiSha256}`));
      assert.equal(existsSync(dest), true);
      assert.match(readFileSync(dest, 'utf8'), /BEGIN CERTIFICATE/);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(SENTINEL), false);
      assert.equal(received.includes(SENTINEL), false);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the hardware gate requires hwTest on a registry device', () => {
    const dir = tempDir();
    try {
      const passwordFile = writeSecret(dir, 'pw', 'pw-1');
      const base = {
        lab1: device({ passwordFile, tls: { mode: 'insecure' }, hwTest: false }),
      };
      const env = {
        PIKVM_HW_TEST_DEVICE: 'lab1',
        PIKVM_DEVICES: registryJson(base),
      };
      assert.throws(() => hwDeviceRequest(env), /Set hwTest true/);
      base.lab1.hwTest = true;
      env.PIKVM_DEVICES = registryJson(base);
      assert.deepEqual(hwDeviceRequest(env), { skip: false, name: 'lab1' });
      assert.throws(
        () => hwDeviceRequest({
          PIKVM_HW_TEST_DEVICE: 'other',
          PIKVM_DEVICES: registryJson(base),
        }),
        /not in the registry/,
      );
      assert.throws(
        () => hwDeviceRequest({ PIKVM_HW_TEST_DEVICE: 'other' }),
        /Only "default" is accepted/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
