/**
 * **终端页签标题**（OSC 0）——把状态行 ② 那一格的会话名同步到终端页签 / 窗口标题。
 *
 * ## 为什么是 OSC 0
 *
 * 「应用把自己的标题报给终端」的**业界通用序列**就是 OSC 0（`\x1b]0;<标题>\x07`）：
 * Ghostty / iTerm2 / Terminal.app / kitty / WezTerm 原生认，tmux 把它解释为窗格标题。
 * 不做任何 Ghostty 专有方案（Ghostty 的 VT 文档明列 OSC 0/1/2，页签默认显示它）。
 *
 * ## 约定（照 codex / gemini-cli 的共识）
 *
 * - **变更时才写**（缓存上一次写入的标题，去重——每帧都写既吵又有闪烁风险）；
 * - **清空 ≠ 恢复**：退出时写一条**空** OSC（`\x1b]0;\x07`）清掉自己写过的标题；
 *   「恢复 shell 之前的原标题」**不可移植**（没有跨终端的读回手段，codex 同话），不假装能；
 * - **无标题的兜底＝产品名**（`🪄 Magic Code`——页签要的是身份，不是状态）；
 * - **清洗**：标题文本来自不可信来源（AI 生成的标题是模型输出、改名是用户输入），
 *   C0/C1 控制字符一律剔除（防截断或重塑转义序列——OSC 注入），空白折叠成单空格，
 *   按字素截到上限（多数终端对超长标题静默截断，240 留足余量）。
 */

/** 页签标题的字符上限——**字素**（与状态行标题那把尺子同源，多留余量给窗格装饰）。 */
export const TAB_TITLE_MAX_CHARS = 240

/** 清洗不可信标题文本——控制字符剔除、空白折叠、按字素截断；清洗后全空＝空串。 */
export function sanitizeTabTitle(text: string, limit: number = TAB_TITLE_MAX_CHARS): string {
  let out = ''
  let pendingSpace = false
  for (const char of Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).map(part => part.segment)) {
    const code = char.codePointAt(0) ?? 0
    // C0（含 \t \n \r）、DEL、C1——能截断、伪造或重塑转义序列的一律不进标题；
    // 控制段与空白同法折成单空格（codex / opencode 同一口径：词界不清掉）
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) || /\s/u.test(char)) {
      if (out !== '') pendingSpace = true
      continue
    }
    if (pendingSpace) {
      if (out.length >= limit) break
      out += ' '
      pendingSpace = false
    }
    if (out.length >= limit) break
    out += char
  }
  return out.trim()
}

/** 页签标题的写出面——`out` 由装配注入（真 stdout / 测试假流）。 */
export type TabTitleWriter = {
  /** ② 的会话名变了——`null` ＝ 还没有标题（按状态行同一口径显示「新会话」）。 */
  update(session: string | null): void
  /** 收摊——清掉自己写过的标题（写空 OSC，不假装能恢复原值）。 */
  clear(): void
}

/** 造标题写出器——去重状态随实例走（一条终端一个）。无标题时的兜底＝产品名（页签身份）。 */
export function createTabTitleWriter(out: { write(text: string): void }, fallback: string = '🪄 Magic Code'): TabTitleWriter {
  /** 上一次写出去的标题——去重用；`undefined` ＝ 本实例还什么都没写过。 */
  let last: string | undefined

  return {
    update(session: string | null): void {
      const title = sanitizeTabTitle(session ?? fallback)
      if (title === '' || title === last) return
      last = title
      out.write(`\x1b]0;${title}\x07`)
    },
    clear(): void {
      if (last === undefined) return
      last = undefined
      out.write('\x1b]0;\x07')
    },
  }
}
