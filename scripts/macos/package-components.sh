#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
PROFILE="${1:-terminal}"
[[ "$PROFILE" == engine || "$PROFILE" == terminal ]] || { echo '用法：package-components.sh engine|terminal' >&2; exit 1; }
OUTPUT="$ROOT/.artifacts/macos"
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
mkdir -p "$OUTPUT"
TEMP="$(mktemp -d "$OUTPUT/components.XXXXXX")"
trap 'rm -rf "$TEMP"' EXIT
bun run typecheck
bash scripts/macos/build-components.sh "$TEMP/payload" "$PROFILE"
cat > "$TEMP/payload/install.sh" <<INSTALL
#!/bin/bash
set -euo pipefail
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
exec "\$DIR/magic-engine" install --profile "$PROFILE" --payload "\$DIR" "\$@"
INSTALL
chmod 755 "$TEMP/payload/install.sh"
ARCHIVE="$OUTPUT/magic-$PROFILE-$VERSION-arm64.tar.gz"
tar -czf "$TEMP/package.tar.gz" -C "$TEMP/payload" .
mv "$TEMP/package.tar.gz" "$ARCHIVE"
printf '%s\n' "$ARCHIVE"
