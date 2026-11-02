#!/usr/bin/env bash
# The smoke a bundle passes on the runner that built it, on Linux or macOS:
# started on a temporary home, the app must name its run in the home's
# record, say its address and connect its connector; SIGTERM must run the
# stop order to exit code 0 and a record without a run; and the bundle must
# carry the notice. An AppImage is given as the AppRun its
# --appimage-extract makes, whose environment the bundled webview needs; the
# app as Contents/MacOS/Project02.
set -euo pipefail

app=${1:?"usage: smoke-shell.sh <squashfs-root/AppRun | Project02.app/Contents/MacOS/Project02>"}

# Without a display the app runs on a virtual one, its tray and its single
# instance on a session bus of their own inside it.
if [[ $(uname) == Linux && -z ${DISPLAY:-} ]]; then
  exec xvfb-run -a dbus-run-session -- "$BASH" "$0" "$@"
fi

root=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf -- "$root" || true' EXIT
home=$root/home
record=$home/daemon.json
export HOME=$root XDG_CONFIG_HOME=$root/config XDG_CACHE_HOME=$root/cache XDG_DATA_HOME=$root/data
if [[ $(uname) == Darwin ]]; then
  bundle=$(cd "$(dirname "$app")/../.." && pwd)
  logs=$HOME/Library/Logs/io.github.quellamc.project02
else
  bundle=$(cd "$(dirname "$app")" && pwd)
  logs=$XDG_DATA_HOME/io.github.quellamc.project02/logs
fi
pid=

pass() { echo "ok: $1"; }

fail() {
  echo "FAILED: $1" >&2
  for log in "$logs/daemon.log" "$logs/telegram.log" "$root/app.log"; do
    echo "--- $log" >&2
    cat "$log" >&2 2>/dev/null || true
  done
  if [[ -n $pid ]]; then kill -KILL "$pid" 2>/dev/null || true; fi
  exit 1
}

# Runs the command given until it succeeds, or answers false at the deadline.
by_deadline() {
  until "$@"; do
    ((SECONDS < deadline)) || return 1
    sleep 0.2
  done
}

ended() { ! kill -0 "$pid" 2>/dev/null; }

notice=$(find "$bundle" -name THIRD-PARTY-NOTICES.txt -type f)
[[ -n $notice ]] || fail "$bundle carries no THIRD-PARTY-NOTICES.txt"
pass "the bundle carries $notice"

"$app" --store "$home" >"$root/app.log" 2>&1 &
pid=$!
deadline=$((SECONDS + 60))

by_deadline grep -Eqs "\"pid\": $pid(,|\$)" "$record" ||
  fail "$record did not name the app's run, pid $pid, within 60 s"
pass "the record names the app's run, pid $pid"
by_deadline grep -qs '^PROJECT02_GATEWAY=http://127\.0\.0\.1:' "$logs/daemon.log" ||
  fail "the daemon did not say its address within 60 s"
pass "the daemon's log holds its address"
by_deadline grep -qs '^Telegram connector: connected to ' "$logs/telegram.log" ||
  fail "the connector did not connect within 60 s"
pass "the connector's log says it connected"

kill -TERM "$pid" 2>/dev/null || fail "the app had ended before SIGTERM"
deadline=$((SECONDS + 30))
by_deadline ended || fail "the app still ran 30 s after SIGTERM"
code=0
wait "$pid" || code=$?
pid=
((code == 0)) || fail "the app ended with exit code $code after SIGTERM"
pass "SIGTERM ended the app with exit code 0"
[[ -f $record ]] || fail "$record is gone"
! grep -q '"running"' "$record" || fail "$record still names a run"
pass "the record names no run"
