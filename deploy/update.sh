#!/usr/bin/env bash
# Updates DetailFlow on the server to the latest main: fetch, install, build. Runs as the service user
# (sudo -u detailflow /opt/detailflow/deploy/update.sh); the caller restarts the service afterwards.
# Nothing is changed if the build fails; the previous commit is printed for a rollback.
set -euo pipefail
cd /opt/detailflow

previous=$(git rev-parse --short HEAD)
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ -d dist ]; then
  echo "Already up to date ($previous)."
  exit 0
fi
# Build in place; the running process keeps serving the old files until it is restarted.
git merge --ff-only --quiet origin/main
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if ! corepack pnpm install --frozen-lockfile || ! corepack pnpm build; then
  echo "Build failed: going back to $previous." >&2
  git reset --hard --quiet "$previous"
  corepack pnpm install --frozen-lockfile && corepack pnpm build
  exit 1
fi
echo "Updated $previous → $(git rev-parse --short HEAD). Restart the service to apply."
