<!-- Modified 2026-10 by PLN: opt-in hardware suite (GPL-3.0; see NOTICE) -->

# Hardware suite

Opt-in checks against one PiKVM. `npm test` does not run them, and CI does not call `npm run test:hw`. With `PIKVM_HW_TEST_DEVICE` unset, every test skips and the process does not open a socket.

The device registry is not built yet. The only accepted name is `default`, which is the legacy `PIKVM_HOST` / `PIKVM_USERNAME` / `PIKVM_PASSWORD` device (`resolveDevice`). Any other name fails before a connection, with a message that names Phase B item 10.

## Prerequisites

- Node.js 22 or newer (`node --version`).
- Tailscale is up on this machine (`tailscale status`).
- The PiKVM is on the same tailnet and answers HTTPS on its MagicDNS name.

Build once if you have not already:

```bash
npm ci
npm run build
```

## Environment

Placeholders only. Do not commit real hostnames, tailnet names, or passwords.

```bash
export PIKVM_HOST=https://pikvm.example.ts.net
export PIKVM_USERNAME=admin
export PIKVM_PASSWORD=replace-with-the-kvmd-password
export PIKVM_VERIFY_SSL=false
export PIKVM_HW_TEST_DEVICE=default
npm run test:hw
```

`PIKVM_VERIFY_SSL` is the TLS switch that exists today. It is verified only when the value is the string `true`. Any other value, including unset, leaves `verifySsl` false (`rejectUnauthorized: false`).

- Stock PiKVM image, self-signed certificate: leave `PIKVM_VERIFY_SSL` unset or set it to `false`.
- Tailscale certificate (the MagicDNS name is on the cert, and this machine trusts the Tailscale CA): set `PIKVM_VERIFY_SSL=true`.
- Separate `verify` / `pin` / `insecure` modes are not implemented yet. Pinning a certificate file is Phase B.

The read-only level does not need the HTTP arm flags. The MSD and HID levels do, because the suite calls the same tools an HTTP session would.

## Levels

| Level | Variables | What it touches |
| --- | --- | --- |
| Read-only (default) | `PIKVM_HW_TEST_DEVICE=default` plus the host and password | Auth check, `GET /api/info?fields=system,hw` (kvmd version and model are logged), one raw `GET /api/msd` (logged with the password redacted) and `pikvm_msd_status`, the TLS mode in use, one bad-password `GET` (a single 401, `PIKVM_AUTH_FAILED`, not retried), and optionally the same host on port 1 mapped to `PIKVM_UNREACHABLE`. A filtered port is skipped rather than failed. |
| MSD | also `PIKVM_HW_TEST_ALLOW_MSD=1` and `PIKVM_MCP_ARM_MSD=1` | Uploads a tiny `mcp-hwtest-<timestamp>-<rand>.iso`, mounts it as cdrom, ejects twice (the second result is `alreadyDisconnected`), mounts it as flash read-only, ejects, and removes it. If `PIKVM_HW_TEST_FETCH_URL` is an allowlisted `https` URL, `pikvm_msd_fetch_url` downloads it under another `mcp-hwtest-*` name and then removes that name. |
| MSD force | `PIKVM_HW_TEST_ALLOW_MSD=force` instead of `1` | Dangerous. If the virtual drive is already connected, the cycle disconnects it, runs the writes above, and remounts the previous image afterwards. A busy drive is not skipped either; the cycle may fail. |
| HID | also `PIKVM_HW_TEST_ALLOW_HID=1` and `PIKVM_MCP_ARM_HID=1` | `pikvm_type` sends the two characters `hw` with delay 0 and again with delay 50. Delay is milliseconds. kvmd reads seconds, so 50 is sent as `0.05`. This types into whatever has focus. Leave the target on a safe screen, such as an empty text editor, and do not leave a shell prompt focused. |

`PIKVM_HW_TEST_ALLOW_MSD` unset, or any value other than `1` or `force`, skips the MSD cycle. The drive is not changed. If the drive is connected or busy, `1` skips with a message instead of disconnecting it. `force` is the only override.

`PIKVM_MSD_URL_ALLOWLIST` must already allow `PIKVM_HW_TEST_FETCH_URL`. A URL that is not `https` or not allowlisted fails the MSD test before the upload. Leave `PIKVM_HW_TEST_FETCH_URL` unset to skip that step. The fetch still refuses private and link-local addresses unless the existing URL flags allow them.

## Image bytes

The storage name is always `mcp-hwtest-<timestamp>-<rand>.iso` (a fetch uses the same prefix and an extra `-url` segment).

`xorriso` is used when it is on `PATH`, otherwise `genisoimage`. Both build a small ISO from a one-line `readme.txt` (`-V MCPHWTEST`, ISO level 1). If neither tool is present, or the tool fails, the file is a fixed 64-byte fixture from `fallbackIsoBytes()` in `test/hw/media.mjs`:

```text
bytes 0-7    MCPHWISO
bytes 8-15   00000001
bytes 16-63  pikvm-mcp hardware-suite fixture, newline, space padded
```

That fixture is not a mountable ISO 9660 volume. A real volume needs a 32 KiB system area plus descriptors, which would pass the 32 KiB cap on the fallback. kvmd stores either body. The log line `hw: image ... via xorriso|genisoimage|fixture` says which one was uploaded.

## Expected output

Skipped tests (no device):

```text
# skipped N
# pass 0
# fail 0
```

Each skip reason is `PIKVM_HW_TEST_DEVICE is unset`. There is no connection.

A read-only run logs lines like:

```text
hw: auth ok device=default
hw: kvmd version 4.x
hw: model v4plus
hw: info { ... }
hw: raw /api/msd { ... }
hw: tls verifySsl=false
```

The raw MSD JSON is passed through the same password redaction as tool errors. An MSD run also logs the snapshot and, at the end, `hw: no mcp-hwtest images left`. A HID run logs `hw: pikvm_type delay 0 accepted` and the same for 50.

## Cleanup

The MSD cycle records the drive snapshot, then runs the writes in `try` / `finally`.

The `finally` block:

1. Disconnects the drive if it is connected.
2. Removes every storage name that starts with `mcp-hwtest-`. `mcp-hwtest.iso` (no hyphen after the word) and every other name are left in place.
3. Remounts the previous image when the snapshot had one, with the previous cdrom or flash mode, the previous `rw` flag, and the previous connected flag.
4. Logs any `mcp-hwtest-*` name still present, or `hw: no mcp-hwtest images left`.

A failure in the middle, including a forced failure, still runs that block. Killing the process (Ctrl-C, or the machine losing power) does not. Clean up by hand:

```bash
curl -k -u admin:replace-with-the-kvmd-password \
  https://pikvm.example.ts.net/api/msd
```

Remove only names that start with `mcp-hwtest-`. If one of them is still connected, eject first.

```bash
curl -k -u admin:replace-with-the-kvmd-password \
  -X POST 'https://pikvm.example.ts.net/api/msd/set_connected?connected=0'

curl -k -u admin:replace-with-the-kvmd-password \
  -X POST 'https://pikvm.example.ts.net/api/msd/remove?image=mcp-hwtest-TIMESTAMP-RAND.iso'
```

The `hw: snapshot ...` line is the image to put back, with its `connected`, `cdrom`, and `rw` values. Do not remove any other image.

## CI

`npm test` expands `test/*.test.mjs` only. These files live in `test/hw/` and are named `*.hw.test.mjs`, so that glob does not see them. The workflow runs `npm ci`, `npm run typecheck`, and `npm test`. It does not run `npm run test:hw`.

On Node 22.14, `node --test test/hw` from the repo root is a directory import (`"type": "module"`) and does not discover the files. Use `npm run test:hw`, which passes `test/hw/*.hw.test.mjs`. A normal test runs `node --test` with its working directory set to `test/hw`, the device variable unset, and asserts that every hardware test skipped and that no socket or DNS lookup happened.

## Manual checklist

Copy one row per PiKVM. The suite covers a tiny image, not a multi-gigabyte upload.

| PiKVM | Model | kvmd | MSD | free shape | 4 GiB up / URL time | 413? | client timeout? | refusals OK? | cdrom / flash ro / rw | TLS verify / pin / insecure | pin after cert change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | | | | | | | | | | | |
