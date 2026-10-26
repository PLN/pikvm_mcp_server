// Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
// GPL-3.0-only. See LICENSE and NOTICE.
//
// Dependency-free image metadata check. Node on a GitHub ubuntu-24.04
// runner already provides this; the job does not install exiftool.
// JPEG: walk markers up to the scan, including a second JPEG after EOI.
// An APP1 Exif segment (which is where a GPS IFD, TIFF tag 0x8825, lives)
// or an APP1 XMP segment is a hit. JFIF APP0 and an ICC APP2 are not.
// PNG: an eXIf chunk, or an iTXt/tEXt/zTXt keyword XML:com.adobe.xmp, is a hit.
// Other image types: the same Exif and XMP magics anywhere in the file.
// Values are never printed. A parse failure fails closed.

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const EXIF = Buffer.from('Exif\0\0', 'latin1')
const XAP = Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1')
const XMP_META = Buffer.from('<x:xmpmeta', 'latin1')
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff'])

function u16(buf, offset, le) {
  return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset)
}

function u32(buf, offset, le) {
  return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset)
}

function exifHasGps(payload) {
  try {
    return exifHasGpsInner(payload)
  } catch {
    return false
  }
}

function exifHasGpsInner(payload) {
  if (payload.length < 14 || !payload.subarray(0, 6).equals(EXIF)) return false
  const tiff = payload.subarray(6)
  const endian = tiff.toString('latin1', 0, 2)
  if (endian !== 'II' && endian !== 'MM') return false
  const le = endian === 'II'
  if (tiff.length < 8) return false
  const seen = new Set()
  function walk(offset, depth) {
    if (depth > 8 || seen.has(offset)) return false
    if (offset < 0 || offset + 2 > tiff.length) return false
    seen.add(offset)
    const count = u16(tiff, offset, le)
    if (offset + 2 + count * 12 + 4 > tiff.length) return false
    for (let k = 0; k < count; k++) {
      const entry = offset + 2 + k * 12
      const tag = u16(tiff, entry, le)
      if (tag === 0x8825) return true
      if (tag === 0x8769) {
        const pointer = u32(tiff, entry + 8, le)
        if (walk(pointer, depth + 1)) return true
      }
    }
    const next = u32(tiff, offset + 2 + count * 12, le)
    if (next !== 0 && walk(next, depth + 1)) return true
    return false
  }
  return walk(u32(tiff, 4, le), 0)
}

function isXmp(payload) {
  const head = payload.subarray(0, Math.min(payload.length, 80))
  return head.includes(XAP) || head.includes(XMP_META)
}

function jpegHits(buf, start) {
  if (start + 2 > buf.length || buf[start] !== 0xff || buf[start + 1] !== 0xd8) {
    throw new Error('not a jpeg')
  }
  let i = start + 2
  let hit = false
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) throw new Error('jpeg marker')
    while (i < buf.length && buf[i] === 0xff) i++
    if (i >= buf.length) throw new Error('jpeg marker')
    const marker = buf[i++]
    if (marker === 0xd9) return { hit, next: i }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (i + 2 > buf.length) throw new Error('jpeg length')
    const len = buf.readUInt16BE(i)
    if (len < 2 || i + len > buf.length) throw new Error('jpeg length')
    const payload = buf.subarray(i + 2, i + len)
    if (marker === 0xe1) {
      const exif = payload.length >= 6 && payload.subarray(0, 6).equals(EXIF)
      const gps = exifHasGps(payload)
      if (exif || gps || isXmp(payload)) hit = true
    }
    i += len
    if (marker === 0xda) {
      while (i + 1 < buf.length) {
        if (buf[i] !== 0xff) {
          i++
          continue
        }
        const next = buf[i + 1]
        if (next === 0x00) {
          i += 2
          continue
        }
        if (next === 0xd9) return { hit, next: i + 2 }
        if (next >= 0xd0 && next <= 0xd7) {
          i += 2
          continue
        }
        break
      }
      throw new Error('jpeg scan')
    }
  }
  throw new Error('jpeg end')
}

function inspectJpeg(buf) {
  let hit = false
  let offset = 0
  let guard = 0
  while (offset + 1 < buf.length && guard < 8) {
    if (buf[offset] !== 0xff || buf[offset + 1] !== 0xd8) break
    const parsed = jpegHits(buf, offset)
    if (parsed.hit) hit = true
    offset = parsed.next
    guard++
    if (offset < buf.length && buf[offset] === 0xff && buf[offset + 1] === 0xd8) continue
    break
  }
  if (offset === 0) throw new Error('not a jpeg')
  return hit
}

function keywordOf(chunk) {
  const end = chunk.indexOf(0)
  const slice = end === -1 ? chunk : chunk.subarray(0, end)
  return slice.toString('latin1')
}

function inspectPng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) throw new Error('not a png')
  let i = 8
  let hit = false
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    if (i + 12 + len > buf.length) throw new Error('png chunk')
    const type = buf.toString('latin1', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'eXIf') hit = true
    if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      if (keywordOf(data) === 'XML:com.adobe.xmp') hit = true
    }
    i += 12 + len
    if (type === 'IEND') return hit
  }
  throw new Error('png end')
}

function magicHit(buf) {
  return buf.includes(EXIF) || buf.includes(XAP) || buf.includes(XMP_META)
}

function inspect(buf, ext) {
  if (ext === '.jpg' || ext === '.jpeg') return inspectJpeg(buf)
  if (ext === '.png') return inspectPng(buf)
  return magicHit(buf)
}

function readInputs() {
  if (process.argv.length > 2) return process.argv.slice(2)
  return readFileSync(0).toString('utf8').split('\0').filter((item) => item !== '')
}

const hits = []
for (const file of readInputs()) {
  const ext = extname(file).toLowerCase()
  if (!IMAGE_EXT.has(ext)) continue
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    process.stderr.write('image: unreadable\n')
    process.exit(1)
  }
  try {
    if (inspect(buf, ext)) hits.push(`${file}:1 R-image`)
  } catch {
    process.stderr.write('image: unreadable\n')
    process.exit(1)
  }
}
if (hits.length) process.stdout.write(`${hits.join('\n')}\n`)
