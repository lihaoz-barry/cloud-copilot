#!/usr/bin/env bash
#
# Restart cloud-scheduler (:8788).
#
# Deliberately separate from scripts/restart.sh, and deliberately rare. The
# dashboard restarts on every self-deploy; this process is the one thing that
# must not, because it holds the pid and process group of every running Copilot
# session. Restarting it is safe — the sessions are detached and write their own
# logs, and the new supervisor adopts them from data/sessions/index.json — but
# there is a window in which nothing is watching for their exit, so do it on
# purpose rather than as a side effect of shipping code.
#
# Same rules as restart.sh: identify the target by the port it holds, verify it
# is ours before killing anything, and fail loudly if the replacement does not
# answer.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SCHEDULER_PORT:-8788}"
LOG="$ROOT/scheduler.log"
cd "$ROOT" || exit 1

listener() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

wait_for_free() {
  local tries="$1"
  for _ in $(seq 1 "$tries"); do
    [ -z "$(listener)" ] && return 0
    sleep 0.25
  done
  [ -z "$(listener)" ]
}

pid="$(listener)"
if [ -n "$pid" ]; then
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *node*scheduler-server.js*) ;;
    *)
      echo "refusing to kill pid $pid on port $PORT — not a cloud-scheduler: $cmd" >&2
      exit 1
      ;;
  esac
  echo "stopping pid $pid (supervised sessions keep running)"
  kill "$pid" 2>/dev/null
  if ! wait_for_free 40; then
    echo "pid $pid ignored SIGTERM after 10s — sending SIGKILL" >&2
    kill -9 "$pid" 2>/dev/null
    wait_for_free 20
  fi
fi

if [ -n "$(listener)" ]; then
  echo "port $PORT is still held by pid $(listener) — refusing to start a second scheduler" >&2
  exit 1
fi

nohup npm run scheduler > "$LOG" 2>&1 &
new=$!

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    echo "cloud-scheduler up on :$PORT (pid $new)"
    curl -s "http://127.0.0.1:$PORT/api/health" | head -c 400
    echo
    exit 0
  fi
  kill -0 "$new" 2>/dev/null || break
  sleep 0.5
done

echo "cloud-scheduler did not answer on :$PORT within 20s — last 20 lines of $LOG:" >&2
tail -20 "$LOG" >&2
exit 1
