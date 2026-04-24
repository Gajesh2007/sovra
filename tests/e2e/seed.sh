#!/usr/bin/env bash
# Seeds a mounted /app/.data with aged files + a large events.jsonl.
set -euo pipefail
DATA_DIR="${1:-/app/.data}"
mkdir -p "$DATA_DIR"/{images,videos,voice,bid-images}

# Old media files (mtime 10 days ago)
for sub in images videos voice bid-images; do
  for i in 1 2 3; do
    f="$DATA_DIR/$sub/old-$i.bin"
    head -c $((1 * 1024 * 1024)) /dev/urandom > "$f"   # 1 MB each
    touch -d '10 days ago' "$f"
  done
done

# Fresh media (mtime now)
head -c $((512 * 1024)) /dev/urandom > "$DATA_DIR/images/fresh.png"

# events.jsonl bigger than 50 MB — 70k lines × ~860 bytes ≈ 60.2 MB
# With ~12MB media → ~72MB total → triggers disk pressure (>70% of 100MB)
cat > /tmp/gen-events.js <<'EOF'
const fs = require('fs');
const stream = fs.createWriteStream(process.argv[2], { flags: 'w' });
for (let i = 0; i < 70000; i++) {
  stream.write(JSON.stringify({ type: 'monologue', text: 'x'.repeat(800), state: 'scanning', ts: i }) + '\n');
}
stream.end();
EOF
bun run /tmp/gen-events.js "$DATA_DIR/events.jsonl"

# A posts.json referencing the old image
cat > "$DATA_DIR/posts.json" <<'JSON'
[
  {
    "id":"p1","tweetId":"t1","cartoonId":"c1","text":"test",
    "imageUrl":"/images/old-1.bin","type":"organic","postedAt":1,
    "engagement":{"likes":0,"retweets":0,"replies":0,"views":0,"lastChecked":0}
  }
]
JSON

du -sh "$DATA_DIR"/* 2>/dev/null
