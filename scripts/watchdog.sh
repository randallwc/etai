#!/bin/sh
# Keeps scripts/serve.sh alive; serve.sh in turn keeps messaging, bus,
# and notify each running exactly once. Self-single via flock. Run:
#   setsid sh scripts/watchdog.sh &
cd "$(dirname "$0")/.."
exec 9>/tmp/etai-watchdog.lock
flock -n 9 || exit 0
while true; do
  if ! pgrep -f "scripts/serve.sh" >/dev/null; then
    echo "[watchdog] serve.sh gone, restarting" >>/tmp/etai-serve.log
    setsid sh scripts/serve.sh >/dev/null 2>&1 </dev/null &
  fi
  sleep 5
done
