#!/usr/bin/env bash
# Modified 2026-10 by PLN: public-file privacy guard (GPL-3.0; see NOTICE).
# GPL-3.0-only. See LICENSE and NOTICE.
#
# Usage:
#   PUBLIC_DENYLIST_FILE=/path/outside/repo scripts/check-public.sh [git-range]
# The range is an argument, PUBLIC_GUARD_RANGE, or the CI event
# (pull_request base..head, push before..sha). With no range, only the
# tracked tree is checked. History outside the range is never checked:
# main already contains upstream commits that fail the identity rule.
#
# Identity is PLN-only on purpose. Author and committer names must be
# PLN or GitHub, and addresses must be the PLN noreply forms or
# noreply@github.com. Any other person fails, including another GitHub
# noreply address, until the maintainer changes this rule. The same
# check runs for pull_request and push. dependabot[bot] with its numeric
# noreply address passes identity. For that commit, and for a pull
# request whose author login is dependabot[bot], only the email rule is
# relaxed. Every other rule still runs.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$(git rev-parse --show-toplevel)"

hits=()
tmps=()
cleanup() {
  # shellcheck disable=SC2317
  local tmp
  # shellcheck disable=SC2317
  for tmp in "${tmps[@]+"${tmps[@]}"}"; do
    # shellcheck disable=SC2317
    rm -rf "$tmp"
  done
}
trap cleanup EXIT

add_hit() {
  hits+=("$1")
}

mk() {
  local tmp
  tmp=$(mktemp)
  tmps+=("$tmp")
  printf '%s\n' "$tmp"
}

# Patterns are assembled at runtime so this file does not contain the
# literal shapes it searches for.
email_re='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
pln_email_re='^([0-9]+\+)?PLN@users\.noreply\.github\.com$'
bot_name=$(printf '%s' 'dependabot' '[bot]')
bot_name_re=$(printf '%s' 'dependabot\[bot\]')
bot_email_re=$(printf '%s%s%s' '^[0-9]+\+' 'dependabot\[bot\]@' 'users\.noreply\.github\.com$')
bc_re=$(printf '%s' 'bc-[0-9a-f]{6,}')
ts_suf=$(printf '%s.%s' 'ts' 'net')
example_ts="example.${ts_suf}"
ts_re="[A-Za-z0-9.-]+\\.${ts_suf}"
home_re="/$(printf '%s' 'home')/[A-Za-z0-9._-]+"
users_re="/$(printf '%s' 'Users')/[A-Za-z0-9._-]+"
sec_ghp=$(printf '%s%s' 'gh' 'p_')
sec_pat=$(printf '%s%s' 'github_' 'pat_')
sec_ts=$(printf '%s%s' 'ts' 'key-')
sec_begin=$(printf '%s' '-----BEGIN ')
sec_kind=$(printf '%s' '.* PRIVATE KEY')
sec_key="${sec_begin}${sec_kind}"
co_prefix=$(printf '%s%s' 'Co-authored-' 'by:')
pln_co_re="^${co_prefix} PLN <([0-9]+\\+)?PLN@users\\.noreply\\.github\\.com>$"
bot_co_re="^${co_prefix} ${bot_name_re} <[0-9]+\\+${bot_name_re}@users\\.noreply\\.github\\.com>$"
sob_line=$(printf '%s%s%s%s%s' 'Signed-off-by: ' "$bot_name" ' <' "$(printf '%s%s' 'support@' 'github.com')" '>')

excluded() {
  case $1 in
    scripts/check-public.sh|scripts/public-guard/*|test/public-guard/*) return 0 ;;
    *) return 1 ;;
  esac
}

email_allowed() {
  local email=$1
  local line=$2
  if [[ $line == "$sob_line" ]]; then
    return 0
  fi
  if [[ $line =~ $bot_co_re ]]; then
    return 0
  fi
  if [[ $email == 'noreply@github.com' ]]; then
    return 0
  fi
  if [[ $email =~ $pln_email_re ]]; then
    return 0
  fi
  local domain=${email#*@}
  local domain_lc=${domain,,}
  if [[ $domain_lc == *.example || $domain_lc == *'.example.'* ]]; then
    return 0
  fi
  return 1
}

line_has_bad_email() {
  local line=$1
  local rest=$line
  local found
  while [[ $rest =~ $email_re ]]; do
    found=${BASH_REMATCH[0]}
    if ! email_allowed "$found" "$line"; then
      return 0
    fi
    rest=${rest#*"$found"}
  done
  return 1
}

line_has_bad_ts() {
  local line=$1
  local rest=$line
  local host
  while [[ $rest =~ $ts_re ]]; do
    host=${BASH_REMATCH[0]}
    if [[ $host != "$example_ts" && $host != *".${example_ts}" ]]; then
      return 0
    fi
    rest=${rest#*"$host"}
  done
  return 1
}

line_has_bad_coauthor() {
  local line=$1
  [[ $line == *"$co_prefix"* ]] || return 1
  if [[ $line =~ $pln_co_re ]]; then
    return 1
  fi
  if [[ $line =~ $bot_co_re ]]; then
    return 1
  fi
  return 0
}

party_ok() {
  local name=$1
  local email=$2
  if [[ $name == "$bot_name" && $email =~ $bot_email_re ]]; then
    return 0
  fi
  if [[ $name == PLN || $name == GitHub ]]; then
    if [[ $email == 'noreply@github.com' || $email =~ $pln_email_re ]]; then
      return 0
    fi
  fi
  return 1
}

# grep -nHE | cut keeps file:line only. Stderr is discarded. Exit 2 fails.
grep_locs() {
  local mode=$1
  local pattern=$2
  shift 2
  local locs status
  set +e
  if [[ $mode == deny ]]; then
    locs=$(grep -nIHEiE -f "$pattern" -- "$@" 2>/dev/null | cut -d: -f1,2)
  else
    locs=$(grep -nIHE -e "$pattern" -- "$@" 2>/dev/null | cut -d: -f1,2)
  fi
  status=$?
  set -e
  if [[ $status -eq 2 ]]; then
    if [[ $mode == deny ]]; then
      echo 'denylist: invalid pattern' >&2
    else
      echo 'grep: pattern rejected' >&2
    fi
    exit 1
  fi
  if [[ $status -ne 0 && $status -ne 1 ]]; then
    echo 'grep: failed' >&2
    exit 1
  fi
  if [[ $status -eq 0 && -n $locs ]]; then
    printf '%s\n' "$locs"
  fi
}

read_line() {
  local file=$1
  local line=$2
  sed -n "${line}p" -- "$file"
}

load_ci_event() {
  [[ -n ${EVENT_JSON:-} ]] || return 0
  local dir
  dir=$(mktemp -d)
  tmps+=("$dir")
  node "$SCRIPT_DIR/public-guard/read-event.mjs" write "$dir"
  if [[ -z ${PUBLIC_GUARD_EVENT:-} ]]; then
    PUBLIC_GUARD_EVENT=$(cat "$dir/event_name")
  fi
  if [[ -z ${PUBLIC_GUARD_SHA:-} ]]; then
    PUBLIC_GUARD_SHA=$(cat "$dir/sha")
  fi
  if [[ -z ${PUBLIC_GUARD_BEFORE:-} ]]; then
    PUBLIC_GUARD_BEFORE=$(cat "$dir/before")
  fi
  if [[ -z ${PUBLIC_GUARD_BASE:-} ]]; then
    PUBLIC_GUARD_BASE=$(cat "$dir/base")
  fi
  if [[ -z ${PUBLIC_GUARD_HEAD:-} ]]; then
    PUBLIC_GUARD_HEAD=$(cat "$dir/head")
  fi
  if [[ -z ${PUBLIC_GUARD_PR_TITLE+x} ]]; then
    PUBLIC_GUARD_PR_TITLE=$(cat "$dir/pr_title")
  fi
  if [[ -z ${PUBLIC_GUARD_PR_BODY+x} ]]; then
    PUBLIC_GUARD_PR_BODY=$(cat "$dir/pr_body")
  fi
  if [[ -z ${PUBLIC_GUARD_PR_AUTHOR+x} ]]; then
    PUBLIC_GUARD_PR_AUTHOR=$(cat "$dir/pr_author")
  fi
}

load_denylist() {
  local raw line count
  count=0
  if [[ -n ${PUBLIC_DENYLIST+x} ]]; then
    raw=$PUBLIC_DENYLIST
  elif [[ -n ${PUBLIC_DENYLIST_FILE:-} ]]; then
    if [[ ! -f $PUBLIC_DENYLIST_FILE ]]; then
      echo 'denylist: PUBLIC_DENYLIST_FILE is not a file' >&2
      exit 1
    fi
    raw=$(cat "$PUBLIC_DENYLIST_FILE")
  else
    echo 'denylist: missing or empty' >&2
    exit 1
  fi
  raw=${raw//$'\r'/}
  DENY_FILE=$(mk)
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ -z $line ]]; then
      continue
    fi
    printf '%s\n' "$line" >> "$DENY_FILE"
    count=$((count + 1))
  done <<< "$raw"
  if [[ $count -eq 0 ]]; then
    echo 'denylist: missing or empty' >&2
    exit 1
  fi
  local status
  set +e
  printf '\n' | grep -E -f "$DENY_FILE" >/dev/null 2>/dev/null
  status=$?
  set -e
  if [[ $status -eq 2 ]]; then
    echo 'denylist: invalid pattern' >&2
    exit 1
  fi
}

resolve_range() {
  RANGE_SPEC=
  RANGE_ONE=0
  if [[ -n ${1:-} ]]; then
    RANGE_SPEC=$1
  elif [[ -n ${PUBLIC_GUARD_RANGE:-} ]]; then
    RANGE_SPEC=$PUBLIC_GUARD_RANGE
  elif [[ ${PUBLIC_GUARD_EVENT:-} == pull_request ]]; then
    if [[ -z ${PUBLIC_GUARD_BASE:-} || -z ${PUBLIC_GUARD_HEAD:-} ]]; then
      echo 'range: pull_request is missing base or head' >&2
      exit 1
    fi
    RANGE_SPEC="${PUBLIC_GUARD_BASE}..${PUBLIC_GUARD_HEAD}"
  elif [[ ${PUBLIC_GUARD_EVENT:-} == push ]]; then
    if [[ -z ${PUBLIC_GUARD_SHA:-} ]]; then
      echo 'range: push is missing sha' >&2
      exit 1
    fi
    if [[ -z ${PUBLIC_GUARD_BEFORE:-} || ${PUBLIC_GUARD_BEFORE} =~ ^0+$ ]] || ! git cat-file -e "${PUBLIC_GUARD_BEFORE}^{commit}" 2>/dev/null; then
      RANGE_SPEC=$PUBLIC_GUARD_SHA
      RANGE_ONE=1
    else
      RANGE_SPEC="${PUBLIC_GUARD_BEFORE}..${PUBLIC_GUARD_SHA}"
    fi
  fi
  if [[ -n $RANGE_SPEC && $RANGE_SPEC != *..* ]]; then
    RANGE_ONE=1
  fi
}

note_simple_locs() {
  local label_mode=$1
  local rule=$2
  local locs=$3
  local loc file line
  [[ -n $locs ]] || return 0
  while IFS= read -r loc; do
    [[ -n $loc ]] || continue
    case $label_mode in
      file)
        add_hit "${loc} ${rule}"
        ;;
      names)
        file=${loc%%:*}
        line=${loc##*:}
        add_hit "${name_lines[$((line - 1))]}:0 ${rule}"
        ;;
      *)
        add_hit "${label_mode} ${rule}"
        ;;
    esac
  done <<< "$locs"
}

note_filtered_locs() {
  local label_mode=$1
  local rule=$2
  local kind=$3
  local locs=$4
  local loc file line text bad
  [[ -n $locs ]] || return 0
  while IFS= read -r loc; do
    [[ -n $loc ]] || continue
    file=${loc%%:*}
    line=${loc##*:}
    text=$(read_line "$file" "$line")
    bad=1
    case $kind in
      email) line_has_bad_email "$text" || bad=0 ;;
      ts) line_has_bad_ts "$text" || bad=0 ;;
      co) line_has_bad_coauthor "$text" || bad=0 ;;
    esac
    [[ $bad -eq 1 ]] || continue
    case $label_mode in
      file) add_hit "${loc} ${rule}" ;;
      names) add_hit "${name_lines[$((line - 1))]}:0 ${rule}" ;;
      *) add_hit "${label_mode} ${rule}" ;;
    esac
  done <<< "$locs"
}

# grep_locs runs inside a command substitution. Its exit must be checked
# in this shell; a failure there does not stop the script on its own.
take_locs() {
  local dest=$1
  shift
  local out status
  set +e
  out=$(grep_locs "$@")
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    exit "$status"
  fi
  printf -v "$dest" '%s' "$out"
}

scan_patterns() {
  local label_mode=$1
  local relax=$2
  shift 2
  [[ $# -gt 0 ]] || return 0
  local locs
  take_locs locs plain "$bc_re" "$@"
  note_simple_locs "$label_mode" R-bc "$locs"
  take_locs locs plain "$home_re" "$@"
  note_simple_locs "$label_mode" R-home "$locs"
  take_locs locs plain "$users_re" "$@"
  note_simple_locs "$label_mode" R-home "$locs"
  take_locs locs plain "$sec_ghp" "$@"
  note_simple_locs "$label_mode" R-secret "$locs"
  take_locs locs plain "$sec_pat" "$@"
  note_simple_locs "$label_mode" R-secret "$locs"
  take_locs locs plain "$sec_ts" "$@"
  note_simple_locs "$label_mode" R-secret "$locs"
  take_locs locs plain "$sec_key" "$@"
  note_simple_locs "$label_mode" R-secret "$locs"
  take_locs locs plain "$ts_re" "$@"
  note_filtered_locs "$label_mode" R-tsnet ts "$locs"
  take_locs locs plain "$co_prefix" "$@"
  note_filtered_locs "$label_mode" R-coauthor co "$locs"
  if [[ $relax -eq 0 ]]; then
    take_locs locs plain "$email_re" "$@"
    note_filtered_locs "$label_mode" R-email email "$locs"
  fi
  if [[ -n ${DENY_FILE:-} ]]; then
    take_locs locs deny "$DENY_FILE" "$@"
    note_simple_locs "$label_mode" R-denylist "$locs"
  fi
}

scan_addresses() {
  local label_mode=$1
  shift
  [[ $# -gt 0 ]] || return 0
  local out status loc file line
  set +e
  out=$(printf '%s\0' "$@" | node "$SCRIPT_DIR/public-guard/scan-ip.mjs")
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    echo 'address scan failed' >&2
    exit 1
  fi
  [[ -n $out ]] || return 0
  while IFS= read -r loc; do
    [[ -n $loc ]] || continue
    case $label_mode in
      file) add_hit "$loc" ;;
      names)
        file=${loc%%:*}
        line=${loc%% *}
        line=${line##*:}
        add_hit "${name_lines[$((line - 1))]}:0 ${loc##* }"
        ;;
      *)
        add_hit "${label_mode} ${loc##* }"
        ;;
    esac
  done <<< "$out"
}

scan_images() {
  [[ $# -gt 0 ]] || return 0
  local out status loc
  set +e
  out=$(printf '%s\0' "$@" | node "$SCRIPT_DIR/public-guard/image-meta.mjs")
  status=$?
  set -e
  if [[ $status -ne 0 ]]; then
    echo 'image scan failed' >&2
    exit 1
  fi
  [[ -n $out ]] || return 0
  while IFS= read -r loc; do
    [[ -n $loc ]] || continue
    add_hit "$loc"
  done <<< "$out"
}

scan_one_commit() {
  local sha=$1
  local an ae cn ce relax blob
  an=$(git log -1 --format='%an' "$sha")
  ae=$(git log -1 --format='%ae' "$sha")
  cn=$(git log -1 --format='%cn' "$sha")
  ce=$(git log -1 --format='%ce' "$sha")
  if ! party_ok "$an" "$ae" || ! party_ok "$cn" "$ce"; then
    add_hit "commit ${sha} R-identity"
  fi
  relax=0
  if [[ $an == "$bot_name" && $ae =~ $bot_email_re ]]; then
    relax=1
  fi
  blob=$(mk)
  {
    printf '%s\n' "$an" "$ae" "$cn" "$ce"
    git log -1 --format='%B' "$sha"
  } > "$blob"
  scan_patterns "commit ${sha}" "$relax" "$blob"
  scan_addresses "commit ${sha}" "$blob"
}

scan_commits() {
  [[ -n $RANGE_SPEC ]] || return 0
  local revs sha status
  if [[ $RANGE_ONE -eq 1 ]]; then
    if ! git cat-file -e "${RANGE_SPEC}^{commit}" 2>/dev/null; then
      echo 'range: not a commit' >&2
      exit 1
    fi
    revs=$RANGE_SPEC
  else
    set +e
    revs=$(git rev-list "$RANGE_SPEC")
    status=$?
    set -e
    if [[ $status -ne 0 ]]; then
      echo 'range: not a commit range' >&2
      exit 1
    fi
  fi
  for sha in $revs; do
    scan_one_commit "$sha"
  done
}

scan_pr_text() {
  local label=$1
  local text=$2
  local relax=$3
  local blob
  blob=$(mk)
  printf '%s\n' "$text" > "$blob"
  scan_patterns "$label" "$relax" "$blob"
  scan_addresses "$label" "$blob"
}

load_ci_event

if [[ ${PUBLIC_GUARD_EVENT:-} == push ]]; then
  PUBLIC_GUARD_SKIP_DENYLIST=0
fi

if [[ ${PUBLIC_GUARD_SKIP_DENYLIST:-} == 1 ]]; then
  printf '::notice::denylist skipped: %s\n' "${PUBLIC_GUARD_SKIP_REASON:-denylist skipped}"
else
  load_denylist
fi

resolve_range "${1:-}"

all_files=()
while IFS= read -r -d '' path; do
  all_files+=("$path")
done < <(git ls-files -z)

content_files=()
if [[ ${#all_files[@]} -gt 0 ]]; then
  for path in "${all_files[@]}"; do
    if excluded "$path"; then
      continue
    fi
    content_files+=("$path")
  done
fi

name_lines=()
if [[ ${#all_files[@]} -gt 0 ]]; then
  name_file=$(mk)
  printf '%s\n' "${all_files[@]}" > "$name_file"
  mapfile -t name_lines < "$name_file"
  scan_patterns names 0 "$name_file"
  scan_addresses names "$name_file"
fi

if [[ ${#content_files[@]} -gt 0 ]]; then
  scan_patterns file 0 "${content_files[@]}"
  scan_addresses file "${content_files[@]}"
  scan_images "${content_files[@]}"
fi

scan_commits

pr_relax=0
if [[ ${PUBLIC_GUARD_PR_AUTHOR:-} == "$bot_name" ]]; then
  pr_relax=1
fi
if [[ -n ${PUBLIC_GUARD_PR_TITLE+x} ]]; then
  scan_pr_text pr-title "$PUBLIC_GUARD_PR_TITLE" "$pr_relax"
fi
if [[ -n ${PUBLIC_GUARD_PR_BODY+x} ]]; then
  scan_pr_text pr-body "$PUBLIC_GUARD_PR_BODY" "$pr_relax"
fi

if [[ ${#hits[@]} -gt 0 ]]; then
  printf '%s\n' "${hits[@]}" | sort -u
  exit 1
fi
exit 0
