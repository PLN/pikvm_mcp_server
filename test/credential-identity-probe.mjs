// Modified 2026-10 by PLN: opened-inode credential probe (GPL-3.0; see NOTICE).

/**
 * Opens the credential path as a different file, then resolves the secret.
 * The parent test passes --experimental-test-module-mocks.
 * One JSON object goes to stdout: { value, lines } or { error, lines }.
 */

import * as fs from 'node:fs';
import { mock } from 'node:test';

const secretPath = process.env.PIKVM_IDENTITY_SECRET;
const decoyPath = process.env.PIKVM_IDENTITY_DECOY;
const credDir = process.env.PIKVM_IDENTITY_DIR;
const credentialsRoot = process.env.PIKVM_IDENTITY_ROOT;
const realOpenSync = fs.openSync;

mock.module('node:fs', {
  namedExports: {
    ...fs,
    openSync(filePath, flags, mode) {
      const target = filePath === secretPath ? decoyPath : filePath;
      return realOpenSync(target, flags, mode);
    },
  },
});

const { resolveSecret } = await import('../dist/secrets.js');

const lines = [];
const orig = console.error;
console.error = (...args) => {
  lines.push(args.map((part) => String(part)).join(' '));
};
try {
  const value = resolveSecret({
    name: 'PIKVM_PASSWORD',
    credName: 'pikvm-password',
    required: true,
    env: { CREDENTIALS_DIRECTORY: credDir },
    credentialsRoot,
  });
  process.stdout.write(`${JSON.stringify({ value, lines })}\n`);
} catch (err) {
  const error = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ error, lines })}\n`);
  process.exitCode = 1;
} finally {
  console.error = orig;
}
