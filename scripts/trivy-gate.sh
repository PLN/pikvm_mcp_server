#!/usr/bin/env bash
# Modified 2026-10 by PLN: image scan gate (GPL-3.0; see NOTICE).
#
# Usage: scripts/trivy-gate.sh <dir|image.tar> [report.json]
# The only place the gate flags live. The release scan, the gate
# self-test and PR CI all call this script.
# Exit 0: no fixable CRITICAL or HIGH finding after .trivyignore.yaml.
# Any other exit fails the gate, including a failed DB download: Trivy's
# defaults fail open, so every flag that makes it fail is explicit here.
set -euo pipefail

target=${1:?usage: scripts/trivy-gate.sh <dir|image.tar> [report.json]}
root=$(cd "$(dirname "$0")/.." && pwd)
trivy=${TRIVY:-trivy}
report=${2:-}
if [ -z "$report" ]; then
  report=$(mktemp)
  trap 'rm -f "$report"' EXIT
fi

if [ -d "$target" ]; then
  mode=(fs "$target")
elif [ -f "$target" ]; then
  mode=(image --input "$target")
else
  echo "trivy-gate: $target is neither a directory nor a file" >&2
  exit 2
fi

rc=0
"$trivy" "${mode[@]}" \
  --exit-code 1 --ignore-unfixed --severity CRITICAL,HIGH --scanners vuln --no-progress \
  --ignorefile "$root/.trivyignore.yaml" \
  --format json --output "$report" || rc=$?
if [ -s "$report" ]; then
  "$trivy" convert --format table "$report" || true
fi
echo "trivy-gate: exit $rc for $target"
exit "$rc"
