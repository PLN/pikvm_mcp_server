#!/bin/sh
# Modified 2026-10 by PLN: Docker image (GPL-3.0; see NOTICE).
# Modified 2026-10 by PLN: comments no longer promise an end to restarts (GPL-3.0; see NOTICE).
#
# Fills /data defaults for variables that are unset or empty, then runs
# the server. A variable that is already set always wins. Each default
# is logged by name and path, never by value. Nothing here changes,
# copies or chmods a file.
set -eu

log() {
  echo "entrypoint: $*" >&2
}

default_to() {
  log "$1=$2 (default)"
  export "$1=$2"
}

if [ ! -r /data ] || [ ! -x /data ]; then
  log "/data is not readable by uid $(id -u). chown the volume to $(id -u):$(id -g), or set user: to its owner"
  exit 78
fi

# The server parses the port with parseInt, so "http" would quietly
# select stdio. Empty means stdio.
port=${PIKVM_MCP_PORT:-}
if [ -n "$port" ]; then
  case $port in
    *[!0-9]*) port_ok=no ;;
    *) if [ ${#port} -le 5 ] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then port_ok=yes; else port_ok=no; fi ;;
  esac
  if [ "$port_ok" = no ]; then
    log "PIKVM_MCP_PORT must be a number from 1 to 65535, or empty for stdio"
    exit 64
  fi
fi

mkdir -p /data/tls /data/secrets /data/images 2>/dev/null || true

if [ -z "${PIKVM_MCP_BEARER:-}" ] && [ -z "${PIKVM_MCP_BEARER_FILE:-}" ] && [ -f /data/secrets/pikvm-mcp-bearer ]; then
  default_to PIKVM_MCP_BEARER_FILE /data/secrets/pikvm-mcp-bearer
fi
if [ -z "${PIKVM_PASSWORD:-}" ] && [ -z "${PIKVM_PASSWORD_FILE:-}" ] && [ -f /data/secrets/pikvm-password ]; then
  default_to PIKVM_PASSWORD_FILE /data/secrets/pikvm-password
fi
if [ -z "${PIKVM_DEVICES:-}" ] && [ -z "${PIKVM_DEVICES_FILE:-}" ] && [ -z "${PIKVM_HOST:-}" ] && [ -f /data/devices.json ]; then
  default_to PIKVM_DEVICES_FILE /data/devices.json
fi
if [ -z "${PIKVM_MSD_LOCAL_DIR:-}" ] && [ -d /data/images ]; then
  default_to PIKVM_MSD_LOCAL_DIR /data/images
fi

tls_mode=$(printf '%s' "${PIKVM_TLS_MODE:-}" | tr -d ' \t')
first=${1:-}
if [ -z "${PIKVM_TLS_CERT_FILE:-}" ] && { [ "$tls_mode" = pin ] || [ "$first" = pin ]; }; then
  default_to PIKVM_TLS_CERT_FILE /data/tls/default.pem
fi
# PIKVM_TLS_MODE applies to the legacy single device only. Without this
# check a missing pin file is a bare ENOENT.
if [ "$tls_mode" = pin ] && [ "$first" != pin ] && [ -z "${PIKVM_DEVICES:-}" ] && [ -z "${PIKVM_DEVICES_FILE:-}" ] \
  && [ ! -e "${PIKVM_TLS_CERT_FILE:-}" ]; then
  log "PIKVM_TLS_MODE=pin and ${PIKVM_TLS_CERT_FILE:-} does not exist. run: pin default"
  exit 78
fi

# Node ignores a file without a certificate silently, so check first.
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f /data/tls/ca.pem ]; then
  if grep -q -- '-----BEGIN CERTIFICATE-----' /data/tls/ca.pem 2>/dev/null; then
    default_to NODE_EXTRA_CA_CERTS /data/tls/ca.pem
  else
    log "/data/tls/ca.pem has no certificate and is not used"
  fi
fi

exec node /app/dist/index.js "$@"
