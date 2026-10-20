// Modified 2026-10 by PLN: bounded MSD test teardown and fetch (GPL-3.0; see NOTICE).

/**
 * Ceilings for the MSD tests. Each subtest is finite and shorter than
 * the file, so one stall fails that subtest and the rest of the file
 * still runs. Teardown and fetch use a shorter bound and reject with
 * the operation's name. The timer is cleared when the work finishes.
 */

import test from 'node:test';

export const MSD_SUBTEST_TIMEOUT_MS = 30_000;
export const MSD_UPLOAD_SUITE_TIMEOUT_MS = 120_000;
export const MSD_FILE_TIMEOUT_MS = 300_000;
export const MSD_TEARDOWN_TIMEOUT_MS = 10_000;
export const MSD_FETCH_TIMEOUT_MS = 10_000;
export const MSD_HW_FETCH_TIMEOUT_MS = 60_000;

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

export async function boundedFetch(url, init = {}, label = 'fetch', ms = MSD_FETCH_TIMEOUT_MS) {
  const signal = init.signal ?? AbortSignal.timeout(ms);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (init.signal == null && err && err.name === 'TimeoutError') {
      throw new Error(`${label} timed out after ${ms}ms`, { cause: err });
    }
    throw err;
  }
}

export async function boundedDispatch(dispatch, url, init = {}, label = 'request', ms = MSD_FETCH_TIMEOUT_MS) {
  const ownSignal = init.signal == null;
  const signal = ownSignal ? AbortSignal.timeout(ms) : init.signal;
  try {
    return await dispatch(url, { ...init, signal });
  } catch (err) {
    if (ownSignal && err && err.name === 'TimeoutError') {
      throw new Error(`${label} timed out after ${ms}ms`, { cause: err });
    }
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

export function msdTest(name, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = undefined;
  }
  return test(name, withTimeout(options), fn);
}

export function msdSubtest(t, name, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = undefined;
  }
  return t.test(name, withTimeout(options), fn);
}
