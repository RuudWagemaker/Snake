#!/usr/bin/env bash
# Pull the latest code for the checked-out branch and redeploy if it changed.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$BRANCH")" ] || [ "${1:-}" = "--force" ]; then
  echo "$(date -Is) updating to $(git rev-parse --short "origin/$BRANCH")"
  git reset -q --hard "origin/$BRANCH"
  docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
  docker image prune -f >/dev/null
fi
