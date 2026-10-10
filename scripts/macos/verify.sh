#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUTPUT="$ROOT/.artifacts/macos"
APP="${1:-$OUTPUT/Magic Code.app}"
codesign --verify --deep --strict --verbose=2 "$APP"
python3 -B scripts/macos/helper-probe.py "$APP/Contents/Helpers/magic-runtime"
python3 -B scripts/macos/hosted-probe.py "$APP"
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
DMG="$OUTPUT/Magic Code-$VERSION-arm64.dmg"
if [[ -f "$DMG" ]]; then hdiutil verify "$DMG"; fi
echo '签名、编译 Engine 与模型/工具检查完成；系统托管及 App 界面验证使用独立验证入口。'
