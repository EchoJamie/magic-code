#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUTPUT="$ROOT/.artifacts/macos"
mkdir -p "$OUTPUT"
# Native contract and true Process tests require the signed embedded helper.
if [[ ! -x "$OUTPUT/Magic Code.app/Contents/Helpers/magic-runtime" ]]; then bash scripts/macos/build.sh; fi
TEMP="$(mktemp -d "$OUTPUT/native-check.XXXXXX")"
PASSED=false
trap 'if [[ "$PASSED" == true ]]; then rm -rf "$TEMP"; else printf "原生检查失败，诊断保留于 %s\n" "$TEMP"; fi' EXIT
DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}" xcodebuild \
  -project apps/macos/MagicCode.xcodeproj -scheme MagicCode -configuration Debug \
  -derivedDataPath "$OUTPUT/DerivedData" -destination 'platform=macOS,arch=arm64' \
  -parallel-testing-enabled NO -resultBundlePath "$TEMP/NativeTests.xcresult" test CODE_SIGNING_ALLOWED=NO \
  > "$TEMP/xcode-test.log" 2>&1 || { tail -120 "$TEMP/xcode-test.log"; exit 1; }
tail -18 "$TEMP/xcode-test.log"
PASSED=true
