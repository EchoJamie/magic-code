/**
 * 显示小工具（缺陷轮 II 重画）——外壳自持显示组件的公共部件。
 *
 * 三件：**宽度**（CJK 算 2——折行与截断都靠它）· **折行 / 截断 / 补齐**（记录区的视口
 * 预算与状态行的两段排版都要自己算：铺满窗口之后**行数是我们的账**）· **一行短的时长**。
 *
 * 为什么自己算折行：终端也会折，但那样**视口预算就数不准**（记录区只渲染视口内的行，
 * 数错一行就少一行）。宽度自己算、行自己折，Ink 拿到的就是不折的确定行。
 */

/** 色板（原型 · 组件规格）——颜色只表语义，不做装饰。 */
export const PALETTE = {
  fg: '#d8dce4',
  dim: '#8b93a1',
  faint: '#5a626f',
  user: '#56b6c2',
  tool: '#61afef',
  ok: '#98c379',
  warn: '#e5c07b',
  danger: '#e06c75',
  /** 分隔点 / 更弱的痕（`·` 回执）。 */
  ghost: '#49505e',
} as const

/**
 * 一个字符占几列——**CJK / 全角算 2**，其余算 1。
 *
 * 只求「折行与截断数得对」，不求 Unicode 全覆盖（emoji / 组合字符按 1 算，
 * 顶多让某行多一列——不会串行）。
 */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0

  // 常见全角区：CJK 统一表意 · 全角标点 · 假名 · 谚文 · 全角形式
  if (code >= 0x1100 && code <= 0x115f) return 2
  if (code >= 0x2e80 && code <= 0xa4cf) return 2
  if (code >= 0xac00 && code <= 0xd7a3) return 2
  if (code >= 0xf900 && code <= 0xfaff) return 2
  if (code >= 0xfe30 && code <= 0xfe6f) return 2
  if (code >= 0xff00 && code <= 0xff60) return 2
  if (code >= 0xffe0 && code <= 0xffe6) return 2

  return 1
}

/** 文本占几列。 */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)

  return width
}

/** 折行——按显示宽度切（不切在字符中间；超长单词硬切）。 */
export function wrap(text: string, width: number): readonly string[] {
  if (width <= 0) return [text]

  const lines: string[] = []

  for (const raw of text.split('\n')) {
    let line = ''
    let used = 0

    for (const char of raw) {
      const size = charWidth(char)
      if (used + size > width && line !== '') {
        lines.push(line)
        line = ''
        used = 0
      }
      line += char
      used += size
    }

    lines.push(line)
  }

  return lines
}

/** 截断到宽度（超了加 `…`）——状态行的窄窗口降级用。 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (displayWidth(text) <= width) return text

  let kept = ''
  let used = 0
  for (const char of text) {
    const size = charWidth(char)
    if (used + size > width - 1) break
    kept += char
    used += size
  }

  return `${kept}…`
}

/** 右侧补齐到宽度（左右两段排版用）。 */
export function padRight(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap <= 0 ? text : text + ' '.repeat(gap)
}

/** 毫秒 → 人读（`0.6s` / `800ms`）。 */
export function durationLabel(elapsedMs: number): string {
  return elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${elapsedMs}ms`
}

/** token 数 → 人读（`3.1k` / `12.4k`）。 */
export function tokenLabel(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
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
