#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${1:-$ROOT/.artifacts/macos/components}"
PROFILE="${2:-terminal}"
[[ "$PROFILE" == engine || "$PROFILE" == terminal ]] || { echo '组合须为 engine 或 terminal' >&2; exit 1; }
mkdir -p "$OUTPUT"
cd "$ROOT"
# **语音助手**（U135）——先编出来，`magic-cli` 打包时把它**嵌进单文件**（不另放一个产物）。
# 采音与端侧转写在 Swift 里，外壳只读它的 stdout。麦克风／语音识别的用途说明要烤进
# 二进制的 `__info_plist`，否则系统不给这条进程授权；硬运行时下还必须有
# `com.apple.security.device.audio-input`（见 `Voice.entitlements`）。
if [[ "$PROFILE" == terminal ]]; then
  VOICE_OUT="$ROOT/packages/client/local-capabilities/voice/build"
  mkdir -p "$VOICE_OUT"
  swiftc -O "$ROOT/packages/client/local-capabilities/voice/main.swift" \
    "$ROOT/packages/client/local-capabilities/voice/Hotkey.swift" -o "$VOICE_OUT/magic-voice.bin" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$ROOT/packages/client/local-capabilities/voice/Info.plist"
  codesign --force --options runtime --timestamp=none --sign "${MAGIC_SIGN_IDENTITY:-Apple Development: echojamieee@outlook.com (9JHY98AJMC)}" \
    --entitlements apps/macos/MagicCode/Resources/Voice.entitlements "$VOICE_OUT/magic-voice.bin"
  codesign --verify --strict --verbose=2 "$VOICE_OUT/magic-voice.bin"
fi
COMPONENTS=(engine)
if [[ "$PROFILE" == terminal ]]; then COMPONENTS+=(cli); fi
for COMPONENT in "${COMPONENTS[@]}"; do
  FILE="$OUTPUT/magic-$COMPONENT"
  if [[ -f "$FILE" ]] && lsof -t "$FILE" >/dev/null 2>&1; then echo "组件正在使用：$FILE" >&2; exit 1; fi
  bun scripts/macos/build-components.mjs "$COMPONENT" "$FILE"
  codesign --force --options runtime --timestamp=none --sign "${MAGIC_SIGN_IDENTITY:-Apple Development: echojamieee@outlook.com (9JHY98AJMC)}" \
    --entitlements apps/macos/MagicCode/Resources/Helper.entitlements "$FILE"
  codesign --verify --strict --verbose=2 "$FILE"
done
