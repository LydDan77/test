#!/usr/bin/env bash
# Makes sure exactly ONE development server is running on port 3000, then exits 0.
#
#   scripts/dev-ensure.sh             start it if it is not running; wait until it is healthy
#   scripts/dev-ensure.sh --status    say whether it is running (exit 0) or not (exit 1)
#   scripts/dev-ensure.sh --stop      stop the server this script started
#   scripts/dev-ensure.sh --restart   stop, then start (needed after `npm run db:reset`)
#
# Safe to call repeatedly and from several terminals or agents at once: a lock makes sure two
# callers can never both start a server. The server owns the local database in ./.data, so
# never start a second `next dev` by hand, and never open ./.data from another process.
#
# "Healthy" means GET /api/health answers 200 with "app":"etoile", which also means the local
# database is open and migrated. The server's output goes to .dev.log.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PORT=3000
# localhost, not 127.0.0.1: `next dev` refuses its own dev resources to other host names.
HEALTH_URL="http://localhost:${PORT}/api/health"
LOG="$ROOT/.dev.log"
LOCK="$ROOT/.dev.lock"
PIDFILE="$ROOT/.dev.pid"
START_TIMEOUT=240   # seconds to wait for a fresh server (first compile + database setup)
LOCK_TIMEOUT=300    # seconds to wait for another caller that is starting the server

say() { printf 'dev-ensure: %s\n' "$*"; }
fail() { printf 'dev-ensure: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

healthy() {
  curl -fsS --max-time 8 "$HEALTH_URL" 2>/dev/null | grep -q '"app":"etoile"'
}

# True when anything at all is accepting connections on the port.
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && return 0
  (exec 3<>"/dev/tcp/::1/${PORT}") 2>/dev/null && return 0
  return 1
}

recorded_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null)"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

stop_server() {
  local pid
  if pid="$(recorded_pid)"; then
    say "stopping the development server (pid $pid)"
    # The server was started in its own session, so its process group is its pid:
    # this stops npm, next and every worker together.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    local waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do sleep 0.5; waited=$((waited + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    fi
    # Give the port a moment to be released.
    waited=0
    while port_in_use && [ "$waited" -lt 20 ]; do sleep 0.5; waited=$((waited + 1)); done
  fi
  rm -f "$PIDFILE"
}

# --- lock: an atomic mkdir, with the holder's pid inside so a dead holder can be detected ---------
LOCK_HELD=0
release_lock() { [ "$LOCK_HELD" = 1 ] && rm -rf "$LOCK"; LOCK_HELD=0; }
trap release_lock EXIT
trap 'release_lock; exit 130' INT TERM

acquire_lock() {
  local waited=0 empty_for=0 holder
  while ! mkdir "$LOCK" 2>/dev/null; do
    holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$holder" ]; then
      empty_for=0
      if ! kill -0 "$holder" 2>/dev/null; then
        say "removing a stale lock left by pid $holder"
        rm -rf "$LOCK"
        continue
      fi
    else
      # The holder writes its pid right after mkdir. No pid for 10 s means it died in between.
      empty_for=$((empty_for + 1))
      if [ "$empty_for" -ge 20 ]; then rm -rf "$LOCK"; empty_for=0; continue; fi
    fi
    if [ "$waited" = 0 ]; then say "another caller is starting the server; waiting for it"; fi
    sleep 0.5
    waited=$((waited + 1))
    [ "$waited" -ge $((LOCK_TIMEOUT * 2)) ] && fail "timed out waiting for the lock at $LOCK"
  done
  LOCK_HELD=1
  printf '%s\n' "$$" > "$LOCK/pid"
}

start_server() {
  : > "$LOG"
  say "starting the development server on port $PORT (log: .dev.log)"
  # Its own session (setsid) so it outlives this script and the terminal that ran it.
  if command -v setsid >/dev/null 2>&1; then
    NEXT_TELEMETRY_DISABLED=1 setsid nohup npm run dev -- --port "$PORT" >> "$LOG" 2>&1 < /dev/null &
  else
    NEXT_TELEMETRY_DISABLED=1 nohup npm run dev -- --port "$PORT" >> "$LOG" 2>&1 < /dev/null &
  fi
  local pid=$!
  disown "$pid" 2>/dev/null || true
  printf '%s\n' "$pid" > "$PIDFILE"

  local waited=0
  until healthy; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PIDFILE"
      printf '%s\n' "--- last lines of .dev.log ---" >&2
      tail -n 40 "$LOG" >&2
      fail "the development server exited while starting"
    fi
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$START_TIMEOUT" ]; then
      printf '%s\n' "--- last lines of .dev.log ---" >&2
      tail -n 40 "$LOG" >&2
      fail "the development server did not become healthy within ${START_TIMEOUT}s (it is still running; see .dev.log)"
    fi
  done
  say "ready at http://localhost:${PORT} (pid $pid, ${waited}s)"
}

ensure_running() {
  # Fast path: nothing to do, no lock needed.
  if healthy; then say "already running at http://localhost:${PORT}"; return 0; fi

  acquire_lock
  # Someone else may have started it while we waited for the lock.
  if healthy; then say "already running at http://localhost:${PORT}"; return 0; fi

  if port_in_use; then
    # Something is listening but not answering as a healthy Étoile server. It may be our own
    # server still compiling or busy; give it a while before deciding.
    # A server this script started gets longer than a stranger on the port does.
    local patience=20
    recorded_pid >/dev/null && patience=90
    say "port $PORT is in use but not healthy yet; waiting up to ${patience}s"
    local waited=0
    while [ "$waited" -lt "$patience" ]; do
      healthy && { say "already running at http://localhost:${PORT}"; return 0; }
      port_in_use || break
      sleep 1
      waited=$((waited + 1))
    done
    if port_in_use; then
      if recorded_pid >/dev/null; then
        say "the server this script started is not answering; restarting it"
        stop_server
      else
        fail "port $PORT is in use by another program. Stop it, then run this again."
      fi
    fi
  fi

  # A leftover process from an earlier start that never got as far as listening.
  if recorded_pid >/dev/null; then stop_server; fi
  start_server
}

case "${1:-}" in
  "")
    ensure_running
    ;;
  --status)
    if healthy; then say "running at http://localhost:${PORT}"; exit 0; fi
    say "not running"
    exit 1
    ;;
  --stop)
    acquire_lock
    if recorded_pid >/dev/null; then
      stop_server
    elif port_in_use; then
      fail "something is on port $PORT, but this script did not start it; not touching it"
    else
      say "not running"
    fi
    ;;
  --restart)
    acquire_lock
    if recorded_pid >/dev/null; then
      stop_server
    elif port_in_use; then
      fail "something is on port $PORT, but this script did not start it; not touching it"
    fi
    start_server
    ;;
  -h|--help)
    sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *)
    fail "unknown option: $1 (use --status, --stop, --restart or no option)"
    ;;
esac
exit 0
