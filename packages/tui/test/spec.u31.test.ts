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
import type { Frame, Stage } from './screen.ts'
import { rendered } from './screen.ts'
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

/**
 * **三轮返工**（2026-09-20 · 三轮验收退回）——**活动帧不得撑满终端**。
 *
 * 与前两轮**同一条机制**，这回出在**活动区**那笔账上：动态帧的行数到了终端高度，Ink 就走
 * **整屏那一支**（`ink.js` 的 `renderInteractiveFrame`：`isFullscreen ? output : output + '\n'`）
 * ——只写正文、**不写末尾那个换行**，而它摆光标的后缀仍按「正文之下还有一行」回退
 * （`cursor-helpers.js` 的 `buildCursorSuffix`：`moveUp = visibleLineCount - cursor.y`）
 * ⇒ **真光标高一行**。够得着它的有两条路，本轮各修一条、各钉一组：
 *
 * ① **账本身正好填满**——`liveBudget = max(1, rows - dock - 2)` 在活动区吃满时 ＝ `rows`
 *    （注释写着「不填满窗口」，算式却正好填满）。40×10 · 草稿 300 个 a · 3 行流式：
 *    帧正好 10 行，真光标 `(13,6)`、应为 `(13,7)`；
 * ② **单条记录自己就超预算**——早先那支「至少留住一条整行」（`kept.length > 0` 才 `break`）
 *    让一条 4 行的流式记录在 3 行的预算里**整条留了下来** ⇒ 帧 11 行，照样顶满。
 *    **只减预算常量减不掉这一条**（条目仍溢出），故改成**真切它的末尾那几行**。
 *
 * 判据两件，缺一不可：
 * - **字节**：帧尾那个换行还在不在——「顶满没顶满」的**直接**判据（比数屏上行数稳：
 *   滚动与整屏清都会影响屏的读数，上一轮就是靠这条认出来的）；
 * - **真光标**：它得落在插入点那一行（用户看得见的那一条）。
 */
describe('返工三 · 活动帧不撑满终端（流式增长 · 单条超预算）', () => {
  /** 40 列 ⇒ 内容宽 38 ⇒ 300 个 a 折成 8 个视觉行；矮窗（10 行）⇒ 交互区吃满半屏 5 行。 */
  const LONG = 'a'.repeat(300)
  /** 矮窗——这条缺陷只在「动态帧够得着终端高度」时露头（24 行的窗里一个场景都拦不住）。 */
  const SHORT = { columns: 40, rows: 10 } as const
  /** 插入点：退回点名的那个位置（两头折叠）。 */
  const AT = 200

  /**
   * 帧尾那个换行在不在——**「动态帧顶满终端了吗」的字节判据**。
   *
   * 判法：只取**末尾那一小段**字节，把控制序列统统剥掉，看剩下的是不是以 `\n` 收尾
   * ——正文之后**没有**换行＝Ink 走了整屏那一支（顶满），有＝没顶满。取末尾一小段是
   * **故意的**：帧体里本来就有换行（行与行之间），取整串会数到上一行去；而光标后缀
   * （上移 / 定位 / 显光标 / 同步更新收尾，还带色码复位）最长也就几十个字节。
   * ⚠️ **剥色码这一道不能省**：`FORCE_COLOR=3` 那道门下色码是开着的，不剥就会把
   * `\e[39m` 当成帧尾（这一条正是我第一版踩的坑——同一份字节在两个色档下答案不同）。
   */
  function trailingBreak(bytes: string): boolean {
    const esc = String.fromCharCode(27)

    return (
      bytes
        .slice(-120)
        // OSC（超链接那类）与 CSI（色 · 光标 · 擦行 · 同步更新）——两类控制序列都剥掉
        .replace(new RegExp(`${esc}\\][^${esc}]*(?:\\u0007|${esc}\\\\)`, 'g'), '')
        .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, 'g'), '')
        .endsWith('\n')
    )
  }

  /** 矮窗 ＋ 长草稿（插入点 200）＋ 若干行流式正文——探针 `stream-frame.ts 40 10` 那一形。 */
  function streaming(lines: number): Stage {
    const stage = createStage()
    stage.feed([
      event('model.delta', {
        channel: 'text',
        text: Array.from({ length: lines }, (_, index) => `流式 ${String(index + 1).padStart(2, '0')}`).join('\n'),
      }),
    ])
    stage.press({ kind: 'paste', text: LONG })
    while (at(stage) > AT) stage.press({ kind: 'left' })

    return stage
  }

  /** 长草稿 ＋ 矮窗（没有流式）——对照组：这一档本来就够不着终端高度。 */
  function drafted(): Stage {
    const stage = createStage()
    stage.press({ kind: 'paste', text: LONG })
    while (at(stage) > AT) stage.press({ kind: 'left' })

    return stage
  }

  /** 三条工具记录（各两行：标题 ＋ 结果）——六行挤在两行的活动区预算里。 */
  function toolRows(): Stage {
    const stage = drafted()
    stage.feed(
      ['a.txt', 'b.txt', 'c.txt'].flatMap((path, at) => [
        event('tool.call', { name: 'ls', args: { path } }, { id: at + 1 }),
        event('tool.result', { call: at + 1, ok: true, output: { text: path } }, { id: at + 11 }),
      ]),
    )

    return stage
  }

  /** 裁决接管（材料一行）——接管期间没有插入点，真光标藏起来。 */
  const TAKEOVER = [
    event('tool.call', { name: '跑测试', args: {} }, { id: 71 }),
    event('tool.decision.request', { call: 71, name: '跑测试', material: '命令 bun test', weight: 'light' }, { id: 88 }),
  ]

  function taken(): Stage {
    const stage = createStage()
    stage.type('abcd')
    stage.press({ kind: 'left' })
    stage.press({ kind: 'left' }) // ab|cd
    stage.feed(TAKEOVER)

    return stage
  }

  /** 接管 → 批准 → **归还**（草稿与插入点一起回来）。 */
  function returned(): Stage {
    const stage = taken()
    stage.press({ kind: 'char', char: 'y' }) // 答「批准」
    stage.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 300 }, { id: 88 })])

    return stage
  }

  test('流式 1/2/3/4/6 行——帧**短于**这一屏，真光标落在插入点那一行', async () => {
    for (const lines of [1, 2, 3, 4, 6]) {
      const stage = streaming(lines)
      const bytes = await rendered([stage.shell.getView()], SHORT, null)
      const frame = await stage.screen(SHORT)

      // 原锚：3/4/6 那三档**没有**这个换行（帧 10/11/13 行，正好顶满 ⇒ Ink 走了整屏那一支）
      expect([lines, trailingBreak(bytes)]).toEqual([lines, true])
      // 插入点是展示区最后一条正文行 ⇒ 它该在「… 下面还有 2 行」那条的**上一行**
      // （`x` 与二轮那条同形：左留白 1 ＋ 第 6 个视觉行上 12 个 a）
      expect([lines, frame.screen.cursor]).toEqual([
        lines,
        { x: 1 + 12, y: viewportOf(frame, frame.rowOf('… 下面还有 2 行')) - 1 },
      ])
    }
  })

  test('单条流式记录**自己就超预算**——屏上画**末尾**那几行，记录里一行不少', async () => {
    const stage = streaming(12) // 一条记录、十二个视觉行；活动区的预算只有 2 行
    const bytes = await rendered([stage.shell.getView()], SHORT, null)
    const frame = await stage.screen(SHORT)

    // 原锚：整条留下来（12 ＋ 1 ＋ 5 ＋ 1 ＝ 19 行的帧）⇒ 顶满 ⇒ 没有这个换行
    expect(trailingBreak(bytes)).toBe(true)
    expect(frame.has('流式 12')).toBe(true) // 最新那几行看得见（活动区是**尾**窗口）
    expect(frame.has('流式 01')).toBe(false) // 开头画不下——**屏**放不下，不是记录里丢

    // **记录里一行不少**：切的是画，不是记录（输出照旧整条进记录，塞在 `row.text` 里）
    const row = stage.shell.getView().rows[0]
    const text = row?.kind === 'assistant' ? row.text : ''

    expect(text.split('\n')).toHaveLength(12)
    expect(text).toContain('流式 01')
  })

  test('多条工具记录——只画得下**最近**的那几条，帧仍短于这一屏', async () => {
    const stage = toolRows()
    const bytes = await rendered([stage.shell.getView()], SHORT, null)
    const frame = await stage.screen(SHORT)

    expect(trailingBreak(bytes)).toBe(true) // 原锚：六行整条留下 ⇒ 帧 11 行 ⇒ 顶满
    expect(frame.has('ls {"path":"c.txt"}')).toBe(true) // 最近那条在屏上
    expect(frame.has('ls {"path":"a.txt"}')).toBe(false) // 早的那几条让位（**整条**让——不切一半）
    expect(stage.shell.getView().rows).toHaveLength(3) // 三条都在记录里
  })

  test('矮窗里接管 → 归还——真光标回到**原插入点**，帧仍不顶满', async () => {
    // 接管那一屏也得短于终端（卡片自成一块：材料一行 ＋ 四行）
    expect(trailingBreak(await rendered([taken().shell.getView()], SHORT, null))).toBe(true)

    const stage = returned()
    stage.type('X') // 接着打——字进在**原来那个位置**
    const frame = await stage.screen(SHORT)

    expect(draftOf(stage)).toBe('abXcd')
    // 1（左留白）＋ 2（`› `）＋ `abX` 3 列 ＝ 6（与 80×24 那条同形，这里换矮窗）
    expect(frame.screen.cursor).toEqual({ x: 6, y: frame.rowOf('› abXcd') })
  })

  test('装得下就照画——**不裁**（裁剪只发生在装不下时）', async () => {
    const stage = streaming(3)
    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('流式 01')).toBe(true)
    expect(frame.has('流式 03')).toBe(true)
  })

  test('不变量：各档窗 × 各形屏——动态帧**一律**短于终端', async () => {
    // 列数**不低于 40**——那是本仓自己声明的「最窄还得看得见」那一档
    // （`spec.u31` 的 `NARROW`、banner 的块字档都按它划）。
    //
    // ⚠️ **如实记一条限度**（本轮不claim、也没改）：40 列以下另有两处**账比屏少一行**——
    // 空态那句引导语（32 列以下会折成两行）与裁决卡的键位行（38 列以下会折成两行）。
    // 前者已按「整句折几行」算进账里（见 `AppView` 的 `empty`），但 30×8 这类**极窄又极矮**
    // 的窗上，光是「空态 ＋ 分隔线 ＋ 交互区 ＋ 状态行」就已经等于终端高度，活动区让到 0
    // 也收不下；后者那两行在 `decision.ts` 里成形、账在 `app.ts` 里算，要收得动那个文件
    // （本单所有权之外）。⇒ **本矩阵不覆盖 40 列以下**，限度写进回报。
    const sizes = [
      { columns: 40, rows: 10 },
      { columns: 40, rows: 8 }, // 更矮：交互区 4 行 ＋ 分隔线 ＋ 状态行 ＝ 只余得下一行活动区
      { columns: 60, rows: 12 }, // 中号
      { columns: 80, rows: 24 }, // 正常尺寸（这一档本来就不顶满——防的是「修过头」）
    ] as const

    const cases: readonly (readonly [string, () => Stage])[] = [
      ['空态', () => createStage()],
      ['流式 3 行', () => streaming(3)],
      ['流式 40 行（单条超预算）', () => streaming(40)],
      ['长草稿（无流式）', () => drafted()],
      ['三条工具记录', () => toolRows()],
      ['接管中', () => taken()],
      ['接管归还后', () => returned()],
    ]

    // 一格格问过去，**全跑完再断言**——第一格就停会把后面的格子藏起来（矩阵要的是一张全景图）
    const topped: string[] = []
    for (const size of sizes) {
      for (const [name, make] of cases) {
        const bytes = await rendered([make().shell.getView()], size, null)
        if (!trailingBreak(bytes)) topped.push(`${size.columns}×${size.rows} 的「${name}」`)
      }
    }

    expect(topped).toEqual([]) // 空数组＝每一格都短于终端；红的时候列着是哪几格顶满了
  })
})
