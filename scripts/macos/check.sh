#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUTPUT="$ROOT/.artifacts/macos"
mkdir -p "$OUTPUT"
# Native contract and true Process tests require the signed embedded helper.
if [[ ! -x "$OUTPUT/Magic Code.app/Contents/Helpers/magic-runtime" ]]; then bash scripts/macos/build.sh; fi
RESULT="$OUTPUT/NativeTests-$(date +%Y%m%d-%H%M%S).xcresult"
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" xcodebuild \
  -project apps/macos/MagicCode.xcodeproj -scheme MagicCode -configuration Debug \
  -derivedDataPath "$OUTPUT/DerivedData" -destination 'platform=macOS,arch=arm64' \
  -parallel-testing-enabled NO -resultBundlePath "$RESULT" test CODE_SIGNING_ALLOWED=NO \
  > "$OUTPUT/xcode-test.log" 2>&1 || { tail -120 "$OUTPUT/xcode-test.log"; exit 1; }
tail -18 "$OUTPUT/xcode-test.log"
