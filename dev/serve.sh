#!/usr/bin/env bash
# (Re)start the dev server on :5199 in the background; pid in dev/.vite.pid
cd "$(dirname "$0")/.."
[ -f dev/.vite.pid ] && kill "$(cat dev/.vite.pid)" 2>/dev/null && sleep 1
nohup npx vite --port 5199 --strictPort > "${VITE_LOG:-/tmp/mi-vite.log}" 2>&1 &
echo $! > dev/.vite.pid
sleep 3
tail -2 "${VITE_LOG:-/tmp/mi-vite.log}"
