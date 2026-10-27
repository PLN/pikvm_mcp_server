<!-- Modified 2026-10 by PLN: systemd guide (GPL-3.0; see NOTICE) -->

# Running the server under systemd

The Docker image ([docker.md](docker.md)) is the default deployment. A plain install under systemd stays supported. It needs Node.js 22.9.0 or later on the host (see "Usage with Claude Code" in [README.md](../README.md)) and, for `pikvm_read_text`, the system `tesseract` binary.

Build from a checkout:

```bash
npm ci
npm run build
```

Run `node /path/to/pikvm_mcp_server/dist/index.js` from the unit's `ExecStart=`. The variables are the same as in [README.md](../README.md). Set `PIKVM_MCP_NO_DOTENV=1` in a unit, so a stray `.env` next to the build cannot change the configuration.

## Secrets with `LoadCredential`

`PIKVM_PASSWORD` and `PIKVM_MCP_BEARER` are read from `$CREDENTIALS_DIRECTORY/pikvm-password` and `$CREDENTIALS_DIRECTORY/pikvm-mcp-bearer` when they are not set directly or through `*_FILE`. systemd sets `CREDENTIALS_DIRECTORY` for the credentials a unit loads:

```ini
# /etc/systemd/system/pikvm-mcp.service.d/credentials.conf
[Service]
LoadCredential=pikvm-password:/etc/pikvm/password
LoadCredential=pikvm-mcp-bearer:/etc/pikvm/bearer
Environment=PIKVM_HOST=https://pikvm.example.ts.net
Environment=PIKVM_MCP_PORT=8675
Environment=PIKVM_MCP_NO_DOTENV=1
```

`LoadCredential` files are often mode `0440` because of an ACL mask. That group bit is not warned for a direct child of a credentials directory under `/run/credentials/<name>/`; the exact conditions are in the Secrets section of [README.md](../README.md).

## A device registry

Each registry device names its password with `passwordCredential`, one credential per device:

```ini
# /etc/systemd/system/pikvm-mcp.service.d/devices.conf
[Service]
LoadCredential=pikvm-lab1:/etc/pikvm/lab1-password
LoadCredential=pikvm-lab2:/etc/pikvm/lab2-password
Environment=PIKVM_DEVICES_FILE=/etc/pikvm-mcp/devices.json
Environment=PIKVM_MCP_PORT=8675
Environment=PIKVM_MCP_NO_DOTENV=1
```

Do not also set `PIKVM_HOST` or `PIKVM_PASSWORD` for these devices. `pikvm-mcp-server pin <device>` writes each device's `tls.certFile`, so that directory must be writable by whoever runs it.

## Hardening

Do not set `MemoryDenyWriteExecute=yes`: Node's JIT needs writable and executable memory, and the server will not start. Other sandboxing options (`ProtectSystem=`, `PrivateTmp=`, `NoNewPrivileges=` and so on) are not tested here yet; check the unit still starts, pins and uploads after adding them.

## Stopping

`systemctl stop` sends SIGTERM. A finished shutdown exits 0; the process exits 1 if shutdown takes longer than eight seconds. A `TimeoutStopSec=` of 30 seconds leaves room for that.
