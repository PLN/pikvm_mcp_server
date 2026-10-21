// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: caller locations, body timeouts, and teardown after a hang (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: stack frames keep a Windows drive letter (GPL-3.0; see NOTICE).

/**
 * Ceilings for the MSD tests. Each subtest is finite and shorter than
 * the file, so one stall fails that subtest and the rest of the file
 * still runs. Teardown and fetch use a shorter bound and reject with
 * the operation's name. The timer is cleared when the work finishes.
 * A hang in the test body still runs teardown: helpers register it on
 * the test's after hook, which the runner calls when the ceiling fires.
 * node:test records the location of the function that calls test().
 * These wrappers call test() from a one-line script attributed to the
 * real caller, so a failure points at that line.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const MSD_SUBTEST_TIMEOUT_MS = 30_000;
export const MSD_UPLOAD_SUITE_TIMEOUT_MS = 120_000;
export const MSD_FILE_TIMEOUT_MS = 300_000;
export const MSD_TEARDOWN_TIMEOUT_MS = 10_000;
export const MSD_FETCH_TIMEOUT_MS = 10_000;
export const MSD_HW_FETCH_TIMEOUT_MS = 60_000;

const here = fileURLToPath(import.meta.url);
const currentTest = new AsyncLocalStorage();
const BODY_METHODS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'];

function errorText(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function bounded(label, promise, ms = MSD_TEARDOWN_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export function closed(server, label, ms = MSD_TEARDOWN_TIMEOUT_MS) {
  let settled = false;
  const done = new Promise((resolve, reject) => {
    server.close((err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    });
  });
  return bounded(label, done, ms).catch((err) => {
    settled = true;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    throw err;
  });
}

function labelTimeout(err, label, ms) {
  if (err && err.name === 'TimeoutError') {
    throw new Error(`${label} timed out after ${ms}ms`, { cause: err });
  }
  throw err;
}

function wrapMethod(target, method, label, ms) {
  const orig = target[method];
  if (typeof orig !== 'function') return;
  target[method] = async (...args) => {
    try {
      return await orig.apply(target, args);
    } catch (err) {
      labelTimeout(err, label, ms);
    }
  };
}

/**
 * AbortSignal.timeout stays armed after fetch() resolves. A stall in
 * res.json() or res.text() is the same signal, and the error is a raw
 * TimeoutError unless the body method is wrapped with the call's label.
 */
function wrapFetchBody(res, label, ms) {
  for (const method of BODY_METHODS) wrapMethod(res, method, label, ms);
  return res;
}

function wrapDispatchBody(res, label, ms) {
  const body = res && res.body;
  if (!body) return res;
  for (const method of BODY_METHODS) wrapMethod(body, method, label, ms);
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const orig = body[Symbol.asyncIterator].bind(body);
    body[Symbol.asyncIterator] = function labeledIterator() {
      const iterator = orig();
      const next = iterator.next.bind(iterator);
      iterator.next = async (...args) => {
        try {
          return await next(...args);
        } catch (err) {
          labelTimeout(err, label, ms);
        }
      };
      return iterator;
    };
  }
  return res;
}

export async function boundedFetch(url, init = {}, label = 'fetch', ms = MSD_FETCH_TIMEOUT_MS) {
  const ownSignal = init.signal == null;
  const signal = ownSignal ? AbortSignal.timeout(ms) : init.signal;
  try {
    const res = await fetch(url, { ...init, signal });
    if (ownSignal) wrapFetchBody(res, label, ms);
    return res;
  } catch (err) {
    if (ownSignal) labelTimeout(err, label, ms);
    throw err;
  }
}

export async function boundedDispatch(dispatch, url, init = {}, label = 'request', ms = MSD_FETCH_TIMEOUT_MS) {
  const ownSignal = init.signal == null;
  const signal = ownSignal ? AbortSignal.timeout(ms) : init.signal;
  try {
    const res = await dispatch(url, { ...init, signal });
    if (ownSignal) wrapDispatchBody(res, label, ms);
    return res;
  } catch (err) {
    if (ownSignal) labelTimeout(err, label, ms);
    throw err;
  }
}

export async function runBounded(steps) {
  const errors = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const err = new Error(errors.map(errorText).join('; '));
    err.cause = errors[0];
    throw err;
  }
}

export async function finishWith(work, teardown) {
  let failure;
  let result;
  try {
    result = await work();
  } catch (err) {
    failure = err;
  }
  try {
    await teardown();
  } catch (err) {
    failure = failure ? combine(failure, err) : err;
  }
  if (failure) throw failure;
  return result;
}

/**
 * Run teardown when the test ends, including when its ceiling cancels it.
 * The same function is what finishWith awaits, so a normal exit does not
 * close twice. Outside an msdTest there is no after hook, and the
 * returned function is still the teardown.
 */
export function onTestTeardown(fn) {
  let running;
  const once = () => {
    if (!running) running = Promise.resolve().then(() => fn());
    return running;
  };
  const t = currentTest.getStore();
  if (t) t.after(() => once());
  return once;
}

function combine(primary, extra) {
  const err = new Error(`${errorText(primary)}; ${errorText(extra)}`);
  err.cause = primary;
  return err;
}

function withTimeout(options) {
  const timeout = options && options.timeout != null ? options.timeout : MSD_SUBTEST_TIMEOUT_MS;
  if (!(timeout < MSD_FILE_TIMEOUT_MS)) {
    throw new Error(
      `MSD test timeout ${timeout}ms must be below the file timeout ${MSD_FILE_TIMEOUT_MS}ms`,
    );
  }
  return { ...options, timeout };
}

// A drive letter is `C:\` or `/C:/` after `file://`. `[^():]+` alone stops
// at that colon and the helper frame is chosen instead of the caller.
const STACK_FRAME = /\(?((?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/[A-Za-z]:\/)?[^():]+):(\d+):(\d+)\)?$/;

/** File, line, and column from one stack frame. Undefined when it has none. */
export function stackFrameSite(frame) {
  const match = String(frame).match(STACK_FRAME);
  if (!match) return undefined;
  let file = match[1];
  if (file.startsWith('file://')) file = fileURLToPath(file);
  return { file, line: Number(match[2]), column: Number(match[3]) };
}

function callerSite() {
  const frames = new Error().stack.split('\n').slice(1);
  for (const frame of frames) {
    const site = stackFrameSite(frame);
    if (!site || site.file === here) continue;
    return site;
  }
  return undefined;
}

function runRegistered(source, fields) {
  const site = callerSite();
  const context = vm.createContext({ test, ...fields });
  const script = new vm.Script(source, site ? {
    filename: site.file,
    lineOffset: site.line - 1,
    columnOffset: Math.max(0, site.column - 1),
  } : undefined);
  return script.runInContext(context);
}

export function msdTest(name, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = undefined;
  }
  const wrapped = (t) => currentTest.run(t, () => fn(t));
  return runRegistered('test(name, options, fn)', {
    name,
    options: withTimeout(options),
    fn: wrapped,
  });
}

export function msdSubtest(t, name, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = undefined;
  }
  const wrapped = (inner) => currentTest.run(inner, () => fn(inner));
  return runRegistered('t.test(name, options, fn)', {
    t,
    name,
    options: withTimeout(options),
    fn: wrapped,
  });
}
