/**
 * U110 · **查看那一屏**（设计 · 终端交互「查看：另开一屏」）——**纯的那一半**。
 *
 * 真 PTY 那一头（备用屏、`?1049` 那一对、主缓冲没被污染）归 `frames-u110-tui.ts`；
 * 这一层钉的是**不碰终端就说得清的那几条**：键怎么认、一个键走一步、一帧长什么样。
 * 它们全是纯函数（`src/screen.ts` 与 `src/transcript.ts`），故不起 Ink、不写字节。
 *
 * ## 为什么这几条值得单钉（都是帧套件**咬不动**的地方）
 *
 * - **键表**：少认一个键，屏上就是「按了没反应」——而帧套件只按它自己在用例里写的那几个键；
 * - **一个键走一步**：滚动 / 跳转的数字（半页、整页、上下一条交代）在这儿一眼看得出对不对；
 * - **一帧的形**：状态行**在最后那一行**、命中**反显**、折行那句**不在这一屏上**——
 *   这三条各是一条判据，不该埋在几十秒起步的真 PTY 套件里。
 */

import { describe, expect, test } from 'bun:test'
import { parseScreenKeys, screenFrame } from '../src/screen.ts'
import { matchesOf, screenKey, screenLayout, screenOpened, textOfLines } from '../src/transcript.ts'
import type { MaterialSpot, ScreenKey, ScreenLayout, ScreenState } from '../src/transcript.ts'
import type { LogLine, Segment } from '../src/components/log.ts'
import type { LogRow, UserImage } from '../src/view.ts'

// ══ 装置（都是**手搓的行与帧**：这一层判的是算法，不是渲染链路）════════

const line = (text: string, key = text): LogLine => ({ key, segments: [{ text }] })

/** 一屏的排版——键那一层只认这三个数（`lines` / `turns` / `height` / `maxTop`）。 */
const layout = (
  count: number,
  options: { readonly height?: number; readonly turns?: readonly number[]; readonly materials?: readonly MaterialSpot[] } = {},
): ScreenLayout => {
  const height = options.height ?? 10

  return {
    lines: Array.from({ length: count }, (_, at) => line(`第 ${at + 1} 行`, `l${at}`)),
    turns: options.turns ?? [],
    materials: options.materials ?? [],
    height,
    maxTop: Math.max(0, count - height),
  }
}

const state = (patch: Partial<ScreenState> = {}): ScreenState => ({ ...screenOpened(), ...patch })

/** 走一步（把 `ScreenStep` 拆成「新的样子」或一个词）——判据读它。 */
function step(from: ScreenState, key: ScreenKey, at: ScreenLayout): ScreenState | 'close' | 'edit' | 'none' | 'attach' | 'export' {
  const got = screenKey(from, key, at)
  if (got.kind === 'state') return got.state

  return got.kind
}

/** 顶行（滚到哪儿的判据看它）。 */
const topOf = (one: ScreenState): string => textOfLines([one.top >= 0 ? line(String(one.top)) : line('')])

/** 造一条记录行（只造这一段用得着的那三形）。 */
const userRow = (at: number, text: string): LogRow => ({ kind: 'user', key: `u${at}`, text, echoed: false })

/** 带图的那一条交代（U110 那两条动作的主语就是它）。 */
const imageOf = (n: number): UserImage => ({
  marker: `Image#${n}`,
  name: `第${n}张.png`,
  mime: 'image/png',
  blob: `blob-${n}`,
  source: `/tmp/第${n}张.png`,
  label: `第${n}张.png`,
})

const userWithImages = (at: number, text: string, images: readonly UserImage[]): LogRow => ({
  kind: 'user',
  key: `u${at}`,
  text,
  echoed: false,
  images,
})
const assistantRow = (at: number, text: string): LogRow => ({ kind: 'assistant', key: `a${at}`, text })
// 思考行 U112 起带它自己那一段的计时三格——这一层（查看那一屏）不看它们，
// 给一个「已经收梢、没有起点」的形就够（与 `applyResume` 重放出来那一段同形）
const thinkingRow = (at: number, text: string): LogRow => ({
  kind: 'thinking',
  key: `t${at}`,
  text,
  startedAt: null,
  lastAt: null,
  flowing: false,
})

// ══ ① 键表：设计那一节列的键，一个不少 ═══════════════════════════════

describe('U110 · 键怎么认', () => {
  /**
   * ⚠️ **这一组判的是「字节 → 键 → 走一步」那条整路**（不是只判解析器）：可见字符那几把键
   * **在状态机那一层才认**（由头见 `transcript.ts` 的 `SINGLE_KEYS` 注——读字节那一层
   * 不知道此刻在不在打搜索词）。真 PTY 上按一下走的就是这条路。
   */
  const at = layout(100, { height: 10, turns: [0, 20, 40] })

  const walked = (bytes: string, from: ScreenState = state()): unknown => {
    const keys = parseScreenKeys(bytes)
    expect(keys.length, `${JSON.stringify(bytes)} 认出来的键数`).toBe(1)

    return step(from, keys[0] as ScreenKey, at)
  }

  test('滚与跳：`j` `k` `↑` `↓` `g` `G` `ctrl+d` `ctrl+u` `空格` `b` `{` `}`', () => {
    const cases: readonly (readonly [string, ScreenState, number])[] = [
      ['j', state({ top: 0 }), 1],
      ['k', state({ top: 4 }), 3],
      ['\u001b[B', state({ top: 0 }), 1],
      ['\u001b[A', state({ top: 4 }), 3],
      ['g', state({ top: 40 }), 0],
      ['G', state({ top: 0 }), 90],
      ['\u0004', state({ top: 0 }), 5],
      ['\u0015', state({ top: 5 }), 0],
      [' ', state({ top: 0 }), 10],
      ['b', state({ top: 10 }), 0],
      ['}', state({ top: 0 }), 20],
      ['{', state({ top: 20 }), 0],
    ]

    for (const [bytes, from, top] of cases) {
      expect(walked(bytes, from), JSON.stringify(bytes)).toMatchObject({ top })
    }
  })

  test('退出与编辑器：`q` `Esc` `ctrl+o` `ctrl+c` 都退出；`v` 交给编辑器', () => {
    for (const bytes of ['q', '\u001b', '\u000f', '\u0003']) {
      expect(walked(bytes), JSON.stringify(bytes)).toBe('close')
    }
    expect(walked('v')).toBe('edit')
  })

  test('`/` 开搜索那一档', () => {
    expect(walked('/')).toMatchObject({ asking: '' })
  })

  test('⚠️ **打搜索词时这些字照样打得进去**（`b` `j` `n` `q` `v` 都在键表里，却不该抢词）', () => {
    for (const word of ['b', 'json', 'q', 'n', 'v']) {
      const typed = step(state({ asking: '' }), { kind: 'text', text: word }, at)
      expect(typed, word).toMatchObject({ asking: word })
    }
  })

  test('普通字符攒成一段（粘贴进来的整句算一段）；退格与回车各是一把键', () => {
    expect(parseScreenKeys('abc')).toEqual([{ kind: 'text', text: 'abc' }])
    expect(parseScreenKeys('a b')).toEqual([{ kind: 'text', text: 'a b' }])
    expect(parseScreenKeys('\u007f')).toEqual([{ kind: 'backspace' }])
    expect(parseScreenKeys('\r')).toEqual([{ kind: 'accept' }])
  })

  test('认不出来的转义序列当 `Esc`（丢掉它就是「按了没反应」）', () => {
    expect(parseScreenKeys('\u001b[Z')).toEqual([{ kind: 'cancel' }, { kind: 'text', text: '[Z' }])
  })
})

// ══ ② 一个键走一步 ═══════════════════════════════════════════════════

describe('U110 · 一个键走一步', () => {
  const at = layout(100, { height: 10 })
  const open = state()

  test('`j` / `k` 一行、`g` / `G` 到顶底；到边就停（不越界）', () => {
    expect(step(open, { kind: 'lineDown' }, at)).toMatchObject({ top: 1 })
    expect(step(state({ top: 3 }), { kind: 'lineUp' }, at)).toMatchObject({ top: 2 })
    expect(step(state({ top: 3 }), { kind: 'top' }, at)).toMatchObject({ top: 0 })
    expect(step(open, { kind: 'lineUp' }, at)).toMatchObject({ top: 0 })
    expect(step(open, { kind: 'bottom' }, at)).toMatchObject({ top: 90 })
    expect(step(state({ top: 90 }), { kind: 'lineDown' }, at)).toMatchObject({ top: 90 })
  })

  test('`ctrl+d` / `ctrl+u` 半页（半屏那几行）、`空格` / `b` 整页', () => {
    expect(step(open, { kind: 'halfDown' }, at)).toMatchObject({ top: 5 })
    expect(step(state({ top: 5 }), { kind: 'halfUp' }, at)).toMatchObject({ top: 0 })
    expect(step(open, { kind: 'pageDown' }, at)).toMatchObject({ top: 10 })
    expect(step(state({ top: 10 }), { kind: 'pageUp' }, at)).toMatchObject({ top: 0 })
  })

  test('`{` / `}` 跳**上一条 / 下一条用户交代**（严格越过当前屏顶）', () => {
    // 交代在 0、20、40 行——锚就是那几行本身（不是它们前面那一行留白）
    const withTurns = layout(100, { height: 10, turns: [0, 20, 40] })

    expect(step(state({ top: 0 }), { kind: 'turnDown' }, withTurns)).toMatchObject({ top: 20 })
    expect(step(state({ top: 20 }), { kind: 'turnDown' }, withTurns)).toMatchObject({ top: 40 })
    expect(step(state({ top: 20 }), { kind: 'turnUp' }, withTurns)).toMatchObject({ top: 0 })
    // 顶上加一条「已在最上」：没有更早的交代就停在原处（不跳到屏顶那一行）
    expect(step(state({ top: 0 }), { kind: 'turnUp' }, withTurns)).toMatchObject({ top: 0 })
    // 底下同理：没有更晚的就停住
    expect(step(state({ top: 40 }), { kind: 'turnDown' }, withTurns)).toMatchObject({ top: 40 })
  })

  test('`q` / `Esc` / `ctrl+o` 都是退出；`v` 交给编辑器', () => {
    expect(step(open, { kind: 'close' }, at)).toBe('close')
    expect(step(open, { kind: 'edit' }, at)).toBe('edit')
  })

  test('不在搜字时，普通字符什么都不做（这一屏不产生内容）', () => {
    expect(step(open, { kind: 'text', text: 'x' }, at)).toBe('none')
    // `n` / `N` 没搜过时按下去**什么都不发生**（返回的是原样，不是「跳到第 0 处」）
    expect(step(open, { kind: 'matchNext' }, at)).toMatchObject({ top: 0, term: '', at: 0 })
  })
})

// ══ ③ 搜索：`/` 打字 → 回车 → `n` / `N` ═══════════════════════════════

describe('U110 · 搜索那一趟', () => {
  const at = layout(100, { height: 10, turns: [] })

  test('`/` 开词档；打字进去；回车**把词留下**并把第一处滚进视野', () => {
    const asking = step(state({ top: 50 }), { kind: 'search' }, at)
    expect(asking).toMatchObject({ asking: '' })

    const typed = step(asking as ScreenState, { kind: 'text', text: '第 7' }, at)
    expect(typed).toMatchObject({ asking: '第 7' })

    // 从第 50 行往下找：「第 7」命中「第 7 行」与「第 70…79 行」——**取屏顶之下那一处**
    // （第 71 行，下标 70），并把那一处滚进视野（屏顶落到它上面）
    const done = step(typed as ScreenState, { kind: 'accept' }, at)
    expect(done).toMatchObject({ asking: null, term: '第 7', at: 1, top: 60 })
  })

  test('`Esc` 取消这一档：词没收下，**上一次搜的也不抹掉**', () => {
    const cancelled = step(state({ top: 3, asking: '第 7', term: '旧的', at: 2 }), { kind: 'cancel' }, at)
    expect(cancelled).toMatchObject({ asking: null, term: '旧的', at: 2 })
  })

  test('打字那一档里其余键一个都不认（不带出翻页 / 退出）', () => {
    for (const key of [{ kind: 'close' }, { kind: 'edit' }, { kind: 'pageDown' }, { kind: 'bottom' }] as const) {
      const got = screenKey(state({ asking: '甲' }), key, at)
      expect(got.kind, key.kind).toBe('none')
    }
    // 上下仍然放行（打字时也要能挪一挪，看底下那处）
    expect(step(state({ asking: '甲', top: 4 }), { kind: 'lineDown' }, at)).toMatchObject({ top: 5 })
  })

  test('`n` / `N` 绕圈走，并把那一处滚进视野', () => {
    const hits = matchesOf(at.lines, '第 1')  // 命中「第 1 行 / 第 10…19 行 / 第 100 行」——共 12 处
    expect(hits.length).toBe(12)

    const first = state({ term: '第 1', at: 0, top: 0 })
    const next = step(first, { kind: 'matchNext' }, at)
    expect(next).toMatchObject({ at: 1 })

    // 从最后一处再往下 ⇒ 绕回第一处；且**那一处滚进视野**（不在屏上就滚过去）
    const wrapped = step(state({ term: '第 1', at: 11, top: 80 }), { kind: 'matchNext' }, at)
    expect(wrapped).toMatchObject({ at: 0, top: 0 })

    expect(step(state({ term: '第 1', at: 0 }), { kind: 'matchPrev' }, at)).toMatchObject({ at: 11 })
  })

  test('搜不到就如实说「0 处」（不假装跳到第 1 处）', () => {
    const done = step(state({ asking: '没有这个词' }), { kind: 'accept' }, at)
    expect(done).toMatchObject({ term: '没有这个词', at: 0 })
  })
})

// ══ ④ 排版：**不折**＋交代锚点落在交代自己那一行 ═══════════════════════

describe('U110 · 排版', () => {
  test('视图里**不折**：思考那一段展开态整段都在（内联那一半折成一行）', () => {
    const rows: readonly LogRow[] = [
      userRow(1, '看看'),
      thinkingRow(1, '第一句想头\n第二句想头\n第三句想头'),
      assistantRow(1, '好。'),
    ]

    const expanded = screenLayout(rows, { columns: 60, screenRows: 20 })
    const said = textOfLines(expanded.lines)
    expect(said).toContain('第一句想头')
    expect(said).toContain('第三句想头')
    expect(said).not.toContain('（思考）…')
  })

  test('交代的锚落在**它自己那一行**上（不是它前面那一行留白）', () => {
    const rows: readonly LogRow[] = [
      userRow(1, '第一条'),
      assistantRow(1, '甲'),
      userRow(2, '第二条'),
      assistantRow(2, '乙'),
    ]

    const laid = screenLayout(rows, { columns: 60, screenRows: 20 })
    expect(laid.turns.length).toBe(2)

    for (const anchor of laid.turns) {
      expect(laid.lines[anchor]?.segments.map((piece) => piece.text).join('')).toContain('› ')
    }
  })

  test('一屏几行、最多滚到哪儿', () => {
    const laid = screenLayout([assistantRow(1, '一句')], { columns: 60, screenRows: 12 })
    expect(laid.height).toBe(11)   // 屏高减掉底下那条状态行
    expect(laid.maxTop).toBe(0)    // 内容还不够一屏——滚不动
  })
})

// ══ ⑤ 一帧的形：状态行在最后一行、命中反显、没有「折」那一句 ═══════════

describe('U110 · 一帧长什么样', () => {
  const at = layout(100, { height: 6, turns: [] })
  const frame = (one: ScreenState, columns = 40): string =>
    screenFrame({ layout: at, state: one, columns, hits: matchesOf(at.lines, one.term) })

  test('整帧等于「屏高」行：内容区 ＋ 底下**一条**状态行', () => {
    const rows = frame(state()).split('\r\n')
    // 内容 6 行 ＋ 状态 1 行；行内各带一个擦到行尾的 `CSI K`（不是换行，故这里按 `\r\n` 切）
    expect(rows.length).toBe(7)
    expect(rows[6]).toContain('行')
  })

  test('状态行报得出「读到哪儿 / 共多少行」与键位提示', () => {
    const status = frame(state({ top: 20 }), 100).split('\r\n')[6] as string
    expect(status).toContain('21–26 / 100 行')
    expect(status).toContain('ctrl+u/d 半页')
    expect(status).toContain('q 退出')
  })

  test('搜过的词报「第几处 / 共几处」；打字那一档报「搜索：…」', () => {
    expect(frame(state({ term: '第 2', at: 2 }), 100)).toContain('/第 2 第 3/11 处')
    expect(frame(state({ asking: '甲' }), 100)).toContain('搜索：甲')
  })

  test('命中那一行**反显**（`CSI 7 m`）——其余行不反显', () => {
    const body = frame(state({ term: '第 3', top: 0 })).split('\r\n')
    const marked = body.filter((row) => row.includes('\u001b[7m'))

    expect(marked.length).toBe(1)
    expect(marked[0]).toContain('第 3 行')
  })

  test('⚠️ **没选中材料时，底下那行一个字都不提那两条动作**（反向判据）', () => {
    const status = frame(state(), 100).split('\r\n')[6] as string
    expect(status).not.toContain('加入本次输入')
    expect(status).not.toContain('导出原图')
  })

  test('选中一处材料：底下那行报出**是哪一条**与两条动作', () => {
    const withMaterials: ScreenLayout = {
      ...at,
      materials: [{ line: 2, image: imageOf(1) }],
    }
    const status = screenFrame({ layout: withMaterials, state: state({ picked: 2 }), columns: 100, hits: [] })
      .split('\r\n')[6] as string

    expect(status).toContain('Image#1 · 第1张.png')
    expect(status).toContain('Enter 加入本次输入')
    expect(status).toContain('e 导出原图')
  })

  test('选中的那一行**反显**', () => {
    const withMaterials: ScreenLayout = { ...at, materials: [{ line: 2, image: imageOf(1) }] }
    const body = screenFrame({ layout: withMaterials, state: state({ picked: 2 }), columns: 100, hits: [] }).split('\r\n')

    expect(body[2]).toContain('\u001b[7m')
    expect(body.filter((row) => row.includes('\u001b[7m')).length).toBe(1)
  })

  test('⚠️ **这一屏上没有「折」那一句**（那一句只属于内联那一半）', () => {
    expect(frame(state())).not.toContain('ctrl+o 看全文')
    expect(frame(state())).not.toContain('还有')
  })

  test('窄窗从右往左省（位置那一句先保住）', () => {
    const narrow = frame(state({ top: 20 }), 30).split('\r\n')[6] as string
    expect(narrow).toContain('21–26 / 100 行')
    expect(narrow).not.toContain('q 退出')
  })
})

// ══ ⑥ 材料：选中与两条动作（U110 · 追加）═════════════════════════════

describe('U110 · 材料那一行', () => {
  /** 两条交代，头一条带两张图、第二条不带——材料行落位与「哪一条是主语」都看它。 */
  const rows: readonly LogRow[] = [
    userWithImages(1, '看下这两张', [imageOf(1), imageOf(2)]),
    assistantRow(1, '看了。'),
    userRow(2, '再改一版'),
    assistantRow(2, '改好了。'),
  ]
  const at = screenLayout(rows, { columns: 60, screenRows: 12 })

  test('材料行紧跟在**它那条交代**后面，一张一行', () => {
    expect(at.materials.length).toBe(2)
    expect(textOfLines(at.lines).split('\n')[at.materials[0]?.line ?? -1]).toContain('▣ Image#1 · 第1张.png')
    expect(textOfLines(at.lines).split('\n')[at.materials[1]?.line ?? -1]).toContain('▣ Image#2 · 第2张.png')
    // 材料行在**头一条交代**与后来那几句之间（不是在末尾另起一堆）
    const later = at.turns[1] as number
    expect(at.materials.every((one) => one.line < later)).toBe(true)
  })

  test('`[` / `]` 选中一条、并在屏上滚进视野', () => {
    const picked = step(state({ top: 0 }), { kind: 'materialNext' }, at)
    expect(picked).toMatchObject({ picked: at.materials[0]?.line })
    const second = step(picked as ScreenState, { kind: 'materialNext' }, at)
    expect(second).toMatchObject({ picked: at.materials[1]?.line })
    // 到头就停（不绕圈）
    const stays = step(second as ScreenState, { kind: 'materialNext' }, at)
    expect(stays).toMatchObject({ picked: at.materials[1]?.line })
    // 往回
    expect(step(second as ScreenState, { kind: 'materialPrev' }, at)).toMatchObject({ picked: at.materials[0]?.line })
  })

  test('⚠️ **没选中时那两条动作不出现**（回车与 `e` 都不认）', () => {
    expect(step(state(), { kind: 'accept' }, at)).toBe('none')
    expect(step(state(), { kind: 'materialExport' }, at)).toBe('none')
  })

  test('选中之后：回车＝加入本次输入、`e` ＝导出原图，且**作用于那一条**', () => {
    const second = step(step(state(), { kind: 'materialNext' }, at) as ScreenState, { kind: 'materialNext' }, at) as ScreenState
    const attach = screenKey(second, { kind: 'accept' }, at)
    expect(attach.kind).toBe('attach')
    expect(attach.kind === 'attach' ? attach.material.blob : '').toBe('blob-2')

    const exported = screenKey(second, { kind: 'materialExport' }, at)
    expect(exported.kind).toBe('export')
    expect(exported.kind === 'export' ? exported.material.marker : '').toBe('Image#2')
  })

  test('一条材料都没有时，`[` / `]` 什么都不做（不编一个空选中出来）', () => {
    const bare = screenLayout([userRow(1, '没图'), assistantRow(1, '好。')], { columns: 60, screenRows: 12 })
    expect(bare.materials).toEqual([])
    expect(step(state(), { kind: 'materialNext' }, bare)).toBe('none')
    expect(step(state(), { kind: 'materialPrev' }, bare)).toBe('none')
  })

  test('`[` / `]` / `e` 三个键真按键走得到（字节 → 键 → 一步）', () => {
    const open = state({ top: 0 })
    const viaBracket = step(open, parseScreenKeys(']')[0] as ScreenKey, at)
    expect(viaBracket).toMatchObject({ picked: at.materials[0]?.line })
    expect(step(state({ picked: at.materials[0]?.line }), parseScreenKeys('[')[0] as ScreenKey, at)).toMatchObject({
      picked: at.materials[0]?.line,
    })
    expect(step(state({ picked: at.materials[0]?.line }), parseScreenKeys('e')[0] as ScreenKey, at)).toBe('export')
  })
})

// ══ ⑦ 顶行的读法（判据用得上的一格，单独钉一下它的意思）═════════════

describe('U110 · 位置那一格', () => {
  test('`top` 是显示坐标系里的行号（0 起）', () => {
    expect(topOf(state({ top: 0 }))).toBe('0')
    expect(topOf(state({ top: 7 }))).toBe('7')
  })
})

// ══ ⑦ 交给编辑器的那一份：整条记录，不是一屏 ═══════════════════════════

describe('U110 · `v` 交出去的那一份', () => {
  test('是**整条记录**的纯文本（含滚在屏外那些行）', () => {
    const at = layout(100, { height: 10 })
    const text = textOfLines(at.lines)

    expect(text.split('\n').length).toBe(100)
    expect(text).toContain('第 1 行')
    expect(text).toContain('第 100 行')
  })
})

// 让 `Segment` 这个类型留一个用处（手搓的行用它）——纯为类型检查看得见
const SAMPLE: Segment = { text: 'x' }
void SAMPLE
