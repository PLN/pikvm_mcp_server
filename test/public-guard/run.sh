#!/usr/bin/env bash
# Modified 2026-10 by PLN: public-file privacy guard tests (GPL-3.0; see NOTICE).
# Violating strings are built at runtime. This file is also excluded by
# the guard so a fixture cannot hide a hit in the tracked tree.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
GUARD=$ROOT/scripts/check-public.sh
DECIDE=$ROOT/scripts/public-guard/decide-skip.sh
PLN_MAIL='78331+PLN@users.noreply.github.com'
PLN_BARE='PLN@users.noreply.github.com'
PASS=0
FAIL=0
OUT=
RC=0
tmps=()

cleanup() {
  local tmp
  for tmp in "${tmps[@]+"${tmps[@]}"}"; do
    rm -rf "$tmp"
  done
}
trap cleanup EXIT

record() {
  local name=$1
  local ok=$2
  if [[ $ok -eq 1 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL %s\nrc=%s\n%s\n---\n' "$name" "$RC" "$OUT" >&2
  fi
}

want() {
  local name=$1
  local want_rc=$2
  local rule=$3
  local ban=$4
  local ok=1
  if [[ $RC -ne $want_rc ]]; then
    ok=0
  fi
  if [[ $rule != - ]] && ! grep -q -E "(^|[[:space:]])${rule}$" <<< "$OUT"; then
    ok=0
  fi
  if [[ $ban != - ]] && grep -q -F -e "$ban" <<< "$OUT"; then
    ok=0
  fi
  record "$name" "$ok"
}

g_run() {
  local dir=$1
  shift
  set +e
  OUT=$(
    cd "$dir" && env \
      -u PUBLIC_DENYLIST \
      -u PUBLIC_DENYLIST_FILE \
      -u PUBLIC_GUARD_EVENT \
      -u PUBLIC_GUARD_RANGE \
      -u PUBLIC_GUARD_BASE \
      -u PUBLIC_GUARD_HEAD \
      -u PUBLIC_GUARD_BEFORE \
      -u PUBLIC_GUARD_SHA \
      -u PUBLIC_GUARD_PR_TITLE \
      -u PUBLIC_GUARD_PR_BODY \
      -u PUBLIC_GUARD_PR_AUTHOR \
      -u PUBLIC_GUARD_SKIP_DENYLIST \
      -u PUBLIC_GUARD_SKIP_REASON \
      -u EVENT_JSON \
      -u EVENT_NAME \
      -u GIT_SHA \
      -u GITHUB_ACTIONS \
      -u GITHUB_EVENT_PATH \
      -u PUBLIC_GUARD_EVENT_PATH \
      "$@" bash "$GUARD" 2>&1
  )
  RC=$?
  set -e
}

new_repo() {
  local dir
  dir=$(mktemp -d)
  tmps+=("$dir")
  git init -q -b main "$dir"
  git -C "$dir" config user.name PLN
  git -C "$dir" config user.email "$PLN_MAIL"
  git -C "$dir" config commit.gpgsign false
  git -C "$dir" config core.hooksPath /dev/null
  printf 'ok\n' > "$dir/keep.txt"
  git -C "$dir" add keep.txt
  git -C "$dir" -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit --no-gpg-sign -q -m seed
  printf '%s\n' "$dir"
}

commit_tree() {
  local dir=$1
  local name=${2:-PLN}
  local email=${3:-$PLN_MAIL}
  local message=${4:-note}
  git -C "$dir" add -A
  git -C "$dir" -c user.name="$name" -c user.email="$email" \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit --no-gpg-sign -q -m "$message"
}

commit_file() {
  local dir=$1
  local name=$2
  local email=$3
  local file=$4
  git -C "$dir" -c user.name="$name" -c user.email="$email" \
    -c commit.gpgsign=false -c core.hooksPath=/dev/null \
    commit --no-gpg-sign --allow-empty -q -F "$file"
}

tip() {
  git -C "$1" rev-parse HEAD
}

co_prefix=$(printf '%s%s' 'Co-authored-' 'by:')
bot_name=$(printf '%s' 'dependabot' '[bot]')
bot_mail=$(printf '%s%s%s' '49699333+' "$bot_name" '@users.noreply.github.com')
support=$(printf '%s%s' 'support@' 'github.com')
v4bad=$(printf '%s%s' '10.9.8.' '7')
v4other=$(printf '%s%s' '192.168.4.' '4')
v6bad=$(printf '%s%s' 'fd12:3456:' ':abcd')
bc_bad=$(printf '%s%s' 'bc-' 'abc123')
home_bad=$(printf '%s%s' '/home/' 'alice')
users_bad=$(printf '%s%s' '/Users/' 'alice')
mail_bad=$(printf '%s%s' 'pat@' 'example.com')
host_bad=$(printf '%s%s' 'lab' '.ts.net')
tok_ghp=$(printf '%s%s%s' 'gh' 'p_' 'zzzzzzzz')
tok_gho=$(printf '%s%s%s' 'gh' 'o_' 'zzzzzzzz')
tok_ghs=$(printf '%s%s%s' 'gh' 's_' 'zzzzzzzz')
tok_ghu=$(printf '%s%s%s' 'gh' 'u_' 'zzzzzzzz')
tok_ghr=$(printf '%s%s%s' 'gh' 'r_' 'zzzzzzzz')
tok_pat=$(printf '%s%s%s' 'github_' 'pat_' 'zzzzzzzz')
tok_ts=$(printf '%s%s%s' 'ts' 'key-' 'zzzzzzzz')
key_begin=$(printf '%s' '-----BEGIN ')
key_kind=$(printf '%s' 'RSA PRIVATE KEY-----')
key_pkcs=$(printf '%s%s' 'PRIVATE ' 'KEY-----')
key_ssh=$(printf '%s%s' 'OPENSSH ' 'PRIVATE KEY-----')
key_enc=$(printf '%s%s' 'ENCRYPTED ' 'PRIVATE KEY-----')
deny_word=$(printf '%s%s' 'ZQDENY' 'TOKEN')
co_lower=$(printf '%s%s' 'co-authored-' 'by:')
v4end=$(printf '%s%s' '10.0.0.' '5')
v4sent=$(printf '%s%s' '192.168.1.' '5')

# --- clean tree ---
dir=$(new_repo)
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'clean tree passes' 0 - -

# --- generic rules ---
dir=$(new_repo)
printf '%s\n' "$mail_bad" > "$dir/n.txt"
printf '%s\n' 'ada@images.example' > "$dir/ok-mail.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'email fails and example address is absent from the hit' 1 R-email "$mail_bad"
if grep -q -F 'ok-mail.txt' <<< "$OUT"; then
  record 'example address was flagged' 0
else
  record 'example address passes' 1
fi

dir=$(new_repo)
printf '%s\n' "$PLN_BARE" "$PLN_MAIL" 'noreply@github.com' > "$dir/ok-mail.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'noreply forms pass' 0 - -

dir=$(new_repo)
evil_mail=$(printf '%s%s' 'x@evil.example.' 'attacker.org')
ok_com=$(printf '%s%s' 'a@cdn.' 'example.com')
ok_net=$(printf '%s%s' 'a@cdn.' 'example.net')
ok_org=$(printf '%s%s' 'a@cdn.' 'example.org')
printf '%s\n' "$evil_mail" > "$dir/n.txt"
printf '%s\n' "$ok_com" "$ok_net" "$ok_org" 'ada@images.example' > "$dir/ok-mail.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'narrow example domains reject a nested label' 1 R-email "$evil_mail"
ok=1
if grep -q -F 'ok-mail.txt' <<< "$OUT"; then
  ok=0
fi
record 'documented example suffixes pass' "$ok"

dir=$(new_repo)
printf '%s\n' "see ${bc_bad} here" > "$dir/n.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'bc id fails' 1 R-bc "$bc_bad"

dir=$(new_repo)
{
  printf '%s\n' 'subject' ''
  printf '%s PLN <%s>\n' "$co_prefix" "$PLN_MAIL"
} > "$dir/msg.txt"
commit_file "$dir" PLN "$PLN_MAIL" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'PLN coauthor digits form passes' 0 - -

dir=$(new_repo)
{
  printf '%s\n' 'subject' ''
  printf '%s PLN <%s>\n' "$co_prefix" "$PLN_BARE"
} > "$dir/msg.txt"
commit_file "$dir" PLN "$PLN_MAIL" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'PLN coauthor bare form passes' 0 - -

dir=$(new_repo)
{
  printf '%s Pat <%s>\n' "$co_prefix" "$mail_bad"
} > "$dir/msg.txt"
commit_file "$dir" PLN "$PLN_MAIL" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'other coauthor fails' 1 R-coauthor 'Pat'

dir=$(new_repo)
{
  printf '%s\n' 'subject' ''
  printf '%s PLN <%s>\n' "$co_lower" "$PLN_MAIL"
} > "$dir/msg.txt"
commit_file "$dir" PLN "$PLN_MAIL" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'lowercase PLN coauthor passes' 0 - -

dir=$(new_repo)
{
  printf '%s\n' 'subject' ''
  printf '%s Pat <%s>\n' "$co_lower" "$mail_bad"
} > "$dir/msg.txt"
commit_file "$dir" PLN "$PLN_MAIL" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'lowercase other coauthor fails' 1 R-coauthor 'Pat'

dir=$(new_repo)
printf '%s\n' "host ${host_bad}" > "$dir/n.txt"
printf '%s\n' 'use pikvm.example.ts.net' > "$dir/ok-host.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'ts.net fails and the match is omitted' 1 R-tsnet "$host_bad"
if grep -q -F 'ok-host.txt' <<< "$OUT"; then
  record 'example.ts.net was flagged' 0
else
  record 'example.ts.net passes' 1
fi

dir=$(new_repo)
mkdir -p "$dir/docs" "$dir/test" "$dir/src"
printf '%s\n' "$v4bad" > "$dir/docs/bad.md"
printf '%s\n' '172.17.0.1' > "$dir/docs/docker.md"
printf '%s\n' '100.64.0.8' > "$dir/docs/registry.md"
printf '%s\n' '100.64.0.0/10' > "$dir/docs/cidr.md"
printf '%s\n' '127.0.0.1' > "$dir/docs/loop.md"
printf '%s\n' "$v4bad" > "$dir/test/case.mjs"
printf '%s\n' "$v4bad" > "$dir/src/url-policy.ts"
printf '%s\n' "$v4bad" > "$dir/notes.example"
printf '%s\n' "$v4bad" > "$dir/.env.example"
tick=$(printf '\140')
{
  printf '%s\n' '# readme'
  printf '%s\n' "- **${tick}PIKVM_MSD_URL_ALLOWLIST${tick}** — ${v4other}"
  printf '%s\n' '  still the bullet'
  printf '%s\n' "- **${tick}PIKVM_MCP_PORT${tick}** — ${v4bad}"
} > "$dir/README.md"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'private address in docs fails' 1 R-ip "$v4bad"
ok=1
for skip in docs/docker.md docs/registry.md docs/cidr.md docs/loop.md test/case.mjs src/url-policy.ts notes.example .env.example 'README.md:2'; do
  if grep -q -F "$skip" <<< "$OUT"; then
    ok=0
  fi
done
if ! grep -q -F 'README.md:4 R-ip' <<< "$OUT"; then
  ok=0
fi
if ! grep -q -F 'docs/bad.md' <<< "$OUT"; then
  ok=0
fi
record 'path and value allowlists' "$ok"

dir=$(new_repo)
{
  printf 'The host is %s.\n' "$v4sent"
  printf 'try %s. then\n' "$v4end"
  printf '%s...\n' "$v4end"
} > "$dir/end.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'private address before a period fails' 1 R-ip "$v4sent"
ok=1
if ! grep -q -F 'end.txt:1 R-ip' <<< "$OUT"; then ok=0; fi
if ! grep -q -F 'end.txt:2 R-ip' <<< "$OUT"; then ok=0; fi
if ! grep -q -F 'end.txt:3 R-ip' <<< "$OUT"; then ok=0; fi
if grep -q -F "$v4end" <<< "$OUT" || grep -q -F "$v4sent" <<< "$OUT"; then ok=0; fi
record 'sentence-end addresses are hits and omitted' "$ok"

dir=$(new_repo)
{
  printf 'v%s\n' "$v4end"
  printf '%s\n' '1.2.3.4.5'
  printf '%s.1\n' "$v4end"
  printf '%s%s\n' '1.10.0.5.' '2'
} > "$dir/skip.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'dotted neighbours are not private addresses' 0 - "$v4end"

dir=$(new_repo)
mkdir -p "$dir/docs" "$dir/test"
printf '%s\n' "$v6bad" > "$dir/docs/bad.md"
printf '%s\n' 'fe80::/10' > "$dir/docs/link.md"
printf '%s\n' "$v6bad" > "$dir/test/case.mjs"
tick=$(printf '\140')
{
  printf '%s\n' '# readme'
  printf '%s\n' "- **${tick}PIKVM_MSD_URL_ALLOW_PRIVATE${tick}** — ${v6bad}"
  printf '%s\n' "- **${tick}PIKVM_MCP_PORT${tick}** — ${v6bad}"
} > "$dir/README.md"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'ipv6 outside the allowlist fails' 1 R-ip6 "$v6bad"
ok=1
for skip in docs/link.md test/case.mjs 'README.md:2'; do
  if grep -q -F "$skip" <<< "$OUT"; then
    ok=0
  fi
done
if ! grep -q -F 'README.md:3 R-ip6' <<< "$OUT"; then
  ok=0
fi
record 'ipv6 path and value allowlists' "$ok"

dir=$(new_repo)
printf '%s\n' "path ${home_bad} and ${users_bad}" > "$dir/n.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'home paths fail' 1 R-home "$home_bad"

dir=$(new_repo)
{
  printf '%s\n' "$tok_ghp"
  printf '%s\n' "$tok_gho"
  printf '%s\n' "$tok_ghs"
  printf '%s\n' "$tok_ghu"
  printf '%s\n' "$tok_ghr"
  printf '%s\n' "$tok_pat"
  printf '%s\n' "$tok_ts"
  printf '%s%s\n' "$key_begin" "$key_kind"
  printf '%s%s\n' "$key_begin" "$key_pkcs"
  printf '%s%s\n' "$key_begin" "$key_ssh"
  printf '%s%s\n' "$key_begin" "$key_enc"
} > "$dir/n.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'secret shapes fail and are omitted' 1 R-secret "$tok_ghp"
ok=1
for ban in "$tok_gho" "$tok_ghs" "$tok_ghu" "$tok_ghr" "$tok_pat" "$tok_ts" "$key_pkcs" "$key_ssh" "$key_enc"; do
  if grep -q -F "$ban" <<< "$OUT"; then
    ok=0
  fi
done
if [[ $(grep -c 'R-secret$' <<< "$OUT" || true) -ne 11 ]]; then
  ok=0
fi
record 'every secret shape is flagged' "$ok"

dir=$(new_repo)
name=$(printf '%s%s' 'pkg' "${home_bad}.txt")
mkdir -p "$dir/$(dirname "$name")"
printf 'ok\n' > "$dir/$name"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'file name fails the home rule' 1 R-home -

dir=$(new_repo)
printf 'xx \377 yy %s\n' "$bc_bad" > "$dir/odd.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'invalid byte still matches a bc id' 1 R-bc "$bc_bad"

dir=$(new_repo)
printf 'aa \000 bb %s\n' "$v4bad" > "$dir/nul.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'nul byte still matches a private address' 1 R-ip "$v4bad"

# --- images ---
dir=$(new_repo)
node --input-type=module - "$dir" <<'END'
import { writeFileSync } from 'node:fs'
const clean = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb0043000201010101010201010102020202020403020202020504040304060506060605060606070908060709070606080b08090a0a0a0a0a06080b0c0b0a0c090a0a0affdb004301020202020202050303050a0706070a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0affc00011080001000103012200021101031101ffc4001500010100000000000000000000000000000008ffc40014100100000000000000000000000000000000ffc4001501010100000000000000000000000000000809ffc40014110100000000000000000000000000000000ffda000c03010002110311003f008bc014d7f1ffd9',
  'hex',
)
const tiff = Buffer.alloc(44)
tiff.write('II', 0, 'latin1')
tiff.writeUInt16LE(42, 2)
tiff.writeUInt32LE(8, 4)
tiff.writeUInt16LE(1, 8)
tiff.writeUInt16LE(0x8825, 10)
tiff.writeUInt16LE(4, 12)
tiff.writeUInt32LE(1, 14)
tiff.writeUInt32LE(26, 18)
tiff.writeUInt32LE(0, 22)
tiff.writeUInt16LE(1, 26)
tiff.writeUInt16LE(0, 28)
tiff.writeUInt16LE(1, 30)
tiff.writeUInt32LE(4, 32)
tiff.writeUInt8(2, 36)
tiff.writeUInt8(2, 37)
tiff.writeUInt32LE(0, 40)
const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
const seg = Buffer.alloc(4 + body.length)
seg[0] = 0xff
seg[1] = 0xe1
seg.writeUInt16BE(2 + body.length, 2)
body.copy(seg, 4)
const bad = Buffer.concat([clean.subarray(0, 2), seg, clean.subarray(2)])
if (!bad.includes(Buffer.from([0x25, 0x88]))) {
  process.stderr.write('fixture is missing a GPS IFD tag\n')
  process.exit(1)
}
if (clean.includes(Buffer.from('Exif\0\0', 'latin1'))) {
  process.stderr.write('clean fixture contains exif\n')
  process.exit(1)
}
writeFileSync(`${process.argv[2]}/clean.jpg`, clean)
writeFileSync(`${process.argv[2]}/gps.jpg`, bad)
END
set +e
direct=$(node "$ROOT/scripts/public-guard/image-meta.mjs" "$dir/clean.jpg" "$dir/gps.jpg" 2>&1)
direct_rc=$?
set -e
OUT=$direct
RC=0
if [[ $direct_rc -ne 0 ]]; then
  RC=1
fi
if ! grep -q -F 'gps.jpg:1 R-image' <<< "$direct"; then
  RC=1
fi
if grep -q -F 'clean.jpg' <<< "$direct"; then
  RC=1
fi
want 'image parser flags the GPS fixture only' 0 R-image -
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'guard flags the GPS image and passes the stripped one' 1 R-image -
if grep -q -F 'clean.jpg' <<< "$OUT"; then
  record 'stripped image was flagged' 0
else
  record 'stripped image passes' 1
fi

dir=$(new_repo)
node --input-type=module - "$dir" <<'END'
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const dir = process.argv[2]
const cleanJpeg = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb0043000201010101010201010102020202020403020202020504040304060506060605060606070908060709070606080b08090a0a0a0a0a06080b0c0b0a0c090a0a0affdb004301020202020202050303050a0706070a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0affc00011080001000103012200021101031101ffc4001500010100000000000000000000000000000008ffc40014100100000000000000000000000000000000ffc4001501010100000000000000000000000000000809ffc40014110100000000000000000000000000000000ffda000c03010002110311003f008bc014d7f1ffd9',
  'hex',
)

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const sum = Buffer.alloc(4)
  sum.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, sum])
}

function png(extra) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  const idat = deflateSync(Buffer.from([0, 0]))
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    ...extra,
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function segment(marker, payload) {
  const seg = Buffer.alloc(4 + payload.length)
  seg[0] = 0xff
  seg[1] = marker
  seg.writeUInt16BE(2 + payload.length, 2)
  payload.copy(seg, 4)
  return Buffer.concat([cleanJpeg.subarray(0, 2), seg, cleanJpeg.subarray(2)])
}

function webp(fourcc, payload) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2))
  chunk.write(fourcc, 0, 4, 'latin1')
  chunk.writeUInt32LE(payload.length, 4)
  payload.copy(chunk, 8)
  const file = Buffer.alloc(12 + chunk.length)
  file.write('RIFF', 0, 'latin1')
  file.writeUInt32LE(4 + chunk.length, 4)
  file.write('WEBP', 8, 'latin1')
  chunk.copy(file, 12)
  return file
}

function tiff(tag) {
  const buf = Buffer.alloc(26)
  buf.write('II', 0, 'latin1')
  buf.writeUInt16LE(42, 2)
  buf.writeUInt32LE(8, 4)
  buf.writeUInt16LE(1, 8)
  buf.writeUInt16LE(tag, 10)
  buf.writeUInt16LE(3, 12)
  buf.writeUInt32LE(1, 14)
  buf.writeUInt16LE(1, 18)
  buf.writeUInt32LE(0, 22)
  return buf
}

function box(type, payload) {
  const buf = Buffer.alloc(8 + payload.length)
  buf.writeUInt32BE(8 + payload.length, 0)
  buf.write(type, 4, 4, 'latin1')
  payload.copy(buf, 8)
  return buf
}

const exifMagic = Buffer.from('Exif\0\0', 'latin1')
const app13 = segment(0xed, Buffer.from('8BIM', 'latin1'))
const com = segment(0xfe, Buffer.from('note', 'latin1'))
const exifWebp = webp('EXIF', Buffer.from('zzzz', 'latin1'))
const xmpWebp = webp('XMP ', Buffer.from('zzzz', 'latin1'))
const cleanWebp = webp('VP8 ', Buffer.from('zzzz', 'latin1'))
const brand = Buffer.alloc(8)
brand.write('heic', 0, 'latin1')
const cleanHeic = box('ftyp', brand)
const metaHeic = Buffer.concat([cleanHeic, box('Exif', Buffer.from('zzzz', 'latin1'))])
const avifBrand = Buffer.alloc(8)
avifBrand.write('avif', 0, 'latin1')
const metaAvif = Buffer.concat([box('ftyp', avifBrand), box('XMP ', Buffer.from('zzzz', 'latin1'))])
const files = {
  'clean.png': png([]),
  'text.png': png([pngChunk('tEXt', Buffer.from('Comment\0hi', 'latin1'))]),
  'ztxt.png': png([pngChunk('zTXt', Buffer.from('Comment\0\0hi', 'latin1'))]),
  'itxt.png': png([pngChunk('iTXt', Buffer.from('Comment\0\0\0\0\0hi', 'latin1'))]),
  'exif.png': png([pngChunk('eXIf', Buffer.from('abcd', 'latin1'))]),
  'clean.gif': Buffer.from('4749463839610100010000000021f90401000000002c00000000010001000002024c01003b', 'hex'),
  'clean.tif': tiff(0x0100),
  'clean.tiff': tiff(0x0100),
  'gps.tif': tiff(0x8825),
  'clean.webp': cleanWebp,
  'exif.webp': exifWebp,
  'xmp.webp': xmpWebp,
  'app13.jpg': app13,
  'com.jpg': com,
  'clean.jfif': cleanJpeg,
  'gps.jpe': segment(0xe1, Buffer.concat([exifMagic, tiff(0x8825)])),
  'clean.heic': cleanHeic,
  'meta.heic': metaHeic,
  'meta.avif': metaAvif,
  'junk.heic': Buffer.from('notanimage!!', 'latin1'),
}
for (const [name, buf] of Object.entries(files)) {
  if (name !== 'gps.jpe' && buf.includes(exifMagic)) {
    process.stderr.write('fixture carries an exif prefix\n')
    process.exit(1)
  }
  writeFileSync(`${dir}/${name}`, buf)
}
if (!files['gps.tif'].includes(Buffer.from([0x25, 0x88]))) {
  process.stderr.write('tiff fixture is missing a GPS IFD tag\n')
  process.exit(1)
}
END

meta=$ROOT/scripts/public-guard/image-meta.mjs
set +e
direct=$(node "$meta" \
  "$dir/clean.png" "$dir/text.png" "$dir/ztxt.png" "$dir/itxt.png" "$dir/exif.png" \
  "$dir/clean.gif" "$dir/clean.tif" "$dir/clean.tiff" "$dir/gps.tif" \
  "$dir/clean.webp" "$dir/exif.webp" "$dir/xmp.webp" \
  "$dir/app13.jpg" "$dir/com.jpg" "$dir/clean.jfif" "$dir/gps.jpe" \
  "$dir/clean.heic" "$dir/meta.heic" "$dir/meta.avif" "$dir/junk.heic" \
  "$ROOT/assets/simple_setup.jpg" "$ROOT/test/fixtures/ocr-hello.png" 2>&1)
direct_rc=$?
set -e
OUT=$direct
RC=0
if [[ $direct_rc -ne 0 ]]; then
  RC=1
fi
ok=1
for hit in text.png ztxt.png itxt.png exif.png gps.tif exif.webp xmp.webp app13.jpg com.jpg gps.jpe meta.heic meta.avif junk.heic; do
  if ! grep -q -F "$hit:1 R-image" <<< "$direct"; then
    ok=0
  fi
done
for clean in clean.png clean.gif clean.tif clean.tiff clean.webp clean.jfif clean.heic simple_setup.jpg ocr-hello.png; do
  if grep -q -F "$clean" <<< "$direct"; then
    ok=0
  fi
done
if [[ $ok -eq 0 ]]; then
  RC=1
fi
want 'image metadata fixtures match the reader' 0 R-image -
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST='a^'
want 'guard flags the new metadata fixtures' 1 R-image -
ok=1
for hit in text.png ztxt.png itxt.png exif.png gps.tif exif.webp xmp.webp app13.jpg com.jpg gps.jpe meta.heic meta.avif junk.heic; do
  if ! grep -q -F "$hit:1 R-image" <<< "$OUT"; then
    ok=0
  fi
done
for clean in clean.png clean.gif clean.tif clean.tiff clean.webp clean.jfif clean.heic; do
  if grep -q -F "$clean" <<< "$OUT"; then
    ok=0
  fi
done
record 'clean image fixtures pass the guard' "$ok"

# --- identity ---
dir=$(new_repo)
commit_file "$dir" PLN "$PLN_BARE" <(printf 'web\n')
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'bare PLN address passes identity' 0 - -

dir=$(new_repo)
commit_file "$dir" PLN "$PLN_MAIL" <(printf 'digits\n')
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'numeric PLN address passes identity' 0 - -

dir=$(new_repo)
commit_file "$dir" GitHub 'noreply@github.com' <(printf 'web flow\n')
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'web flow identity passes' 0 - -

other_name=$(printf '%s' 'Other')
other_mail=$(printf '%s%s%s' '12345+' 'Other@' 'users.noreply.github.com')
dir=$(new_repo)
commit_file "$dir" "$other_name" "$other_mail" <(printf 'nope\n')
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'another noreply username fails identity' 1 R-identity "$other_name"

person=$(printf '%s' 'Ada')
person_mail=$(printf '%s%s' 'ada@' 'example.com')
dir=$(new_repo)
commit_file "$dir" "$person" "$person_mail" <(printf 'nope\n')
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'another person fails identity' 1 R-identity "$person"

dir=$(new_repo)
real_name=$(printf '%s %s' 'Real' 'Name')
commit_file "$dir" "$real_name" "$PLN_MAIL" <(printf 'note\n')
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'a real name with the PLN address fails identity' 1 R-identity "$real_name"

# --- dependabot exemption ---
dir=$(new_repo)
{
  printf '%s\n' 'Bump dep' ''
  printf 'Signed-off-by: %s <%s>\n' "$bot_name" "$support"
  printf '%s %s <%s>\n' "$co_prefix" "$bot_name" "$bot_mail"
} > "$dir/msg.txt"
commit_file "$dir" "$bot_name" "$bot_mail" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'dependabot identity and exact trailers pass' 0 - -

dir=$(new_repo)
{
  printf '%s %s\n' 'host' "$host_bad"
  printf '%s %s <%s>\n' "$co_prefix" "$bot_name" "$bot_mail"
} > "$dir/msg.txt"
commit_file "$dir" "$bot_name" "$bot_mail" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'dependabot commit with ts.net still fails' 1 R-tsnet "$host_bad"

dir=$(new_repo)
{
  printf '%s %s\n' 'addr' "$v4bad"
} > "$dir/msg.txt"
commit_file "$dir" "$bot_name" "$bot_mail" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'dependabot commit with a private address still fails' 1 R-ip "$v4bad"

dir=$(new_repo)
{
  printf '%s %s\n' 'id' "$bc_bad"
} > "$dir/msg.txt"
commit_file "$dir" "$bot_name" "$bot_mail" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'dependabot commit with a bc id still fails' 1 R-bc "$bc_bad"

dir=$(new_repo)
{
  printf '%s\n' 'Bump' ''
  printf '%s Pat <%s>\n' "$co_prefix" "$mail_bad"
} > "$dir/msg.txt"
commit_file "$dir" "$bot_name" "$bot_mail" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'dependabot commit with another coauthor still fails' 1 R-coauthor 'Pat'

dir=$(new_repo)
extra=$(printf '%s%s' 'person@' 'example.com')
commit_file "$dir" "$bot_name" "$bot_mail" <(printf 'mail %s\n' "$extra")
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'dependabot commit relaxes only the email rule' 0 - "$extra"

dir=$(new_repo)
{
  printf 'note\n\n'
  printf 'Signed-off-by: %s <%s>\n' "$bot_name" "$support"
} > "$dir/msg.txt"
commit_file "$dir" PLN "$PLN_MAIL" "$dir/msg.txt"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'exact dependabot signed-off-by passes on a human commit' 0 - "$support"

dir=$(new_repo)
commit_file "$dir" PLN "$PLN_MAIL" <(printf 'mail %s\n' "$support")
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_RANGE="$sha"
want 'support address outside the signed-off-by line fails' 1 R-email "$support"

# --- bounded range ---
dir=$(new_repo)
base=$(tip "$dir")
commit_file "$dir" "$person" "$person_mail" <(printf 'old %s\n' "$bc_bad")
old=$(tip "$dir")
commit_file "$dir" PLN "$PLN_MAIL" <(printf 'new\n')
head=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT=pull_request \
  PUBLIC_GUARD_BASE="$old" PUBLIC_GUARD_HEAD="$head"
want 'pull_request range skips the parent commit' 0 - "$bc_bad"
if grep -q -F "commit ${old}" <<< "$OUT"; then
  record 'parent commit was checked' 0
else
  record 'parent commit was not checked' 1
fi

g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT=pull_request \
  PUBLIC_GUARD_BASE="$base" PUBLIC_GUARD_HEAD="$head"
want 'pull_request range includes the commits after base' 1 R-identity "$person"

g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT=push \
  PUBLIC_GUARD_BEFORE="$old" PUBLIC_GUARD_SHA="$head"
want 'push range checks only the new commit' 0 - "$bc_bad"

zeros=$(printf '%.40d' 0)
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT=push \
  PUBLIC_GUARD_BEFORE="$zeros" PUBLIC_GUARD_SHA="$head"
want 'all-zero before checks only the tip' 0 - "$bc_bad"

missing=$(printf '%.40s' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT=push \
  PUBLIC_GUARD_BEFORE="$missing" PUBLIC_GUARD_SHA="$head"
want 'missing before checks only the tip' 0 - "$bc_bad"

g_run "$dir" PUBLIC_DENYLIST='a^'
want 'no range does not read older commits' 0 - "$bc_bad"

dir=$(new_repo)
g_run "$dir" GITHUB_ACTIONS=true PUBLIC_DENYLIST='a^'
want 'actions with no event fails the range rule' 1 R-range -
if grep -q -F 'range R-range' <<< "$OUT"; then
  record 'missing range prints the rule id' 1
else
  record 'missing range prints the rule id' 0
fi

dir=$(new_repo)
sha=$(tip "$dir")
g_run "$dir" GITHUB_ACTIONS=true PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT=push PUBLIC_GUARD_SHA="$sha"
want 'actions push range is not the missing-range rule' 0 - -
if grep -q -F 'R-range' <<< "$OUT"; then
  record 'a resolved range stays quiet' 0
else
  record 'a resolved range stays quiet' 1
fi

# --- denylist ---
dir=$(new_repo)
g_run "$dir"
want 'missing denylist fails' 1 - -
if grep -q -F 'denylist: missing or empty' <<< "$OUT"; then
  record 'missing denylist message' 1
else
  record 'missing denylist message' 0
fi

dir=$(new_repo)
g_run "$dir" PUBLIC_DENYLIST=$'\n\r\n'
want 'blank denylist fails' 1 - -
if grep -q -F 'denylist: missing or empty' <<< "$OUT"; then
  record 'blank denylist message' 1
else
  record 'blank denylist message' 0
fi

blank=$(mktemp)
tmps+=("$blank")
printf '\n\n' > "$blank"
dir=$(new_repo)
g_run "$dir" PUBLIC_DENYLIST_FILE="$blank"
want 'blank denylist file fails' 1 - -

dir=$(new_repo)
g_run "$dir" PUBLIC_DENYLIST='   '
want 'whitespace-only denylist fails' 1 - -
if grep -q -F 'denylist: missing or empty' <<< "$OUT"; then
  record 'whitespace-only denylist message' 1
else
  record 'whitespace-only denylist message' 0
fi

dir=$(new_repo)
printf 'see %s\n' "$deny_word" > "$dir/n.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST="$(printf ' %s \n' "$deny_word")"
want 'trimmed denylist pattern still matches' 1 R-denylist "$deny_word"

dir=$(new_repo)
printf 'see %s\n' "$deny_word" > "$dir/n.txt"
commit_tree "$dir"
g_run "$dir" PUBLIC_DENYLIST="$(printf '%s\r\n' "$deny_word")"
want 'CRLF denylist hits and omits the match' 1 R-denylist "$deny_word"

dir=$(new_repo)
g_run "$dir" PUBLIC_DENYLIST='['
want 'bad denylist regex fails' 1 - -
if grep -q -F 'denylist: invalid pattern' <<< "$OUT"; then
  record 'bad regex message' 1
else
  record 'bad regex message' 0
fi
if grep -q -F 'Invalid regular expression' <<< "$OUT"; then
  record 'bad regex leaked grep stderr' 0
else
  record 'bad regex hides grep stderr' 1
fi

dir=$(new_repo)
sha=$(tip "$dir")
g_run "$dir" PUBLIC_GUARD_SKIP_DENYLIST=1 \
  PUBLIC_GUARD_SKIP_REASON='pull_request head repository does not match this repository' \
  PUBLIC_GUARD_EVENT=pull_request PUBLIC_GUARD_BASE="$sha" PUBLIC_GUARD_HEAD="$sha"
want 'skip flag passes without a denylist' 0 - -
if grep -q -F '::notice::denylist skipped:' <<< "$OUT"; then
  record 'skip prints a notice' 1
else
  record 'skip prints a notice' 0
fi

dir=$(new_repo)
printf '%s\n' "$v4bad" > "$dir/docs-bad.md"
commit_tree "$dir"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_GUARD_SKIP_DENYLIST=1 \
  PUBLIC_GUARD_SKIP_REASON='pull_request actor is dependabot[bot]' \
  PUBLIC_GUARD_EVENT=pull_request PUBLIC_GUARD_BASE="$sha" PUBLIC_GUARD_HEAD="$sha"
want 'skip still runs the other rules' 1 R-ip "$v4bad"
if grep -q -F '::notice::' <<< "$OUT"; then
  record 'skip notice with a content hit' 1
else
  record 'skip notice with a content hit' 0
fi

dir=$(new_repo)
sha=$(tip "$dir")
g_run "$dir" PUBLIC_GUARD_SKIP_DENYLIST=1 PUBLIC_GUARD_EVENT=push PUBLIC_GUARD_SHA="$sha"
want 'push does not skip a missing denylist' 1 - -
if grep -q -F 'denylist: missing or empty' <<< "$OUT" && ! grep -q -F '::notice::' <<< "$OUT"; then
  record 'push missing denylist has no notice' 1
else
  record 'push missing denylist has no notice' 0
fi

dir=$(new_repo)
printf 'see %s\n' "$deny_word" > "$dir/n.txt"
commit_tree "$dir"
sha=$(tip "$dir")
g_run "$dir" PUBLIC_DENYLIST="$deny_word" PUBLIC_GUARD_EVENT=push \
  PUBLIC_GUARD_SKIP_DENYLIST=1 PUBLIC_GUARD_SHA="$sha" PUBLIC_GUARD_BEFORE="$sha"
want 'denylist still applies on push' 1 R-denylist "$deny_word"

# --- pull request text ---
dir=$(new_repo)
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_PR_TITLE="host ${host_bad}" \
  PUBLIC_GUARD_PR_AUTHOR=PLN
want 'pull request title is checked' 1 R-tsnet "$host_bad"
if grep -q -F 'pr-title R-tsnet' <<< "$OUT"; then
  record 'title label' 1
else
  record 'title label' 0
fi

g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_PR_BODY="id ${bc_bad}" \
  PUBLIC_GUARD_PR_AUTHOR=PLN
want 'pull request body is checked' 1 R-bc "$bc_bad"

g_run "$dir" PUBLIC_DENYLIST='a^' \
  PUBLIC_GUARD_PR_TITLE="mail ${extra}" \
  PUBLIC_GUARD_PR_AUTHOR="$bot_name"
want 'dependabot pull request relaxes email' 0 - "$extra"

g_run "$dir" PUBLIC_DENYLIST='a^' \
  PUBLIC_GUARD_PR_TITLE="mail ${extra}" \
  PUBLIC_GUARD_PR_AUTHOR=PLN
want 'human pull request does not relax email' 1 R-email "$extra"

# --- decide-skip ---
run_decide() {
  set +e
  OUT=$(env -u EVENT_JSON -u HEAD_REPO -u GITHUB_EVENT_PATH -u PUBLIC_GUARD_EVENT_PATH "$@" bash "$DECIDE" 2>&1)
  RC=$?
  set -e
}

run_decide EVENT_NAME=pull_request ACTOR="$bot_name" REPOSITORY='PLN/pikvm_mcp_server' HEAD_REPO='PLN/pikvm_mcp_server'
want 'actor dependabot skips' 0 - -
if grep -q -F 'skip=1' <<< "$OUT"; then record 'actor skip value' 1; else record 'actor skip value' 0; fi

run_decide EVENT_NAME=pull_request ACTOR=PLN REPOSITORY='PLN/pikvm_mcp_server' HEAD_REPO='other/repo'
want 'fork skips' 0 - -
if grep -q -F 'skip=1' <<< "$OUT"; then record 'fork skip value' 1; else record 'fork skip value' 0; fi

run_decide EVENT_NAME=pull_request ACTOR=PLN REPOSITORY='PLN/pikvm_mcp_server' HEAD_REPO=
want 'deleted fork skips' 0 - -
if grep -q -F 'skip=1' <<< "$OUT"; then record 'deleted fork skip value' 1; else record 'deleted fork skip value' 0; fi

run_decide EVENT_NAME=pull_request ACTOR=PLN REPOSITORY='PLN/pikvm_mcp_server' HEAD_REPO='PLN/pikvm_mcp_server'
want 'same repository does not skip' 0 - -
if grep -q -F 'skip=0' <<< "$OUT"; then record 'same repo skip value' 1; else record 'same repo skip value' 0; fi

run_decide EVENT_NAME=pull_request ACTOR=PLN REPOSITORY='PLN/pikvm_mcp_server' HEAD_REPO='pln/pikvm_mcp_server'
want 'repository compare ignores case' 0 - -
if grep -q -F 'skip=0' <<< "$OUT"; then record 'case-insensitive skip value' 1; else record 'case-insensitive skip value' 0; fi

run_decide EVENT_NAME=push ACTOR="$bot_name" REPOSITORY='PLN/pikvm_mcp_server' HEAD_REPO='PLN/pikvm_mcp_server'
want 'push does not skip' 0 - -
if grep -q -F 'skip=0' <<< "$OUT"; then record 'push skip value' 1; else record 'push skip value' 0; fi

set +e
OUT=$(EVENT_JSON='{"pull_request":{"head":{"repo":null}}}' EVENT_NAME=pull_request ACTOR=PLN REPOSITORY='PLN/pikvm_mcp_server' bash "$DECIDE" 2>&1)
RC=$?
set -e
want 'null head repository skips' 0 - -
if grep -q -F 'skip=1' <<< "$OUT"; then record 'null repo skip value' 1; else record 'null repo skip value' 0; fi

# --- large event file ---
dir=$(new_repo)
sha=$(tip "$dir")
marker=$(printf '%s%s' 'LONG' 'MARK')
node --input-type=module - "$dir" "$sha" "$marker" "$bc_bad" <<'END'
import { writeFileSync } from 'node:fs'
const dir = process.argv[2]
const sha = process.argv[3]
const marker = process.argv[4]
const bc = process.argv[5]
const body = `${'x'.repeat(140000)}\n${marker}\n${bc}\n`
const event = {
  pull_request: {
    title: 't',
    body,
    user: { login: 'PLN' },
    base: { sha },
    head: { sha, repo: { full_name: 'PLN/pikvm_mcp_server' } },
  },
}
writeFileSync(`${dir}/event.json`, JSON.stringify(event))
END
if [[ $(wc -c < "$dir/event.json") -le 140000 ]]; then
  record 'event file is large enough' 0
else
  record 'event file is large enough' 1
fi
g_run "$dir" PUBLIC_DENYLIST='a^' PUBLIC_GUARD_EVENT_PATH="$dir/event.json" EVENT_NAME=pull_request
want 'a large event file is checked' 1 R-bc "$bc_bad"
if grep -q -F "$marker" <<< "$OUT"; then
  record 'event body was not printed' 0
else
  record 'event body was not printed' 1
fi
if grep -q -F 'pr-body R-bc' <<< "$OUT"; then
  record 'large event labels the body' 1
else
  record 'large event labels the body' 0
fi

# --- this repository ---
set +e
OUT=$(
  cd "$ROOT" && env \
    -u PUBLIC_DENYLIST_FILE \
    -u PUBLIC_GUARD_EVENT \
    -u PUBLIC_GUARD_RANGE \
    -u PUBLIC_GUARD_PR_TITLE \
    -u PUBLIC_GUARD_PR_BODY \
    -u PUBLIC_GUARD_SKIP_DENYLIST \
    -u EVENT_JSON \
    -u EVENT_NAME \
    -u GITHUB_ACTIONS \
    -u GITHUB_EVENT_PATH \
    -u PUBLIC_GUARD_EVENT_PATH \
    PUBLIC_DENYLIST='a^' bash "$GUARD" 2>&1
)
RC=$?
set -e
want 'tracked tree passes' 0 - -

printf 'pass=%s fail=%s\n' "$PASS" "$FAIL"
if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
