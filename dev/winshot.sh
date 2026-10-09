#!/usr/bin/env bash
# Headless screenshot via Windows Chrome (WSL lacks Chromium's system libs).
# Usage: dev/winshot.sh <url> <out.png> [budget_ms]
set -euo pipefail
url="$1"; out="$2"; budget="${3:-8000}"
wintmp='C:\Users\jeffr\AppData\Local\Temp'
name="mi-shot-$$.png"
prof="$wintmp\\mi-headless-$$"
timeout 120 "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist \
  --user-data-dir="$prof" --no-first-run --window-size=1280,800 --hide-scrollbars \
  --enable-logging=stderr --v=0 \
  --screenshot="$wintmp\\$name" "$url" 2>&1 | grep -aE 'CONSOLE|Uncaught|ERROR:.*(js|console)' | sed -E 's/.*CONSOLE[^"]*"/[console] "/' | head -60 || true
cp "/mnt/c/Users/jeffr/AppData/Local/Temp/$name" "$out" && rm -f "/mnt/c/Users/jeffr/AppData/Local/Temp/$name"
rm -rf "/mnt/c/Users/jeffr/AppData/Local/Temp/mi-headless-$$" 2>/dev/null || true
