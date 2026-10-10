#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUTPUT="$ROOT/.artifacts/macos"
CONFIGURATION="${MAGIC_CONFIGURATION:-Release}"
DEVELOPER="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
NAME="Magic Code"
APP="$OUTPUT/$NAME.app"
IDENTITY="${MAGIC_SIGN_IDENTITY:-Apple Development: echojamieee@outlook.com (9JHY98AJMC)}"
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
DMG="$OUTPUT/$NAME-$VERSION-arm64.dmg"
PROTOCOL="$(python3 - "$VERSION" <<'PY'
import re, pathlib, sys
source = pathlib.Path('packages/contracts/src/native.ts').read_text()
assert re.search(r"SOFTWARE_VERSION = '([^']+)'", source).group(1) == sys.argv[1], 'package 与 native SOFTWARE_VERSION 必须同版'
print(re.search(r'NATIVE_PROTOCOL = ([0-9]+)', source).group(1))
PY
)"
mkdir -p "$OUTPUT"
if [[ -d "$APP" ]] && lsof -t +D "$APP" > /dev/null 2>&1; then echo "构建包正在使用：$APP" >&2; exit 1; fi
if [[ -f "$DMG" ]] && lsof -t "$DMG" > /dev/null 2>&1; then echo "镜像正在使用：$DMG" >&2; exit 1; fi
TEMP="$(mktemp -d "$OUTPUT/build.XXXXXX")"
ASSEMBLED=false
COMPLETE=false
cleanup() {
  rm -rf "$TEMP"
  if [[ "$ASSEMBLED" == true && "$COMPLETE" != true ]]; then rm -rf "$APP"; rm -f "$DMG"; fi
}
trap cleanup EXIT
# 输入清单仅用于本次同版检查，构建后清理。
python3 - "$TEMP/inputs.json" <<'PY'
import hashlib, json, pathlib, sys
patterns = ['packages/*/src/**/*', 'packages/*/package.json', 'apps/macos/MagicCode/**/*',
            'apps/macos/MagicCode.xcodeproj/**/*', 'scripts/macos/build*', 'patches/*.patch',
            'bun.lock', 'package.json', 'tsconfig.json', 'bunfig.toml']
inputs = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for pattern in patterns for p in pathlib.Path('.').glob(pattern) if p.is_file()}
pathlib.Path(sys.argv[1]).write_text(json.dumps([patterns, inputs]))
PY
bun run typecheck
MAGIC_SIGN_IDENTITY="$IDENTITY" bash scripts/macos/build-helper.sh "$TEMP/magic-runtime"
DEVELOPER_DIR="$DEVELOPER" xcodebuild -project apps/macos/MagicCode.xcodeproj -scheme MagicCode \
  -configuration "$CONFIGURATION" -derivedDataPath "$OUTPUT/DerivedData" -destination 'platform=macOS,arch=arm64' \
  build CODE_SIGNING_ALLOWED=NO MARKETING_VERSION="$VERSION" > "$TEMP/xcode-build.log" 2>&1 || { tail -80 "$TEMP/xcode-build.log"; exit 1; }
# 只替换本入口生成且未使用的产物。
if [[ -d "$APP" ]] && lsof -t +D "$APP" > /dev/null 2>&1; then echo "构建包正在使用：$APP" >&2; exit 1; fi
rm -rf "$APP"
rm -f "$DMG"
ASSEMBLED=true
ditto "$OUTPUT/DerivedData/Build/Products/$CONFIGURATION/$NAME.app" "$APP"
mkdir -p "$APP/Contents/Helpers"
cp "$TEMP/magic-runtime" "$APP/Contents/Helpers/magic-runtime"
/usr/libexec/PlistBuddy -c "Set :MagicProtocolVersion $PROTOCOL" "$APP/Contents/Info.plist"
codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$APP"
python3 - "$TEMP/inputs.json" <<'PY'
import hashlib, json, pathlib, sys
patterns, inputs = json.loads(pathlib.Path(sys.argv[1]).read_text())
current = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for pattern in patterns for p in pathlib.Path('.').glob(pattern) if p.is_file()}
assert current == inputs, '构建期间输入或文件集合变化，请重建'
PY
mkdir "$TEMP/stage"
ditto "$APP" "$TEMP/stage/$NAME.app"
ln -s /Applications "$TEMP/stage/Applications"
hdiutil create -ov -format UDZO -volname "$NAME" -srcfolder "$TEMP/stage" "$DMG"
COMPLETE=true
printf 'App: %s\nDMG: %s\n' "$APP" "$DMG"
