#!/usr/bin/env bash
# Modified 2026-10 by PLN: image scan waiver lint (GPL-3.0; see NOTICE).
#
# Usage: scripts/lint-waivers.sh [file]   (default: .trivyignore.yaml)
# Each entry under vulnerabilities needs an id, purls or paths, a
# statement, and an expired_at date (YYYY-MM-DD) that has not passed and
# is at most 90 days from today (UTC). An empty list passes.
# Needs yq v4 (mikefarah, preinstalled on GitHub's Ubuntu runners) and jq.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
file=${1:-$root/.trivyignore.yaml}
json=$(yq -o=json '.' < "$file")
today=$(date -u +%F)
limit=$(date -u -d '+90 days' +%F)

problems=$(jq -r --arg today "$today" --arg limit "$limit" '
  if (.vulnerabilities | type) != "array" then
    "vulnerabilities must be a list"
  else
    .vulnerabilities | to_entries[] | .key as $i | .value as $w
    | "entry \($i) (\($w.id // "no id"))" as $at
    | (if ($w.id | type) != "string" or $w.id == "" then "\($at): id is missing" else empty end),
      (if ((($w.purls // []) | length) + (($w.paths // []) | length)) == 0
        then "\($at): needs purls or paths; an id alone waives every package" else empty end),
      (if ($w.statement | type) != "string" or ($w.statement | length) == 0
        then "\($at): statement is missing" else empty end),
      (($w.expired_at // "") | tostring) as $exp
      | (if ($exp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}") | not) then "\($at): expired_at (YYYY-MM-DD) is missing"
        elif $exp[0:10] < $today then "\($at): expired on \($exp[0:10])"
        elif $exp[0:10] > $limit then "\($at): expired_at \($exp[0:10]) is more than 90 days out"
        else empty end)
  end' <<<"$json")

if [ -n "$problems" ]; then
  echo "lint-waivers: $file" >&2
  while IFS= read -r line; do echo "  $line" >&2; done <<<"$problems"
  exit 1
fi
echo "lint-waivers: $file is valid ($(jq '.vulnerabilities | length' <<<"$json") waiver(s))"
