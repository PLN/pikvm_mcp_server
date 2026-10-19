// Modified 2026-10 by PLN: POSIX capability probes for fixtures (GPL-3.0; see NOTICE).

/**
 * Cached probes for fixtures that need a symlink, a FIFO, or an exact
 * mode. Linux can do all three, so those assertions still run here.
 * A platform that cannot do one of them skips only that assertion.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let symlink;
let fifo;
let exactMode;

function probe(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), `pikvm-${name}-`));
  try {
    return fn(dir);
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function symlinkAvailable() {
  if (symlink !== undefined) return symlink;
  symlink = probe('symlink', (dir) => {
    const file = join(dir, 'file');
    const link = join(dir, 'link');
    writeFileSync(file, 'x');
    symlinkSync(file, link);
    return lstatSync(link).isSymbolicLink();
  });
  return symlink;
}

export function fifoAvailable() {
  if (fifo !== undefined) return fifo;
  fifo = probe('fifo', (dir) => {
    execFileSync('mkfifo', [join(dir, 'pipe')], { stdio: 'ignore' });
    return true;
  });
  return fifo;
}

/**
 * True when chmod 0644 is what a later stat reports. Windows often
 * accepts the call and still reports 0666.
 */
export function exactModeAvailable() {
  if (exactMode !== undefined) return exactMode;
  exactMode = probe('mode', (dir) => {
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    chmodSync(file, 0o644);
    return (statSync(file).mode & 0o777) === 0o644;
  });
  return exactMode;
}
