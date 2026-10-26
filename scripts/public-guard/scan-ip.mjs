// Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
//
// Prints "path:line R-ip" or "path:line R-ip6" for private-range hits.
// The address text is not printed. IPv6 (fc00::/7 and fe80::/10) is
// included because every measured hit on this tree is either on an
// allowlisted path or one of the exact documentation tokens.
// Image extensions are skipped here; the image rule reads those files.
// A NUL byte does not skip a text file.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function loadValues(name) {
  const text = readFileSync(join(here, name), 'utf8')
  const values = new Set()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '' || line.startsWith('#')) continue
    values.add(line)
  }
  return values
}

function loadPathPatterns() {
  const text = readFileSync(join(here, 'ip-path-allowlist.txt'), 'utf8')
  const patterns = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '' || line.startsWith('#')) continue
    patterns.push(line)
  }
  return patterns
}

const ipv4Values = loadValues('ip-value-allowlist.txt')
const ipv6Values = loadValues('ip6-value-allowlist.txt')
const pathPatterns = loadPathPatterns()

function pathAllowed(rel) {
  const base = rel.split('/').pop()
  for (const pattern of pathPatterns) {
    if (pattern.endsWith('/')) {
      if (rel.startsWith(pattern)) return true
    } else if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      if (base.endsWith(suffix)) return true
    } else if (rel === pattern) {
      return true
    }
  }
  return false
}

function urlPolicyLines(rel, text) {
  const allowed = new Set()
  if (rel !== 'README.md' && rel !== 'NOTICE') return allowed
  const lines = text.split('\n')
  if (rel === 'README.md') {
    let inSection = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^## /.test(line)) inSection = false
      const bullet = line.match(/^- \*\*`([^`]+)`/)
      if (bullet) {
        inSection = bullet[1] === 'PIKVM_MSD_URL_ALLOWLIST'
          || bullet[1] === 'PIKVM_MSD_URL_ALLOW_PRIVATE'
      }
      if (inSection) allowed.add(i + 1)
    }
    return allowed
  }
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (/^\d{4}-\d{2}, by PLN:\s*$/.test(lines[i])) starts.push(i)
  }
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length
    const chunk = lines.slice(from, to).join('\n')
    if (!chunk.includes('PIKVM_MSD_URL_ALLOWLIST') && !chunk.includes('PIKVM_MSD_URL_ALLOW_PRIVATE')) {
      continue
    }
    for (let i = from; i < to; i++) allowed.add(i + 1)
  }
  return allowed
}

function ipv4Kind(token) {
  const addr = token.split('/')[0]
  const parts = addr.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((part) => Number(part))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  const a = nums[0]
  const b = nums[1]
  if (a === 127) return 'loop'
  if (a === 10) return 'priv'
  if (a === 172 && b >= 16 && b <= 31) return 'priv'
  if (a === 192 && b === 168) return 'priv'
  if (a === 100 && b >= 64 && b <= 127) return 'priv'
  if (a === 169 && b === 254) return 'priv'
  return null
}

function parseV6(token) {
  let addr = token.split('/')[0].toLowerCase()
  const lastColon = addr.lastIndexOf(':')
  if (lastColon !== -1) {
    const tail = addr.slice(lastColon + 1)
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) {
      const p = tail.split('.').map((part) => Number(part))
      if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
      const hi = ((p[0] << 8) | p[1]).toString(16)
      const lo = ((p[2] << 8) | p[3]).toString(16)
      addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`
    }
  }
  const halves = addr.split('::')
  if (halves.length > 2) return null
  const expand = (side) => (side === '' ? [] : side.split(':'))
  let groups
  if (halves.length === 1) {
    groups = expand(halves[0])
    if (groups.length !== 8) return null
  } else {
    const left = expand(halves[0])
    const right = expand(halves[1])
    if (left.length + right.length > 7) return null
    groups = left.concat(Array(8 - left.length - right.length).fill('0'), right)
  }
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) => {
    const value = parseInt(group, 16)
    bytes[index * 2] = value >> 8
    bytes[index * 2 + 1] = value & 0xff
  })
  return bytes
}

function ipv6Kind(token) {
  const bytes = parseV6(token)
  if (!bytes) return null
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'll'
  if ((bytes[0] & 0xfe) === 0xfc) return 'ula'
  return null
}

const ipv4Re = /(?<![0-9A-Za-z])(?<![0-9]\.)(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?(?![0-9A-Za-z])(?!\.[0-9])/g
const imageExt = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.gif', '.webp',
  '.tif', '.tiff', '.heic', '.avif',
])

function isImage(rel) {
  const base = rel.split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return false
  return imageExt.has(base.slice(dot).toLowerCase())
}
const ipv6Re = /(?<![0-9A-Za-z:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F:]*(?:\/\d{1,3})?(?![0-9A-Za-z:])/g

function scanText(rel, text) {
  const hits = []
  if (pathAllowed(rel)) return hits
  const section = urlPolicyLines(rel, text)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    if (section.has(lineNo)) continue
    const line = lines[i]
    for (const match of line.matchAll(ipv4Re)) {
      const token = match[0]
      if (ipv4Values.has(token)) continue
      if (ipv4Kind(token) === 'priv') hits.push(`${rel}:${lineNo} R-ip`)
    }
    for (const match of line.matchAll(ipv6Re)) {
      const token = match[0]
      if (ipv6Values.has(token)) continue
      if (ipv6Kind(token)) hits.push(`${rel}:${lineNo} R-ip6`)
    }
  }
  return hits
}

function readInputs() {
  if (process.argv.length > 2) return process.argv.slice(2)
  const buf = readFileSync(0)
  return buf.toString('utf8').split('\0').filter((item) => item !== '')
}

const hits = []
for (const rel of readInputs()) {
  let buf
  try {
    buf = readFileSync(rel)
  } catch {
    process.stderr.write('address scan: unreadable file\n')
    process.exit(1)
  }
  if (isImage(rel)) continue
  hits.push(...scanText(rel, buf.toString('latin1')))
}
if (hits.length) process.stdout.write(`${hits.join('\n')}\n`)
