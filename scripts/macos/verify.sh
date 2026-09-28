#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUTPUT="$ROOT/.artifacts/macos"
APP="$OUTPUT/Magic Code Dev.app"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements :- "$APP/Contents/Helpers/magic-runtime" > "$OUTPUT/helper-entitlements.plist" 2> "$OUTPUT/helper-signature.log"
python3 -B scripts/macos/helper-probe.py "$APP/Contents/Helpers/magic-runtime" | tee "$OUTPUT/helper-probe.json"
python3 -B scripts/macos/verify.py "$APP" "$OUTPUT"
python3 -B scripts/macos/hosted-probe.py "$APP" "$OUTPUT"
if [[ -f "$OUTPUT/Magic Code Dev.dmg" ]]; then
  hdiutil verify "$OUTPUT/Magic Code Dev.dmg" > "$OUTPUT/dmg-verify.log"
  INSTALL="$(mktemp -d /tmp/magic-native-install.XXXXXX)"
  mkdir -p "$INSTALL/volume" "$INSTALL/Applications" "$OUTPUT/relocated"
  trap 'hdiutil detach "$INSTALL/volume" > /dev/null 2>&1 || true; rm -rf "$INSTALL"' EXIT
  hdiutil attach "$OUTPUT/Magic Code Dev.dmg" -readonly -nobrowse -mountpoint "$INSTALL/volume" > "$OUTPUT/dmg-mount.log"
  ditto "$INSTALL/volume/Magic Code Dev.app" "$INSTALL/Applications/Magic Code Dev.app"
  hdiutil detach "$INSTALL/volume" > "$OUTPUT/dmg-unmount.log"
  codesign --verify --deep --strict "$INSTALL/Applications/Magic Code Dev.app"
  python3 -B scripts/macos/helper-probe.py "$INSTALL/Applications/Magic Code Dev.app/Contents/Helpers/magic-runtime" > "$OUTPUT/relocated/helper-probe.json"
  python3 -B scripts/macos/verify.py "$INSTALL/Applications/Magic Code Dev.app" "$OUTPUT/relocated"
fi
echo '默认验证不会启动 Terminal.app、安装登录项或请求/发送系统通知。'
