#!/bin/sh
cd "$(dirname "$0")/.."
echo $$ > /tmp/etai-serve.pid
exec 8>/tmp/etai-serve.lock
flock -n 8 || exit 0
pkill -f "node messaging/index.js" 2>/dev/null
pkill -f "node bus/index.js" 2>/dev/null
pkill -f "node calendar-agent/notify.js" 2>/dev/null
sleep 1
supervise() {
  name=$1
  shift
  trap 'kill $pid 2>/dev/null' EXIT
  trap 'exit' TERM INT
  pid=
  while true; do
    "$@" >>"/tmp/etai-$name.log" 2>&1 &
    pid=$!
    wait $pid
    rc=$?
    echo "[serve] $name exited rc=$rc; restarting in 3s" >>/tmp/etai-serve.log
    sleep 3
  done
}
supervise messaging node messaging/index.js &
MPID=$!
supervise bus node bus/index.js &
BPID=$!
supervise notify node calendar-agent/notify.js &
NPID=$!
trap 'kill $MPID $BPID $NPID 2>/dev/null' EXIT
trap 'exit' TERM INT
wait
