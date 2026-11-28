#!/usr/bin/env bash
# Tries the lock of scripts/dev-ensure.sh the hard way: many callers at once, in a scratch
# folder, with and without a stale lock left by a dead holder. Starts no server.
#
#   scripts/dev-ensure.test.sh            25 rounds of 8 callers, for each kind of lock
#   scripts/dev-ensure.test.sh 100 12     100 rounds of 12 callers
#
# Exits 0 when no two callers ever held the lock at the same time, 1 otherwise.

set -u
ROUNDS="${1:-25}"
CALLERS="${2:-8}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/dev-ensure-test.XXXXXX")"
trap 'rm -rf "$SANDBOX"' EXIT

# One caller: take the lock, check nobody else is inside, stay a moment, leave.
caller() {
  (
    export DEV_ENSURE_ROOT="$1" DEV_ENSURE_LIB=1
    [ "$2" = mkdir ] && export DEV_ENSURE_NO_FLOCK=1
    # shellcheck disable=SC1091
    . "$HERE/dev-ensure.sh" >/dev/null 2>&1
    acquire_lock >/dev/null 2>&1 || { echo "caller could not get the lock" >> "$1/errors"; exit 1; }
    if ! mkdir "$1/inside" 2>/dev/null; then echo overlap >> "$1/overlaps"; fi
    sleep 0.02
    rmdir "$1/inside" 2>/dev/null
    echo done >> "$1/finished"
    release_lock
  )
}

# A pid that is certainly not running.
dead_pid() {
  ( exit 0 ) &
  local pid=$!
  wait "$pid" 2>/dev/null
  printf '%s' "$pid"
}

failed=0
for kind in flock mkdir; do
  if [ "$kind" = flock ] && ! command -v flock >/dev/null 2>&1; then
    echo "flock: not on this machine, skipped"
    continue
  fi
  for start in clean stale; do
    bad=0
    for round in $(seq 1 "$ROUNDS"); do
      dir="$SANDBOX/$kind-$start-$round"
      mkdir -p "$dir"
      if [ "$start" = stale ]; then
        # What a holder killed outright leaves behind.
        mkdir "$dir/.dev.lock"
        dead_pid > "$dir/.dev.lock/pid"
      fi
      for _ in $(seq 1 "$CALLERS"); do caller "$dir" "$kind" & done
      wait
      finished="$(wc -l < "$dir/finished" 2>/dev/null || echo 0)"
      if [ -s "$dir/overlaps" ] || [ -s "$dir/errors" ] || [ "$finished" -ne "$CALLERS" ]; then bad=$((bad + 1)); fi
    done
    echo "$kind lock, $start start: $bad of $ROUNDS rounds had two holders at once or a caller that never got in ($CALLERS callers each)"
    [ "$bad" -gt 0 ] && failed=1
  done
done
exit "$failed"
