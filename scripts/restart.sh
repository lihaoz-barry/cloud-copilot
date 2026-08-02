#!/usr/bin/env bash
#
# Replace the running cloud-copilot with one started from the code now on disk.
# This is what `.cloud-copilot.json` runs to deploy this repo to itself, so its
# failure mode matters more than its speed.
#
# The one-liner it replaces —
#     pkill -f 'node server.js'; sleep 1; (nohup npm start &); sleep 2; curl ...
# — could fail two ways at once, and did it silently:
#
#   * `pkill -f 'node server.js'` matches by command line, so it also matches
#     the shell running that very command (its argv contains the pattern) and
#     any unrelated project's `node server.js`;
#   * a fixed `sleep 1` does not wait for the port to be released, so the new
#     process died of EADDRINUSE while the OLD one kept serving. The files on
#     disk were new, the code answering requests was not, and every endpoint
#     the new UI had learned about returned 404.
#
# So: identify the target by the port it actually holds, verify it is ours,
# wait for the port to really free up, and exit non-zero (with the log) if the
# replacement is not answering. A deploy that did not deploy must fail loudly.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
LOG="$ROOT/server.log"
cd "$ROOT" || exit 1

# pid of whatever is LISTENing on our port, empty if the port is free.
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
  # Never kill a stranger: the port is ours by convention, not by right.
  case "$cmd" in
    *node*server.js*) ;;
    *)
      echo "refusing to kill pid $pid on port $PORT — not a cloud-copilot server: $cmd" >&2
      exit 1
      ;;
  esac
  echo "stopping pid $pid"
  kill "$pid" 2>/dev/null
  if ! wait_for_free 40; then
    echo "pid $pid ignored SIGTERM after 10s — sending SIGKILL" >&2
    kill -9 "$pid" 2>/dev/null
    wait_for_free 20
  fi
fi

if [ -n "$(listener)" ]; then
  echo "port $PORT is still held by pid $(listener) — refusing to start a second server" >&2
  exit 1
fi

nohup npm start > "$LOG" 2>&1 &
new=$!

for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    echo "cloud-copilot up on :$PORT (pid $new, $(git rev-parse --short HEAD 2>/dev/null || echo '?'))"
    exit 0
  fi
  # The launcher dying is a definite answer — stop waiting for the timeout.
  kill -0 "$new" 2>/dev/null || break
  sleep 0.5
done

echo "server did not answer on :$PORT within 30s — last 20 lines of $LOG:" >&2
tail -20 "$LOG" >&2
exit 1
