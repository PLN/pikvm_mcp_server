// Modified 2026-10 by PLN: POSIX capability probes for fixtures (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a FIFO counts only when the path is a FIFO (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: the Windows FIFO skip reason (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: POSIX probes are asserted, not skipped (GPL-3.0; see NOTICE).

/**
 * Cached probes for fixtures that need a symlink, a FIFO, or an exact
 * mode. Linux can do all three, so those assertions still run here.
 * Windows skips a FIFO and an exact mode. On POSIX those probes are
 * asserted, so a missing mkfifo or a mode that does not stick fails.
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

/**
 * Git for Windows ships mkfifo. It can exit 0 and leave no file, so a
 * later open or lstat is ENOENT. That is not a FIFO fixture.
 */
export const WIN32_FIFO_SKIP =
  'Git for Windows mkfifo exits 0 and leaves no file Node can open';

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
    const pipe = join(dir, 'pipe');
    execFileSync('mkfifo', [pipe], { stdio: 'ignore' });
    // Git for Windows ships mkfifo. It can exit 0 without leaving a
    // FIFO that Node can open, so the command's status is not enough.
    return statSync(pipe).isFIFO();
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
