// Modified 2026-10 by PLN: optional system-tesseract fixture (GPL-3.0; see NOTICE).

/**
 * Reads a committed PNG with the tesseract binary on PATH.
 * Skips when that binary is absent. No network and no traineddata in the repo.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTesseractEngine } from '../dist/ocr.js';

function tesseractOnPath() {
  return new Promise((resolve) => {
    execFile('tesseract', ['--version'], { timeout: 2000, killSignal: 'SIGKILL' }, (err) => {
      resolve(!err);
    });
  });
}

const available = await tesseractOnPath();

test('the system tesseract reads the committed fixture', {
  skip: available ? false : 'tesseract is not on PATH',
}, async () => {
  const png = readFileSync(new URL('./fixtures/ocr-hello.png', import.meta.url));
  assert.ok(png.length >= 8 * 1024 && png.length <= 16 * 1024, `fixture is ${png.length} bytes`);
  assert.equal(png.subarray(0, 4).toString('hex'), '89504e47');
  const engine = createTesseractEngine({ bin: 'tesseract', timeoutMs: 10000 });
  const recognized = await engine.recognize(png, {
    langs: 'eng',
    psm: 8,
    signal: new AbortController().signal,
  });
  const text = recognized.words.map((word) => word.text).join(' ');
  assert.match(text, /HELLO/);
});
