// Modified 2026-10 by PLN: short-password and tool-error redaction (GPL-3.0; see NOTICE).

import test from 'node:test';
import assert from 'node:assert/strict';
import { KvmdError } from '../dist/pikvm/client.js';
import { redactSecrets } from '../dist/redact.js';
import { formatToolError } from '../dist/server.js';

test('a password shorter than 4 characters is not removed literally', () => {
  const text = redactSecrets('the category field stayed intact', 'cat');
  assert.equal(text, 'the category field stayed intact');
});

test('a password of 4 or more characters is removed literally', () => {
  const text = redactSecrets('leak testpw now', 'testpw');
  assert.equal(text, 'leak [REDACTED] now');
});

test('formatToolError passes the password into redactSecrets', () => {
  const plain = formatToolError(new Error('leak testpw in category'), 'testpw');
  assert.equal(plain, 'Error: leak [REDACTED] in category');

  const kvmd = formatToolError(
    new KvmdError(400, 'ValidatorError', 'leak testpw please', 'GET /api/streamer'),
    'testpw',
  );
  assert.doesNotMatch(kvmd, /testpw/);
  assert.match(kvmd, /\[REDACTED\]/);

  const short = formatToolError(new Error('the category field stayed intact'), 'cat');
  assert.equal(short, 'Error: the category field stayed intact');
});
