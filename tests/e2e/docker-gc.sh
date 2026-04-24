#!/usr/bin/env bash
set -euo pipefail

IMAGE="sovra-gc-e2e:local"
CONTAINER="sovra-gc-e2e"
SCENARIO="${1:-no-r2}"   # no-r2 | r2-mock

echo "== Building image =="
docker build -t "$IMAGE" .

# Clean previous
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# tmpfs size: 100 MB to force disk-pressure with the 60MB events.jsonl + ~12MB media
TMPFS_OPT="--tmpfs /app/.data:rw,size=100m"

# Minimal env — R2 disabled unless scenario says otherwise
ENVS=(
  -e TEST_MODE=true
  -e GC_ENABLED=true
  -e TWITTER_BEARER_TOKEN=x
  -e TWITTER_API_KEY=x
  -e TWITTER_API_SECRET=x
  -e TWITTER_ACCESS_TOKEN=x
  -e TWITTER_ACCESS_SECRET=x
  -e TWITTER_USERNAME=test
  -e ANTHROPIC_API_KEY=x
)

if [ "$SCENARIO" = "r2-mock" ]; then
  echo "(r2-mock scenario skipped — requires minio; add later)"
  exit 0
fi

echo "== Starting container (scenario=$SCENARIO) =="
docker run -d --name "$CONTAINER" $TMPFS_OPT "${ENVS[@]}" "$IMAGE"

echo "== Seeding /app/.data =="
docker cp tests/e2e/seed.sh "$CONTAINER:/tmp/seed.sh"
docker exec "$CONTAINER" bash /tmp/seed.sh /app/.data

echo "== Waiting 10s for a janitor cycle (TEST_MODE → 2s initial delay + 5s interval) =="
sleep 10

echo "== Inspecting /app/.data after janitor run =="
docker exec "$CONTAINER" sh -c 'du -sb /app/.data/events.jsonl /app/.data/images /app/.data/videos /app/.data/voice /app/.data/bid-images 2>/dev/null || true'

# Assertions
EVENTS_SIZE=$(docker exec "$CONTAINER" sh -c 'stat -c %s /app/.data/events.jsonl')
LINES=$(docker exec "$CONTAINER" sh -c 'wc -l < /app/.data/events.jsonl')
echo "events.jsonl: size=$EVENTS_SIZE bytes, lines=$LINES"

if [ "$EVENTS_SIZE" -ge $((50 * 1024 * 1024)) ]; then
  echo "FAIL: events.jsonl did not rotate below 50 MB"
  docker logs "$CONTAINER" 2>&1 | tail -80
  docker rm -f "$CONTAINER"
  exit 1
fi

if [ "$LINES" -gt 10500 ]; then
  echo "FAIL: events.jsonl has $LINES lines, expected ~10000"
  docker rm -f "$CONTAINER"
  exit 1
fi

# Under disk pressure (>70%) the tmpfs should have dropped aged media
OLD_REMAINING=$(docker exec "$CONTAINER" sh -c 'ls /app/.data/images/old-*.bin 2>/dev/null | wc -l')
if [ "$SCENARIO" = "no-r2" ]; then
  echo "old-*.bin remaining: $OLD_REMAINING (informational)"
  POSTS_IMAGE_URL=$(docker exec "$CONTAINER" sh -c 'cat /app/.data/posts.json | grep -o imageUrl || true')
  if [ "$OLD_REMAINING" = "0" ] && [ -n "$POSTS_IMAGE_URL" ]; then
    echo "FAIL: old-1.bin deleted but posts.json still references it"
    docker rm -f "$CONTAINER"
    exit 1
  fi
fi

echo "PASS"
docker rm -f "$CONTAINER"
