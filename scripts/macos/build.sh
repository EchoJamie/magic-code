#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
OUTPUT="$ROOT/.artifacts/macos"
CONFIGURATION="${MAGIC_CONFIGURATION:-Debug}"
DEVELOPER="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
NAME="Magic Code"
if [[ "$CONFIGURATION" == Release ]]; then NAME="Magic Code"; fi
APP="$OUTPUT/$NAME.app"
mkdir -p "$OUTPUT"
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
PROTOCOL="$(python3 - "$VERSION" <<'PY'
import re, pathlib, sys
source = pathlib.Path('packages/contracts/src/native.ts').read_text()
version = re.search(r"SOFTWARE_VERSION = '([^']+)'", source).group(1)
assert version == sys.argv[1], 'package 与 native SOFTWARE_VERSION 必须同版'
print(re.search(r'NATIVE_PROTOCOL = ([0-9]+)', source).group(1))
PY
)"
python3 - "$OUTPUT/build-inputs.json" <<'PYINPUT'
import datetime, hashlib, json, pathlib, subprocess, sys
patterns = ['packages/*/src/**/*', 'packages/*/package.json', 'apps/macos/MagicCode/**/*',
            'apps/macos/MagicCode.xcodeproj/project.pbxproj',
            'apps/macos/MagicCode.xcodeproj/xcshareddata/xcschemes/*.xcscheme',
            'scripts/macos/build*.sh', 'scripts/macos/build-helper.mjs',
            'bun.lock', 'package.json', 'tsconfig.json', 'bunfig.toml']
files = sorted({p for pattern in patterns for p in pathlib.Path('.').glob(pattern) if p.is_file()})
inputs = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
projection = 'packages/app/src/run/native-projection.ts'
committed = subprocess.check_output(['git', 'show', head + ':' + projection])
record = {'startedAt': datetime.datetime.now().astimezone().isoformat(), 'coreCommit': head, 'patterns': patterns, 'inputs': inputs,
          'nativeProjectionMatchesCoreCommit': hashlib.sha256(committed).hexdigest() == inputs[projection]}
pathlib.Path(sys.argv[1]).write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
PYINPUT
bun run typecheck
bash scripts/macos/build-helper.sh "$OUTPUT/magic-runtime"
DEVELOPER_DIR="$DEVELOPER" xcodebuild -project apps/macos/MagicCode.xcodeproj -scheme MagicCode \
  -configuration "$CONFIGURATION" -derivedDataPath "$OUTPUT/DerivedData" -destination 'platform=macOS,arch=arm64' \
  build CODE_SIGNING_ALLOWED=NO MARKETING_VERSION="$VERSION" > "$OUTPUT/xcode-build.log" 2>&1 || { tail -80 "$OUTPUT/xcode-build.log"; exit 1; }
# Replace only this generated bundle, rejecting a running artifact before replacement.
if [[ -d "$APP" ]]; then
  if lsof -t +D "$APP" > /dev/null 2>&1; then echo "构建包正在使用：$APP" >&2; exit 1; fi
  rm -rf "$APP"
fi
ditto "$OUTPUT/DerivedData/Build/Products/$CONFIGURATION/$NAME.app" "$APP"
mkdir -p "$APP/Contents/Helpers"
cp "$OUTPUT/magic-runtime" "$APP/Contents/Helpers/magic-runtime"
/usr/libexec/PlistBuddy -c "Set :MagicProtocolVersion $PROTOCOL" "$APP/Contents/Info.plist"
IDENTITY="${MAGIC_SIGN_IDENTITY:--}"
STAMP=--timestamp=none
if [[ "$CONFIGURATION" == Release ]]; then
  [[ "$IDENTITY" == 'Developer ID Application:'* ]] || { echo 'Release 需要明确的 Developer ID Application 身份；本地使用 Debug。' >&2; exit 1; }
  STAMP=--timestamp
fi
codesign --force --options runtime "$STAMP" --sign "$IDENTITY" \
  --entitlements apps/macos/MagicCode/Resources/Helper.entitlements "$APP/Contents/Helpers/magic-runtime"
codesign --force --options runtime "$STAMP" --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
python3 -B scripts/macos/helper-probe.py "$APP/Contents/Helpers/magic-runtime" | tee "$OUTPUT/helper-probe.json"
cp bun.lock "$OUTPUT/bun.lock.snapshot"
python3 - "$OUTPUT/build-info.json" "$DEVELOPER" "$CONFIGURATION" <<'PY'
import json, pathlib, subprocess, sys, os, hashlib, datetime
def command(args, **kwargs): return subprocess.check_output(args, text=True, **kwargs).strip()
root = pathlib.Path.cwd()
package = json.loads((root/'package.json').read_text())
inputs = json.loads((pathlib.Path(sys.argv[1]).parent/'build-inputs.json').read_text())
current = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
           for pattern in inputs['patterns'] for p in root.glob(pattern) if p.is_file()}
assert current == inputs['inputs'], '构建期间输入或文件集合变化，请重建'
inputs['verifiedUnchangedAt'] = datetime.datetime.now().astimezone().isoformat()
(pathlib.Path(sys.argv[1]).parent/'build-inputs.json').write_text(json.dumps(inputs, ensure_ascii=False, indent=2)+'\n')
info = {'version': package['version'], 'bun': command(['bun','--version']),
        'xcode': command(['xcodebuild','-version'], env={**os.environ,'DEVELOPER_DIR':sys.argv[2]}),
        'os': command(['sw_vers']), 'architecture': command(['uname','-m']),
        'configuration': sys.argv[3], 'gitHead': command(['git','rev-parse','HEAD']),
        'dirty': bool(command(['git','status','--porcelain'])),
        'coreCommit': inputs['coreCommit'], 'nativeProjectionMatchesCoreCommit': inputs['nativeProjectionMatchesCoreCommit'],
        'inputManifest': 'build-inputs.json', 'inputsUnchangedDuringBuild': True}
pathlib.Path(sys.argv[1]).write_text(json.dumps(info, ensure_ascii=False, indent=2)+'\n')
PY
if [[ "$CONFIGURATION" == Release ]]; then
  : "${MAGIC_NOTARY_PROFILE:?Release 需要已配置的公证 keychain profile}"
  ditto -c -k --keepParent "$APP" "$OUTPUT/notary.zip"
  DEVELOPER_DIR="$DEVELOPER" xcrun notarytool submit "$OUTPUT/notary.zip" --keychain-profile "$MAGIC_NOTARY_PROFILE" --wait
  DEVELOPER_DIR="$DEVELOPER" xcrun stapler staple "$APP"
fi
STAGE="$(mktemp -d "$OUTPUT/dmg-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -ov -format UDZO -volname "$NAME" -srcfolder "$STAGE" "$OUTPUT/$NAME.dmg" > "$OUTPUT/dmg-build.log"
if [[ "$CONFIGURATION" == Release ]]; then
  codesign --timestamp --sign "$IDENTITY" "$OUTPUT/$NAME.dmg"
  DEVELOPER_DIR="$DEVELOPER" xcrun notarytool submit "$OUTPUT/$NAME.dmg" --keychain-profile "$MAGIC_NOTARY_PROFILE" --wait
  DEVELOPER_DIR="$DEVELOPER" xcrun stapler staple "$OUTPUT/$NAME.dmg"
  spctl --assess --type execute --verbose=2 "$APP"
fi
printf 'App: %s\nDMG: %s\n' "$APP" "$OUTPUT/$NAME.dmg"
