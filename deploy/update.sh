#!/usr/bin/env bash
# Pull the latest code for the checked-out branch and redeploy if it changed.
# A deploy only counts as done once the containers are up; a failed build is
# retried on the next run (every 5 minutes from cron).
set -uo pipefail
cd "$(dirname "$0")/.."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
MARK=deploy/.deployed
git fetch -q origin "$BRANCH" || { echo "$(date -Is) fetch failed"; exit 1; }
TARGET="$(git rev-parse "origin/$BRANCH")"
if [ "$(cat "$MARK" 2>/dev/null)" != "$TARGET" ] || [ "${1:-}" = "--force" ]; then
  echo "$(date -Is) deploying $(git rev-parse --short "$TARGET")"
  git reset -q --hard "$TARGET"
  if docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build; then
    echo "$TARGET" > "$MARK"
    docker image prune -f >/dev/null
    echo "$(date -Is) deployed $(git rev-parse --short "$TARGET")"
  else
    echo "$(date -Is) deploy FAILED, will retry in 5 minutes"
    exit 1
  fi
fi
