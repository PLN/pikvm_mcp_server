#!/usr/bin/env bash
# Modified 2026-10 by PLN: Docker image smoke test (GPL-3.0; see NOTICE).
#
# Smoke test for the container image, cases S1-S20. S21 is this script on
# an arm64 runner. No real PiKVM: hosts are kvm.invalid, or a host-side
# TLS fixture on 127.0.0.1 reached with --network host.
#
# Usage: test/docker/smoke.sh <image>
# EXPECT_REVISION, when set, must equal the image's revision label (S17).
# Needs docker, node and jq on the host.
set -euo pipefail

IMAGE=${1:?usage: test/docker/smoke.sh <image>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MCP="node $ROOT/test/docker/mcp-stdio.mjs"
WORK=$(mktemp -d)
LABEL=pikvm-smoke-$$
VOLUME=pikvm-smoke-$$
FIXTURE_PID=
failures=0

cleanup() {
  docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  if [ -n "$FIXTURE_PID" ]; then kill "$FIXTURE_PID" 2>/dev/null || true; fi
  # Data dirs belong to uid 10001 or root, so remove them from a container.
  docker run --rm --user 0 --network none -v "$WORK:/w" --entrypoint sh "$IMAGE" \
    -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "ok   $1"; }
fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }
check() {
  # check <case> <description> <command...>
  local id=$1 what=$2
  shift 2
  if "$@"; then pass "$id $what"; else fail "$id" "$what"; fi
}
has() { grep -qF -- "$2" <<<"$1"; }
lacks() { ! has "$1" "$2"; }
# exits_with <code|nonzero> <text>: the last run's rc and output ($rc, $out).
exits_with() {
  if [ "$1" = nonzero ]; then [ "$rc" -ne 0 ]; else [ "$rc" -eq "$1" ]; fi && has "$out" "$2"
}

# Common flags: every container runs read-only with all capabilities dropped.
run() { docker run --rm --label "$LABEL" --read-only --cap-drop ALL "$@"; }
as_root() { docker run --rm --user 0 --network none --entrypoint "$1" "${@:2}"; }

# newdata <name>: a host dir for /data, owned by 10001 once own_data runs.
newdata() { mkdir -p "$WORK/$1/secrets" "$WORK/$1/tls" "$WORK/$1/images"; echo "$WORK/$1"; }
own_data() { as_root chown -v "$1:/d" "$IMAGE" -R 10001:10001 /d >/dev/null; }
stat_in() { as_root stat -v "$1:/d" "$IMAGE" -c "$2" "/d/$3"; }

echo "image: $IMAGE"

# S1: no host, nothing in /data.
d=$(newdata s1); own_data "$d"
rc=0; out=$(run -v "$d:/data" "$IMAGE" </dev/null 2>&1) || rc=$?
check S1 "no host exits non-zero with the PIKVM_HOST message" \
  exits_with nonzero 'PIKVM_HOST environment variable is required'

# S2, S7 (no tmpfs), S13: stdio, invalid host, dummy password.
d=$(newdata s2); own_data "$d"
rc=0; tools=$($MCP tools -- docker run -i --rm --label "$LABEL" --read-only --cap-drop ALL \
  -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy "$IMAGE" 2>"$WORK/s2.err") || rc=$?
echo "     tools listed: $(wc -l <<<"$tools")"
check S2 "stdio answers tools/list and exits 0 on stdin EOF" test "$rc" -eq 0
check S2 "pikvm_msd_upload is listed" has "$tools" pikvm_msd_upload
check S13 "pikvm_read_text is listed" has "$tools" pikvm_read_text

# S3: registry only, absolute paths, no PIKVM_HOST.
d=$(newdata s3)
printf 'dummy' >"$d/secrets/kvm1-password"; chmod 0600 "$d/secrets/kvm1-password"
cat >"$d/devices.json" <<'EOF'
{"default": "kvm1", "devices": {"kvm1": {"host": "https://kvm.invalid", "username": "admin", "passwordFile": "/data/secrets/kvm1-password", "tls": {"mode": "insecure"}}}}
EOF
own_data "$d"
rc=0; $MCP tools -- docker run -i --rm --label "$LABEL" --read-only --cap-drop ALL \
  -v "$d:/data" "$IMAGE" >/dev/null 2>"$WORK/s3.err" || rc=$?
check S3 "registry-only start answers" test "$rc" -eq 0
check S3 "entrypoint logs the registry default" grep -qF 'entrypoint: PIKVM_DEVICES_FILE=/data/devices.json (default)' "$WORK/s3.err"

# S4: HTTP with a 0600 bearer file. S15 stops this container.
d=$(newdata s4)
bearer=smoke-bearer-0123456789abcdef0123456789abcdef
printf '%s' "$bearer" >"$d/secrets/pikvm-mcp-bearer"; chmod 0600 "$d/secrets/pikvm-mcp-bearer"
own_data "$d"
cid=$(docker run -d --label "$LABEL" --read-only --cap-drop ALL --tmpfs /tmp -p 127.0.0.1::8675 -v "$d:/data" \
  -e PIKVM_MCP_PORT=8675 -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy "$IMAGE")
port=$(docker port "$cid" 8675/tcp | head -n 1 | sed 's/.*://')
url=http://127.0.0.1:$port
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/healthz" || true)" = 200 ] && break
  sleep 0.5
done
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"pikvm-smoke","version":"0"}}}'
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
mcp_post() {
  code -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "$@" -d "$init" "$url/mcp"
}
check S4 "GET /healthz is 200 ok" test "$(curl -s "$url/healthz")" = ok
check S4 "HEAD /healthz is 401" test "$(code -I "$url/healthz")" = 401
check S4 "no token is 401" test "$(mcp_post)" = 401
check S4 "wrong token is 401" test "$(mcp_post -H 'Authorization: Bearer wrong')" = 401
check S4 "initialize with the bearer is 200" test "$(mcp_post -H "Authorization: Bearer $bearer")" = 200
logs=$(docker logs "$cid" 2>&1)
check S4 "HID and MSD are disarmed" has "$logs" 'HID DISARMED, MSD DISARMED'
check S4 "the healthcheck exits 0" docker exec "$cid" node /usr/local/bin/healthcheck.mjs
check S4 "no bearer value in the logs" lacks "$logs" "$bearer"
armed=$(docker run -d --label "$LABEL" --read-only --cap-drop ALL -v "$d:/data" -e PIKVM_MCP_PORT=8675 \
  -e PIKVM_MCP_ARM_HID=1 -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy "$IMAGE")
for _ in $(seq 1 60); do
  docker logs "$armed" 2>&1 | grep -q 'MCP Server running' && break
  sleep 0.5
done
check S4 "PIKVM_MCP_ARM_HID=1 arms HID" has "$(docker logs "$armed" 2>&1)" 'HID ARMED, MSD DISARMED'
docker rm -f "$armed" >/dev/null

# S15: an idle HTTP server stops fast and exits 0.
start=$(date +%s%N)
docker stop -t 30 "$cid" >/dev/null
ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "     docker stop took ${ms} ms"
check S15 "docker stop returns within 3 s" test "$ms" -lt 3000
check S15 "exit code after SIGTERM is 0" test "$(docker inspect -f '{{.State.ExitCode}}' "$cid")" = 0
docker rm -f "$cid" >/dev/null

# S5: HTTP without a bearer.
d=$(newdata s5); own_data "$d"
rc=0; out=$(run -v "$d:/data" -e PIKVM_MCP_PORT=8675 -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy \
  "$IMAGE" </dev/null 2>&1) || rc=$?
check S5 "HTTP without a bearer exits 1 with the message" \
  exits_with 1 'PIKVM_MCP_BEARER must be set'

# S6: port validation in the entrypoint.
for bad in http 0 70000; do
  rc=0; out=$(run -v "$d:/data" -e PIKVM_MCP_PORT="$bad" -e PIKVM_HOST=https://kvm.invalid "$IMAGE" </dev/null 2>&1) || rc=$?
  check S6 "port '$bad' exits 64 with a message" \
    exits_with 64 'PIKVM_MCP_PORT must be a number'
done
rc=0; out=$(run -v "$d:/data" -e PIKVM_MCP_PORT= -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy \
  "$IMAGE" </dev/null 2>&1) || rc=$?
check S6 "an empty port starts stdio" exits_with 0 'PiKVM MCP Server running'

# S7: identity, read-only rootfs, no npm.
check S7 "uid is 10001" test "$(docker run --rm --entrypoint id "$IMAGE" -u)" = 10001
check S7 "/app is not writable on a read-only rootfs" \
  bash -c "! docker run --rm --read-only --entrypoint touch '$IMAGE' /app/x 2>/dev/null"
check S7 "/app is not writable on a writable rootfs" \
  bash -c "! docker run --rm --entrypoint touch '$IMAGE' /app/x 2>/dev/null"
d=$(newdata s7); own_data "$d"
rc=0; $MCP tools -- docker run -i --rm --label "$LABEL" --read-only --cap-drop ALL --tmpfs /tmp \
  -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy "$IMAGE" >/dev/null 2>&1 || rc=$?
check S7 "starts with --tmpfs /tmp (S2 ran without)" test "$rc" -eq 0
check S7 "npm, npx and corepack are absent" \
  bash -c "! docker run --rm --entrypoint sh '$IMAGE' -c 'command -v npm || command -v npx || command -v corepack'"

# S8: named volume ownership, and an unreadable bind mount.
docker volume create "$VOLUME" >/dev/null
check S8 "a fresh named volume is 10001:10001 mode 750" \
  test "$(docker run --rm -v "$VOLUME:/data" --entrypoint stat "$IMAGE" -c %u:%g:%a /data)" = 10001:10001:750
rc=0; $MCP tools -- docker run -i --rm --label "$LABEL" --read-only --cap-drop ALL -v "$VOLUME:/data" \
  -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy "$IMAGE" >/dev/null 2>&1 || rc=$?
check S8 "the server runs on the named volume" test "$rc" -eq 0
d=$(newdata s8)
as_root sh -v "$d:/d" "$IMAGE" -c 'chown -R 0:0 /d && chmod 0700 /d'
rc=0; out=$(run -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid "$IMAGE" </dev/null 2>&1) || rc=$?
check S8 "a root-owned 0700 bind mount exits 78 with the chown hint" \
  exits_with 78 'chown the volume'

# S9: loose secret modes warn and are left alone.
for mode in 0644:'group or other bits are set' 0640:'group bits are set' 0600:''; do
  m=${mode%%:*} want=${mode#*:}
  d=$(newdata "s9-$m")
  printf 'dummy' >"$d/secrets/pikvm-password"; chmod "$m" "$d/secrets/pikvm-password"
  own_data "$d"
  out=$(run -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid "$IMAGE" </dev/null 2>&1) || true
  if [ -n "$want" ]; then
    check S9 "mode $m warns '$want'" has "$out" "is mode $m; $want"
  else
    check S9 "mode $m is silent" lacks "$out" 'bits are set'
  fi
  check S9 "mode $m is unchanged" test "$(stat_in "$d" %a secrets/pikvm-password)" = "${m#0}"
done

# S10: a secret the container user cannot read.
d=$(newdata s10)
printf 'smoke-secret-value-s10' >"$d/secrets/pikvm-password"
own_data "$d"
as_root sh -v "$d:/d" "$IMAGE" -c 'chown 0:0 /d/secrets/pikvm-password && chmod 0600 /d/secrets/pikvm-password'
rc=0; out=$(run -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid "$IMAGE" </dev/null 2>&1) || rc=$?
check S10 "an unreadable secret exits 1 with EACCES" \
  exits_with 1 'PIKVM_PASSWORD_FILE (/data/secrets/pikvm-password): cannot read (EACCES)'
check S10 "no secret value in the output" lacks "$out" smoke-secret-value-s10

# Host-side TLS fixture for S11 and S19 (127.0.0.1 only).
fx=$WORK/fixture; mkdir -p "$fx"
node "$ROOT/test/docker/tls-fixture.mjs" "$fx" &
FIXTURE_PID=$!
for _ in $(seq 1 50); do [ -s "$fx/port" ] && break; sleep 0.1; done
kvm=https://kvm.test:$(cat "$fx/port")
hostnet=(--network host --add-host kvm.test:127.0.0.1)

# S11: pin in stdio mode.
d=$(newdata s11); own_data "$d"
rc=0; out=$(run "${hostnet[@]}" -v "$d:/data" -e PIKVM_HOST="$kvm" "$IMAGE" pin default </dev/null 2>&1) || rc=$?
check S11 "pin without --yes and without a TTY refuses" \
  exits_with nonzero 'refusing to write the certificate without a TTY'
check S11 "the refused pin wrote nothing" test -z "$(as_root ls -v "$d:/d" "$IMAGE" -A /d/tls)"
rc=0; run "${hostnet[@]}" -v "$d:/data" -e PIKVM_HOST="$kvm" "$IMAGE" pin default --yes </dev/null >/dev/null 2>&1 || rc=$?
check S11 "pin default --yes exits 0" test "$rc" -eq 0
check S11 "the pin file is 0644 and owned by 10001" test "$(stat_in "$d" %a:%u tls/default.pem)" = 644:10001
before=$(stat_in "$d" %Y.%y tls/default.pem)
for _ in 1 2; do
  out=$(run "${hostnet[@]}" -v "$d:/data" -e PIKVM_HOST="$kvm" -e PIKVM_TLS_MODE=pin -e PIKVM_PASSWORD=dummy \
    "$IMAGE" </dev/null 2>&1) || true
done
pin_started() { has "$out" 'PiKVM MCP Server running' && lacks "$out" 'Could not authenticate'; }
check S11 "pin mode starts and authenticates against the pinned fixture" pin_started
check S11 "two pin-mode starts do not rewrite the pin file" test "$(stat_in "$d" %Y.%y tls/default.pem)" = "$before"

# S12: pin mode without a pin file.
d=$(newdata s12); own_data "$d"
rc=0; out=$(run -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid -e PIKVM_TLS_MODE=pin -e PIKVM_PASSWORD=dummy \
  "$IMAGE" </dev/null 2>&1) || rc=$?
check S12 "pin mode without a pin file exits 78 naming pin default" \
  exits_with 78 'run: pin default'

# S13: OCR.
check S13 "tesseract has eng" bash -c "docker run --rm --entrypoint tesseract '$IMAGE' --list-langs 2>&1 | grep -qx eng"
d=$(newdata s13); own_data "$d"
rc=0; tools=$($MCP tools -- docker run -i --rm --label "$LABEL" --read-only --cap-drop ALL -v "$d:/data" \
  -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy -e PIKVM_OCR_ENGINE=off "$IMAGE" 2>/dev/null) || rc=$?
ocr_off() { [ "$rc" -eq 0 ] && has "$tools" pikvm_screenshot && lacks "$tools" pikvm_read_text; }
check S13 "PIKVM_OCR_ENGINE=off answers tools/list without pikvm_read_text" ocr_off
rc=0; out=$(run -v "$d:/data" -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy -e PIKVM_OCR_ENGINE=host \
  -e PIKVM_OCR_TESSERACT_BIN=/nonexistent/tesseract "$IMAGE" </dev/null 2>&1) || rc=$?
check S13 "a bogus tesseract path with engine host fails startup" \
  exits_with nonzero 'is not usable'

# S14: sharp loads and works.
check S14 "sharp resizes and crops" docker run --rm --read-only --cap-drop ALL --network none --entrypoint node "$IMAGE" \
  --input-type=module -e "
    const { default: sharp } = await import('sharp');
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } })
      .resize(32, 24).extract({ left: 0, top: 0, width: 16, height: 12 }).jpeg().toBuffer();
    const meta = await sharp(jpeg).metadata();
    if (meta.width !== 16 || meta.height !== 12) process.exit(1);"

# S16: compressed layer sum per arch.
docker save "$IMAGE" -o "$WORK/image.tar"
mkdir -p "$WORK/image"; tar -xf "$WORK/image.tar" -C "$WORK/image"; rm -f "$WORK/image.tar"
compressed=0
while read -r layer; do
  f=$WORK/image/$layer
  if [ "$(head -c 2 "$f" | od -An -tx1 | tr -d ' ')" = 1f8b ]; then
    size=$(stat -c %s "$f")
  else
    size=$(gzip -c "$f" | wc -c)
  fi
  compressed=$((compressed + size))
done < <(jq -r '.[0].Layers[]' "$WORK/image/manifest.json")
rm -rf "$WORK/image"
echo "     compressed layer sum: $((compressed / 1000000)) MB; uncompressed: $(( $(docker image inspect -f '{{.Size}}' "$IMAGE") / 1000000 )) MB"
check S16 "compressed layer sum is at most 175 MB" test "$compressed" -le 175000000

# S17: labels and licence files.
labels=$(docker image inspect -f '{{json .Config.Labels}}' "$IMAGE")
label() { jq -r --arg k "org.opencontainers.image.$1" '.[$k] // empty' <<<"$labels"; }
check S17 "source label" test "$(label source)" = https://github.com/PLN/pikvm_mcp_server
check S17 "licenses label" test "$(label licenses)" = GPL-3.0-only
if [ -n "${EXPECT_REVISION:-}" ]; then
  check S17 "revision label is $EXPECT_REVISION" test "$(label revision)" = "$EXPECT_REVISION"
  check S17 "version and title labels" test -n "$(label version)" -a -n "$(label title)"
else
  echo "skip S17 revision, version and title labels (EXPECT_REVISION unset)"
fi
check S17 "/app/LICENSE equals the repo's" bash -c "docker run --rm --entrypoint cat '$IMAGE' /app/LICENSE | cmp -s - '$ROOT/LICENSE'"
check S17 "/app/NOTICE equals the repo's" bash -c "docker run --rm --entrypoint cat '$IMAGE' /app/NOTICE | cmp -s - '$ROOT/NOTICE'"
check S17 "/app/THIRD-PARTY-NOTICES.txt is not empty" docker run --rm --entrypoint test "$IMAGE" -s /app/THIRD-PARTY-NOTICES.txt

# S18: compose file, with and without a .env next to it.
mkdir -p "$WORK/compose"; cp "$ROOT/compose.yaml" "$WORK/compose/"
check S18 "compose config without .env" docker compose --project-directory "$WORK/compose" -f "$WORK/compose/compose.yaml" config -q
printf 'PIKVM_HOST=https://kvm.invalid\n' >"$WORK/compose/.env"
check S18 "compose config with a dummy .env" docker compose --project-directory "$WORK/compose" -f "$WORK/compose/compose.yaml" config -q

# S19: verify mode with a private CA, one tool call each.
d=$(newdata s19); own_data "$d"
call() {
  $MCP call pikvm_get_resolution '{}' -- docker run -i --rm --label "$LABEL" --read-only --cap-drop ALL "${hostnet[@]}" \
    -v "$d:/data" -e PIKVM_HOST="$kvm" -e PIKVM_TLS_MODE=verify -e PIKVM_PASSWORD=dummy "$IMAGE" 2>&1 || true
}
out=$(call)
check S19 "without ca.pem the call fails with PIKVM_TLS_VERIFY_FAILED" has "$out" PIKVM_TLS_VERIFY_FAILED
as_root sh -v "$d:/d" -v "$fx/ca.pem:/ca.pem:ro" "$IMAGE" -c 'cp /ca.pem /d/tls/ca.pem && chown 10001:10001 /d/tls/ca.pem'
out=$(call)
check S19 "the entrypoint exports /data/tls/ca.pem" has "$out" 'entrypoint: NODE_EXTRA_CA_CERTS=/data/tls/ca.pem (default)'
ca_ok() { has "$out" 1920 && has "$out" isError=false && lacks "$out" PIKVM_TLS_VERIFY_FAILED; }
check S19 "with ca.pem the call succeeds" ca_ok
as_root sh -v "$d:/d" "$IMAGE" -c 'echo not a certificate >/d/tls/ca.pem'
out=$(call)
ca_bad() { has "$out" 'has no certificate and is not used' && lacks "$out" NODE_EXTRA_CA_CERTS=; }
check S19 "an invalid ca.pem is not exported" ca_bad

# S20: no network at all.
d=$(newdata s20); own_data "$d"
cid=$(docker run -d --label "$LABEL" --read-only --cap-drop ALL --network none -v "$d:/data" -e PIKVM_MCP_PORT=8675 \
  -e PIKVM_MCP_BEARER="$bearer" -e PIKVM_HOST=https://kvm.invalid -e PIKVM_PASSWORD=dummy "$IMAGE")
up=no
for _ in $(seq 1 60); do
  if docker exec "$cid" node /usr/local/bin/healthcheck.mjs 2>/dev/null; then up=yes; break; fi
  sleep 0.5
done
check S20 "starts and answers /healthz with --network none" test "$up" = yes
docker rm -f "$cid" >/dev/null

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures smoke check(s) failed"
  exit 1
fi
echo "all smoke checks passed"
