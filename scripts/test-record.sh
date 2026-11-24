#!/bin/bash
# 测试结果落盘（2026-11-24 裁定：每次运行的失败清单与详情写入文件，
# 定位问题不依赖重跑）——结构化 JUnit + 人读日志双份，`last-*` 固定名指向最近一次。
#
# 用法：scripts/test-record.sh <套件名> <bun test 参数...>
# 退出码 = bun test 的退出码（管道不影响门禁语义）。
set -uo pipefail

SUITE="${1:?用法: test-record.sh <套件名> <bun test 参数...>}"
shift

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.artifacts/test-results"
STAMP="$(date +%Y%m%d-%H%M%S)"
JUNIT="$DIR/$SUITE-$STAMP.xml"
LOG="$DIR/$SUITE-$STAMP.log"
mkdir -p "$DIR"

bun test "$@" --reporter=junit --reporter-outfile="$JUNIT" 2>&1 | tee "$LOG"
CODE="${PIPESTATUS[0]}"

cp "$JUNIT" "$DIR/last-$SUITE.xml"
cp "$LOG" "$DIR/last-$SUITE.log"

# 滚动保留最近 30 份（含 last 副本之外的按时间戳命名的产物）
ls -t "$DIR"/"$SUITE"-[0-9]*.xml "$DIR"/"$SUITE"-[0-9]*.log 2>/dev/null | tail -n +31 | while read -r stale; do rm -f "$stale"; done

if [[ "$CODE" != 0 ]]; then
  echo "── 测试未全绿（退出码 $CODE）；失败详情见 $JUNIT（结构化）与 $LOG（全文）" >&2
else
  echo "── 测试全绿；结果已记录：$JUNIT"
fi
exit "$CODE"
