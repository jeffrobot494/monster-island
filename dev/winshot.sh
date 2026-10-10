#!/usr/bin/env bash
# Headless screenshot via Windows Chrome (WSL lacks Chromium's system libs).
# Usage: [PROFILE=name] dev/winshot.sh <url> <out.png>   (add &shot=ms to the URL to hold the load event)
# PROFILE keeps a named profile (localStorage survives between runs); otherwise a temp one is used and removed.
set -uo pipefail
url="$1"; out="$2"
wintmp='C:\Users\jeffr\AppData\Local\Temp'
name="mi-shot-$$.png"
prof="mi-headless-${PROFILE:-$$}"
log=$(mktemp)
timeout 1200 "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
  --user-data-dir="$wintmp\\$prof" --no-first-run --window-size=${WIN:-1280,800} --hide-scrollbars \
  --enable-logging=stderr --v=0 --screenshot="$wintmp\\$name" "$url" > "$log" 2>&1
grep -aE 'CONSOLE|Uncaught' "$log" | sed -E 's/.*CONSOLE[^"]*"/[console] "/; s/", source: .*/"/'
rm -f "$log"
cp "/mnt/c/Users/jeffr/AppData/Local/Temp/$name" "$out" && rm -f "/mnt/c/Users/jeffr/AppData/Local/Temp/$name"
[ -z "${PROFILE:-}" ] && rm -rf "/mnt/c/Users/jeffr/AppData/Local/Temp/$prof" 2>/dev/null
true
