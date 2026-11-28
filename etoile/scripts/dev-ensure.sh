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
#
# It never stops or restarts a server that is running unless you pass --stop or --restart: a
# server that is slow to answer (a long compile, a busy machine) is everybody's server.
#
# The server listens on this machine only (--hostname localhost): its rate limits are off and
# every test account has the same published password, so it must not be reachable from the
# network.

set -u

# DEV_ENSURE_ROOT moves the lock, pid and log files; scripts/dev-ensure.test.sh uses it to try
# the lock in a scratch folder.
ROOT="${DEV_ENSURE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
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
  # The pid may have been given to some other program since the file was written.
  if command -v ps >/dev/null 2>&1; then
    ps -p "$pid" -o args= 2>/dev/null | grep -Eq 'npm|next|node' || return 1
  fi
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

# --- lock ---------------------------------------------------------------------------------------------
#
# With flock(1) (every Linux): the lock is held on an open file, and the kernel lets go of it
# the moment the holder exits, however it exits. There is no such thing as a stale lock.
#
# Without flock (macOS): an atomic mkdir, with the holder's pid inside so that a dead holder can
# be detected. Taking over a dead holder's lock is the dangerous step: several waiters see the
# same dead pid, and if each simply removed the lock and made its own, the second would remove
# the FIRST one's fresh lock and both would hold it. So the takeover itself is done under a
# second mkdir ($TAKEOVER) that only one waiter can make, and that waiter looks again at
# who holds the lock before removing it.
LOCK_HELD=0
# Both live outside the checkout (nothing new to ignore), named after this checkout's path.
LOCK_NAME="${TMPDIR:-/tmp}/etoile-dev-ensure-$(printf '%s' "$ROOT" | cksum | cut -d' ' -f1)"
LOCK_FILE="$LOCK_NAME.lock"
TAKEOVER="$LOCK_NAME.takeover"
USE_FLOCK=0
if [ "${DEV_ENSURE_NO_FLOCK:-}" != 1 ] && command -v flock >/dev/null 2>&1; then USE_FLOCK=1; fi

release_lock() {
  if [ "$LOCK_HELD" = 1 ]; then
    if [ "$USE_FLOCK" = 1 ]; then exec 9>&-; else rm -rf "$LOCK"; fi
  fi
  LOCK_HELD=0
}
trap release_lock EXIT
trap 'release_lock; exit 130' INT TERM

# When a file or folder was last changed, in seconds since 1970, or 0 when that cannot be told
# (it is gone, or neither the GNU nor the BSD form of stat works here).
mtime_of() {
  local value
  value="$(stat -c %Y "$1" 2>/dev/null)" || value=""
  case "$value" in ''|*[!0-9]*) value="$(stat -f %m "$1" 2>/dev/null)" || value="" ;; esac
  case "$value" in ''|*[!0-9]*) value=0 ;; esac
  printf '%s' "$value"
}

# True when the lock directory is held by nobody alive: its pid is of a dead process, or it has
# had no pid for 10 seconds (the holder writes one right after mkdir, so it died in between).
lock_is_stale() {
  local holder
  holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$holder" ]; then
    kill -0 "$holder" 2>/dev/null && return 1
    return 0
  fi
  [ -d "$LOCK" ] || return 1
  local made now
  made="$(mtime_of "$LOCK")"
  now="$(date +%s)"
  [ "$made" != 0 ] && [ $((now - made)) -ge 10 ]
}

# Removes a stale lock, at most one caller at a time, looking again first. Returns at once
# when someone else is already doing it.
take_over_stale_lock() {
  if ! mkdir "$TAKEOVER" 2>/dev/null; then
    # Someone else is taking it over. If they died doing it, clear the way after 30 seconds.
    local made now
    made="$(mtime_of "$TAKEOVER")"
    now="$(date +%s)"
    if [ "$made" != 0 ] && [ $((now - made)) -ge 30 ]; then rmdir "$TAKEOVER" 2>/dev/null; fi
    return 0
  fi
  # Only one caller is here at a time. The lock may have changed hands since we looked.
  if lock_is_stale; then
    say "removing a stale lock left by pid $(cat "$LOCK/pid" 2>/dev/null || echo '?')"
    rm -rf "$LOCK"
  fi
  rmdir "$TAKEOVER" 2>/dev/null
}

acquire_lock() {
  if [ "$USE_FLOCK" = 1 ]; then
    exec 9>>"$LOCK_FILE" || fail "cannot open the lock file $LOCK_FILE"
    if ! flock -n 9; then
      say "another caller is starting the server; waiting for it"
      flock -w "$LOCK_TIMEOUT" 9 || fail "timed out waiting for the lock at $LOCK_FILE"
    fi
    LOCK_HELD=1
    return 0
  fi

  local waited=0
  while ! mkdir "$LOCK" 2>/dev/null; do
    if lock_is_stale; then
      take_over_stale_lock
      continue
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
  # "9>&-": the server must not inherit the lock file, or it would hold the lock for as long as
  # it runs. "--hostname localhost": reachable from this machine only.
  if command -v setsid >/dev/null 2>&1; then
    NEXT_TELEMETRY_DISABLED=1 setsid nohup npm run dev -- --port "$PORT" --hostname localhost >> "$LOG" 2>&1 < /dev/null 9>&- &
  else
    NEXT_TELEMETRY_DISABLED=1 nohup npm run dev -- --port "$PORT" --hostname localhost >> "$LOG" 2>&1 < /dev/null 9>&- &
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
    recorded_pid >/dev/null && patience=120
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
        # It is running and it is everybody's: slow is not a reason to take it away from them.
        fail "the development server (pid $(recorded_pid)) is running but has not answered $HEALTH_URL for ${patience}s. It may be busy compiling: look at .dev.log and try again. If it is stuck, restart it with: scripts/dev-ensure.sh --restart"
      else
        fail "port $PORT is in use by another program. Stop it, then run this again."
      fi
    fi
  fi

  # A process from an earlier start that is alive but not listening: most likely a server that
  # is still starting. Wait for it; never replace a live one without --restart.
  if recorded_pid >/dev/null; then
    say "a development server (pid $(recorded_pid)) is starting; waiting up to ${START_TIMEOUT}s for it"
    local waited=0
    while recorded_pid >/dev/null && [ "$waited" -lt "$START_TIMEOUT" ]; do
      healthy && { say "already running at http://localhost:${PORT}"; return 0; }
      sleep 1
      waited=$((waited + 1))
    done
    if recorded_pid >/dev/null; then
      fail "the development server (pid $(recorded_pid)) is running but never became healthy. Look at .dev.log. If it is stuck, restart it with: scripts/dev-ensure.sh --restart"
    fi
    # It exited on its own: start a fresh one.
    rm -f "$PIDFILE"
  fi
  start_server
}

# Sourced by scripts/dev-ensure.test.sh to try the functions above without starting anything.
if [ "${DEV_ENSURE_LIB:-}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

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
