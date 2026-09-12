#!/bin/sh
# Always-on dev stack: messaging, bus, calendar notify. Restarts the
# whole stack if any member dies -- bus subscribes to messaging at
# startup, so order and restart-together both matter. Logs to /tmp/etai-*.
# Stop: kill $(cat /tmp/etai-serve.pid) or pkill -f serve.sh
cd "$(dirname "$0")/.."
echo $$ > /tmp/etai-serve.pid
trap 'kill $MPID $BPID $NPID 2>/dev/null' EXIT
while true; do
  node messaging/index.js >>/tmp/etai-messaging.log 2>&1 &
  MPID=$!
  sleep 1
  node bus/index.js >>/tmp/etai-bus.log 2>&1 &
  BPID=$!
  node calendar-agent/notify.js >>/tmp/etai-notify.log 2>&1 &
  NPID=$!
  echo "[serve] up: messaging=$MPID bus=$BPID notify=$NPID" >>/tmp/etai-serve.log
  while kill -0 $MPID 2>/dev/null && kill -0 $BPID 2>/dev/null && kill -0 $NPID 2>/dev/null; do
    sleep 2
  done
  kill $MPID $BPID $NPID 2>/dev/null
  echo "[serve] a member died; restarting stack" >>/tmp/etai-serve.log
  sleep 2
done
