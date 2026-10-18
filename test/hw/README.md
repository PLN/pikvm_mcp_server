<!-- Modified 2026-10 by PLN: opt-in hardware suite (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: 1 MiB ISO, leftover names, closed port 65000 (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: password via resolveSecret (GPL-3.0; see NOTICE) -->

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

The password is `loadConfig()`'s `resolveSecret` result, the same helper the server uses. `PIKVM_PASSWORD` wins. Otherwise `PIKVM_PASSWORD_FILE` is a regular file (one trailing newline removed). Otherwise, when `CREDENTIALS_DIRECTORY` is set, `$CREDENTIALS_DIRECTORY/pikvm-password` is the systemd `LoadCredential` file. A missing credential file leaves the password unset. A missing `PIKVM_PASSWORD_FILE` is an error that names that variable and the path. The value is not logged.

| Variable | Role |
| --- | --- |
| `PIKVM_PASSWORD` | kvmd password. Wins over the file and the credential. |
| `PIKVM_PASSWORD_FILE` | Path of a regular file holding the password. |
| `PIKVM_MCP_BEARER` | Not required for this suite. The server uses it only for HTTP mode. |
| `PIKVM_MCP_BEARER_FILE` | Path of a regular file holding that bearer. |
| `CREDENTIALS_DIRECTORY` | systemd directory. Credential names are `pikvm-password` and `pikvm-mcp-bearer`. |

`PIKVM_VERIFY_SSL` is the TLS switch that exists today. It is verified only when the value is the string `true`. Any other value, including unset, leaves `verifySsl` false (`rejectUnauthorized: false`).

- Stock PiKVM image, self-signed certificate: leave `PIKVM_VERIFY_SSL` unset or set it to `false`.
- Tailscale certificate (the MagicDNS name is on the cert, and this machine trusts the Tailscale CA): set `PIKVM_VERIFY_SSL=true`.
- Separate `verify` / `pin` / `insecure` modes are not implemented yet. Pinning a certificate file is Phase B.

The read-only level does not need the HTTP arm flags. The MSD and HID levels do, because the suite calls the same tools an HTTP session would.

## Levels

| Level | Variables | What it touches |
| --- | --- | --- |
| Read-only (default) | `PIKVM_HW_TEST_DEVICE=default` plus the host and password | Auth check, `GET /api/info?fields=system,hw` (kvmd version and model are logged), one raw `GET /api/msd` (logged with the password redacted) and `pikvm_msd_status`, the TLS mode in use, one bad-password `GET` (a single 401, `PIKVM_AUTH_FAILED`, not retried), and a closed-port probe of the same host. The probe uses port 65000 unless `PIKVM_HW_TEST_UNREACHABLE_PORT` names another port. Set that variable to `0` or `skip` to skip the probe. A connection refused is `PIKVM_UNREACHABLE`. A filtered port (the request times out) is skipped rather than failed. |
| MSD | also `PIKVM_HW_TEST_ALLOW_MSD=1` and `PIKVM_MCP_ARM_MSD=1` | Uploads a 1 MiB `mcp-hwtest-<timestamp>-<rand>.iso`, mounts it as cdrom, ejects twice (the second result is `alreadyDisconnected`), mounts it as flash read-only, ejects, and removes it. If `PIKVM_HW_TEST_FETCH_URL` is an allowlisted `https` URL, `pikvm_msd_fetch_url` downloads it under another `mcp-hwtest-*` name and then removes that name. |
| MSD force | `PIKVM_HW_TEST_ALLOW_MSD=force` instead of `1` | Dangerous. Confirm the target host is not using the virtual drive before running force. If the virtual drive is already connected, the cycle disconnects it, runs the writes above, and remounts the previous image afterwards. A busy drive is not skipped either; the cycle may fail. |
| HID | also `PIKVM_HW_TEST_ALLOW_HID=1` and `PIKVM_MCP_ARM_HID=1` | `pikvm_type` sends the two characters `hw` with delay 0 and again with delay 50. Delay is milliseconds. kvmd reads seconds, so 50 is sent as `0.05`. This types into whatever has focus. Leave the target on a safe screen, such as an empty text editor, and do not leave a shell prompt focused. |

`PIKVM_HW_TEST_ALLOW_MSD` unset, or any value other than `1` or `force`, skips the MSD cycle. The drive is not changed. If the drive is connected or busy, `1` skips with a message instead of disconnecting it. `force` is the only override.

`PIKVM_MSD_URL_ALLOWLIST` must already allow `PIKVM_HW_TEST_FETCH_URL`. A URL that is not `https` or not allowlisted fails the MSD test before the upload. Leave `PIKVM_HW_TEST_FETCH_URL` unset to skip that step. The fetch still refuses private and link-local addresses unless the existing URL flags allow them.

## Image bytes

The storage name is always `mcp-hwtest-<timestamp>-<rand>.iso` (a fetch uses the same prefix and an extra `-url` segment). Node writes the file at test time. There is no `xorriso` or `genisoimage` dependency, and there is no small fallback fixture.

The image is 1 MiB: 512 sectors of 2048 bytes. The kernel `fsg_lun_open` path refuses a cdrom smaller than 300×2048 bytes (614,400) and a flash image smaller than 512 bytes, and `set_connected` then fails with `ETOOSMALL`.

`hwIsoBytes()` in `test/hw/media.mjs` fills that buffer:

- Sector 16 is a Primary Volume Descriptor: type 1, `CD001`, version 1, volume space size 512 (both-endian), logical block size 2048 (both-endian), volume set size 1, volume sequence number 1, and a root directory record whose extent is sector 18.
- Sector 17 is the volume descriptor set terminator (`0xFF`, `CD001`, version 1).
- Sector 18 is the root directory, with `.` (`0x00`) and `..` (`0x01`) records.
- Sectors 19 and 20 are the type-L and type-M path tables.

The log line is `hw: image <name> (<bytes> bytes)`.

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

The raw MSD JSON is passed through the same password redaction as tool errors. An MSD run also logs the snapshot, `hw: image <name> (<bytes> bytes)`, and at the end either `hw: no mcp-hwtest images left` or `hw: leftover mcp-hwtest images: ...`. A leftover line names images this run did not create. A HID run logs `hw: pikvm_type delay 0 accepted` and the same for 50.

## Cleanup

The MSD cycle records the drive snapshot, then runs the writes in `try` / `finally`.

The `finally` block:

1. Disconnects the drive if it is connected.
2. Removes only the exact image names this run created (the upload name, and the fetch name when a fetch was requested). Any other `mcp-hwtest-*` name is a leftover: it is logged and not deleted. `mcp-hwtest.iso` (no hyphen after the word) does not match the prefix and is left in place.
3. Remounts the previous image when the snapshot had one and that name is not an `mcp-hwtest-*` image, with the previous cdrom or flash mode, the previous `rw` flag (forced false for cdrom), and the previous connected flag. When the snapshot had no image, the previous cdrom and `rw` flags are written with `set_params` and no image name.
4. Logs leftover `mcp-hwtest-*` names that this run did not create, or `hw: no mcp-hwtest images left`.

A failure in the middle, including a forced failure, still runs that block. Killing the process (Ctrl-C, or the machine losing power) does not. Clean up by hand. `curl -u admin` prompts for the password; do not put the password on the command line.

```bash
curl -k -u admin \
  https://pikvm.example.ts.net/api/msd
```

Remove only the names this run logged (`hw: image ...` and the fetch name). Do not delete every `mcp-hwtest-*` name. Leftovers that were already on the device are reported and left alone. If one of this run's names is still connected, eject first.

```bash
curl -k -u admin \
  -X POST 'https://pikvm.example.ts.net/api/msd/set_connected?connected=0'

curl -k -u admin \
  -X POST 'https://pikvm.example.ts.net/api/msd/remove?image=mcp-hwtest-TIMESTAMP-RAND.iso'
```

The `hw: snapshot ...` line is the image to put back, with its `connected`, `cdrom`, and `rw` values. Do not remove any other image.

## CI

`npm test` expands `test/*.test.mjs` only. These files live in `test/hw/` and are named `*.hw.test.mjs`, so that glob does not see them. The workflow runs `npm ci`, `npm run typecheck`, and `npm test`. It does not run `npm run test:hw`.

On Node 22.14, `node --test test/hw` from the repo root is a directory import (`"type": "module"`) and does not discover the files. Use `npm run test:hw`, which passes `test/hw/*.hw.test.mjs` and `--test-concurrency=1`. A normal test runs `node --import` of the network guard and `node --test --test-concurrency=1` with its working directory set to `test/hw` and the device variable unset. The TAP reporter does not print file names, so that test uses `test/hw-discovered-reporter.mjs`, which lists each discovered file. The test asserts that `readonly.hw.test.mjs`, `msd.hw.test.mjs`, and `hid.hw.test.mjs` were all discovered, that all 7 tests skipped, and that stdout and stderr together contain no socket or DNS marker. `node --test` copies a child file's stderr onto the runner's stdout, so the marker is not visible on stderr alone.

## Manual checklist

Copy one row per PiKVM. The suite covers a tiny image, not a multi-gigabyte upload.

| PiKVM | Model | kvmd | MSD | free shape | 4 GiB up / URL time | 413? | client timeout? | refusals OK? | cdrom / flash ro / rw | TLS verify / pin / insecure | pin after cert change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1 | | | | | | | | | | | |
