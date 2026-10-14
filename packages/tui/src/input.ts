/** 外壳认得的按键——组件把 Ink 的 `(input, key)` 收窄成这个（多出来的都算 `other`）。 */
export type ShellKey =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'enter' }
  /** `shift+回车`——**换行**（原型 · 键盘：`回车` 发送 · `shift+回车` 换行）。 */
  | { readonly kind: 'newline' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'shift+tab' }
  | { readonly kind: 'ctrl+g' }
  | { readonly kind: 'backspace' }

  | { readonly kind: 'left' }
  | { readonly kind: 'right' }

  | { readonly kind: 'lineStart' }
  | { readonly kind: 'lineEnd' }
  /** `delete`（前向删除）——删插入点**右边**那一个字素。 */
  | { readonly kind: 'delete' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'ctrl+p' }
  | { readonly kind: 'ctrl+n' }
  | { readonly kind: 'pickerDetailTop'; readonly top: number }
  | { readonly kind: 'memberInput' }
  | { readonly kind: 'memberMenu' }
  | { readonly kind: 'alt+enter' }
  | { readonly kind: 'up'; readonly columns?: number }
  | { readonly kind: 'down'; readonly columns?: number }

  | { readonly kind: 'ctrl+c' }
  | { readonly kind: 'ctrl+o' }
  | { readonly kind: 'ctrl+r' }

  | { readonly kind: 'ctrl+t' }

  | { readonly kind: 'ctrl+x' }

  | { readonly kind: 'ctrl+w' }

  | { readonly kind: 'ctrl+v' }

  | { readonly kind: 'decisionTop'; readonly top: number }
  | { readonly kind: 'planTop'; readonly top: number }
  | { readonly kind: 'readerTop'; readonly top: number }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'other'; readonly label: string }


/** Ink 的 `(input, key)` → 外壳认得的按键（0 到多条——一次回调可能带一串正文）。 */
export function toShellKeys(
  input: string,
  key: {
    readonly ctrl?: boolean
    readonly meta?: boolean
    readonly shift?: boolean
    readonly return?: boolean
    readonly backspace?: boolean
    readonly delete?: boolean
    readonly escape?: boolean
    readonly upArrow?: boolean
    readonly downArrow?: boolean
    readonly leftArrow?: boolean
    readonly rightArrow?: boolean
    readonly tab?: boolean
  },
): readonly ShellKey[] {
  if (key.return === true && key.meta === true) return [{kind:'alt+enter'}]
  if (key.ctrl === true && input === 'p') return [{ kind: 'ctrl+p' }]
  if (key.ctrl === true && input === 'n') return [{ kind: 'ctrl+n' }]
  if (key.ctrl === true && input === 'c') return [{ kind: 'ctrl+c' }]
  if (key.ctrl === true && input === 'g') return [{ kind: 'ctrl+g' }]
  if (key.ctrl === true && input === 'o') return [{ kind: 'ctrl+o' }]
  if (key.ctrl === true && input === 'r') return [{ kind: 'ctrl+r' }]
  // `Ctrl T`——收起/展开当前清单（U34）。两条来路同形：裸控制码 `\x14`（Ink 解成
  // `ctrl＋字母 t`）与 kitty 协议下的 `CSI 116;5u`（`use-input` 那两支都归到 `input === 't'`）。
  if (key.ctrl === true && input === 't') return [{ kind: 'ctrl+t' }]
  // `Ctrl X` / `Ctrl W`——会话列表里停选中的那一条（U50）：整体 / 局部两档。
  // 只在 `/resume` 那一屏有意义（见 `shell.ts` 那两个键的注），别处按下去是无声的。
  if (key.ctrl === true && input === 'x') return [{ kind: 'ctrl+x' }]
  if (key.ctrl === true && input === 'w') return [{ kind: 'ctrl+w' }]
  // `Ctrl V`——取剪贴板里的图（U107）。**这个键必须落在 `other` 那一支之前认下来**
  // （同下面 `Ctrl A` / `Ctrl E` 那条注的由头：落到 `other` 就没人接了）。
  // 两条来路同形（裸控制码 `\x16` 与 kitty 协议下的 `CSI 22;5u`）——与 `Ctrl T` 同一处置。
  if (key.ctrl === true && input === 'v') return [{ kind: 'ctrl+v' }]
  // **`Ctrl A` / `Ctrl E`——行首 / 行末**（U85）。原型 · 键盘那一节没列这一对，可它是
  // **readline 的老面孔**（用户真跑时按下去发现没有）：与 `←` `→` 同一族的插入点移动，
  // 只是**一步跨到行首 / 行末**。语义与落点见 `shell.ts` 的 `lineStart` / `lineEnd`。
  //
  // ⚠️ **落到 `other` 那支就不管用了**——那是「没人接的键」的收容处（见下面那一支），
  //    故这一对必须在它**之前**认下来（早先正是漏在这儿：屏上按下去什么都不发生）。
  if (key.ctrl === true && input === 'a') return [{ kind: 'lineStart' }]
  if (key.ctrl === true && input === 'e') return [{ kind: 'lineEnd' }]
  if (key.tab === true) return [{ kind: key.shift === true ? 'shift+tab' : 'tab' }]

  // **`shift+回车` ＝ 换行**（原型 · 键盘）。两条来路都要认（这就是「两条来路」那件事）：
  // ① **kitty 键盘协议**（`run.ts` 开了）——终端把它报成独立的 `CSI 13;2u`，
  //    Ink 解出 `return ＋ shift`；
  // ② **裸 LF**——有的终端 `shift+回车` 就发一个 `\n`（而 `\n` 在 Ink 那儿**本来就不是**
  //    `return`：它名字叫 `enter`；今天落到下面的分支会被当成一个正文字符塞进草稿）。
  if (key.return === true && key.shift === true) return [{ kind: 'newline' }]
  if (input === '\n') return [{ kind: 'newline' }]

  if (key.return === true) return [{ kind: 'enter' }]
  // ⚠️ **退格与前向删除是两个键**（U31）——早先并成「退格」，插入点一动就露馅：
  //    两个键删的是**两边**（`⌫` 删插入点左边、`delete` 删右边）
  if (key.backspace === true) return [{ kind: 'backspace' }]
  if (key.delete === true) return [{ kind: 'delete' }]
  if (key.escape === true) return [{ kind: 'escape' }]
  if (key.upArrow === true) return [{ kind: 'up' }]
  if (key.downArrow === true) return [{ kind: 'down' }]
  // 左右键（U31）——Ink 给的形态：`input === ''` ＋ `key.leftArrow / rightArrow`
  if (key.leftArrow === true) return [{ kind: 'left' }]
  if (key.rightArrow === true) return [{ kind: 'right' }]

  // 带 ctrl / meta 的其余键不是正文（Ink 把控制字符解成「字母 ＋ ctrl」）
  if (key.ctrl === true || key.meta === true) {
    return input === '' ? [] : [{ kind: 'other', label: `${key.ctrl === true ? 'ctrl+' : 'meta+'}${input}` }]
  }

  if (input === '') return []

  // 一次来一串＝**攒块**——来路两条（都不是「只有粘贴」）：
  // ① **敲的键被合块**（D35 的主角）：应用的读没跟上手，`/exit` 与紧接的回车并成一个读块；
  // ② 终端不认 bracketed paste 时的**粘贴**。
  //
  // ⚠️ **一个字符都不改**（2026-09-22 独立复核）：早先这里逐字符摊开时不落控制字符，
  // 结果**粘贴里的 Tab 被悄悄删掉**（`if ready:\n\tprint(1)` 到模型手上成了不带缩进的
  // 两行）——Tab 是**合法的粘贴内容**，不是「用户打不出来」的东西。**原文照收**：
  // 是正文就原样进草稿；换行那一条由上面 `input === '\n'` 与 `key.return` 两处管。
  //
  // ⚠️ **D35**：末尾那一个 `\r` 得认回来——但**只在能自证的那一形**上（见 `trailingEnterOf`）。
  //    它是**唯一**从这一支里长出来的非正文键；其余每一个字符照旧原样摊开。
  const body = trailingEnterOf(input)
  const chars = [...(body ?? input)].map((char) => ({ kind: 'char', char }) as const)

  return body === null ? chars : [...chars, { kind: 'enter' }]
}

/**
 * 攒块**末尾**那一个 `\r` 算不算回车（缺陷 D35）——**只认能自证的那一形**。
 *
 * 返回该当回车的那种块里**减掉末尾 `\r` 的正文**；不算回车时返回 `null`（那个块原样是正文）。
 *
 * ## 那个缺陷
 *
 * 正文与回车**挤进同一个读块**时（`/exit\r`），Ink 的 `parseKeypress` 把整块当**一串正文**
 * （`name: ''`）⇒ `key.return` 不成立 ⇒ `toShellKeys` 给出 6 个字符键、**没有回车**：
 * 那一按不提交，屏上什么也不发生。底下所有命令都受影响，不止 `/exit`。
 *
 * ⚠️ **合块与终端的写边界无关**：真 PTY 实测——**六次写、每字一次、间隔 0ms**，仍然并成一个
 * `/exit\r` 读块。合块取决于**应用读得快不快**（`readable` 一响就 `stdin.read()`，读得慢就攒着），
 * 而「**App 正忙、敲完立刻回车**」正是它——那正是交互最快的用法。
 *
 * ## 为什么只能认这么窄
 *
 * 「敲的正文＋回车」与「粘贴进来的一段带换行的文字」**在同一个读块里长得一样**——三处都问了，
 * 无处可用：
 *
 * - **`useInput` 那一头只有一串字符**：实测 `/exit\r` ⇒ `input` 是整串、`key` 十几个布尔全假。
 *   没有来源、没有边界；时序（读块是什么时候攒的）也不外传。
 * - **粘贴那条信道**（`usePaste`）**只在终端认 bracketed paste 时才走**：那时
 *   `\x1b[200~ … \x1b[201~` 由 Ink 的解析器切成 `paste` 事件、与读块无关（marker 跨块也认）。
 *   终端不认它时（`?2004h` 被忽略），粘贴就是一块**裸正文**落进这里，与敲的键同形。
 * - **Bun 的 PTY 那头给不出**：`Bun.Terminal` 只有 `write` / `resize` / `setRawMode` / `data`，
 *   没有粘贴或输入事件这一说；`process.stdin` 同样没有。字节流里唯一的粘贴边界就是那对 marker，
 *   而它已经被 Ink 消费掉了。
 *
 * 于是只剩**字符形状**可判，而形状里有且只有一条能自证——三条全中才认：
 *
 * 1. **块以 `\r` 结尾**（敲出来的回车就是 `\r`）；
 * 2. **块里 `\r` 只这一个**——挡住「一段 CR 结尾的多行」（`a\rb\r` 是两个）；
 * 3. **块里没有 `\n`**——**多行粘贴必然带 `\n`**（LF 与 CRLF 都带），而带换行的块本来就该
 *    原样进草稿（`\n` 在正文里是**真换行**，见 `case 'char'` 那一支）。
 *
 * 三条之外的任何块**一律原样是正文**：宁可不修，也不把粘贴切碎——**切碎比这个缺陷更坏**。
 *
 * ⚠️ **代价（如实记）**：敲多行草稿（`shift+回车` 的 `\n`）之后**立刻**回车的话，那一块同样
 * 带 `\n` ⇒ 那一下仍然不提交（**与今天一样，不是新坏**）。要更宽只剩「问终端 bracketed paste
 * 开没开」（`CSI ? 2004 $ p`）那一条路——多数终端根本不答，还多一次开机时序的赌，故不做。
 */
export function trailingEnterOf(input: string): string | null {
  if (input.length < 2 || !input.endsWith('\r')) return null
  if (input.includes('\n')) return null
  if (input.slice(0, -1).includes('\r')) return null

  return input.slice(0, -1)
}
