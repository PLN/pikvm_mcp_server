// Modified 2026-10 by PLN: hardware suite image bytes (GPL-3.0; see NOTICE).

/**
 * Tiny image for the MSD write cycle.
 * The storage name is always mcp-hwtest-<timestamp>-<rand>.iso.
 * xorriso, then genisoimage, builds a real ISO when one of them is on
 * PATH. Otherwise the file is fallbackIsoBytes(), a fixed 64-byte
 * fixture. A mountable ISO 9660 image needs a 32 KiB system area plus
 * descriptors, so that fixture is not a mountable volume. kvmd stores
 * the bytes either way. The layout is ASCII and identical every call:
 *   0-7    MCPHWISO
 *   8-15   00000001
 *   16-63  "pikvm-mcp hardware-suite fixture" and a newline, space padded
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const HWTEST_PREFIX = 'mcp-hwtest-';

export function isHwTestImageName(name) {
  return typeof name === 'string'
    && name.startsWith(HWTEST_PREFIX)
    && name.length > HWTEST_PREFIX.length
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('..');
}

export function hwTestImageName(suffix = '') {
  const rand = randomBytes(4).toString('hex');
  const extra = suffix ? `-${suffix}` : '';
  return `${HWTEST_PREFIX}${Date.now()}-${rand}${extra}.iso`;
}

export function fallbackIsoBytes() {
  const buf = Buffer.alloc(64, 0x20);
  buf.write('MCPHWISO', 0, 'ascii');
  buf.write('00000001', 8, 'ascii');
  buf.write('pikvm-mcp hardware-suite fixture\n', 16, 'ascii');
  return buf;
}

async function findIsoTool() {
  for (const bin of ['xorriso', 'genisoimage']) {
    try {
      await execFileAsync(bin, ['--version']);
      return bin;
    } catch {
      // Not installed, or it refused --version.
    }
  }
  return null;
}

export async function prepareHwImage(dir, name) {
  const dest = join(dir, name);
  const tool = await findIsoTool();
  if (!tool) {
    await writeFile(dest, fallbackIsoBytes());
    return { path: dest, generator: 'fixture', bytes: 64 };
  }
  const stage = await mkdtemp(join(tmpdir(), 'pikvm-hwiso-'));
  try {
    await writeFile(join(stage, 'readme.txt'), 'pikvm mcp hardware suite\n');
    if (tool === 'xorriso') {
      await execFileAsync('xorriso', [
        '-as', 'mkisofs',
        '-o', dest,
        '-V', 'MCPHWTEST',
        '-iso-level', '1',
        stage,
      ]);
    } else {
      await execFileAsync('genisoimage', [
        '-o', dest,
        '-V', 'MCPHWTEST',
        '-iso-level', '1',
        stage,
      ]);
    }
  } catch (err) {
    await writeFile(dest, fallbackIsoBytes());
    return { path: dest, generator: 'fixture', bytes: 64, toolError: err.message };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  const info = await stat(dest);
  return { path: dest, generator: tool, bytes: info.size };
}
