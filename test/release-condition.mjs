// Modified 2026-10 by PLN: publish condition tests C1-C9 (GPL-3.0; see NOTICE).

/**
 * Checks the publish condition in .github/workflows/release.yml.
 * Usage: node test/release-condition.mjs
 *
 * 1. test/fixtures/release-publish-if.txt holds exactly one line, and
 *    release.yml and the stub workflow carry it as a whole line once
 *    indentation is stripped. A commented-out or folded copy does not count.
 * 2. That line is evaluated with GitHub's expression rules for every
 *    combination of the four upstream results, verify's resume output
 *    ('true', 'false', empty, missing) and a cancelled run, and must
 *    agree with the specification below. A job that fails on purpose
 *    would fail a GitHub run, and continue-on-error reports success to
 *    the jobs that need it, so the failure cases are covered here. The
 *    stub workflow runs the cases without a failed job on GitHub itself.
 *
 * Only the expression subset the condition uses is supported: !, &&, ||,
 * ==, !=, parentheses, 'string' literals, property paths and cancelled().
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

const fixtureText = read('test/fixtures/release-publish-if.txt');
const fixtureLines = fixtureText.split('\n');
if (fixtureLines.length !== 2 || fixtureLines[1] !== '') {
  throw new Error('release-publish-if.txt must be exactly one line ending in LF');
}
const line = fixtureLines[0];
for (const file of ['.github/workflows/release.yml', '.github/workflows/release-condition-stub.yml']) {
  const lines = read(file).split(/\r?\n/).map((l) => l.replace(/^\s+/, ''));
  if (!lines.includes(line)) throw new Error(`${file} does not carry the committed publish condition`);
}

const match = /^if: \$\{\{ (.*) \}\}$/.exec(line);
if (!match) throw new Error('the condition must be written as if: ${{ ... }}');

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(&&|\|\||==|!=|!|\(|\))|'([^']*)'|([A-Za-z_][A-Za-z0-9_.-]*))/y;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot parse the condition at: ${src.slice(pos)}`);
    if (m[1]) tokens.push({ op: m[1] });
    else if (m[2] !== undefined) tokens.push({ str: m[2] });
    else tokens.push({ name: m[3] });
    pos = re.lastIndex;
    while (src[pos] === ' ') pos += 1;
  }
  return tokens;
}

// GitHub: different types are compared as numbers (null 0, '' 0, a
// non-numeric string NaN); two strings compare without case.
function toNumber(v) {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v.trim() === '') return 0;
  const n = Number(v);
  return Number.isNaN(n) ? NaN : n;
}
function equal(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return toNumber(a) === toNumber(b);
}
const truthy = (v) => !(v === null || v === false || v === '' || v === 0);

function evaluate(src, ctx) {
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const take = (op) => {
    if (!peek() || peek().op !== op) throw new Error(`expected ${op}`);
    i += 1;
  };
  function primary() {
    const t = tokens[i++];
    if (!t) throw new Error('unexpected end of the condition');
    if (t.op === '(') {
      const v = or();
      take(')');
      return v;
    }
    if (t.str !== undefined) return t.str;
    if (t.name === 'cancelled' && peek()?.op === '(') {
      take('(');
      take(')');
      return ctx.cancelled;
    }
    if (t.name) {
      let v = ctx;
      for (const part of t.name.split('.')) v = v == null ? null : (v[part] ?? null);
      return v;
    }
    throw new Error(`unexpected ${JSON.stringify(t)}`);
  }
  function unary() {
    if (peek()?.op === '!') {
      i += 1;
      return !truthy(unary());
    }
    const left = primary();
    const op = peek()?.op;
    if (op === '==' || op === '!=') {
      i += 1;
      const right = primary();
      return op === '==' ? equal(left, right) : !equal(left, right);
    }
    return left;
  }
  function and() {
    let v = unary();
    while (peek()?.op === '&&') {
      i += 1;
      const r = unary();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  function or() {
    let v = and();
    while (peek()?.op === '||') {
      i += 1;
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  const v = or();
  if (i !== tokens.length) throw new Error('trailing tokens in the condition');
  return truthy(v);
}

/** Design rev 8, section 7.2 step 4. A missing or empty resume is the normal path. */
function specified({ cancelled, verify, resume, build, smoke, scan }) {
  if (cancelled || verify !== 'success') return false;
  const gates = [build, smoke, scan];
  if (resume === 'true') return gates.every((r) => r === 'skipped');
  return gates.every((r) => r === 'success');
}

const results = ['success', 'failure', 'cancelled', 'skipped'];
const resumes = ['true', 'false', '', null];
let checked = 0;
let runs = 0;
for (const cancelled of [false, true]) {
  for (const verify of results) {
    for (const resume of resumes) {
      for (const build of results) {
        for (const smoke of results) {
          for (const scan of results) {
            const c = { cancelled, verify, resume, build, smoke, scan };
            const outputs = resume === null ? {} : { resume };
            const ctx = {
              cancelled,
              needs: {
                verify: { result: verify, outputs },
                build: { result: build },
                smoke: { result: smoke },
                scan: { result: scan },
              },
            };
            const got = evaluate(match[1], ctx);
            if (got !== specified(c)) {
              throw new Error(`publish would ${got ? 'run' : 'skip'} for ${JSON.stringify(c)}`);
            }
            checked += 1;
            if (got) runs += 1;
          }
        }
      }
    }
  }
}

// The named cases from the design, as a readable record.
const named = [
  ['C1', false, 'success', 'false', 'success', 'success', 'success', true],
  ['C2', false, 'success', 'false', 'success', 'success', 'failure', false],
  ['C3', false, 'success', 'false', 'success', 'failure', 'success', false],
  ['C4', false, 'success', 'false', 'failure', 'skipped', 'skipped', false],
  ['C5', false, 'success', '', 'skipped', 'skipped', 'skipped', false],
  ['C6', false, 'success', 'true', 'skipped', 'skipped', 'skipped', true],
  ['C7', false, 'failure', 'true', 'skipped', 'skipped', 'skipped', false],
  ['C8', false, 'success', 'true', 'success', 'success', 'success', false],
  ['C9', true, 'success', 'false', 'success', 'success', 'success', false],
];
for (const [id, cancelled, verify, resume, build, smoke, scan, run] of named) {
  const ctx = {
    cancelled,
    needs: { verify: { result: verify, outputs: { resume } }, build: { result: build }, smoke: { result: smoke }, scan: { result: scan } },
  };
  if (evaluate(match[1], ctx) !== run) throw new Error(`${id}: publish must ${run ? 'run' : 'skip'}`);
  console.log(`ok ${id}: publish ${run ? 'runs' : 'is skipped'}`);
}
console.log(`ok: ${checked} combinations agree with the specification; publish runs in ${runs}`);
