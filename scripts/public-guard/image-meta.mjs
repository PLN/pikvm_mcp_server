// Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
//
// Dependency-free image metadata check. Node on a GitHub ubuntu-24.04
// runner already provides this; the job does not install exiftool.
// Values are never printed. A parse failure of JPEG, PNG, GIF, WebP,
// or TIFF fails closed (the process exits, and the file is not skipped).
//
// JPEG (.jpg, .jpeg, .jpe, .jfif): walk markers up to the scan,
// including a second JPEG after EOI. A hit is APP1 Exif (a GPS IFD is
// TIFF tag 0x8825 inside that segment), APP1 XMP, APP13 (marker 0xED,
// IPTC / Photoshop 3.0 / 8BIM), or COM (marker 0xFE). JFIF APP0 and an
// ICC APP2 are not hits.
// PNG: an eXIf chunk, a tEXt chunk, a zTXt chunk, or any iTXt chunk is
// a hit. The keyword is not consulted.
// WebP: walk RIFF chunks. A chunk named EXIF or "XMP " is a hit. The
// EXIF chunk is a hit even when its payload has no Exif prefix.
// GIF: GIF87a / GIF89a is a hit only when the file contains an Exif
// prefix or an XMP packet.
// TIFF (.tif, .tiff): a GPS IFD pointer (tag 0x8825), including one
// reached through the Exif IFD (tag 0x8769), or an XMP tag (0x02BC),
// is a hit.
// HEIC and AVIF: an Exif or XMP box, or those byte sequences inside a
// box, is a hit. A file with one of those extensions that is not a
// complete ISO box stream is a hit, so an unknown image is not skipped.
// Any other extension in the inspected set is a hit for the same reason.

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

const EXIF = Buffer.from('Exif\0\0', 'latin1')
const XAP = Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1')
const XMP_META = Buffer.from('<x:xmpmeta', 'latin1')
const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp',
  '.tif', '.tiff', '.heic', '.avif',
])

function u16(buf, offset, le) {
  return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset)
}

function u32(buf, offset, le) {
  return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset)
}

function magicHit(buf) {
  return buf.includes(EXIF) || buf.includes(XAP) || buf.includes(XMP_META)
}

function tiffFlag(tiff) {
  if (tiff.length < 8) return false
  const endian = tiff.toString('latin1', 0, 2)
  if (endian !== 'II' && endian !== 'MM') return false
  const le = endian === 'II'
  if (u16(tiff, 2, le) !== 42) return false
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
      if (tag === 0x8825 || tag === 0x02bc) return true
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

function exifHasGps(payload) {
  try {
    if (payload.length < 14 || !payload.subarray(0, 6).equals(EXIF)) return false
    return tiffFlag(payload.subarray(6))
  } catch {
    return false
  }
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
      if (exif || exifHasGps(payload) || isXmp(payload)) hit = true
    }
    if (marker === 0xed || marker === 0xfe) hit = true
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

function inspectPng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) throw new Error('not a png')
  let i = 8
  let hit = false
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i)
    if (i + 12 + len > buf.length) throw new Error('png chunk')
    const type = buf.toString('latin1', i + 4, i + 8)
    if (type === 'eXIf' || type === 'tEXt' || type === 'zTXt' || type === 'iTXt') hit = true
    i += 12 + len
    if (type === 'IEND') return hit
  }
  throw new Error('png end')
}

function inspectGif(buf) {
  const sig = buf.toString('latin1', 0, 6)
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('not a gif')
  return magicHit(buf)
}

function inspectWebp(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    throw new Error('not a webp')
  }
  let i = 12
  let hit = false
  while (i + 8 <= buf.length) {
    const four = buf.toString('latin1', i, i + 4)
    const size = buf.readUInt32LE(i + 4)
    const dataStart = i + 8
    if (dataStart + size > buf.length) throw new Error('webp chunk')
    if (four === 'EXIF' || four === 'XMP ') hit = true
    i = dataStart + size
    if ((size % 2) === 1 && i < buf.length) i += 1
  }
  return hit
}

function inspectTiff(buf) {
  if (buf.length < 8) throw new Error('not a tiff')
  const endian = buf.toString('latin1', 0, 2)
  if (endian !== 'II' && endian !== 'MM') throw new Error('not a tiff')
  const le = endian === 'II'
  if (u16(buf, 2, le) !== 42) throw new Error('not a tiff')
  return tiffFlag(buf)
}

function inspectIsoBmff(buf) {
  if (buf.length < 8 || buf.toString('latin1', 4, 8) !== 'ftyp') return true
  let i = 0
  let hit = false
  while (i + 8 <= buf.length) {
    let size = buf.readUInt32BE(i)
    const type = buf.toString('latin1', i + 4, i + 8)
    let header = 8
    if (size === 1) {
      if (i + 16 > buf.length) return true
      const big = buf.readBigUInt64BE(i + 8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return true
      size = Number(big)
      header = 16
    } else if (size === 0) {
      size = buf.length - i
    }
    if (!Number.isInteger(size) || size < header || i + size > buf.length) return true
    if (type === 'Exif' || type === 'exif' || type === 'XMP ' || type === 'xmp ') hit = true
    const payload = buf.subarray(i + header, i + size)
    if (payload.includes(EXIF) || payload.includes(XAP) || payload.includes(XMP_META)) hit = true
    i += size
  }
  if (i !== buf.length) return true
  return hit
}

function inspect(buf, ext) {
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.jpe' || ext === '.jfif') return inspectJpeg(buf)
  if (ext === '.png') return inspectPng(buf)
  if (ext === '.gif') return inspectGif(buf)
  if (ext === '.webp') return inspectWebp(buf)
  if (ext === '.tif' || ext === '.tiff') return inspectTiff(buf)
  if (ext === '.heic' || ext === '.avif') return inspectIsoBmff(buf)
  return true
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
