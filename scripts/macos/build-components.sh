#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${1:-$ROOT/.artifacts/macos/components}"
PROFILE="${2:-terminal}"
[[ "$PROFILE" == engine || "$PROFILE" == terminal ]] || { echo '组合须为 engine 或 terminal' >&2; exit 1; }
mkdir -p "$OUTPUT"
cd "$ROOT"
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
