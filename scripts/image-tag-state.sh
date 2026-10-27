#!/usr/bin/env bash
# Modified 2026-10 by PLN: release registry check (GPL-3.0; see NOTICE).
#
# Usage: scripts/image-tag-state.sh <image:tag>
# Prints "present" or "absent". The release workflow's only registry
# classification; verify and publish both call it, logged in to ghcr.
# A tag is absent only on an explicit "not found" answer. Anything else
# (unauthorized, denied, a timeout, a network error) fails closed. Every
# non-zero inspect prints its exit status and output first, so the first
# release candidate shows what ghcr answers for a missing package.
set -uo pipefail

ref=${1:?usage: scripts/image-tag-state.sh <image:tag>}
out=$(docker buildx imagetools inspect "$ref" 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  echo present
  exit 0
fi
echo "image-tag-state: imagetools inspect $ref exited $rc:" >&2
printf '%s\n' "$out" >&2
if grep -qi 'not found' <<<"$out"; then
  echo absent
  exit 0
fi
echo "image-tag-state: not an explicit not-found answer; failing closed" >&2
exit 1
