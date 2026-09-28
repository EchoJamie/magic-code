#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="${1:-$ROOT/.artifacts/macos/magic-runtime}"
mkdir -p "$(dirname "$OUTPUT")"
cd "$ROOT"
bun scripts/macos/build-helper.mjs "$OUTPUT"
codesign --force --options runtime --timestamp=none --sign "${MAGIC_SIGN_IDENTITY:--}" \
  --entitlements apps/macos/MagicCode/Resources/Helper.entitlements "$OUTPUT"
codesign --verify --strict --verbose=2 "$OUTPUT"
