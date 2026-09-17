/**
 * 显示小工具（U09）——外壳自持显示组件的公共部件。
 */

/** 文本按行拆（去掉末尾空行——`stdout` 常以换行收尾）。 */
export function linesOf(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  return lines
}

/** 是否是可录入的字符（控制键、转义序列不算——整段粘贴算）。 */
export function isPrintable(input: string): boolean {
  if (input === '') return false

  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) return false
  }

  return true
}

/** 毫秒 → 人读（`1.2s` / `800ms`）。 */
export function durationLabel(elapsedMs: number): string {
  return elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`
}
