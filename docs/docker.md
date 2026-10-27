<!-- Modified 2026-10 by PLN: Docker guide (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: the image is published; verify and build sections (GPL-3.0; see NOTICE) -->
<!-- Modified 2026-10 by PLN: image 0.4.1; gh attestation verify needs a login (GPL-3.0; see NOTICE) -->

# Running the server in Docker

Images are published to `ghcr.io/pln/pikvm_mcp_server` for `linux/amd64` and `linux/arm64`, with the tags `X.Y.Z`, `X.Y` and `latest`. To build the image yourself instead, see the end of this guide.

The image runs the server as uid 10001 under `tini`. `compose.yaml` adds a read-only root filesystem, drops every capability and sets `no-new-privileges`; the `docker run` example below uses the first two as well. Everything the server keeps lives in one `/data` volume. It includes `tesseract` with English data, so `pikvm_read_text` is available by default. `npm` is not in the image.

Use Docker Engine 28.3.3 or later. Before 28.0, a port published to `127.0.0.1` could be reached by other hosts on the same network segment, and 28.2.x to 28.3.2 have a firewalld-reload advisory. Do not set `DOCKER_INSECURE_NO_IPTABLES_RAW=1`. Docker Desktop is not affected.

## Quick start (Compose, HTTP)

From a checkout of this repository, or a directory holding `compose.yaml`:

```bash
umask 077
echo 'PIKVM_HOST=https://pikvm.example.net' > .env
openssl rand -hex 32 > bearer.txt          # the MCP client needs this token
docker compose run --rm -T --entrypoint sh pikvm-mcp -c 'umask 077; cat > /data/secrets/pikvm-mcp-bearer' < bearer.txt
printf '%s' 'the-kvmd-password' | docker compose run --rm -T --entrypoint sh pikvm-mcp -c 'umask 077; cat > /data/secrets/pikvm-password'
docker compose run --rm pikvm-mcp pin default   # compare the fingerprint with the PiKVM web UI, then type yes
docker compose up -d
```

`compose.yaml` sets `PIKVM_TLS_MODE: pin`, so a start without a pin file exits 78 with `run: pin default` rather than a bare file error. `restart: unless-stopped` keeps retrying it until the pin exists or you stop the service. The server listens on `http://127.0.0.1:8675/mcp`. Check it with `curl -s http://127.0.0.1:8675/healthz` (answers `ok`) and `docker compose ps` (healthy after up to 60 s).

Connect Claude Code:

```bash
claude mcp add --transport http pikvm http://127.0.0.1:8675/mcp --header "Authorization: Bearer $(cat bearer.txt)"
```

HID and MSD tools stay disarmed in HTTP mode until you set `PIKVM_MCP_ARM_HID: "1"` or `PIKVM_MCP_ARM_MSD: "1"` in `compose.yaml`.

## stdio instead of HTTP

An MCP client can start the container itself:

```bash
claude mcp add pikvm -- docker run -i --rm --read-only --cap-drop ALL -v pikvm-data:/data -e PIKVM_HOST=https://pikvm.example.net ghcr.io/pln/pikvm_mcp_server:0.4.1
```

Stdout carries only the protocol; logs go to stderr. The process exits when the client closes stdin. **stdio has no process-level arm gate: `PIKVM_MCP_ARM_HID` and `PIKVM_MCP_ARM_MSD` do not apply, and HID and MSD tools are armed** unless a registry device sets `armHid` or `armMsd` to `false`. The password comes from `/data/secrets/pikvm-password` in that volume. Compose prefixes its volumes with the project name (for example `pikvm_mcp_server_pikvm-data`), so `pikvm-data` here is a separate volume unless you name the Compose one.

## The `/data` volume

```
/data                      owned by uid 10001, mode 0750 in the image
├── devices.json           optional device registry
├── secrets/               one file per secret, mode 0600
├── tls/                   pinned certificates (written by pin), optional ca.pem
└── images/                ISO and IMG files for pikvm_msd_upload, read only
```

A new named volume takes the ownership and mode of the image directories on first use. The entrypoint also creates `secrets/`, `tls/` and `images/` when they are missing, for a bind mount. Paths inside `devices.json` (`passwordFile`, `tls.certFile`, `msdLocalDir`) must be absolute container paths, such as `/data/secrets/lab1-password`. A relative path would point into `/app`, which is read-only.

The server writes nothing at runtime except `pin`, which writes the certificate file. Calibration, jobs and HTTP sessions are kept in memory and are lost on restart; MCP clients reconnect.

## Defaults the entrypoint fills in

The entrypoint sets a variable only when it is unset or empty, and logs each default it applies (the variable and the path, never a value). Anything you set yourself wins.

| Variable | Default | When |
| --- | --- | --- |
| `PIKVM_MCP_BEARER_FILE` | `/data/secrets/pikvm-mcp-bearer` | the file exists and `PIKVM_MCP_BEARER` is unset |
| `PIKVM_PASSWORD_FILE` | `/data/secrets/pikvm-password` | the file exists and `PIKVM_PASSWORD` is unset |
| `PIKVM_DEVICES_FILE` | `/data/devices.json` | the file exists and `PIKVM_DEVICES`, `PIKVM_DEVICES_FILE` and `PIKVM_HOST` are all unset |
| `PIKVM_MSD_LOCAL_DIR` | `/data/images` | the directory exists |
| `PIKVM_TLS_CERT_FILE` | `/data/tls/default.pem` | `PIKVM_TLS_MODE` is `pin`, or the first argument is `pin` |
| `NODE_EXTRA_CA_CERTS` | `/data/tls/ca.pem` | the file exists and holds a certificate |

The image itself sets `PIKVM_MCP_HOST=0.0.0.0` (inside the container's own network namespace), `PIKVM_MCP_NO_DOTENV=1` and `PIKVM_OCR_TESSERACT_BIN=/usr/bin/tesseract`. Every other variable in [README.md](../README.md) passes through unchanged.

The entrypoint exits with a message naming the cause, rather than a bare error, when the following holds. A restart policy still retries the container; fix the cause or stop the service.

| Exit | Cause |
| --- | --- |
| 78 | `/data` is not readable by the container user; or `PIKVM_TLS_MODE=pin` and the pin file does not exist |
| 64 | `PIKVM_MCP_PORT` is set but is not a number from 1 to 65535 (empty means stdio) |

`compose.yaml` reads an optional `.env` next to it. Put only the variables you need there. Do not copy `.env.example` wholesale: its `PIKVM_PASSWORD=your_password` line would override the password file.

## A registry instead of `PIKVM_HOST`

Write `/data/devices.json` (see the device registry in [README.md](../README.md)), leave `PIKVM_HOST` unset, and put each password in its own file:

```json
{
  "default": "lab1",
  "devices": {
    "lab1": {
      "host": "https://pikvm.example.net",
      "username": "admin",
      "passwordFile": "/data/secrets/lab1-password",
      "tls": { "mode": "pin", "certFile": "/data/tls/lab1.pem" }
    }
  }
}
```

Pin each device with `docker compose run --rm pikvm-mcp pin lab1`. `PIKVM_TLS_MODE` applies only to the single legacy device, so the registry ignores the one in `compose.yaml`.

## ISO images elsewhere

Mount a host directory over `/data/images`, read-only:

```yaml
    volumes:
      - pikvm-data:/data
      - /srv/isos:/data/images:ro
```

Files must be readable by uid 10001 (world-readable, or owned by it). An unreadable file shows up as "upload path rejected". A symlink pointing outside the directory is refused. Alternatively set `PIKVM_MSD_LOCAL_DIR=/isos` and mount the directory at `/isos`; a registry device's `msdLocalDir` overrides both.

## File ownership and permission warnings

Secret files with group or other bits set produce a warning on stderr; nothing is refused, changed or copied. A file the container user cannot read is a startup error that names the variable and the path.

| Setup | Result |
| --- | --- |
| Named volume, files written as uid 10001 with `umask 077` (the quick start) | Silent. Recommended. |
| Bind-mounted `./data`, `user: "1000:1000"` matching the host owner | Silent with mode `0600`; `0644` warns "group or other bits are set", `0640` warns "group bits are set". |
| Bind mount owned by another user, container as 10001 | `cannot read (EACCES)`; or exit 78 first when `/data` itself is `0700`. Fix `user:` or `chown -R 10001:10001`. |
| Compose `secrets:` with `file:` | Mounted at `/run/secrets/<name>` with the host file's owner and mode (Compose ignores `uid`, `gid` and `mode` for file sources). Set `PIKVM_PASSWORD_FILE=/run/secrets/<name>`. |
| Docker Desktop bind mounts | Modes often look like `0755`; the warnings are noise. |

`devices.json` is not a secret and is not mode-checked, so never put a password in it. `ca.pem` is public and is not mode-checked either, but must be readable by uid 10001.

## Exposure

The image binds `0.0.0.0` inside its container, which is what makes a published port reachable. That is safe because HTTP mode refuses to start without a bearer, HID and MSD are disarmed unless armed, and `compose.yaml` publishes on `127.0.0.1` only. `ports: ["8675:8675"]` without an address would publish on every interface.

From most to least contained:

1. Loopback publish and a client on the same host (`compose.yaml`).
2. Tailscale sidecar, no published ports (`compose.tailscale.yaml`, below).
3. A TLS reverse proxy in front, with the bearer still required.
4. Never publish it on a public interface.

The bearer is the real control. Use at least 32 random bytes (`openssl rand -hex 32`); the server accepts any non-blank token and has no rate limit. `GET /healthz` is unauthenticated and answers only `ok`. `HEAD /healthz` gets 401, so a proxy must probe with GET.

## Tailscale

`compose.tailscale.yaml` runs the server inside the network namespace of a `tailscale/tailscale` sidecar. `tailscale serve` terminates HTTPS on the tailnet and forwards to the server on `127.0.0.1:8675`; no ports are published.

```bash
mkdir -p secrets ts-config
umask 077; printf '%s' '<auth key from the Tailscale admin console>' > secrets/ts-authkey
cat > ts-config/serve.json <<'EOF'
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": { "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8675" } } } }
}
EOF
```

Write the bearer, password and pin into the volume as in the quick start, using `docker compose -f compose.tailscale.yaml run ...`, then `docker compose -f compose.tailscale.yaml up -d`. With `-f`, Compose does not read `compose.override.yaml` on its own, so for a local build add `-f compose.override.yaml` after `-f compose.tailscale.yaml`. The client URL is `https://pikvm-mcp.<tailnet>.ts.net/mcp`. See Tailscale's documentation for `serve` configuration.

Things to know:

- **Kernel mode.** The sidecar runs with `TS_USERSPACE=false`, `/dev/net/tun` and `NET_ADMIN`. The server's kvmd client does not use a proxy, so a userspace sidecar cannot reach a PiKVM that is itself on the tailnet. The server container keeps all capabilities dropped.
- **Names.** MagicDNS names may not resolve inside the shared namespace. In `pin` mode use the PiKVM's tailnet IP: the pin checks the key, not the name. In `verify` mode the name must be on the certificate, so check `getent hosts <name>` from the server container first.
- **Recreate both.** Recreating only the sidecar leaves the server in a dead namespace. Use `docker compose -f compose.tailscale.yaml up -d --force-recreate`.
- **Auth key.** `TS_AUTHKEY=file:/run/secrets/ts-authkey` reads the key from the Compose secret. Never put the key in `environment:` or a committed `.env`. `TS_AUTHKEY_FILE` does not exist.
- The sidecar setup is not exercised by CI; only the Compose file is validated.

On a Linux host that already runs Tailscale, an alternative is `network_mode: host` with `PIKVM_MCP_HOST=127.0.0.1` and `tailscale serve` on the host (not on Docker Desktop).

## Certificates

**Pin (recommended).** `docker compose run --rm pikvm-mcp pin default` connects once, prints the certificate, and writes `/data/tls/default.pem` after you type `yes` (Compose `run` allocates a terminal). For a scripted re-pin after checking the new certificate out of band, add `--yes`. A pinned host is checked by its key, so an IP address works.

**Private CA with `verify`.** Node verifies against its bundled CA roots, not the host's store. To trust a private CA, put its certificate at `/data/tls/ca.pem`:

```bash
docker compose run --rm -T --entrypoint sh pikvm-mcp -c 'cat > /data/tls/ca.pem' < ca.pem
```

and set `PIKVM_TLS_MODE: verify`. The entrypoint exports `NODE_EXTRA_CA_CERTS=/data/tls/ca.pem` only when the file contains a certificate. The CA is trusted process-wide, for every device in a registry; a per-device pin stays the narrower choice. It is read once at start, so a new CA needs a restart. A trust failure shows at startup only as "Could not authenticate"; the first tool call returns `PIKVM_TLS_VERIFY_FAILED`.

## Upgrades and rollback

Pin `X.Y.Z` (or `@sha256:...`) in production. Upgrade with `docker compose pull && docker compose up -d`; roll back by pointing `image:` at the older tag or digest. Nothing in `/data` changes between versions. HTTP sessions do not survive a restart, so MCP clients reconnect. The tags are `X.Y.Z`, `X.Y` and `latest`; there is no floating major tag while the major version is 0.

## Troubleshooting

- **Exit 78, "/data is not readable".** The volume or bind mount belongs to another user. `chown -R 10001:10001` it, or set `user:` to its owner.
- **Exit 78, "run: pin default".** Pin mode without a pin file. Run `docker compose run --rm pikvm-mcp pin default`.
- **Exit 64.** `PIKVM_MCP_PORT` is not a port number.
- **Exit 1, `cannot read (EACCES)`.** The container user cannot read that secret file; see the permissions table.
- **Healthcheck stays "starting".** Startup checks each device before listening, about 16 s per device that drops packets. The start period is 60 s.
- **No `npm` in the container.** It is removed from the runtime image. Rebuild the image to change dependencies.
- **Log timestamps** are in UTC, the container default.

## Verifying an image

Each release carries a build provenance attestation made by the release workflow. `gh` must be logged in (`gh auth login` with any GitHub account, or `GH_TOKEN`), even though the image is public:

```bash
gh attestation verify oci://ghcr.io/pln/pikvm_mcp_server:0.4.1 --repo PLN/pikvm_mcp_server --signer-workflow PLN/pikvm_mcp_server/.github/workflows/release.yml
```

Check the signer workflow and repository. The source commit is in the image's `org.opencontainers.image.revision` label and the matching `vX.Y.Z` git tag.

## Building the image yourself

```bash
docker buildx build --load -t pikvm-mcp:local .
printf 'services:\n  pikvm-mcp:\n    image: pikvm-mcp:local\n' > compose.override.yaml
```

Compose merges `compose.override.yaml` into `compose.yaml` automatically. Building needs BuildKit (`docker buildx build`, or `DOCKER_BUILDKIT=1 docker build`).

## Licence and source

The server is GPL-3.0-only. The image carries `/app/LICENSE`, `/app/NOTICE` and `/app/THIRD-PARTY-NOTICES.txt` (the npm packages in the image, with their licence texts). The corresponding source of a released image is the git commit in its `org.opencontainers.image.revision` label and the matching `vX.Y.Z` tag. Debian packages keep their copyright files under `/usr/share/doc/<package>/copyright`; their source is in the Debian archive. sharp's libvips (LGPL-3.0-or-later) ships as separate shared libraries under `/app/node_modules/@img/`.
