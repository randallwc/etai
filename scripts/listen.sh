#!/bin/sh
# Live inbound feed: polls the messaging recent-buffer and prints each
# new inbound text once. Run: sh scripts/listen.sh  (MESSAGING_URL env
# overrides the default http://localhost:4020).
url=${MESSAGING_URL:-http://localhost:4020}
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "[listen] watching $url/messages"
while true; do
  curl -s -m 5 "$url/messages" >"$tmp.new" 2>/dev/null || { sleep 5; continue; }
  node -e '
    const fs = require("fs");
    const seen = new Set(fs.existsSync(process.argv[1]) ? fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean) : []);
    let msgs = [];
    try { msgs = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).messages ?? []; } catch {}
    for (const m of msgs) {
      if (seen.has(m.externalId)) continue;
      seen.add(m.externalId);
      console.log(`${m.receivedAt} ${m.channel} ${m.from}: ${m.body}`);
    }
    fs.writeFileSync(process.argv[1], [...seen].join("\n"));
  ' "$tmp" "$tmp.new"
  sleep 3
done
