#!/usr/bin/env bash
# Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
#
# The denylist is skipped only for a pull_request whose actor is
# dependabot[bot], or whose head repository is not this repository.
# Head and base repository names are compared without case.
# A missing head repository (deleted fork) compares unequal and is skipped.
# Push is never skipped. The pull request author login is not read.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
EVENT_NAME=${EVENT_NAME:-}
ACTOR=${ACTOR:-}
REPOSITORY=${REPOSITORY:-}

if [[ -z ${HEAD_REPO+x} ]]; then
  HEAD_REPO=$(node "$SCRIPT_DIR/read-event.mjs" head-repo)
fi

skip=0
reason=
bot_actor=$(printf '%s' 'dependabot' '[bot]')
head_cmp=${HEAD_REPO,,}
repo_cmp=${REPOSITORY,,}
if [[ $EVENT_NAME == pull_request ]]; then
  if [[ $ACTOR == "$bot_actor" ]]; then
    skip=1
    reason='pull_request actor is dependabot[bot]'
  elif [[ $head_cmp != "$repo_cmp" ]]; then
    skip=1
    reason='pull_request head repository does not match this repository'
  fi
fi

if [[ -n ${GITHUB_OUTPUT:-} ]]; then
  printf 'skip=%s\n' "$skip" >> "$GITHUB_OUTPUT"
  printf 'reason=%s\n' "$reason" >> "$GITHUB_OUTPUT"
fi
printf 'skip=%s\nreason=%s\n' "$skip" "$reason"
