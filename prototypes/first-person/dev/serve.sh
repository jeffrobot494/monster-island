#!/usr/bin/env bash
# (Re)start the dev server on :5201 in the background; pid in dev/.vite.pid
cd "$(dirname "$0")/.."
# stop whatever holds the port (the pid file only has the npx wrapper; vite runs as its child)
old=$(ss -ltnp 2>/dev/null | grep ':5201 ' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
[ -f dev/.vite.pid ] && old="$old $(cat dev/.vite.pid)"
[ -n "${old// }" ] && kill $old 2>/dev/null
for _ in $(seq 20); do ss -ltn 2>/dev/null | grep -q ':5201 ' || break; sleep 0.5; done
nohup npx vite --port 5201 --strictPort --host > "${VITE_LOG:-/tmp/hmfp-vite.log}" 2>&1 &
echo $! > dev/.vite.pid
sleep 3
tail -2 "${VITE_LOG:-/tmp/hmfp-vite.log}"
