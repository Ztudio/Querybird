#!/usr/bin/env bash
# Rebuilds the debug .app bundle and relaunches it (macOS).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tauri build --debug --bundles app 2>&1 | tail -1
pkill -f "Querybird.app/Contents/MacOS/querybird" || true
sleep 1
open src-tauri/target/debug/bundle/macos/Querybird.app
