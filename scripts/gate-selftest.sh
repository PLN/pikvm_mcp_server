#!/usr/bin/env bash
# Modified 2026-10 by PLN: two-sided scan gate self-test (GPL-3.0; see NOTICE).
#
# Runs scripts/trivy-gate.sh on two committed lockfiles with the real
# .trivyignore.yaml. The bad one pins a version with a known fixable
# CRITICAL advisory and must fail. The good one pins one clean package and
# must pass with a scanned target, so an empty scan cannot pass. A dropped
# --exit-code, an over-broad waiver, or a Trivy bump that fails open
# breaks this test. The fixtures use a .json.txt name so Dependabot and
# the dependency graph leave them alone.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

run_fixture() {
  mkdir -p "$work/$1"
  cp "$root/test/fixtures/gate/$1-lock.json.txt" "$work/$1/package-lock.json"
  rc=0
  bash "$root/scripts/trivy-gate.sh" "$work/$1" "$work/$1.json" || rc=$?
}

run_fixture bad
if [ "$rc" -ne 1 ]; then
  echo "gate-selftest: the bad fixture exited $rc, expected 1. The gate fails open." >&2
  exit 1
fi

run_fixture good
if [ "$rc" -ne 0 ]; then
  echo "gate-selftest: the good fixture exited $rc, expected 0. If Trivy reports a finding, the fixture is stale: pick a new clean version." >&2
  exit 1
fi
results=$(jq '.Results | length' "$work/good.json")
if [ "$results" -lt 1 ]; then
  echo "gate-selftest: the good fixture produced no scan target. The test would pass vacuously." >&2
  exit 1
fi
echo "gate-selftest: bad fixture fails, good fixture passes with $results target(s)"
