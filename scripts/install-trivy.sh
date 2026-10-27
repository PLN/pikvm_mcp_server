#!/usr/bin/env bash
# Modified 2026-10 by PLN: checksum-pinned Trivy install (GPL-3.0; see NOTICE).
#
# Usage: scripts/install-trivy.sh <dir>
# Downloads the pinned Trivy release for this machine, checks it against
# scripts/trivy.sha256 before extracting, and installs <dir>/trivy.
# A missing line or a mismatch fails. A bump is by hand: new version,
# both checksums, and a green gate self-test.
set -euo pipefail

VERSION=0.76.1
dest=${1:?usage: scripts/install-trivy.sh <dir>}
here=$(cd "$(dirname "$0")" && pwd)

case $(uname -m) in
  x86_64) file=trivy_${VERSION}_Linux-64bit.tar.gz ;;
  aarch64) file=trivy_${VERSION}_Linux-ARM64.tar.gz ;;
  *) echo "install-trivy: unsupported machine $(uname -m)" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if ! grep -E "^[0-9a-f]{64}  ${file}\$" "$here/trivy.sha256" > "$work/sum"; then
  echo "install-trivy: no checksum for $file in scripts/trivy.sha256" >&2
  exit 1
fi
curl -fsSL --retry 3 -o "$work/$file" "https://github.com/aquasecurity/trivy/releases/download/v${VERSION}/${file}"
(cd "$work" && sha256sum -c --strict sum)
mkdir -p "$dest"
tar -xzf "$work/$file" -C "$work" trivy
install -m 0755 "$work/trivy" "$dest/trivy"
if ! "$dest/trivy" --version | grep -qx "Version: ${VERSION}"; then
  echo "install-trivy: $dest/trivy is not version $VERSION" >&2
  exit 1
fi
echo "install-trivy: $dest/trivy $VERSION"
