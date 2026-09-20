/**
 * 规格即测试 · **真光标跟随输入**（U31）。
 *
 * 出处：工单 `U31`（实施判据）——「真光标跟随编辑位置；空输入/占位、插入删除、左右移动、
 * 多行与窄窗折行、抽屉接管与关闭均正确」。空输入那一条在 `spec.dock.test.ts`
 * 「输入行 · 光标落在哪」；本文件管**编辑位置**那一半。
 *
 * ## 这一层为什么非上真终端不可
 *
 * 「光标落在哪」不是视图字段能回答的话：`ShellView` 里只有**插入点**（一个下标），
 * 而屏上是**终端自己画的光标**——它与插入点之间隔着折行、折叠、左留白三道账。
 * 故判据一律读 `Frame.screen.cursor`（`record()` 录真字节 → VT 模型读回，
 * **不用 pty**），不读视图、也不读某一格的反显（U31 起输入行不再画那格）。
 *
 * ## 折行那条钉得最死
 *
 * Ink 的文字折行是**词界**折行（`wrap-ansi`，`trim:false` / `hard:true`），
 * 与仓里按宽度硬切的 `wrap()` **不是一回事**——预查里的反例：40 列 ·
 * `z`×30 ＋ ` abcdefghij`，硬切会把 `abcdefghij` 拦腰截断，而屏上是**整词落到下一行**
 * （真 PTY 实测）。⇒ 「按宽度取模算列号」必错，下面那条用例就是拿这个反例钉的。
 */

import { describe, expect, test } from 'bun:test'
import { createView } from '../src/view.ts'
import { dockHeightOf } from '../src/components/app.ts'
import { composerLayout, stepLeft, stepRight } from '../src/components/composer.ts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'
import { event } from './events.ts'

/** 屏上最窄的那一档还得看得见——40 列（内容宽 38）。 */
const NARROW = { columns: 40, rows: 24 } as const

/** 草稿里的插入点——视图字段，语义判据读它。 */
const at = (stage: ReturnType<typeof createStage>): number => stage.shell.getView().caret
const draftOf = (stage: ReturnType<typeof createStage>): string => stage.shell.getView().draft

/** 落单的代理项（半个 emoji）——「不得切坏字符」的判据就是它。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

/**
 * 缓冲行号 → **视口行号**（U31 记）。
 *
 * ⚠️ **两把尺子别混**：`frame.rowOf()` 给的是**缓冲**行号（含滚进 scrollback 的行，顶→底），
 * 而 `frame.screen.cursor.y` 是**视口**行号（终端光标就在视口里）。屏装不下时两者差着
 * 滚出去的那几行——矮窗（`rows: 10`）上正好踩到，高窗上恰好相等（故别的用例看不出来）。
 */
function viewportOf(frame: Frame, bufferRow: number): number {
  return bufferRow - (frame.screen.lines.length - frame.screen.rows)
}

describe('插入点 · 左右移动与中间插删', () => {
  test('左右移动——**草稿一个字不动**，插入点按字素走', () => {
    const stage = createStage()
    stage.type('甲乙丙')

    expect(at(stage)).toBe(3) // 打完在末尾
    stage.press({ kind: 'left' })
    stage.press({ kind: 'left' })
    expect(at(stage)).toBe(1) // 甲|乙丙
    expect(draftOf(stage)).toBe('甲乙丙') // **草稿没动**

    stage.press({ kind: 'right' })
    expect(at(stage)).toBe(2) // 甲乙|丙
    // 到头就停：再往右两次也不会越过末尾
    stage.press({ kind: 'right' })
    stage.press({ kind: 'right' })
    expect(at(stage)).toBe(3)
  })

  test('中间插入——字进在**插入点**处，不是拍在末尾', () => {
    const stage = createStage()
    stage.type('甲乙丙')
    stage.press({ kind: 'left' }) // 甲乙|丙
    stage.type('丁')

    expect(draftOf(stage)).toBe('甲乙丁丙')
    expect(at(stage)).toBe(3) // 插入点在刚打的那个字之后
  })

  test('退格删**左边**那个字 · `delete` 删**右边**那个字', () => {
    const stage = createStage()
    stage.type('甲乙丙')
    stage.press({ kind: 'left' }) // 甲乙|丙

    stage.press({ kind: 'backspace' }) // 删「乙」
    expect(draftOf(stage)).toBe('甲丙')
    expect(at(stage)).toBe(1)

    stage.press({ kind: 'delete' }) // 删「丙」（插入点右边）
    expect(draftOf(stage)).toBe('甲')
    expect(at(stage)).toBe(1)
  })

  test('换行也落在插入点处——`shift+回车` 不在末尾硬加一行', () => {
    const stage = createStage()
    stage.type('甲乙')
    stage.press({ kind: 'left' })
    stage.press({ kind: 'newline' })

    expect(draftOf(stage)).toBe('甲\n乙')
    expect(at(stage)).toBe(2) // 插入点落在新行的行首
  })
})

describe('插入点 · 字素（中文 / emoji / 组合字符不切坏）', () => {
  test('emoji 退一次退**一整个**（不是半个代理项）', () => {
    const stage = createStage()
    stage.type('👍🏽好') // 「肤色 modifier」也算同一个字素

    stage.press({ kind: 'backspace' }) // 退「好」
    expect(draftOf(stage)).toBe('👍🏽')
    stage.press({ kind: 'backspace' }) // 退整个 emoji
    expect(draftOf(stage)).toBe('')
    expect(LONE_SURROGATE.test(draftOf(stage))).toBe(false)
  })

  test('组合字符（`e` ＋ 重音）算一个字', () => {
    const stage = createStage()
    stage.type('éx')

    stage.press({ kind: 'backspace' }) // 退「x」
    expect(draftOf(stage)).toBe('é')
    stage.press({ kind: 'backspace' }) // 再退一次：连字带重音一起去（不留孤立的组合符）
    expect(draftOf(stage)).toBe('')
  })

  test('左右移动也按字素——`stepLeft` / `stepRight` 是尺子', () => {
    expect(stepLeft('👍🏽好', 5)).toBe(4) // 退一整个 emoji
    expect(stepLeft('👍🏽好', 4)).toBe(0)
    expect(stepRight('👍🏽好', 0)).toBe(4)
    expect(stepRight('👍🏽好', 4)).toBe(5)
    expect(stepLeft('éx', 3)).toBe(2)
    expect(stepLeft('éx', 2)).toBe(0)
  })
})

describe('真光标 · 折行与折叠', () => {
  test('窄窗**词界折行**——光标在折行之后那一行（按宽度取模会算错）', async () => {
    const stage = createStage()
    // 预查里那个反例：硬切会把 `abcdefghij` 截成两半，而屏上是**整词**落到第二行
    stage.type('z'.repeat(30) + ' abcdefghij')

    const frame = await stage.screen(NARROW)
    const row = frame.rowOf('abcdefghij') // 整词在屏上**自占一行**（硬切的话它会与 z 同一行）

    // 插入点在末尾 ⇒ 真光标落在第二视觉行、`abcdefghij` 之后（左留白 1 ＋ 10 列）
    expect(frame.screen.cursor).toEqual({ x: 11, y: row })
  })

  test('草稿长过一屏宽——真光标落在**第二个视觉行**的末尾', async () => {
    const stage = createStage()
    stage.type('x'.repeat(100)) // 80 列 ⇒ 内容宽 78 ⇒ 78 ＋ 24

    const frame = await stage.screen({ columns: 80, rows: 24 })

    // 尾部那 24 个 x 落在第二行 —— 1（左留白）＋ 24 ＝ 25
    expect(frame.screen.cursor).toEqual({ x: 25, y: frame.rowOf('○ 空闲') - 1 })
  })

  test('移动之后真光标跟着走（不是停在原地）', async () => {
    const stage = createStage()
    stage.type('甲乙')
    const wide = await stage.screen({ columns: 80, rows: 24 })

    expect(wide.screen.cursor.x).toBe(1 + 2 + 4) // 左留白 1 ＋ `› ` 2 ＋ 两个字各 2 列

    stage.press({ kind: 'left' })
    const moved = await stage.screen({ columns: 80, rows: 24 })
    expect(moved.screen.cursor.x).toBe(1 + 2 + 2) // 退到「甲」之后
    expect(moved.screen.cursor.y).toBe(wide.screen.cursor.y) // 还在同一行
  })

  /**
   * ⚠️ **二轮返工改过这条断言里的数**（U31 二轮验收退回）——
   *
   * - **原锚**：`… 上面还有 1 行`（6 个视觉行 − 5 行正文；那两行提示**不**占预算）。
   * - **为何变**：预算改成**整片输入区**的上限（正文 ＋ 提示一起算）——提示行占它自己那一格
   *   之后，「5 行」里只放得下 4 行正文 ⇒ 收起来的是 2 行。旧数正是「账与屏分家」那笔账的
   *   残影：屏上交互区 6 行而账上写 5 行，矮窗上动态帧顶到终端高度，真光标就高一行。
   * - **新锚**：`… 上面还有 2 行`；插入点仍必须看得见（**这一条没变**，它是这条规格的主句）。
   */
  test('多行草稿超半屏——折叠**如实报行数**，插入点那一行仍看得见', async () => {
    const stage = createStage()
    // 40 列 ⇒ 内容宽 38 ⇒ 折 6 个视觉行（38×5 ＋ 12）——**不是**按 `\n` 数的 1 行
    stage.type('a'.repeat(200))

    const frame = await stage.screen({ columns: 40, rows: 10 }) // 半屏 ＝ 5 行（含提示行）

    expect(frame.has('… 上面还有 2 行')).toBe(true) // 6 − 4：**视觉行**的账；那 4 行 ＋ 这条提示 ＝ 5
    // 插入点在末尾 ⇒ 它那一行（最后一条视觉行，12 宽）必须在屏上，落点在该行末尾
    expect(frame.screen.cursor).toEqual({ x: 1 + 12, y: viewportOf(frame, frame.rowOf('○ 空闲')) - 1 })
  })

  test('交互区高度按**视觉行**算（原锚：按 `\\n` 数逻辑行）', () => {
    const draft = 'x'.repeat(100)
    const view = { ...createView(), draft, caret: draft.length }

    // 80 列 ⇒ 折成 2 个视觉行；2000 列 ⇒ 1 行（**同一份草稿，高度随窗宽变**）
    expect(dockHeightOf(view, 80, 24)).toBe(2)
    expect(dockHeightOf(view, 2000, 24)).toBe(1)
  })
})

describe('真光标 · 抽屉接管与关闭', () => {
  const catalog = [
    event('session.state', {
      active: 's1',
      sessions: [
        { id: 's1', at: 0, title: '记录查询优化' },
        { id: 's2', at: 0, title: '修复时区处理' },
      ],
    }),
  ]

  test('抽屉开着——输入行不在屏上，真光标**不留在输入处**', async () => {
    const stage = createStage()
    stage.feed(catalog)
    stage.type('/session')
    stage.press({ kind: 'enter' })
    stage.feed(catalog)

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('修复时区处理')).toBe(true) // 抽屉开着（有行可点）
    expect(frame.has('›')).toBe(false) // 输入行让位了
    // 真光标被送回帧下（不是停在某一格上冒充输入落点）
    expect(frame.screen.cursor.y).toBeGreaterThan(frame.rowOf('○ 空闲'))
  })

  test('抽屉 `esc` 收起——输入行回来，真光标**回到插入点**', async () => {
    const stage = createStage()
    stage.feed(catalog)
    stage.type('/session')
    stage.press({ kind: 'enter' })
    stage.feed(catalog)
    stage.press({ kind: 'escape' })

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const row = frame.rowOf('交代一件事，回车发送')

    // 空草稿 ⇒ 落点与开抽屉之前**逐格相同**（左留白 1 ＋ `› ` 2）
    expect(frame.screen.cursor).toEqual({ x: 3, y: row })
  })

  test('裁决接管中——真光标不在输入行上（那一下打不进草稿）', async () => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event('tool.decision.request', { call: 71, name: '跑测试', material: '命令 bun test', weight: 'light' }, { id: 88 }),
    ])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('等你的答复')).toBe(true)
    expect(frame.screen.cursor.y).not.toBe(frame.rowOf('等你的答复'))
  })

  /**
   * ⚠️ **返工轮改过这条断言的锚**（首轮验收退回 ②）——
   *
   * - **原锚**：`stage.type('半句话')`（插入点本来就在末尾）＋「草稿归还，真光标回到它的
   *   **末尾**」——那会儿 `undock` 一律把插入点摆到 `draft.length`，这条断言量的其实是
   *   **那条实现**，不是规格。
   * - **为何变**：交接面（裁决）的接管**不经过用户**，草稿连同它的插入点都得原样还回来——
   *   一律摆到末尾＝**把用户打到一半的位置改掉**（`abcd` ←← 接管批准 打 `X` ⇒ `abcdX`，
   *   应为 `abXcd`）。用户真跑报的就是这一条。
   * - **新锚**：中间编辑过（`←←`）再被接管，答完**回到原来那个插入点**：草稿不变、
   *   插入点也不变，接着打的字进在原来的位置，真光标跟着落在那一列。
   */
  test('答完裁决（接管解除）——草稿连同**原插入点**一起归还', async () => {
    const stage = createStage()
    stage.type('abcd') // 接管**之前**打的草稿（接管期间打不进去）
    stage.press({ kind: 'left' })
    stage.press({ kind: 'left' }) // ab|cd
    stage.feed([
      event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
      event('tool.decision.request', { call: 71, name: '跑测试', material: '命令 bun test', weight: 'light' }, { id: 88 }),
    ])
    stage.press({ kind: 'char', char: 'y' }) // 答「批准」
    stage.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 300 }, { id: 88 })])

    expect(draftOf(stage)).toBe('abcd') // 草稿原样归还
    expect(at(stage)).toBe(2) // **插入点也原样**（原锚：一律摆到末尾）

    stage.type('X') // 接着打——字进在原来的位置
    expect(draftOf(stage)).toBe('abXcd')

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const row = frame.rowOf('abXcd')

    // 1（左留白）＋ 2（`› `）＋ `abX` 3 列 ＝ 6（打在 `b` 与 `c` 之间那个位置）
    expect(frame.screen.cursor).toEqual({ x: 6, y: row })
  })
})

describe('插入点 · 复位（清空 / 提交 / 历史 / 补全）', () => {
  test('`esc` 清空草稿——插入点跟着归零', () => {
    const stage = createStage()
    stage.type('半句话')
    stage.press({ kind: 'escape' })

    expect(draftOf(stage)).toBe('')
    expect(at(stage)).toBe(0)
  })

  test('回车提交——草稿清空，插入点归零', () => {
    const stage = createStage()
    stage.type('交代一句')
    stage.press({ kind: 'enter' })

    expect(draftOf(stage)).toBe('')
    expect(at(stage)).toBe(0)
  })

  test('`↑` 历史——插入点落在召回那句的**末尾**', () => {
    const stage = createStage()
    stage.type('第一句')
    stage.press({ kind: 'enter' })
    stage.feed([event('turn.end', { reason: 'settled' })])

    stage.press({ kind: 'up' })
    expect(draftOf(stage)).toBe('第一句')
    expect(at(stage)).toBe(3)
  })

  test('`Tab` 补全——插入点落在补出来的那条之后', () => {
    const stage = createStage()
    stage.type('/gr')
    stage.press({ kind: 'tab' })

    expect(draftOf(stage)).toBe('/grants ')
    expect(at(stage)).toBe('/grants '.length)
  })
})

/**
 * **返工轮**（2026-09-20 · 首轮验收退回）——两条各钉一组。
 *
 * ① **宽度口径**：折行交给 Ink 那一支（`wrap-ansi`），而它量宽用的是 `string-width`，
 *    顺带把正文**规范化**成 NFC（`e` ＋ 组合重音在屏上是 `é`）。落点若还按仓里那个
 *    逐码点的 `displayWidth` 量，「量出来的插入点」与「画出来的行」就不是同一把尺 ⇒
 *    `caretRow` 找不到 ⇒ 真光标掉到状态行底下（用户报的就是这一条）。
 * ② **接管归还插入点**：`takeOver` 只收了草稿文字、`undock` 一律把插入点摆到末尾——
 *    中间编辑过再被接管，回来就落到末尾（`abcd` ←← 接管批准 打 `X` ⇒ `abcdX`，应为 `abXcd`）。
 *
 * ⚠️ 两条都在**真帧**上量（`Frame.screen.cursor`）：屏上那格是真终端画的，
 * 量视图字段只证明得了「我们以为它在哪」。
 */
describe('返工 · 宽度口径（分解字符 / ZWJ emoji / 折行边界）', () => {
  /** 分解形式的 `é`：`e` ＋ 组合重音（U+0301）——**转义写**，源文件里不放不可见字符。 */
  const COMBINING = 'e\u0301'
  /** 屏上那一份（折行正文已规范化）。 */
  const E = COMBINING.normalize()
  /** ZWJ 家庭 emoji——**一个字素**（`string-width` 量 2 列；按码点量会量成 7）。 */
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'

  test('分解形式的 `é`（粘贴）——真光标落在它**之后**，不掉到状态行下', async () => {
    const stage = createStage()
    stage.press({ kind: 'paste', text: COMBINING })

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const row = frame.rowOf(`› ${E}`)

    // 左留白 1 ＋ `› ` 2 ＋ `é` 1 列 ＝ 4（掉出输入区时这里是 (0, 帧下)）
    expect(frame.screen.cursor).toEqual({ x: 4, y: row })
  })

  test('ZWJ 家庭 emoji——按**一个字素**量，落点在它之后', async () => {
    const stage = createStage()
    stage.press({ kind: 'paste', text: FAMILY })

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const row = frame.rowOf(`› ${FAMILY}`)

    // 左留白 1 ＋ `› ` 2 ＋ 家庭 emoji 2 列（ZWJ 串是一个字素，不是四个字符）
    //
    // ⚠️ 这台 VT 模型（`@xterm/headless`）用的是 Unicode 6 的宽度表：**每个 emoji 码点各占一格**
    // （ZWJ 占 0）⇒ 它把这一行排成 7 格，上面那个 5 **不等于**「它以为的行尾」。落点不按它算：
    // 真终端按字素渲染（ZWJ 串是一个 2 列的 emoji），Ink 与 `string-width` 也是这个口径——
    // 而折行正是后两者折的，**同一把尺**才谈得上「跟着插入点走」。
    expect(frame.screen.cursor).toEqual({ x: 5, y: row })
  })

  test('窄窗折行边界——插入点在**第二视觉行**上，列号按同一把尺', async () => {
    const stage = createStage()
    // 40 列 ⇒ 内容宽 38：`› ` ＋ 36 个 a 正好铺满一行，`é` 整词落到第二行（词界折行）
    stage.press({ kind: 'paste', text: `${'a'.repeat(36)} ${COMBINING}` })

    const frame = await stage.screen({ columns: 40, rows: 24 })
    const row = frame.rowOf(E)

    // 折出来的第二行：左留白 1 ＋ 行首那个**词界空格** 1 ＋ `é`（整词落到下一行）
    expect(frame.textAt(row)).toBe(`  ${E}`)
    // 第二行没有 `› `，整行从内容原点起：左留白 1 ＋ 行首那个空格 1 ＋ `é` 1 ＝ 3
    expect(frame.screen.cursor).toEqual({ x: 3, y: row })
  })
})

/**
 * **二轮返工**（2026-09-20 · 二轮验收退回）——折叠提示与正文**共用**那一份高度预算。
 *
 * **根因**：`maxLines`（半屏）早先只管正文，`… 上面 / 下面还有 N 行` 那两行是**另加**上去的
 * ⇒ **账**（`app.ts` 的 `dock`，按 `maxDraftLines` 封顶）写着 5 行、**屏**上却是 7 行。
 * 40×10 的矮窗上动态帧因此正好顶到终端高度（10 行），而 Ink 在这时**省掉末尾那个换行**
 * （`outputHeight >= viewportRows` 那一支，见 `ink.js` 的 `renderInteractiveFrame`），
 * 它的光标后缀却仍按「正文之下还有一行」回退 ⇒ **真光标高一行**：插入点 200 实测
 * `(13, 6)`、应为 `(13, 7)`；160 / 280 那两档交互区只有 6 行、够不着终端高度，
 * 看着是好的——**同一根因，只是矮了一行没触发**（故修的是「账与屏分家」，不是那两档）。
 *
 * **修法**：让提示行占它自己那一格——那一扇窗口的**正文 ＋ 它实际要画的提示行 ≤ 预算**；
 * 窗口贴住某一头时那一头没有提示，省下的格子还给正文。**不**在别处加一行补偿、
 * 也**不**给窄终端开特例分支。
 */
describe('返工二 · 折叠提示与正文共用高度预算', () => {
  /** 40 列 ⇒ 内容宽 38 ⇒ 300 个 a 折成 8 个视觉行（38×7 ＋ 34）。 */
  const LONG = 'a'.repeat(300)

  test('半屏预算是**硬上限**——正文与提示行一起算（含极小预算的护栏）', () => {
    // 插入点摆在中间 ⇒ 两头都折、两行提示各占一格
    // （原锚：5 行正文 ＋ 2 行提示 ＝ 屏上 7 行，账上却写 5）
    expect(composerLayout(LONG, 200, 40, 5).rows.length).toBe(5)
    // 插入点在末尾 ⇒ 贴住下头，「下面」那头没有提示，省下的格子还给正文
    expect(composerLayout(LONG, 300, 40, 5).rows.length).toBe(5)
    // 插入点在最前 ⇒ 对称的另一头
    expect(composerLayout(LONG, 0, 40, 5).rows.length).toBe(5)
    // 预算窄到「一行正文 ＋ 两条提示」都放不下 ⇒ 插入点那一行优先，提示**让位**
    // （真光标得有个地方摆；`maxDraftLines` 给的是半屏，这一档是护栏）
    expect(composerLayout(LONG, 200, 40, 2).rows.length).toBe(1)
    expect(composerLayout(LONG, 200, 40, 1).rows.length).toBe(1)
    // 账与屏取同一处：这一份视图在 10 行窗里的交互区高度 ≤ 半屏
    const view = { ...createView(), draft: LONG, caret: 200 }
    expect(dockHeightOf(view, 40, 10)).toBeLessThanOrEqual(5)
  })

  test('矮窗**两头**折叠——真光标落在插入点那一行（不再高一行）', async () => {
    const stage = createStage()
    stage.press({ kind: 'paste', text: LONG })
    while (at(stage) > 200) stage.press({ kind: 'left' })

    const frame = await stage.screen({ columns: 40, rows: 10 })

    // 两头都折（插入点在中间）——两条提示都在屏上，且都「如实报」收起几行
    expect(frame.has('… 上面还有 3 行')).toBe(true)
    expect(frame.has('… 下面还有 2 行')).toBe(true)
    // 插入点是展示区最后一条正文行 ⇒ 真光标在「… 下面还有 2 行」那条的**上一行**。
    // 原锚 (13, 6)：那会儿交互区 7 行、动态帧正好 10 行顶满终端，Ink 省掉末尾换行
    // ⇒ 光标后缀多回退一行。这条量的就是这个「账与屏分家」。
    expect(frame.screen.cursor).toEqual({
      x: 1 + 12,
      y: viewportOf(frame, frame.rowOf('… 下面还有 2 行')) - 1,
    })
  })

  test('矮窗**单头**折叠——同一把尺（贴住下头，省下的格子还给正文）', async () => {
    const stage = createStage()
    stage.press({ kind: 'paste', text: LONG }) // 插入点在末尾

    const frame = await stage.screen({ columns: 40, rows: 10 })

    expect(frame.has('… 下面还有')).toBe(false) // 插入点在末尾 ⇒ 没有「下面」
    expect(frame.has('… 上面还有 4 行')).toBe(true) // 8 − 4：4 行正文 ＋ 1 行提示 ＝ 5
    // 最后一条视觉行是 36 个 a（首行 `› ` ＋ 36 个铺满，其后每行 38 个）
    // ⇒ 落点在左留白 1 ＋ 36 列之后
    expect(frame.screen.cursor).toEqual({
      x: 1 + 36,
      y: viewportOf(frame, frame.rowOf('○ 空闲')) - 1,
    })
  })
})
