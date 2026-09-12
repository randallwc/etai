#!/bin/sh
# Pull new code and bounce the services onto it. serve.sh supervise
# loops respawn each service ~3s after it dies, so killing the node
# processes is the whole deploy. Safe to run anytime.
cd "$(dirname "$0")/.."

git pull --rebase --autostash || echo "[update] pull failed, restarting on current tree" >&2

if ! pgrep -f "scripts/serve.sh" >/dev/null; then
  setsid sh scripts/serve.sh >/dev/null 2>&1 </dev/null &
fi
pkill -f "node messaging/index.js" 2>/dev/null
pkill -f "node bus/index.js" 2>/dev/null
pkill -f "node calendar-agent/notify.js" 2>/dev/null

for port in 4020 4010; do
  ok=
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s -m 2 "http://localhost:$port/healthz" | grep -q '"ok":true'; then
      ok=1; break
    fi
    sleep 2
  done
  if [ -n "$ok" ]; then echo "[update] :$port healthy"; else echo "[update] :$port NOT responding" >&2; fi
done
