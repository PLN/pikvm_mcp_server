<!-- Modified 2026-10 by PLN: Node.js engines note, GPL-3.0-only licence line, and PIKVM_REQUEST_TIMEOUT_MS (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: MSD upload deadlines (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: cap MSD job at 7 days and idle at 1 hour (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: PIKVM_MCP_ARM_MSD and MSD status, mount, eject (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: mount expectImage and MSD preflight (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: MSD upload jobs and remove (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: hashing jobs, bad-image cleanup, upload try-lock (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: URL fetch allowlist and Tailscale opt-in (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: metadata embeddings, connect timeout, and fetch cleanup (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: deny local NAT64 and non-global wrapped IPv4 (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: connect timeout is independent of the idle timeout (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: connect timeout and DNS map to unreachable (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: pikvm_type delay is milliseconds (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: opt-in hardware suite (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: password and bearer secret files (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: empty secret vars are unset (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: bearer whitespace is HTTP-only (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: TLS verify, pin, and insecure modes (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: pin the leaf, expiry wording, and Node >=22.9.0 (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: kvmd redirects are not followed (GPL-3.0; see NOTICE) -->

# PiKVM MCP Server


[![SonarQube Cloud](https://sonarcloud.io/images/project_badges/sonarcloud-light.svg)](https://sonarcloud.io/summary/new_code?id=kultivator-consulting_pikvm_mcp_server)


[![MCP Badge](https://lobehub.com/badge/mcp/kultivatorconsulting-pikvm_mcp_server?style=plastic)](https://lobehub.com/mcp/kultivatorconsulting-pikvm_mcp_server)




Give AI agents hands. This MCP server connects Claude Code (or any MCP client) directly to a [PiKVM](https://pikvm.org/) device, giving AI full keyboard, mouse, and screen access to a physical machine -- no browser automation, no virtual desktops, no emulators.

Point it at real hardware. Let the AI see the screen, type commands, click buttons, and navigate GUIs on a machine it could never otherwise touch.

<p align="center">
  <img src="assets/simple_setup.jpg" alt="Raspberry Pi 5 connected to a PiKVM V4 Plus" width="600">
  <br>
  <em>A Raspberry Pi 5 controlled via PiKVM V4 Plus -- the AI's physical interface to the real world.</em>
</p>

### Automatic Mouse Calibration

IP-KVM devices translate mouse coordinates through multiple layers — USB HID emulation, host-side input drivers, display scaling — each introducing positional error. Existing KVM products either ignore this (requiring manual correction) or offer limited auto-sync that only detects cursor acceleration in a fixed corner region.

This MCP server takes a different approach. The `pikvm_auto_calibrate` tool uses a vision-based algorithm that:

1. **Moves the cursor** a known distance across multiple randomized screen positions
2. **Diffs screenshot pairs** to isolate the cursor via connected-component analysis
3. **Computes correction factors** from detected vs commanded movement using median aggregation
4. **Self-verifies** by moving to target positions and confirming the cursor lands within 20px

The entire process runs in ~30-60 seconds with no human intervention. Noisy screens (tooltips, animations, dynamic content) are handled through multi-round sampling, ratio divergence filtering, and outlier-resistant statistics — the algorithm discards bad data and still converges on accurate factors.

This is the first IP-KVM tooling — commercial or open source — to implement fully automated mouse coordinate calibration via computer vision. It is what makes precise AI-driven mouse control over a network KVM practical.

### See it in action

The video below shows Claude Code using this MCP server to autonomously interact with a Raspberry Pi desktop: taking a screenshot to identify the OS, opening a text editor from the menu, typing text, and closing the application -- all through the PiKVM hardware interface.

[![Demo Video](https://img.youtube.com/vi/VYE8O1gAs7s/0.jpg)](https://youtu.be/VYE8O1gAs7s)

This next demonstration shows Claude, connected via the PiKVM MCP server, responding to a natural language prompt to auto-calibrate its mouse coordinate scaling before performing a series of precision mouse tasks on a remote machine. The session concludes with Claude autonomously drawing a house in MS Paint — a simple but effective showcase of accurate, AI-driven input control over an isolated system.

[![Demo Video](https://img.youtube.com/vi/kNj8TJD6odo/0.jpg)](https://youtu.be/kNj8TJD6odo)

## Features

- **Automatic mouse calibration** — Vision-based cursor detection computes coordinate correction factors with no manual measurement. The first fully automated calibration for IP-KVM.
- **Screenshot capture** — Get current screen as JPEG image
- **Text typing** — Type text with proper special character handling via keymaps
- **Keyboard control** — Send individual keys or key combinations (e.g., Ctrl+Alt+Delete)
- **Mouse control** — Move, click, and scroll with calibrated coordinate correction

## Installation

```bash
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Edit `.env`:
```
PIKVM_HOST=https://<your-pikvm-ip>
PIKVM_USERNAME=admin
PIKVM_PASSWORD=your_password
PIKVM_VERIFY_SSL=false
PIKVM_TLS_MODE=insecure
PIKVM_DEFAULT_KEYMAP=en-us
PIKVM_REQUEST_TIMEOUT_MS=5000
PIKVM_MSD_JOB_TIMEOUT_MS=21600000
PIKVM_MSD_IDLE_TIMEOUT_MS=60000
```

## Secrets

`PIKVM_PASSWORD` and `PIKVM_MCP_BEARER` are resolved in this order: the direct environment variable, then `<NAME>_FILE`, then `$CREDENTIALS_DIRECTORY/<credential>` when `CREDENTIALS_DIRECTORY` is set. The credential names are `pikvm-password` and `pikvm-mcp-bearer`. A registry device does not use those two variables. Its password is `passwordFile` or `passwordCredential` in the registry JSON.

| Variable | Role |
| --- | --- |
| `PIKVM_PASSWORD` | kvmd password. A non-empty value wins over the file and the credential. An empty value is unset. |
| `PIKVM_PASSWORD_FILE` | Path of a regular file holding the password. An empty value is unset. |
| `PIKVM_MCP_BEARER` | HTTP bearer. A non-empty value wins over the file and the credential. An empty value is unset. Required only when `PIKVM_MCP_PORT` is set. |
| `PIKVM_MCP_BEARER_FILE` | Path of a regular file holding the bearer. An empty value is unset. |
| `CREDENTIALS_DIRECTORY` | systemd `LoadCredential` directory. Consulted only when it is set, and only for a secret that was not set above. A missing credential file means that secret is unset. |

A direct value is used verbatim, including a trailing newline. Only file bytes lose exactly one trailing newline (`\n` or `\r\n`) and a leading UTF-8 BOM. Other whitespace, including a trailing space or a second newline, stays. Empty file content is a startup error. A NUL byte in a file is an error that names the variable and the path. An empty direct value and an empty `*_FILE` are unset and fall through. Symlinks are followed. The file is opened non-blocking and the opened target must be a regular file: a directory, FIFO, socket, or device is rejected, and a FIFO open does not wait. A mode with any group or other bits (looser than `0600`) is warned on stderr, with the variable name, the path, and the mode, never the value. That mode check is skipped on Windows. A file larger than 64 KiB is rejected before the body is read. A missing or unreadable `*_FILE` is a startup error that names the variable and the path. If the direct variable and `*_FILE` are both non-empty, the direct variable wins and one stderr line says the file variable was ignored. In HTTP mode, a bearer with leading or trailing whitespace is rejected at startup. stdio does not use the bearer, so the same value still starts. The error names `PIKVM_MCP_BEARER` and not the value. None of these messages include the secret. A registry `passwordFile` uses this same file reader. `passwordCredential` is one path segment under `CREDENTIALS_DIRECTORY`.

```ini
# /etc/systemd/system/pikvm-mcp.service.d/credentials.conf
[Service]
LoadCredential=pikvm-password:/etc/pikvm/password
LoadCredential=pikvm-mcp-bearer:/etc/pikvm/bearer
Environment=PIKVM_HOST=https://pikvm.example.ts.net
Environment=PIKVM_MCP_PORT=8675
Environment=PIKVM_MCP_NO_DOTENV=1
```

`PIKVM_REQUEST_TIMEOUT_MS` is the abort deadline, in milliseconds, for one ordinary kvmd call. It must be a string of digits from 1 to 600000 (default 5000). `5000abc`, `1e3`, ` 5000 `, `5.5`, and `0` use the default. A value above 600000 is clamped to 600000. An idempotent GET that fails with a network error, a timeout, HTTP 502, or HTTP 503 is tried up to 3 times (backoff 250 ms, then 500 ms, plus a little jitter). POST is not retried. HTTP 500 and 504 are not retried. `GET /streamer/snapshot` retries HTTP 503 once after a 1500 ms grace period, for the ustreamer idle-stop race. That extra try does not use up one of the three attempts, so a snapshot can make at most 4 calls.

`PIKVM_MSD_JOB_TIMEOUT_MS` (default 21600000, six hours) is the wall-clock ceiling for an MSD image upload or URL download. `PIKVM_MSD_IDLE_TIMEOUT_MS` (default 60000) is how long the upload body or the progress stream may sit still. Those two calls do not use `PIKVM_REQUEST_TIMEOUT_MS`, because kvmd does not answer an upload until it has read the body. A value that is not a string of digits, or 0, uses the default. The job ceiling is clamped to 7 days (604800000) and the idle gap to 1 hour (3600000). They are not clamped to the ten-minute ordinary-call cap. `write_remote` `timeout=` is a separate connect timeout (`PIKVM_MSD_URL_CONNECT_TIMEOUT_SEC`, default 30 seconds). It is not this job ceiling.

POST `/hid/*` uses its own ceiling, because kvmd answers only after the input has been applied and a client abort does not cancel that work. `/hid/print` waits `5s + 1.5 × (4·min(length,1024) + 2) × perEventSec + 5s`, and at least 10s. `perEventSec` is the `pikvm_type` `delay` in milliseconds divided by 1000 (50 is sent as 0.05, 200 as 0.2). kvmd reads that query value as seconds. When `delay` is omitted, slow uses 0.02s and otherwise the per-event wait is 0. When that ceiling expires the tool returns `PIKVM_HID_STATE_UNKNOWN` (`input may still be applying; do not resend`) and the call is not retried. A print whose estimate is above 50s is refused before any kvmd call, with a message to shorten the text or lower the delay. With `slow` and no `delay`, that line is 333 characters: 332 still fits under 50s, and 333 does not. kvmd itself accepts up to 1024 characters. PiKVM's nginx likely applies the default 60s `proxy_read_timeout` on `/api/`; that has not been confirmed on hardware. Every other HID POST (key, shortcut, mouse, wheel, reset) uses a fixed 30s ceiling and the same unknown-state error. A connection reset or other socket error after a HID POST was sent is also `PIKVM_HID_STATE_UNKNOWN` and is not retried. A failure before the request is sent, such as connection refused, a connect timeout, or DNS `ENOTFOUND` / `EAI_AGAIN`, stays `PIKVM_UNREACHABLE` and is not retried either. A GET retries those the same way it retries connection refused. An HTTP redirect is `PIKVM_UNEXPECTED_REDIRECT`. GET, POST, HID, and uploads do not follow it, so `X-KVMD-Passwd` is not sent to the `Location` target. The error names the status and the `Location` origin, without the path, the query, or any userinfo.

## TLS

kvmd ships a self-signed certificate. Three modes select how this process checks it. With no registry the device name is `default`. A registry device sets its own `tls.mode`.

| Variable | Role |
| --- | --- |
| `PIKVM_TLS_MODE` | `verify`, `pin`, or `insecure`. Unset follows `PIKVM_VERIFY_SSL` (see below). |
| `PIKVM_TLS_CERT_FILE` | PEM file for `pin`. Required in that mode. A regular file, at most 64 KiB. Opened the same non-blocking way as a secret file. It is not a secret: a loose mode is not warned. |
| `PIKVM_VERIFY_SSL` | Legacy switch. Exactly `true` means `verify`. Any other value, including unset, means `insecure`. Ignored when `PIKVM_TLS_MODE` is set, with one stderr line when the two disagree. |

`verify` uses the system CA store and checks the hostname. A stock self-signed certificate fails with `PIKVM_TLS_VERIFY_FAILED`. `pin` sends the pinned PEM as the only CA, keeps certificate checking on, and compares the leaf SPKI sha256. The hostname is not the identity, so an IP or a name that is not on the certificate still matches when the key matches. A CA-signed leaf is trusted on its own (`allowPartialTrustChain`), which is how a Tailscale or Let's Encrypt certificate works after `pin default`. Pin the leaf only. Pinning a CA or an intermediate fails with `PIKVM_TLS_PIN_MISMATCH`, because that key is not the leaf key. `insecure` turns certificate checks off.

`insecure` is the current default: if `PIKVM_TLS_MODE` is unset and `PIKVM_VERIFY_SSL` is not exactly `true`, the process uses `insecure` and writes one stderr line naming that mode and `pikvm-mcp-server pin default`. That keeps existing self-signed setups working. Switching the default to `pin` or `verify` waits for a later major release. An explicit `PIKVM_TLS_MODE=insecure` logs the same kind of warning. A pin failure or a verify failure is terminal. It is not retried, it is not reported as `PIKVM_UNREACHABLE`, and it never falls back to `insecure`.

Pin a host over Tailscale by reading the certificate once, out of band, and then checking it on every connection:

```bash
export PIKVM_HOST=https://pikvm.example.ts.net
export PIKVM_TLS_CERT_FILE=/etc/pikvm-mcp/default.pem
pikvm-mcp-server pin default
export PIKVM_TLS_MODE=pin
```

`pin default` connects once, with verification disabled only for that handshake. It sends no request and no password. It prints the subject, issuer, validity, SHA-256 certificate fingerprint, and SPKI sha256. On a terminal it writes the file only after you type `yes`. Without a terminal it writes nothing unless you pass `--yes`. `--yes` is for a scripted re-pin after the new certificate was verified out of band. Replacing an existing file prints the old SPKI and the new SPKI first. A file that is already there but is corrupt or not a certificate is shown as `old SPKI sha256: unreadable`, and the command still asks before it writes. The write is a temp file in the same directory, then a rename, mode `0644`. The rename replaces a symlink at `--out` and does not write through it. On POSIX the directory is fsynced after the rename, best-effort. The command writes the leaf only, and it does not run by itself. A pin failure does not run it. An `https://[::1]/` host is connected as `::1` with no SNI name.

An optional alternative is `verify` with a Tailscale certificate. On the PiKVM, `tailscale cert pikvm.example.ts.net` creates a certificate for that MagicDNS name. Trust the Tailscale CA on the machine that runs this server, set `PIKVM_HOST=https://pikvm.example.ts.net` and `PIKVM_TLS_MODE=verify`, and leave `PIKVM_TLS_CERT_FILE` unset. That is a choice, not the default, and it still needs the name on the certificate to match the host.

## Device registry

With `PIKVM_DEVICES_FILE` and `PIKVM_DEVICES` both unset, the server is the single legacy device `default`: `PIKVM_HOST`, `PIKVM_USERNAME`, `PIKVM_PASSWORD` (or `PIKVM_PASSWORD_FILE` or `CREDENTIALS_DIRECTORY/pikvm-password`), `PIKVM_TLS_MODE`, `PIKVM_VERIFY_SSL`, and the arm flags. Nothing in that setup has to change.

Set one of the registry variables to name more than one device. Setting both is a startup error. `PIKVM_DEVICES_FILE` is a JSON file, opened the same non-blocking way as a secret file and capped at 64 KiB. It is not a secret, so a loose mode is not warned. `PIKVM_DEVICES` is the same JSON inline, also capped at 64 KiB. An empty value is unset.

If `PIKVM_HOST` is also set, the registry is used and one stderr line says `PIKVM_HOST` was ignored. The legacy host, password, and TLS mode are not merged into the registry.

`default` must name a device. If it is omitted and there is exactly one device, that device is the default. With several devices, `default` is required. A device name matches `/^[a-z0-9][a-z0-9_-]{0,31}$/`. Unknown fields are a startup error that names the device and the field. A `password` field is rejected; use `passwordFile` or `passwordCredential`. Exactly one of those is required. `passwordFile` is read like any other secret file, including the mode warning. `passwordCredential` is a single path segment in `$CREDENTIALS_DIRECTORY`.

A host is normalised to an http(s) origin. A path, query, or fragment is dropped. Userinfo is an error. There is no IP-range restriction, so a Tailscale `100.64.0.0/10` address or a MagicDNS name is a normal host. `tls.mode` is `verify`, `pin`, or `insecure`. If it is omitted, the device uses `insecure` and stderr names that device and `pikvm-mcp-server pin <device>`. `pin` requires `tls.certFile` and an https origin. `verify` requires https. `PIKVM_TLS_MODE` does not apply to registry devices.

`armHid` and `armMsd` on a device can only narrow the process ceiling. In stdio the ceiling is armed. In HTTP the ceiling is `PIKVM_MCP_ARM_HID` and `PIKVM_MCP_ARM_MSD` (default disarmed). An omitted device flag leaves the ceiling. `true` cannot arm a device the ceiling has disarmed. `msdLocalDir` overrides `PIKVM_MSD_LOCAL_DIR` for that device. `hwTest` must be true before the hardware suite will use the device.

Each device has its own client, busy lock, MSD job lock, calibration, and arm state. Every `pikvm_*` tool except `pikvm_devices` takes an optional `device` argument. Omitted means the registry default. An unknown name is an error that lists the known names and does not open a connection. While a registry is active, tool output names the device that was used. `pikvm_devices` lists names, origins, TLS mode, and arm state. It does not return passwords or secret file paths.

Job ids are random 16-byte hex strings. A job is visible only to the device that created it. Asking for it on another device is the same `unknown job` result as an id that does not exist.

Two Tailscale devices, one pinned and one checked with a Tailscale certificate:

```json
{
  "default": "lab1",
  "devices": {
    "lab1": {
      "host": "https://100.64.0.8",
      "username": "admin",
      "passwordCredential": "pikvm-lab1",
      "tls": { "mode": "pin", "certFile": "/etc/pikvm-mcp/lab1.pem" },
      "armHid": false,
      "armMsd": true,
      "msdLocalDir": "/srv/iso",
      "hwTest": false
    },
    "lab2": {
      "host": "https://pikvm.example.ts.net",
      "username": "admin",
      "passwordCredential": "pikvm-lab2",
      "tls": { "mode": "verify" },
      "armHid": false,
      "armMsd": false,
      "hwTest": true
    }
  }
}
```

`lab2` is `verify` against the MagicDNS name on a Tailscale certificate. Trust that CA on the machine that runs this server. `lab1` is pinned. Create or replace the pin with `pikvm-mcp-server pin lab1`, which connects to `lab1`'s host and writes `tls.certFile` unless `--out` is set. The first pin can run before that file exists. The command still sends no password.

```ini
# /etc/systemd/system/pikvm-mcp.service.d/devices.conf
[Service]
LoadCredential=pikvm-lab1:/etc/pikvm/lab1-password
LoadCredential=pikvm-lab2:/etc/pikvm/lab2-password
Environment=PIKVM_DEVICES_FILE=/etc/pikvm-mcp/devices.json
Environment=PIKVM_MCP_PORT=8675
Environment=PIKVM_MCP_NO_DOTENV=1
```

systemd sets `CREDENTIALS_DIRECTORY` for those credential names. Do not also set `PIKVM_HOST` or `PIKVM_PASSWORD` for these devices.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PIKVM_DEVICES_FILE` | unset | Path of the registry JSON. A regular file, at most 64 KiB. Not a secret. |
| `PIKVM_DEVICES` | unset | The same JSON inline. Ignored when empty. An error when the file is also set. |
| `PIKVM_HW_TEST_DEVICE` | unset | Hardware suite device. `default` in legacy mode. In registry mode the device must set `hwTest` true. |

`pikvm-mcp-server pin <device>` accepts a registry name. With no registry, a name other than `default` is still an error.

kvmd regenerates its self-signed certificate when the PiKVM is reinstalled. The next call then fails with `PIKVM_TLS_PIN_MISMATCH`. The message names device `default`, the expected SPKI sha256, and the presented SPKI sha256. The process does not retry the call, does not try `insecure`, and does not rewrite the pin file. A chain failure whose OpenSSL code is outside the usual set, including an invalid CA or a path-length failure, is still `PIKVM_TLS_VERIFY_FAILED` or `PIKVM_TLS_PIN_MISMATCH`. It is not `PIKVM_UNREACHABLE` and it is not retried.

An expired pinned certificate stays rejected with `PIKVM_TLS_VERIFY_FAILED`. The message says the certificate has expired. Regenerate or renew the kvmd certificate, then pin the new certificate. Pinning the expired certificate again does not make it valid.

1. Read both fingerprints in the error. They are public; the password is not logged.
2. Compare the presented fingerprint out of band, on a channel you already trust.
3. Run `pikvm-mcp-server pin default`. Confirm the old and new SPKI values and type `yes`, or pass `--yes` only after that out-of-band check.
4. Restart the server so it reads the new `PIKVM_TLS_CERT_FILE`.

## HTTP Mode (remote / gateway deployments)

By default the server speaks stdio (spawned directly by an MCP client on the
same machine). Set `PIKVM_MCP_PORT` to serve MCP over the
[Streamable HTTP transport](https://modelcontextprotocol.io) instead — the
mode used when a gateway exposes the device to off-box agents:

```bash
PIKVM_MCP_PORT=8675
PIKVM_MCP_HOST=127.0.0.1
PIKVM_MCP_BEARER=<openssl rand -hex 32>
PIKVM_MCP_ARM_HID=0
PIKVM_MCP_ARM_MSD=0
PIKVM_MCP_NO_DOTENV=0
```

- **`PIKVM_MCP_PORT`** — enables HTTP mode. The endpoint is `/mcp` (MCP
  Streamable HTTP; initialize first, then send `mcp-session-id` on every
  request, `DELETE /mcp` to end the session; idle sessions are reaped after
  24h with an hourly sweep). `GET /healthz` returns `200 ok`
  unauthenticated for supervision scripts.
- **`PIKVM_MCP_HOST`** — bind address, default `127.0.0.1`. Set it to a
  specific interface address (e.g. the docker bridge gateway IP `172.17.0.1`)
  if a containerized reverse proxy needs to reach the instance from outside
  host loopback. Avoid wildcard binds (`0.0.0.0`) — bind only the interface
  the proxy actually uses.
- **`PIKVM_MCP_BEARER`** — required token for every `/mcp` request
  (`Authorization: Bearer <token>`), on POST, GET, and DELETE alike. HTTP
  mode **refuses to start** without it. The refusal names `PIKVM_MCP_BEARER`,
  `PIKVM_MCP_BEARER_FILE`, and `CREDENTIALS_DIRECTORY/pikvm-mcp-bearer`.
  An empty `PIKVM_MCP_BEARER` does not stop stdio mode. Leading or trailing
  whitespace on the configured bearer is rejected at startup, by name only.
  Missing or incorrect tokens get `401` +
  `WWW-Authenticate: Bearer`. Comparison is constant-time (sha256 digests +
  `crypto.timingSafeEqual`), and the token is never written to logs.
  `PIKVM_MCP_BEARER_FILE` or `CREDENTIALS_DIRECTORY/pikvm-mcp-bearer` can
  supply it instead. See Secrets above.
- **`PIKVM_MCP_ARM_HID`** — the HID arm-gate. HTTP mode defaults to
  **disarmed**: every HID-mutating tool (`pikvm_type`, `pikvm_key`,
  `pikvm_shortcut`, `pikvm_mouse_move`, `pikvm_mouse_click`,
  `pikvm_mouse_scroll`, `pikvm_calibrate`, `pikvm_auto_calibrate`) returns a
  typed error naming this variable and no HID events reach the device.
  Read-only tools (`pikvm_screenshot`, `pikvm_get_resolution`,
  `pikvm_get/set/clear_calibration`) stay available. Set `1` to arm. stdio
  mode is never gated — local callers gate on their own side.
- **`PIKVM_MCP_ARM_MSD`** — the MSD arm-gate, separate from HID. HTTP mode
  defaults to **disarmed**: every `pikvm_msd_*` tool except the read-only
  allowlist (`pikvm_msd_status`, `pikvm_msd_job`) returns a typed error naming
  this variable and no mass-storage change reaches the device.
  `PIKVM_MCP_ARM_HID=1` does not arm them. Set `1` to arm. stdio mode is never gated.
- **`PIKVM_MSD_LOCAL_DIR`** — directory `pikvm_msd_upload` may read, by bare
  file name only. Unset hides that tool.
- **`PIKVM_MSD_MAX_BYTES`** — per-transfer cap. Default 16 GiB.
- **`PIKVM_MSD_URL_ALLOWLIST`** — comma-separated entries. An https entry is
  `https://host[:port]/path-prefix` (`https://images.example/iso` matches that
  path and its children, not `isotope`). A Tailscale opt-in is a CIDR inside
  `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, for example `100.64.0.0/10` or
  `100.101.102.103/32`. A CIDR does not match URLs by itself; the https entry
  still has to match, and every resolved address in those ranges must fall in
  one of the CIDRs. A CIDR whose first or last address is always denied,
  such as `100.100.100.100/32`, is rejected when the config loads, and
  the error names that entry. No https entry hides `pikvm_msd_fetch_url`.
- **`PIKVM_MSD_URL_ALLOW_PRIVATE`** — `1` allows an allowlisted host to resolve
  to loopback, unspecified (`0.0.0.0/8`, `::`), RFC1918, other ULA (`fc00::/7`
  outside the Tailscale range), multicast, or broadcast. It does not allow
  Tailscale/CGNAT (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`); those need a CIDR
  opt-in. Link-local and metadata stay denied even when this is `1` and even
  when the host is allowlisted: `169.254.0.0/16`, `fe80::/10`, the AWS IPv6
  metadata address `fd00:ec2::254`, Tailscale's own service addresses
  `100.100.100.100`, `100.100.100.200`, and `fd7a:115c:a1e0::53`, the whole
  local-use NAT64 prefix `64:ff9b:1::/48`, and the IPv4-mapped forms of
  every denied range. `64:ff9b:1::/48` is denied outright and is not
  decoded. IPv4 embedded in `::/96` (other than `::` and `::1`),
  `64:ff9b::/96`, or `2002::/16` is allowed only when that IPv4 is a
  global public address. `ALLOW_PRIVATE` and a Tailscale CIDR do not
  cover a wrapped form. An IPv4-mapped address (`::ffff:`) is the socket
  form of a plain IPv4 address and follows the plain rules. Reserved and documentation
  ranges stay denied too (`240.0.0.0/4`, `198.18.0.0/15`, `192.0.0.0/24`,
  `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `fec0::/10`,
  `2001:db8::/32`). A literal allowlist host in an always-denied range is
  rejected when the config loads. That error names the entry with
  userinfo and the query removed. Default `0`.
- **`PIKVM_MSD_URL_CONNECT_TIMEOUT_SEC`** — connect timeout sent to kvmd as
  `write_remote` `timeout=` (aiohttp `sock_connect`). Digits only, default
  30, clamped to 120. A value that is not a string of digits uses the
  default and logs a warning. `0` and an empty value use the default
  quietly. This timer is not clamped to `PIKVM_MSD_IDLE_TIMEOUT_MS`
  (default 60 seconds). They measure different things: this is how long
  aiohttp may spend opening the connection, and the idle timeout is how
  long the progress stream may sit silent. The job wall clock stays
  `PIKVM_MSD_JOB_TIMEOUT_MS`.
- **Redirect and DNS.** A trailing dot on a hostname is removed before
  DNS and before the URL is sent, so both use the same host. The MCP
  host's DNS answers can differ from the PiKVM's. kvmd (aiohttp) follows
  up to 10 redirects, including an https to
  http downgrade, and resolves DNS itself. This server does not send a
  `redirect: 'manual'` HEAD before the download. Allowlist only
  operator-controlled hosts that do not redirect. A name that changes
  address after the check can still be fetched by kvmd. kvmd logs the full
  URL, including userinfo and the query string, in the PiKVM journal. Error
  text from this server drops both.
- **`PIKVM_MCP_NO_DOTENV`** — set `1` to skip `.env` loading entirely (for
  systemd/gateway units that export env directly; a stray `.env` on disk must
  not win). Only read from the real process environment, so a `.env` cannot
  enable it for itself. Even without it, explicitly-set process env always
  beats `.env` values — dotenv uses `override: false`, so `.env` only fills
  variables the caller did not set.

Quick smoke test:

```bash
# 401 without a token
curl -i -X POST http://localhost:8675/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 200 initialize with the token
curl -i -X POST http://localhost:8675/mcp \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

### Security notes

- Bearer auth is mandatory in HTTP mode by design: the server can move real
  hardware, and an unauthenticated network listener would let anyone type on
  the machine it is connected to.
- Keep the HTTP server behind a trusted network (WireGuard/VPN); bearer-only
  transport is not a substitute for network isolation.
- Run with `PIKVM_MCP_ARM_HID=0` and `PIKVM_MCP_ARM_MSD=0` unless the
  deployment is explicitly supposed to drive HID or change virtual media;
  arming is a per-deployment, explicit decision.
- Bind defaults to `127.0.0.1`; widen it only when a local proxy/gateway
  actually needs the network, and front with a reverse proxy for TLS
  termination or origin/host filtering.
- No SSE streams: POSTs always return a single JSON body and the standalone
  GET SSE stream answers 405. Long-lived SSE connections are killed by
  Cloudflare's edge (and similar proxies), so keeping every MCP exchange a
  plain HTTP round-trip is the CF-safe configuration.
- `/healthz` is intentionally unauthenticated and will be reachable through
  any proxy in front of the server. It returns only the constant body `ok`
  on GET — no state, version, or device information — so public exposure is
  limited to a liveness oracle. Gate it at the proxy if you don't want even
  that.

## Usage with Claude Code

> **Node.js:** `engines` is `>=22.9.0`. Pin mode sets `allowPartialTrustChain`, which Node added in 22.9.0, so a CA-signed leaf can be the pin. Node.js 20 is end-of-life. The runtime dependency undici 7.24.1 needs Node.js >=20.18.1, and `npm test` quotes a glob that `node --test` expands only on Node.js 21 and later. This server uses ES modules. If `node --version` shows an older version, replace `"command": "node"` with the full path to a compatible binary (e.g. `"/usr/local/bin/node"` or your nvm path like `"~/.nvm/versions/node/v22.x.x/bin/node"`). This is common when nvm's default alias points to an older version.

Add to your Claude Code MCP settings (`~/.config/claude-code/settings.json` or via the settings UI):

```json
{
  "mcpServers": {
    "pikvm": {
      "command": "node",
      "args": ["/path/to/pikvm_mcp_server/dist/index.js"],
      "env": {
        "PIKVM_HOST": "https://<your-pikvm-ip>",
        "PIKVM_USERNAME": "admin",
        "PIKVM_PASSWORD": "your_password"
      }
    }
  }
}
```

Or if using the .env file:

```json
{
  "mcpServers": {
    "pikvm": {
      "command": "node",
      "args": ["/path/to/pikvm_mcp_server/dist/index.js"]
    }
  }
}
```

## Available Tools

### Display
- **`pikvm_screenshot`** - Capture current screen as JPEG (optional: maxWidth, maxHeight, quality)
- **`pikvm_get_resolution`** - Get screen resolution and valid coordinate ranges

### Keyboard
- **`pikvm_type`** - Type text with keymap-aware special character handling (required: text; optional: keymap, slow, delay)
- **`pikvm_key`** - Send a key or key combo, e.g. Ctrl+Alt+Del (required: key; optional: modifiers, state)
- **`pikvm_shortcut`** - Send multiple keys pressed simultaneously (required: keys array)

### Mouse
- **`pikvm_mouse_move`** - Move cursor to absolute pixel position or relative delta (required: x, y; optional: relative)
- **`pikvm_mouse_click`** - Click a mouse button, optionally at a position (optional: button, x, y, state)
- **`pikvm_mouse_scroll`** - Scroll the mouse wheel (required: deltaY; optional: deltaX)

### Calibration
- **`pikvm_auto_calibrate`** - Automatically detect cursor and compute calibration factors *(preferred)*
- **`pikvm_calibrate`** - Start manual calibration by moving cursor to screen center for visual verification
- **`pikvm_set_calibration`** - Apply correction factors calculated from calibration (required: factorX, factorY)
- **`pikvm_get_calibration`** - Get current calibration state
- **`pikvm_clear_calibration`** - Reset to uncalibrated mode

### Mass storage
- **`pikvm_msd_status`** - Read mass-storage state (optional: device). Read-only.
- **`pikvm_msd_mount`** - Select an image and connect the virtual drive (required: image, mode `cdrom` or `flash`, confirmImage; optional: rw, connect, expectImage, device). `confirmImage` must equal `image`. When a drive is already connected, `expectImage` must equal that image or the mount is refused and the drive stays connected. An `expectImage` supplied while the drive is disconnected must equal the snapshot image too. The image must already be in storage and complete. A mount of an image that has an active upload or fetch is refused with `MsdImageTransferError` and no POST. Returns the drive re-read after the change. On failure the previous selection is restored. An NBD or URL snapshot image cannot be restored, because `set_params` refuses a name that contains `://`.
- **`pikvm_msd_eject`** - Disconnect the virtual drive (required: expectImage; optional: device). `expectImage` must equal the current image name, or `""` when none is selected. A second eject returns `alreadyDisconnected`. Any other kvmd error is returned as an error.
- **`pikvm_msd_upload`** - Upload a bare file name from `PIKVM_MSD_LOCAL_DIR` (required: file, confirmImage; optional: sha256, device). Returns `{jobId}` immediately after the file is confined. Hashing and the kvmd pre-check run in the job (`hashing`, then `running`). A sha256 mismatch fails the job and makes no upload POST. A second upload or fetch while one is running is refused. If a check after the stream fails, the stored image is removed. `PIKVM_MSD_STATE_UNKNOWN` from `msdWrite` or `msdWriteRemote` skips that cleanup by design: the server does not know whether kvmd kept the image. The transfer does not change the drive. Hidden while `PIKVM_MSD_LOCAL_DIR` is unset.
- **`pikvm_msd_fetch_url`** - Download an allowlisted https URL with kvmd `write_remote` (required: url, confirmImage; optional: image, device). Returns `{jobId}` immediately after the URL and image name are accepted. `image` defaults to the URL's last path segment and uses the same bare-name rules as upload. `confirmImage` must equal that name. The job sends `remove_incomplete=1`, `verify=1` (`insecure` is never sent), and `timeout=` from `PIKVM_MSD_URL_CONNECT_TIMEOUT_SEC` (the downloader connect timeout, default 30 seconds). The job wall clock stays `PIKVM_MSD_JOB_TIMEOUT_MS`. NDJSON progress becomes `bytes` and `total`. DNS, the address check, and the kvmd pre-check run in the job. A fragment is not sent. Cleanup of an incomplete image runs only after an NDJSON progress line for this image. A short stream is `PIKVM_MSD_STATE_UNKNOWN` from `msdWriteRemote` and skips cleanup; `written != size` is not a separate cleanup signal. `MsdUnknownImageError` from remove means kvmd already deleted the file. Hidden while the allowlist has no https entry. Gated by `PIKVM_MCP_ARM_MSD`. https only.
- **`pikvm_msd_job`** - Read that job: `{state, bytes, total, sha256?, error?, removed?, removeError?}`. `state` is `hashing`, `running`, `done`, or `failed`. Finished jobs are dropped after 24 hours. Read-only.
- **`pikvm_msd_remove`** - Remove a stored image (required: image, confirmImage; optional: device). Refuses while the drive is connected and does not disconnect it.

In HTTP mode, MSD changes stay disarmed until `PIKVM_MCP_ARM_MSD=1`. Status and job stay available. stdio is not gated. Mount and eject share one lock per device. A second upload or fetch fails immediately instead of queueing, and a transfer does not queue mount or eject. Logs for a fetch are one JSON line and do not include URL userinfo or the query string. Error text has URL userinfo and the query string removed. kvmd logs the full URL in the PiKVM journal.

## Skills (Prompts & Skill Tools)

The server exposes 15 skills that provide structured guidance for agents. Each skill is available via **two discovery paths**:

- **MCP Prompts** — `prompts/list` / `prompts/get` for clients that support the Prompts capability.
- **Skill Tools** — `tools/list` / `tools/call` as `skill_*` read-only tools, ensuring visibility in marketplaces (e.g. LobeHub) that index tools only.

### Tool Guides

| Prompt Name | Skill Tool | Description |
|---|---|---|
| `take-screenshot` | `skill_take_screenshot` | Capturing screenshots with pikvm_screenshot |
| `check-resolution` | `skill_check_resolution` | Checking screen resolution with pikvm_get_resolution |
| `type-text` | `skill_type_text` | Typing text with pikvm_type |
| `send-key` | `skill_send_key` | Sending keys with pikvm_key |
| `send-shortcut` | `skill_send_shortcut` | Sending keyboard shortcuts with pikvm_shortcut |
| `move-mouse` | `skill_move_mouse` | Moving the mouse with pikvm_mouse_move |
| `click-element` | `skill_click_element` | Clicking with pikvm_mouse_click |
| `scroll-page` | `skill_scroll_page` | Scrolling with pikvm_mouse_scroll |
| `auto-calibrate` | `skill_auto_calibrate` | Automatic mouse calibration with pikvm_auto_calibrate |

### Workflow Recipes

| Prompt Name | Skill Tool | Arguments | Description |
|---|---|---|---|
| `setup-session-workflow` | `skill_setup_session_workflow` | — | Initialize a PiKVM session |
| `calibrate-mouse-workflow` | `skill_calibrate_mouse_workflow` | — | Calibrate mouse coordinates |
| `click-ui-element-workflow` | `skill_click_ui_element_workflow` | `element_description` (required) | Find and click a UI element |
| `fill-form-workflow` | `skill_fill_form_workflow` | `form_description` (optional) | Fill in a form on screen |
| `navigate-desktop-workflow` | `skill_navigate_desktop_workflow` | `goal` (required) | Navigate a desktop environment |
| `auto-calibrate-mouse-workflow` | `skill_auto_calibrate_mouse_workflow` | — | Automatic mouse calibration |

See [`docs/skills/`](docs/skills/) for detailed human-readable guides.

## Key Codes Reference

Common key codes for `pikvm_key` and `pikvm_shortcut`:

- Letters: `KeyA`, `KeyB`, ... `KeyZ`
- Numbers: `Digit0`, `Digit1`, ... `Digit9`
- Function keys: `F1`, `F2`, ... `F12`
- Modifiers: `ShiftLeft`, `ShiftRight`, `ControlLeft`, `ControlRight`, `AltLeft`, `AltRight`, `MetaLeft`, `MetaRight`
- Special: `Enter`, `Escape`, `Backspace`, `Tab`, `Space`, `Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown`
- Arrows: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`

## Hardware suite

Opt-in checks against one real PiKVM. They are not part of `npm test` and CI does not run them. See [test/hw/README.md](test/hw/README.md) for the environment variables, the read-only / MSD / HID levels, and cleanup.

## License

GPL-3.0-only. See [LICENSE](LICENSE) for the licence text and [NOTICE](NOTICE) for origins and the modification log. No later-version grant is stated.
