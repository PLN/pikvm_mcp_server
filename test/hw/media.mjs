// Modified 2026-10 by PLN: hardware suite image bytes (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: 1 MiB ISO 9660 image, no external tool (GPL-3.0; see NOTICE).

/**
 * ISO 9660 image for the MSD write cycle, built in Node.
 * 512 sectors of 2048 bytes (1 MiB). The kernel fsg gadget refuses a
 * cdrom smaller than 300 sectors (614400 bytes) with ETOOSMALL.
 *   sector 16  primary volume descriptor (type 1, CD001, version 1)
 *   sector 17  volume descriptor set terminator (0xFF, CD001, version 1)
 *   sector 18  root directory, '.' (0x00) and '..' (0x01)
 *   sector 19  type-L path table
 *   sector 20  type-M path table
 * The file name is mcp-hwtest-<timestamp>-<rand>.iso.
 */

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const HWTEST_PREFIX = 'mcp-hwtest-';

export const HW_ISO_SECTOR = 2048;
export const HW_ISO_SECTORS = 512;
export const HW_ISO_BYTES = HW_ISO_SECTORS * HW_ISO_SECTOR;

const PVD_SECTOR = 16;
const TERM_SECTOR = 17;
const ROOT_SECTOR = 18;
const PATH_L_SECTOR = 19;
const PATH_M_SECTOR = 20;
const ROOT_DIR_BYTES = HW_ISO_SECTOR;
const PATH_TABLE_BYTES = 10;

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

function both16(buf, offset, value) {
  buf.writeUInt16LE(value, offset);
  buf.writeUInt16BE(value, offset + 2);
}

function both32(buf, offset, value) {
  buf.writeUInt32LE(value, offset);
  buf.writeUInt32BE(value, offset + 4);
}

function writeDirectoryRecord(buf, offset, extent, dataLength, nameByte) {
  const recordLength = 34;
  buf[offset] = recordLength;
  buf[offset + 1] = 0;
  buf.writeUInt32LE(extent, offset + 2);
  buf.writeUInt32BE(extent, offset + 6);
  buf.writeUInt32LE(dataLength, offset + 10);
  buf.writeUInt32BE(dataLength, offset + 14);
  buf[offset + 18] = 126;
  buf[offset + 19] = 10;
  buf[offset + 20] = 18;
  buf[offset + 25] = 0x02;
  both16(buf, offset + 28, 1);
  buf[offset + 32] = 1;
  buf[offset + 33] = nameByte;
  return recordLength;
}

function writePathTable(buf, offset, bigEndian) {
  buf[offset] = 1;
  buf[offset + 1] = 0;
  if (bigEndian) buf.writeUInt32BE(ROOT_SECTOR, offset + 2);
  else buf.writeUInt32LE(ROOT_SECTOR, offset + 2);
  if (bigEndian) buf.writeUInt16BE(1, offset + 6);
  else buf.writeUInt16LE(1, offset + 6);
  buf[offset + 8] = 0x00;
  buf[offset + 9] = 0x00;
}

/** 1 MiB ISO 9660 image. The same bytes every call. */
export function hwIsoBytes() {
  const image = Buffer.alloc(HW_ISO_BYTES);
  const pvd = PVD_SECTOR * HW_ISO_SECTOR;
  image[pvd] = 1;
  image.write('CD001', pvd + 1, 'ascii');
  image[pvd + 6] = 1;
  image.fill(0x20, pvd + 8, pvd + 72);
  image.write('PIKVM MCP', pvd + 8, 'ascii');
  image.write('MCPHWTEST', pvd + 40, 'ascii');
  both32(image, pvd + 80, HW_ISO_SECTORS);
  both16(image, pvd + 120, 1);
  both16(image, pvd + 124, 1);
  both16(image, pvd + 128, HW_ISO_SECTOR);
  both32(image, pvd + 132, PATH_TABLE_BYTES);
  image.writeUInt32LE(PATH_L_SECTOR, pvd + 140);
  image.writeUInt32BE(PATH_M_SECTOR, pvd + 148);
  writeDirectoryRecord(image, pvd + 156, ROOT_SECTOR, ROOT_DIR_BYTES, 0x00);
  image.fill(0x20, pvd + 190, pvd + 813);
  image.write('2026101800000000', pvd + 813, 'ascii');
  image.write('2026101800000000', pvd + 830, 'ascii');
  image.write('0000000000000000', pvd + 847, 'ascii');
  image.write('2026101800000000', pvd + 864, 'ascii');
  image[pvd + 881] = 1;

  const term = TERM_SECTOR * HW_ISO_SECTOR;
  image[term] = 0xff;
  image.write('CD001', term + 1, 'ascii');
  image[term + 6] = 1;

  const root = ROOT_SECTOR * HW_ISO_SECTOR;
  const dot = writeDirectoryRecord(image, root, ROOT_SECTOR, ROOT_DIR_BYTES, 0x00);
  writeDirectoryRecord(image, root + dot, ROOT_SECTOR, ROOT_DIR_BYTES, 0x01);
  writePathTable(image, PATH_L_SECTOR * HW_ISO_SECTOR, false);
  writePathTable(image, PATH_M_SECTOR * HW_ISO_SECTOR, true);
  return image;
}

export async function prepareHwImage(dir, name) {
  const dest = join(dir, name);
  const bytes = hwIsoBytes();
  await writeFile(dest, bytes);
  return { path: dest, bytes: bytes.length };
}
