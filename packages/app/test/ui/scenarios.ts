/**
 * 界面验收 · 代表场景（U40）——**一处写、两个入口用**。
 *
 * 六组场景逐条对 `界面验收工具`·「首批验收场景」（名里的次序就是那篇文档的次序）。
 * 每组都是一段**能读的故事**：起一个真应用、敲键盘、等屏上的条件、把关键几屏取下来，
 * 中途**逐条判**——判据写在故事里，跑法（bun:test / 命令行 `run`）在外面。
 *
 * ## 三条写法上的规矩
 *
 * 1. **只锚已确认行为**（工单的话）——真发现产品不对，记下来报规划侧，
 *    不在这里放宽断言把它盖过去；
 * 2. **等条件，不睡够**——每一步都等一个**屏上的**条件（固定 sleep 只用在「让流式
 *    多吐两块」这种**制造中间态**的地方）；
 * 3. **文案判据尽量取产品自己的常量**——`HINT_IDLE` 与 `placeholderOf` 是**出包**的
 *    （`@magic/tui` 的公开面），直接 import；`HINT_PICKER` / `HINT_DECIDE_LIGHT` **没出包**，
 *    本单按**字面量**锚，并在判据的 `detail` 里写明原锚是什么（真要改这三处文案，
 *    判据会红——那正是 UI 验收工具该有的反应；届时连同本注释一起改）。
 *
 * ## 判据挂了会怎样
 *
 * 第一条挂就**当场停**（`check` 抛 `ScenarioFailure`）；运行器把失败连同**判据名**、
 * 现场目录、最后屏幕一起交回去，并把自己起的应用/端点**全部收干净**
 * （「批量场景失败先留档再关闭」）。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HINT_EXIT_ARMED, HINT_IDLE, placeholderOf } from '@magic/tui'
import { statusLineOf } from './anchors.ts'
import { REPO_ROOT, UiWaitTimeout, createUiSession } from './driver.ts'
import type { Capture, UiSession, UiSessionOptions } from './driver.ts'
import type { FixtureTurn } from './fixture.ts'
import { readDatabase } from '../support.ts'

/** 没出包的文案锚（见文件头注 3）——判据用到它们时，`detail` 里写上这一份。 */
const COPY = {
  // ⚠️ U61 改过这一句（多了 `← 退`）——按上面注 3 那条，字面量锚跟着改，
  //    它红的正是时候：这一句是「抽屉真开了」的判据，提示一变就得有人来看一眼。
  pickerHint: '↑↓ 选 · 回车 定 · ← 退 · esc 收起',
  decideHint: 'y / a / n',
  approval: '批准',
} as const

/**
 * 工具**跑完**那行的完成标记（`tui` 的 `verdictOf`：成功走 `✓`）。
 *
 * ⚠️ 为什么单拎出来当锚：审批卡上就写着要执行的命令（`1. echo hello-magic —— 只读`），
 * 拿**参数里的那串字**当「跑完了」的条件＝**空转**——首轮验收就是这么栽的
 * （`frames/0002-工具跑完.txt` 抓到的其实还是审批卡）。`✓` 只在**结果行**上，
 * 而结果行只在工具真跑完之后才有。
 */
const TOOL_DONE = '✓'

/**
 * 状态行左半**第一格**的词（空闲）——「它又闲下来了」那条判据的锚。
 *
 * 与 `HINT_IDLE` 分开：那一句在**右位**，而右位是**放不下就整段不出现**的（既有口径）
 * ——窄窗里它本来就不该在，拿它当「空闲了没有」的条件，量的就成了窗口宽度。
 */
const IDLE_STATE = '○ 空闲'

/** 一条「已知未修」的登记：**谁欠着、为什么不修**。 */
export type KnownOpen = {
  /** 欠账的缺陷档（库内 `缺陷/Dxx …`）。 */
  readonly defect: string
  /** 为什么不修——一句话，别写「以后再说」。 */
  readonly why: string
}

/** 一条判据的结论——过了的也一并交回（给人看这一组到底判了些什么）。 */
export type CheckOutcome = {
  readonly what: string
  readonly ok: boolean
  readonly detail: string
  /**
   * 有它 ⇒ 这条判据**现在会红，而红的是已经知道的那件事**（登记见 `KNOWN_OPEN`）：
   * 照样跑、照样记、照样打印，但**不中断场景**，也不让门变红。
   * 没有它 ⇒ 不过就抛 `ScenarioFailure`，与往常一样。
   */
  readonly knownOpen?: KnownOpen
}

/** 判据没过——**带上判据名**（场景交付里最要紧的一句话）。 */
export class ScenarioFailure extends Error {
  readonly what: string
  readonly detail: string

  constructor(what: string, detail: string) {
    super(detail === '' ? `判据「${what}」没过` : `判据「${what}」没过：${detail}`)
    this.name = 'ScenarioFailure'
    this.what = what
    this.detail = detail
  }
}

/** 故事手里那几件——判一条、记一句、起一个会话（收摊归运行器）。 */
export type ScenarioContext = {
  check(ok: boolean, what: string, detail?: string): void
  note(line: string): void
  /** 起一个隔离会话；**由运行器统一收摊**（失败也收）。 */
  open(options: UiSessionOptions): Promise<UiSession>
}

export type ScenarioName =
  | 'boot-input-resize-exit'
  | 'drawer-open-close'
  | 'model-stream-approval'
  | 'missing-text-failure'
  | 'assistant-across-calls'
  | 'isolation-repeat-parallel'
  | 'mcp-approval'
  | 'mcp-approval-edge'
  | 'mcp-underscore-name'
  | 'stop-not-rollback'
  | 'exit-command'
  | 'packed-enter'

export type ScenarioOptions = {
  /** 产物根（缺省 `<checkout>/.ui-runs`）。 */
  readonly artifacts?: string
  /** 被测 checkout（缺省＝本仓根）。 */
  readonly checkout?: string
  /** 每判一条往外说一句（命令行 `run` 用它打进度）。 */
  readonly onCheck?: (outcome: CheckOutcome) => void
  readonly onNote?: (line: string) => void
}

export type ScenarioResult = {
  readonly name: ScenarioName
  readonly title: string
  readonly anchors: string
  readonly ok: boolean
  readonly runDirs: readonly string[]
  readonly viewers: readonly string[]
  readonly checks: readonly CheckOutcome[]
  readonly failure?: { readonly what: string; readonly detail: string }
  /** 失败时最后那一眼的屏（同一份也写进了现场）。 */
  readonly lastScreen?: readonly string[]
}

export type Scenario = {
  readonly name: ScenarioName
  readonly title: string
  readonly anchors: string
  readonly story: (ui: ScenarioContext, options: ScenarioOptions) => Promise<void>
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 启动 → 输入 → 窄窗 resize → 清空 → 退出
// ═══════════════════════════════════════════════════════════════════════

const bootInputResizeExit: Scenario = {
  name: 'boot-input-resize-exit',
  title: '启动 → 输入 → 窄窗 resize → 清空草稿 → 退出',
  anchors: '首批验收场景 1：启动、输入、窄窗 resize、清空、退出；真实窗口变化后布局更新',
  story: async (ui, options) => {
    const session = await ui.open({
      label: '场景1-起手输入改窗退出',
      columns: 100,
      rows: 30,
      turns: [{ kind: 'text', text: '收到，我在。' }],
      ...where(options),
    })

    const boot = await session.capture({ label: '起手' })
    ui.check(boot.text.includes('█'), '起手画出了字标', '屏上该有块字版的 MAGIC CODE')
    ui.check(
      boot.lines.some((line) => line.includes(HINT_IDLE)),
      '起手放开输入（右位回到常态提示）',
      `锚＝@magic/tui 的 HINT_IDLE：${HINT_IDLE}`,
    )

    // —— 输入 ——
    await session.send('你好')
    await session.wait({ text: '› 你好' })
    const draft = await session.capture({ label: '草稿' })
    ui.check(draft.text.includes('你好'), '敲进去的字进了草稿', '按键确实经 PTY 到了 CLI')

    // 回车**只敲一遍**，`until` 只是等屏上出现那句话（等不到＝超时留档，不重敲——
    // 重敲会把「慢渲染」掩盖成「过了」，见 `driver.ts`·`WriteUntil`）
    await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 4_000 })
    const answered = await session.capture({ label: '回话之后' })
    ui.check(answered.text.includes('› 你好'), '记录区留下了这次交代', '')
    ui.check(answered.text.includes('⏺ 收到，我在。'), '记录区留下了模型的答复', '锚＝助手标记 `⏺`')

    // —— 窄窗 resize：判据是**应用自己按新宽度画出过一帧**（D27）——
    //
    // ⚠️ 屏上「出现 44 个横线」**不是**充分判据（这一条是被实际假阳性打回来的）：
    // 终端会把旧 100 列的分隔线按新宽度重新折行，44 + 44 + 12 的头一个 44 就满足它——
    // 实测那一趟 resize、wait 通过、取帧三步的累计字节数完全相同，而应用当时一个字节
    // 都还没按新宽度画。「VT 尺寸正确」「每行不超宽度」「有新字节」「答复正文出现」同理：
    // 都是**那一刻**为真、却不代表应用采用了新尺寸。故等的是它**写出去的一整帧**
    // （见 `driver.ts` 里 `WaitCondition.writtenFrame` 的注）。
    await session.resize(44, 16)
    await session.wait({ writtenFrame: 44 })
    // ⚠️ 这一条等到的就是**整帧**（一帧一次写出去），故后面取的帧不用再补等待
    const narrow = await session.capture({ label: '窄窗' })
    ui.check(narrow.columns === 44 && narrow.rows === 16, 'VT 认了新尺寸', '44×16')
    ui.check(
      narrow.lines.every((line) => [...line].length <= 44),
      '窄窗上没有一行超出新宽度',
      `最长一行 ${Math.max(...narrow.lines.map((line) => [...line].length))} 列`,
    )
    // —— 清空草稿（退格删光，回到占位语）——
    await session.send('待删')
    await session.wait({ text: '待删' })
    for (let at = 0; at < 2; at += 1) await session.key('backspace')
    await session.wait({ text: placeholderOf('idle') })
    const cleared = await session.capture({ label: '清空之后' })
    ui.check(!cleared.text.includes('待删'), '退格把草稿删干净了', '')

    // —— 改窗之后**画面本身**也得对（D27 的另一半）——
    // ⚠️ 判的是**稳定画面**：「回话之后」那一帧改窗时应用还在流式，下一帧就会把中间态盖掉
    //    （那是正常的重绘，不是残留）。等它回到空闲（上面那句占位语就是空闲）再数。
    // ⚠️ **两条**（U45）：记录区／交互区之间那条 ＋ 交互区下沿那条。改窗残影（D27）会在
    //    上面留下旧的分隔线 ⇒ 读数**多于**两条，那一半仍是欠着的账（登记见 `KNOWN_OPEN`）。
    const dividers = cleared.lines.filter((line) => isRule(line)).length
    ui.check(dividers === 2, '窄窗稳定后一共只画了两条分隔线', `可见区实际 ${dividers} 条`)
    ui.check(
      countExact(cleared.history, '› 你好') === 1,
      '改窗之后用户消息只有一条（旧帧没留在屏上）',
      `整份缓冲实际 ${countExact(cleared.history, '› 你好')} 条`,
    )
    ui.check(
      countExact(cleared.history, '⏺ 收到，我在。') === 1,
      '改窗之后答复只有一条',
      `整份缓冲实际 ${countExact(cleared.history, '⏺ 收到，我在。')} 条`,
    )

    // —— 退出：空闲**按两次**走人（U46：第一下只印那一行、不退出）——
    // ⚠️ **走 `quit()`，不在这儿自己写两下**（U68）：那道门**只开一小会儿**（1.5 秒），
    //    第二下必须落在门内——「等那一行上屏」等多久才算不误点，是**驱动那一层的账**
    //    （它照 `anchors.exitArmedWindowMs` 有界地等，见 `driver.ts` 的 `quit`）。
    await session.quit()
    const report = await session.close({ graceMs: 2_000 })
    ui.check(report.exit.by === 'app', '两下 ctrl+c 让应用自己退了场', `退出缘由 ${report.exit.by}`)
    ui.check(report.exit.code === 0, '退出码是 0', `实际 ${report.exit.code}`)

    // 退出之后内容留在终端（内联渲染的既有性质）——屏上那些字还在
    const after = await session.screen()
    ui.check(
      after.lines.some((line) => line.text.includes('收到，我在。')),
      '退出后内容留在屏上（不清屏）',
      '',
    )
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 二 · 抽屉开合（空名录 / 有项）
// ═══════════════════════════════════════════════════════════════════════

const drawerOpenClose: Scenario = {
  name: 'drawer-open-close',
  title: '空名录 / 有项抽屉开合：记录不丢不重，之后还能敲',
  anchors: '首批验收场景 2：有项/空名录抽屉开合，记录不丢不重，操作后仍能输入',
  story: async (ui, options) => {
    const session = await ui.open({
      label: '场景2-抽屉开合',
      columns: 100,
      rows: 24,
      turns: [{ kind: 'text', text: '收到' }],
      // 两条目——`/model` 的抽屉才有「有项」可言
      config: {
        providers: {
          local: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u40', model: 'MiniMax-M3' },
          backup: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-u40', model: 'MiniMax-M2' },
        },
      },
      ...where(options),
    })

    const before = await session.capture({ label: '抽屉之前' })
    // ⚠️ 记录类判据看**整个缓冲里的记录区**（`history` 去掉最后那条分隔线之后的），
    // 而不是可见那一屏：记录区会滚动，只比可见的一截时，滚出去的行会被当成「丢了」（实测栽过）；
    // 也不能拿整个缓冲比——抽屉就在分隔线**以下**，那是**该**变的
    const recordBefore = recordHistoryOf(before)

    // —— 空名录：给原因，不开选择器 ——
    await session.send('/grants')
    // 先等草稿真的上了屏，再敲回车（「先等草稿上屏再回车」是早先几轮 pty 实测留下的姿势）
    await session.wait({ text: '› /grants' })
    // ⚠️ 判据是**逐行**匹配的（见 `driver.ts`·`wait` 的注）——故这一句要挑**一行装得下**的：
    // 「还没有授权」那半截会被折行劈开（实测），而这一截在第二行里是完整的
    await session.key('enter', { until: { text: '批准时按 a 就是记一条' } })
    const empty = await session.capture({ label: '空名录' })
    ui.check(empty.text.includes('批准时按 a 就是记一条'), '空名录给了原因（不是一片空白）', '锚＝那行原因')
    ui.check(
      !empty.text.includes(COPY.pickerHint),
      '空名录没有开选择器',
      `锚＝提示「${COPY.pickerHint}」不在屏上`,
    )

    // —— 有项：开选择器，列条目 ——
    await session.send('/model')
    await session.wait({ text: '› /model' })
    await session.key('enter', { until: { text: COPY.pickerHint } })
    const opened = await session.capture({ label: '有项抽屉' })
    ui.check(opened.text.includes('local'), '抽屉列出了第一条目', '')
    ui.check(opened.text.includes('backup'), '抽屉列出了第二条目', '')
    ui.check(
      recordHistoryOf(opened).length === recordHistoryOf(empty).length,
      '开抽屉没有往记录区添行（抽屉在分隔线以下）',
      `空名录后 ${recordHistoryOf(empty).length} 行 · 开抽屉后 ${recordHistoryOf(opened).length} 行`,
    )

    // —— 收起 ——
    await session.key('esc')
    await session.wait({ absent: COPY.pickerHint })
    const closed = await session.capture({ label: '收起之后' })
    ui.check(!closed.text.includes(COPY.pickerHint), 'esc 收起了抽屉', '')

    // —— 「不丢不重」怎么判 ——
    //
    // 口径是**开合一圈之后，记录区一字不差**：拿「空名录那句回执落下之后」那一份当基准
    // （`recordEmpty`），开抽屉、收起之后再取一份（`recordClosed`），两份必须**逐行相同**。
    //
    // ⚠️ 别拿「抽屉之前」那一份当基准：空名录**会**留一行回执（「空列表给原因」是规格），
    // 而回执落地时会把起手那句提示顶掉——那是**该**发生的（回执不是多出来的脏东西）；
    // 拿它当基准，判的就不再是「抽屉弄没弄坏记录」了（实测栽过一版）
    const emptyRecord = recordHistoryOf(empty)
    const closedRecord = recordHistoryOf(closed)
    ui.check(
      closedRecord.length === emptyRecord.length &&
        closedRecord.every((line, at) => line === emptyRecord[at]),
      '记录不丢不重（开合一圈之后与开之前逐行相同）',
      `开抽屉前 ${emptyRecord.length} 行 · 合上后 ${closedRecord.length} 行`,
    )
    const doubled = closedRecord.filter((line) => countOf(line, closedRecord) > 1)
    ui.check(doubled.length === 0, '没有哪一行被重画成两遍（不重影）', `重影 ${JSON.stringify(doubled)}`)
    ui.check(
      recordHistoryOf(opened).length === emptyRecord.length,
      '抽屉开着时记录也没变（抽屉在分隔线以下）',
      `空名录后 ${emptyRecord.length} 行 · 抽屉开着 ${recordHistoryOf(opened).length} 行`,
    )
    ui.check(
      recordBefore.every((line, at) => closedRecord[at] === line || at === recordBefore.length - 1),
      '开合没动到上头那些行（字标与回执都在）',
      `比对了前 ${recordBefore.length - 1} 行`,
    )

    // —— 操作后仍能输入 ——
    await session.send('接着干')
    await session.wait({ text: '› 接着干' })
    const typable = await session.capture({ label: '抽屉之后还能敲' })
    ui.check(typable.text.includes('接着干'), '抽屉开合之后草稿照收', '')
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 三 · 流式 ＋ 工具裁决 ＋ 收尾
// ═══════════════════════════════════════════════════════════════════════

const modelStreamApproval: Scenario = {
  name: 'model-stream-approval',
  title: '流式正文 → 工具裁决接管 → 批准 → 继续并结束',
  anchors: '首批验收场景 3：本地模型流式响应、工具裁决接管、答复后继续并结束；中间屏也能取样',
  story: async (ui, options) => {
    const streamed = '甲乙丙丁戊己庚辛壬癸'
    const head = [...streamed].slice(0, 3).join('')
    const tail = [...streamed].at(-1) as string
    const turns: readonly FixtureTurn[] = [
      { kind: 'tool', name: 'exec', args: { cmd: 'echo hello-magic' } },
      { kind: 'text', text: streamed, chunks: 4, chunkDelayMs: 220 },
    ]
    const session = await ui.open({
      label: '场景3-流式与裁决',
      columns: 100,
      rows: 30,
      turns,
      ...where(options),
    })

    await session.send('跑一下')
    await session.wait({ text: '› 跑一下' })
    await session.key('enter', { until: { text: COPY.decideHint } })
    const deciding = await session.capture({ label: '裁决接管' })
    ui.check(deciding.text.includes('exec'), '裁决卡点名了要调用的工具', '')
    ui.check(deciding.text.includes('echo hello-magic'), '裁决卡给了实际业务参数', '')
    ui.check(deciding.text.includes(COPY.approval), '裁决卡给了键位与后果', `锚＝「${COPY.approval}」`)

    // —— 批准 → 真执行 → 再回模型 ——
    // 敲的是 `y` 这个**字符**——PTY 上一次按键本来就是它，故走 `send`（`key` 只收功能键）。
    // ⚠️ 这一下**绝不能重发**：批准不幂等，重放下去就是**误批下一条**（首轮验收点名的坑）。
    // ⚠️ 等的**不是** `hello-magic` 那串字（审批卡上就有它，见 `TOOL_DONE` 的注）——
    // 等的是**结果行**：`✓ <耗时> · <输出末行>`，它只在工具跑完之后才上屏。
    await session.send('y', { until: { text: TOOL_DONE }, timeoutMs: 10_000 })
    const ran = await session.capture({ label: '工具跑完' })
    ui.check(
      ran.lines.some((line) => line.includes(TOOL_DONE) && line.includes('hello-magic')),
      '工具真跑了：结果行＝完成标记 ＋ 那条输出',
      `锚＝结果行「${TOOL_DONE} … · hello-magic」（审批卡里那串参数不算）`,
    )

    // —— 独立核：**不看屏**，直读应用自己写的记录库 ——
    const results = await awaitToolResult(session, 'hello-magic')
    ui.check(
      results.some((result) => result.ok && result.text.includes('hello-magic')),
      '记录库里真有一条成功的工具结果（输出就在里面）',
      results.length === 0 ? '一条 tool-result 都没有' : `${results.length} 条 tool-result`,
    )

    // —— 中间屏：等头一块正文，紧接着取帧 ——
    await session.wait({ text: head })
    const midway = await session.capture({ label: '流到一半' })
    ui.check(midway.text.includes(head), '中间屏抓到了头一块正文', `头一块＝${head}`)
    ui.check(!midway.text.includes(tail), '取帧时它确实还没吐完（中间态）', `末字「${tail}」还没落屏`)

    // —— 收尾：**等空闲再取帧**（流式末字到了 ≠ 结束：那一刻状态行还写着「工作中」）——
    await session.wait({ text: streamed })
    await session.wait({ text: HINT_IDLE })
    const done = await session.capture({ label: '答复结束' })
    ui.check(done.text.includes(streamed), '正文流完（末字也到了）', '')
    ui.check(
      done.lines.some((line) => line.includes(HINT_IDLE)),
      '取「答复结束」那一帧时它已经空闲（末字到了不等于结束）',
      `锚＝@magic/tui 的 HINT_IDLE：${HINT_IDLE}`,
    )

    // —— 请求侧：两趟、都带着工具表 ——
    const requests = session.requests()
    ui.check(requests.length >= 2, '两趟模型请求（工具前后各一趟）', `实际 ${requests.length} 趟`)
    ui.check(
      requests.slice(0, 2).every((request) => request.tools > 0),
      '请求里带着工具表（真适配链发出去的就是它）',
      `第一趟 ${requests[0]?.tools ?? 0} 件`,
    )
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 七 · 外部工具（MCP）：发现 → 审批 → 批准真调用 / 拒绝零调用 → 释放
// ═══════════════════════════════════════════════════════════════════════

/**
 * 外部服务器那一件——**真进程**（用官方 SDK 的服务器面写的那支假服务器）。
 *
 * 它也是**判据的出处**：每收到一次调用就往 `FAKE_MCP_LOG` 追一行。故「拒绝时零调用」
 * 与「批准真调用」这两条读的是**服务器自己数的数**，不是客户端说了什么。
 */
const FAKE_MCP_SERVER = join(REPO_ROOT, 'packages', 'mcp', 'test', 'support', 'fake-server.ts')

const mcpApproval: Scenario = {
  name: 'mcp-approval',
  title: '外部工具：连上本地服务器 → 审批卡点名服务器/工具 → 批准真调用 · 拒绝零调用 → 退出释放子进程',
  anchors: 'U38 完成出口：真应用连本地假 stdio 服务器，发现 / 审批 / 调用 / 拒绝 / 释放都有可观察结果',
  story: async (ui, options) => {
    const dir = mkdtempSync(join(tmpdir(), 'magic-u38-mcp-'))
    const log = join(dir, 'fake.jsonl')

    const turns: readonly FixtureTurn[] = [
      { kind: 'tool', name: 'mcp__fake__echo', args: { text: '第一次外部调用' } },
      { kind: 'tool', name: 'mcp__fake__echo', args: { text: '第二次外部调用' } },
      { kind: 'text', text: '外部那两件处理完了' },
    ]

    const session = await ui.open({
      label: '场景7-外部工具',
      columns: 100,
      rows: 30,
      turns,
      config: {
        // **显式配置**才连（这一条正是「只有配置里写了才拉起进程」的可观察形态）
        mcp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [FAKE_MCP_SERVER],
              env: { FAKE_MCP_LOG: log, FAKE_MCP_NAME: 'fake' },
            },
          },
        },
      },
      ...where(options),
    })

    // —— 交代 → 第一张审批卡 ——
    await session.send('用外部工具回显一句')
    await session.wait({ text: '› 用外部工具回显一句' }, { timeoutMs: 10_000 })
    await session.key('enter', { until: { text: 'y 批准这一次' } })
    const card = await session.capture({ label: '外部审批卡' })

    ui.check(card.text.includes('fake / echo'), '审批卡点名「服务器 / 工具」', '原锚＝注册表的身份（名字含服务器）')
    ui.check(
      card.text.includes('外部操作 · 效果由服务器决定'),
      '审批卡说的是外部口径（不说可逆 / 不可逆）',
      '锚＝交互约束给的那一句原话',
    )
    ui.check(card.text.includes('第一次外部调用'), '审批卡给了实际业务参数', '')
    ui.check(card.text.includes('y 批准这一次'), '只给「批准这一次」', '')
    ui.check(card.text.includes('n 拒绝'), '给了「拒绝」', '')
    ui.check(
      !/(^|\s)y 批准(\s|　|$)/u.test(card.text.replace('y 批准这一次', '')),
      '没有「总是允许」以外的宽放行（外部件只有这一次）',
      '锚＝卡片正文里不再出现另一处「批准」',
    )
    // **还没答**：服务器一次都没被调（拒绝零调用那条的**前置**——卡还挂着时它已经成立）
    ui.check(mcpCalls(log).length === 0, '卡还挂着时服务器零调用', `日志 ${mcpCalls(log).length} 行`)

    // —— 批准第一件 ——
    // 敲的是 `y` 这个**字符**（PTY 上按键本来就是它）；⚠️ 绝不能重发：批准不幂等。
    await session.send('y', { until: { text: TOOL_DONE }, timeoutMs: 15_000 })
    const approved = await session.capture({ label: '第一次批准后' })
    ui.check(
      approved.lines.some((line) => line.includes(TOOL_DONE) && line.includes('第一次外部调用')),
      '结果行＝完成标记 ＋ 服务器回的那串字',
      `锚＝结果行「${TOOL_DONE} … · 第一次外部调用」（审批卡里那串参数不算）`,
    )
    ui.check(mcpCalls(log).length === 1, '服务器自己数到了那一次调用', `日志 ${mcpCalls(log).length} 行`)

    // —— 第二件：**拒绝** ——
    await session.wait({ text: 'y 批准这一次' }, { timeoutMs: 15_000 })
    const second = await session.capture({ label: '第二张审批卡' })
    ui.check(second.text.includes('第二次外部调用'), '第二张卡给的是第二次的参数', '')

    // 等的是**末尾那句答复**，不是 `HINT_IDLE`——拒绝之后那一小段里，状态行会先回一次
    // 「空闲」（卡收了、下一趟模型还没回来），拿它当条件会**抓到半路**（实测栽过一次：
    // 取到的帧里没有最后那句答复）。等答复本身，条件与判据才是同一件事。
    await session.send('n', { until: { text: '外部那两件处理完了' }, timeoutMs: 15_000 })
    const rejected = await session.capture({ label: '拒绝之后' })
    ui.check(
      mcpCalls(log).length === 1,
      '拒绝＝服务器零调用（计数仍是一次，没有第二次）',
      `日志 ${mcpCalls(log).length} 行（服务器自己数的）`,
    )

    // —— 独立核：不看屏，直读记录库 ——
    const results = await awaitToolResult(session, '第一次外部调用')
    ui.check(
      results.some((result) => result.ok && result.text.includes('第一次外部调用')),
      '记录库里真有一条成功的工具结果',
      results.length === 0 ? '一条 tool-result 都没有' : `${results.length} 条 tool-result`,
    )
    ui.check(rejected.text.includes('外部那两件处理完了'), '拒绝之后这一轮照常走完', '')

    // —— 退出：**自有子进程要收干净**（用户自己的进程不归我们管，那是适配器用例的账）——
    const child = mcpCalls(log)[0]?.pid
    ui.check(typeof child === 'number' && isAlive(child as number), '退出之前：子进程还活着', `pid ${child}`)

    await session.close()
    await waitGone(child as number)
    ui.check(!isAlive(child as number), '退出之后：本进程拉起的服务器子进程没了', `pid ${child}`)

    // —— 第二幕：**配了一台连不上的服务器**（这是最常见的配置失败）——
    //
    // 要看的就一件：用户盼着它的工具出现，结果一件都没有时，**屏上说不说得出是哪一台**。
    // 同时顺带验「单连接失败不拖垮内置工具」——内置那件照跑（`exec`）。
    const broken = await ui.open({
      label: '场景7-连不上',
      columns: 100,
      rows: 24,
      turns: [
        { kind: 'tool', name: 'exec', args: { cmd: 'echo 内置照常' } },
        { kind: 'text', text: '好' },
      ],
      config: {
        mcp: { servers: { broken: { command: '/nonexistent/mcp-server-for-u38' } } },
      },
      ...where(options),
    })

    const boot = await broken.capture({ label: '连不上：起手那一句' })
    ui.check(boot.text.includes('broken'), '连不上的那台服务器被点了名', '锚＝配置里的条目名')
    ui.check(boot.text.includes('连不上'), '起手那一行说了「连不上」', '锚＝装配的 notice 措辞')
    ui.check(
      boot.text.includes('外部工具服务器'),
      '那句话指着外部工具说的（不是别的告警）',
      '',
    )

    await broken.send('跑个内置的')
    // 内置那件是**轻**的（`exec` 只读命令）⇒ 三键位（`y / a / n`，见 `COPY.decideHint`）
    await broken.key('enter', { until: { text: COPY.decideHint }, timeoutMs: 10_000 })
    await broken.send('y', { until: { text: TOOL_DONE }, timeoutMs: 10_000 })
    const ran = await broken.capture({ label: '内置工具照常' })
    ui.check(
      ran.lines.some((line) => line.includes(TOOL_DONE) && line.includes('内置照常')),
      '单连接失败不拖垮内置工具（内置那件照跑）',
      `锚＝结果行「${TOOL_DONE} … · 内置照常」`,
    )
    await broken.close()

    // —— 第三幕：**服务器自己还带了一层**（普通后代）——
    //
    // 独立验收的固定反例：假服务器 `spawn('/bin/sleep')` 之后再正常退出，那一层会不会
    // 成为孤儿。这里看的是**入口退出**那条路：应用自己退场（走 `finally` 里的收尾），
    // 整棵自有子树都得跟着走。
    const grandLog = join(dir, 'nested.jsonl')
    const descended = await ui.open({
      label: '场景7-带后代',
      columns: 100,
      rows: 24,
      turns: [{ kind: 'tool', name: 'mcp__nested__boom', args: {} }],
      config: {
        mcp: {
          servers: {
            nested: {
              command: process.execPath,
              args: [FAKE_MCP_SERVER],
              env: { FAKE_MCP_MODE: 'descendants', FAKE_MCP_LOG: grandLog, FAKE_MCP_NAME: 'nested' },
            },
          },
        },
      },
      ...where(options),
    })

    // ⚠️ **先把这一轮点起来，再去数那一层**（U48 第六段改的次序，判据一个字没动）：
    //
    // 同一台服务器现在会被拉起**两次**——管理者的**预检**一次（连接 → 报状态 → 断开，
    // 探针，**不供会话使用**），执行者的**工具连接**一次（随会话存续）。判据要的是
    // **后者**：只有它才随会话存续、才该跟着服务器一起被收。而执行者要等这一轮真发出去
    // 才存在（空白启动页没有会话、没有执行者），故「先发一句、再数」。
    const already = countDescendants(grandLog) // 预检那一条（配了外部工具就必然有）
    await descended.send('把服务器弄崩')
    await descended.key('enter') // 提交——执行者由此起手，它的工具连接随之拉起那一层
    const grand = await waitForDescendant(grandLog, 8_000, already)
    ui.check(
      typeof grand === 'number' && isAlive(grand),
      '服务器自己拉起的那一层在跑（先确认它真起来了）',
      `pid ${grand}`,
    )

    // —— **服务器自己崩**（调用中途没了）——那一层**当场**就该被收 ——
    //
    // 这是独立复验退回的那一条的组合：崩过之后再 close，SDK 那侧已经没有 pid 可数了，
    // 故「数后代」必须发生在**它还活着的时候**（起手与每次调用之前），不能等收尾那一刻。
    await descended.wait({ text: 'y 批准这一次' }, { timeoutMs: 15_000 })
    await descended.send('y', { until: { text: '未收到结果' }, timeoutMs: 15_000 })

    await waitGone(grand as number)
    ui.check(
      !isAlive(grand as number),
      '服务器崩了之后：连它带起的那一层也没了（不等谁去 close）',
      `pid ${grand}`,
    )

    // 应用自己退场（收尾那一跳在 cli 的 finally 里）——空闲**按两次**才走（U46）。
    //
    // ⚠️ **先看它此刻闲不闲**：服务器崩了之后代理会**再试一次**，屏上往往又挂起一张卡
    //    （或这一轮还在跑）。那种时候 `ctrl+c` 是**中断**，不是退出的第一下（外壳的既有语义）。
    //    ⚠️ 反过来，**闲着的时候千万别先按那一下**——它会挂上「再按一次」，而被 `quit()`
    //    当成第二次 ⇒ 当场退出、等不到那一行（这条实测栽过）。
    const beforeQuit = await descended.screen()
    const text = beforeQuit.lines.map((line) => line.text).join('\n')
    if (!text.includes(HINT_IDLE)) {
      await descended.key('ctrl+c') // 中断这一轮（卡随之作废）
      await descended.wait({ absent: 'y 批准这一次' }, { timeoutMs: 15_000 }).catch(() => undefined)
    }

    await descended.quit()
    await descended.close({ graceMs: 3_000 })
    ui.check(!isAlive(grand as number), '应用退出后：那一层仍然不在', `pid ${grand}`)

    rmSync(dir, { recursive: true, force: true })
  },
}

/** 已经记进流水的后代个数——调用点据它「再数一层新的」（见 `waitForDescendant`）。 */
function countDescendants(log: string): number {
  return descendants(log).length
}

/**
 * 等**第 `beyond + 1` 个**后代出现（有界——夹具自己写，别无限等）；交回它的 pid。
 *
 * ⚠️ **为什么要 `beyond`**（U48 第六段）：同一台服务器会被拉起**两次**——管理者的
 * **预检**一次（连接 → 报状态 → 断开，探针）、执行者的**工具连接**一次（随会话存续）。
 * 判据要的是**后者**：只有它才该跟着服务器一起被收。而「取第一条」会拿到预检那条，
 * 那一条**按设计已经断开、早不在**了——不是收得不对，是问错了人。
 *
 * 流水里只有一行时（没配预检那条路）`beyond = 0`，与改之前一字不差。
 */
async function waitForDescendant(
  log: string,
  timeoutMs = 5_000,
  beyond = 0,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = descendants(log)
    if (found.length > beyond) return found[beyond]
    await Bun.sleep(50)
  }
  return undefined
}

/** 流水里记下的后代 pid（按写入序）。 */
function descendants(log: string): number[] {
  if (!existsSync(log)) return []

  const found: number[] = []
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as { kind?: string; pid?: number }
    if (entry.kind === 'child' && entry.pid !== undefined) found.push(entry.pid)
  }
  return found
}

/**
 * 等**服务器自己收到**某件工具再往下走——流水那一行是 `record()` 在 `CallTool` **入口**写的。
 *
 * ⚠️ **别拿屏上那句「运行中」当「已经在跑」**：工具行在**待裁决**那一刻就画出来了，
 * 那句话**卡还挂着时就在屏上**——实测它在 **0ms** 命中、字节水位与批准前**同一个数**
 * （通过趟与失败趟的步骤形状**完全一样**，对照见
 * `验证/D28甲-D29-20260922/开发/取消就绪条件-对照/`）。失败那趟的 `ctrl+c` 因此打在
 * 「还没开始跑」上：**服务端收到 `slow` 比它晚 3.3ms** ⇒ 取消落空，后一步等「已取消」超时。
 */
async function waitToolCalled(log: string, tool: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (mcpCalls(log).some((call) => call.tool === tool)) return
    await Bun.sleep(20)
  }

  throw new Error(`等服务器收到「${tool}」超时（${timeoutMs}ms）——流水 ${mcpCalls(log).length} 行`)
}

/** 服务器那边的调用流水（判据取它）。 */
function mcpCalls(log: string): readonly { readonly tool: string; readonly pid: number }[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { tool: string; pid: number })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(50)
}

// ═══════════════════════════════════════════════════════════════════════
// 八 · 外部审批的四个边角：窄窗 · 长参数 · 取消 · 断连
// ═══════════════════════════════════════════════════════════════════════

/** 长参数那一幕用的正文——够长到必须折行，且**每一段都可辨认**（看帧时对得上）。 */
const LONG_ARG = `第${'一'.repeat(1)}段：${'甲乙丙丁戊己庚辛壬癸'.repeat(6)}／第二段：${'①②③④⑤⑥⑦⑧⑨⑩'.repeat(3)}`

const mcpApprovalEdge: Scenario = {
  name: 'mcp-approval-edge',
  title: '外部审批的四个边角：窄窗 · 长参数 · 取消 · 断连（各留真帧）',
  anchors: 'U38 返工 B 的四项看帧：窄窗折行、长参数完整、取消只说已停止等待、断连说效果未知',
  story: async (ui, options) => {
    const dir = mkdtempSync(join(tmpdir(), 'magic-u38-edge-'))
    const log = join(dir, 'fake.jsonl')

    // 剧本按次序喂：长参数卡 → 答复 → 拖住（取消）→ 崩掉（断连）→ 收尾
    const turns: readonly FixtureTurn[] = [
      { kind: 'tool', name: 'mcp__fake__echo', args: { text: LONG_ARG } },
      { kind: 'text', text: '第一件完了' },
      { kind: 'tool', name: 'mcp__fake__slow', args: {} },
      { kind: 'tool', name: 'mcp__fake__boom', args: {} },
      { kind: 'text', text: '收工' },
    ]

    const session = await ui.open({
      label: '场景8-审批边角',
      columns: 100,
      rows: 30,
      turns,
      config: {
        mcp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [FAKE_MCP_SERVER],
              env: { FAKE_MCP_LOG: log, FAKE_MCP_NAME: 'fake', FAKE_MCP_MODE: 'fast' },
            },
          },
        },
      },
      ...where(options),
    })

    // —— 一 · 长参数：卡上给的是**完整**参数（不外省略号），折行之后仍读得下来 ——
    await session.send('来件参数长的')
    // ⚠️ **等草稿上屏再回车**（驱动的坑：`send` 只打字，回车抢在前面就会提交一个空草稿，
    // 后面的字全留在输入框里，卡永远不来）
    await session.wait({ text: '› 来件参数长的' }, { timeoutMs: 10_000 })
    await session.key('enter', { until: { text: 'y 批准这一次' }, timeoutMs: 15_000 })
    const longCard = await session.capture({ label: '长参数卡' })
    ui.check(longCard.text.includes('甲乙丙丁戊己庚辛壬癸'), '长参数在卡上（头一段在）', '')
    ui.check(longCard.text.includes('①②③④⑤⑥⑦⑧⑨⑩'), '长参数在卡上（末一段也在，没被截掉）', '')

    // —— 二 · 窄窗：同一张卡，窗宽收到 44 列 ——
    await session.resize(44, 24)
    await session.wait({ text: 'y 批准这一次' }, { timeoutMs: 15_000 })
    const narrow = await session.capture({ label: '窄窗里的卡' })
    ui.check(narrow.columns === 44, 'VT 认了 44 列', `实际 ${narrow.columns}`)

    // 批准掉这一件（免得它一直挂着）——窄窗下的键位照旧可用
    await session.send('y', { until: { text: TOOL_DONE }, timeoutMs: 15_000 })
    const ran = await session.capture({ label: '长参数跑完' })
    ui.check(
      ran.lines.some((line) => line.includes(TOOL_DONE) && line.includes('第')),
      '长参数那件真跑完了（结果行）',
      `锚＝结果行「${TOOL_DONE} …」`,
    )

    // —— 三 · 取消：拖住的那件，批准之后按中断 ——
    // ⚠️ 每一步都**等回空闲**再走下一步：并排跑满测试时，抢在上一轮收尾之前敲回车
    // 会被当成「工作中插话」排队（实测：回车落在收尾那一下，卡姗姗来迟、判据超时）
    //
    // ⚠️ 等的是**状态那一格**（「○ 空闲」），不是右位那句键位提示（`HINT_IDLE`）：
    //    这一步已经在 44 列的窄窗里了，而状态行左半**这一版带着真正的会话标题**
    //    （U50 起首条交代落账后目录会回来一趟，见 `shell.ts` 的 `input.settled` 那一跳），
    //    标题一长，右位那句就按既有口径整段让位——拿它当条件会白等到超时（实测栽过）。
    await session.wait({ text: IDLE_STATE })
    await session.send('再来件拖住的')
    await session.wait({ text: '› 再来件拖住的' }, { timeoutMs: 10_000 })
    await session.key('enter', { until: { text: 'y 批准这一次' }, timeoutMs: 20_000 })
    await session.send('y')
    // 中断之前等两件**真发生过**的事：
    // ① **卡收了**（键位那一行不在）——那一下 `ctrl+c` 才是「中断」，不是「在卡上按了个键」；
    // ② **服务器自己收到了这一笔**（`waitToolCalled`；屏上那句「运行中」证明不了，注见它）。
    await session.wait({ absent: 'y 批准这一次' }, { timeoutMs: 10_000 })
    await waitToolCalled(log, 'slow')

    await session.send('\u0003') // ctrl+c：工作中＝中断
    await session.wait({ text: '已取消' }, { timeoutMs: 10_000 })
    const canceled = await session.capture({ label: '取消之后' })
    ui.check(canceled.text.includes('已取消'), '取消那一笔说「已取消」', '')
    ui.check(
      canceled.text.includes('取消不等于远端撤销'),
      '取消不声称远端撤销（只报已停止等待/已发取消请求）',
      '',
    )

    // —— 四 · 断连：服务器在途没了 ——
    await session.wait({ text: IDLE_STATE })
    await session.send('来件会崩的')
    await session.wait({ text: '› 来件会崩的' }, { timeoutMs: 10_000 })
    await session.key('enter', { until: { text: 'y 批准这一次' }, timeoutMs: 20_000 })
    await session.send('y')
    // 等**只此一处有**的那一整句：取消那一行的正文里也含「未收到结果」三个字
    // （「取消不等于远端撤销，未收到结果」），拿它当条件会**抓到前一张卡**
    await session.wait({ text: '未收到结果，远端可能已执行' }, { timeoutMs: 10_000 })
    const lost = await session.capture({ label: '断连之后' })
    // ⚠️ 逐**行**判（不判整段文本）：40 来列的窄窗里这句话会折行，`includes` 一折就断
    ui.check(
      lost.lines.some((line) => line.includes('未收到结果')) &&
        lost.lines.some((line) => line.includes('远端可能已执行')),
      '断连说「未收到结果，远端可能已执行」（效果未知）',
      '',
    )
    ui.check(
      lost.lines.some((line) => line.includes('请求发出之后连接断了')),
      '缘由说人话（不是 SDK 那串 `MCP error -32000`）',
      '',
    )

    // —— 收尾：空闲再取一帧（键位与状态行都回到常态）——
    await session.wait({ text: IDLE_STATE }, { timeoutMs: 20_000 })
    await session.capture({ label: '收尾' })

    rmSync(dir, { recursive: true, force: true })
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 九 · 下划线开头的合法工具名（返工 C）
// ═══════════════════════════════════════════════════════════════════════

const mcpUnderscoreName: Scenario = {
  name: 'mcp-underscore-name',
  title: '下划线开头的合法工具名：进得了模型工具表，也真调得动',
  anchors: 'U38 返工 C 的固定反例：官方口径只要求字符集（字母/数字/下划线/连字符/点），不要求首字符',
  story: async (ui, options) => {
    const dir = mkdtempSync(join(tmpdir(), 'magic-u38-under-'))
    const log = join(dir, 'fake.jsonl')

    const session = await ui.open({
      label: '场景9-下划线工具名',
      columns: 100,
      rows: 30,
      // 模型**自己**点了那个下划线开头的工具——它没进工具表的话，这一件根本调不动
      turns: [
        { kind: 'tool', name: 'mcp__fake___echo', args: { text: '下划线也调得到' } },
        { kind: 'text', text: '好' },
      ],
      config: {
        mcp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [FAKE_MCP_SERVER],
              env: { FAKE_MCP_LOG: log, FAKE_MCP_NAME: 'fake', FAKE_MCP_MODE: 'under' },
            },
          },
        },
      },
      ...where(options),
    })

    await session.send('调那个下划线开头的')
    await session.wait({ text: '› 调那个下划线开头的' }, { timeoutMs: 10_000 })
    await session.key('enter', { until: { text: 'y 批准这一次' }, timeoutMs: 20_000 })
    const card = await session.capture({ label: '下划线工具的审批卡' })

    ui.check(card.text.includes('fake / _echo'), '卡上点名 `服务器 / 工具`（名字带下划线）', '')
    await session.send('y', { until: { text: TOOL_DONE }, timeoutMs: 20_000 })

    const ran = await session.capture({ label: '下划线工具跑完' })
    ui.check(
      ran.lines.some((line) => line.includes(TOOL_DONE) && line.includes('下划线也调得到')),
      '结果行＝完成标记 ＋ 服务器回的那串字（真调到了）',
      `锚＝结果行「${TOOL_DONE} … · 下划线也调得到」`,
    )
    // 服务器自己数的数：这一件真的被调了一次（不是「未注册的工具」那种答复）
    ui.check(mcpCalls(log).length === 1, '服务器自己数到了这一件', `日志 ${mcpCalls(log).length} 行`)

    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    await session.capture({ label: '收尾' })

    rmSync(dir, { recursive: true, force: true })
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 四 · 故意等不到：结构化失败 ＋ 现场完整 ＋ 清场
// ═══════════════════════════════════════════════════════════════════════

const missingTextFailure: Scenario = {
  name: 'missing-text-failure',
  title: '等一句永远不来的字：结构化失败 ＋ 现场完整 ＋ 清场',
  anchors: '首批验收场景 4：故意等待不存在的文字——非零退出或结构化失败、失败现场完整、自有进程与端口已释放',
  story: async (ui, options) => {
    const session = await ui.open({
      label: '场景4-故意等不到',
      columns: 100,
      rows: 24,
      turns: [{ kind: 'text', text: '收到' }],
      ...where(options),
    })
    const { runDir, fixturePort } = session.facts()

    let failure: unknown
    try {
      await session.wait({ text: '这句话永远不会有' }, { timeoutMs: 900 })
    } catch (error) {
      failure = error
    }

    ui.check(failure instanceof UiWaitTimeout, '超时给的是结构化失败', String(failure))
    const timeout = failure as UiWaitTimeout
    const awaited = timeout.condition
    ui.check(
      'text' in awaited && awaited.text === '这句话永远不会有',
      '失败里带着**等的是什么**',
      JSON.stringify(awaited),
    )
    ui.check(
      timeout.elapsedMs >= 900 && timeout.elapsedMs < 3_000,
      '超时**有界**（不是无限等）',
      `等了 ${Math.round(timeout.elapsedMs)}ms，上限 900ms`,
    )
    ui.check(
      timeout.screen.some((line) => line.trim() !== ''),
      '失败里带着「最后屏幕上是什么」',
      '',
    )
    ui.check(timeout.frameStep > 0, '失败**当场**留了一帧', `第 ${timeout.frameStep} 步`)
    ui.check(existsSync(join(runDir, 'frames')), '帧目录在（含这一帧）', '')

    const info = readJson(join(runDir, 'run.json')) as {
      outcome?: string
      failure?: { kind?: string }
      fixture?: { port?: number } | null
    }
    ui.check(info.outcome === 'failed', 'run.json 记下了这趟是失败的', String(info.outcome))
    ui.check(info.failure?.kind === 'timeout', '失败缘由是 timeout（不是含糊的「出错了」）', '')

    // —— 清场：应用、端点都得真没了，产物得在 ——
    const report = await session.close()
    ui.check(report.exit.code !== null || report.exit.signal !== null, '应用已经收摊', JSON.stringify(report.exit))

    let alive = true
    try {
      process.kill(session.pid, 0)
    } catch {
      alive = false
    }
    ui.check(!alive, '自有应用确实没了', `pid ${session.pid}`)

    let reachable = true
    try {
      await fetch(`http://127.0.0.1:${fixturePort as number}/v1/models`)
    } catch {
      reachable = false
    }
    ui.check(!reachable, '自有 HTTP 端点确实没了', `端口 ${fixturePort}`)

    ui.check(existsSync(report.viewer), '产物仍在（查看页可开）', report.viewer)
    ui.check(existsSync(join(runDir, 'raw.bin')), '原始字节仍在', '')
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 五 · 一轮多次操作，现场保持
// ═══════════════════════════════════════════════════════════════════════

const assistantAcrossCalls: Scenario = {
  name: 'assistant-across-calls',
  title: '输入 → 取帧 → 调窗 → 再输入 → 再取帧：同一 PID、现场保持',
  anchors: '首批验收场景 5：助手入口跨多次独立调用完成「输入→取帧→调整窗口→再输入→再取帧」，同一应用 PID/现场保持',
  story: async (ui, options) => {
    const session = await ui.open({
      label: '场景5-多次操作一现场',
      columns: 100,
      rows: 30,
      turns: [
        { kind: 'text', text: '第一答' },
        { kind: 'text', text: '第二答' },
      ],
      ...where(options),
    })
    const facts = session.facts()

    await session.send('第一件')
    await session.wait({ text: '› 第一件' })
    await session.key('enter', { until: { text: '第一答' } })
    const one = await session.capture({ label: '第一帧' })
    ui.check(session.pid === facts.pid, '取帧之后还是同一个进程', `pid ${facts.pid}`)

    // 判据同场景 1：等**应用自己**按新宽度画出过一帧，不是屏上凑巧有个 70 个横线
    await session.resize(70, 18)
    await session.wait({ writtenFrame: 70 })
    const two = await session.capture({ label: '调窗之后' })
    ui.check(two.columns === 70 && two.rows === 18, '窗口真变了', `${two.columns}×${two.rows}`)
    ui.check(one.step < two.step, '两帧落在不同的步上（时间线读得出来）', `第 ${one.step} → 第 ${two.step} 步`)

    await session.send('第二件')
    await session.wait({ text: '› 第二件' })
    await session.key('enter', { until: { text: '第二答' } })
    const three = await session.capture({ label: '第二帧' })
    ui.check(session.pid === facts.pid, '一轮走完仍是同一个进程（没重启过）', '')
    ui.check(session.runDir === facts.runDir, '还是同一份现场目录', '')
    ui.check(three.text.includes('第一答'), '前一件的痕迹还在（现场没被清掉）', '')
    ui.check(three.text.includes('第二答'), '后一件也落了屏', '')

    const requests = session.requests()
    ui.check(requests.length === 2, '两次交代各走了一趟模型', `实际 ${requests.length} 趟`)

    const after = session.facts()
    ui.check(after.fixturePort === facts.fixturePort, '端点自始至终是同一个', `端口 ${facts.fixturePort}`)
    ui.check(after.home === facts.home, '家目录自始至终是同一个', '')
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 六 · 连续两次 ＋ 两个并行
// ═══════════════════════════════════════════════════════════════════════

const isolationRepeatParallel: Scenario = {
  name: 'isolation-repeat-parallel',
  title: '连续两次 ＋ 两个并行：配置 / 端口 / 记录 / 产物互不串用',
  anchors: '首批验收场景 6：同一场景连续运行两次及两个实例并行，配置、端口、记录、产物互不串用',
  story: async (ui, options) => {
    const once = async (label: string, ask: string, answer: string): Promise<UiSession> => {
      const session = await ui.open({
        label,
        columns: 90,
        rows: 24,
        turns: [{ kind: 'text', text: answer }],
        ...where(options),
      })
      await session.send(ask)
      await session.wait({ text: `› ${ask}` })
      await session.key('enter', { until: { text: answer } })

      return session
    }

    // —— 连续两次 ——
    const first = await once('场景6-第一次', '第一趟', '答第一趟')
    const firstShot = await first.capture({ label: '第一次' })
    const firstFacts = first.facts()

    const second = await once('场景6-第二次', '第二趟', '答第二趟')
    const secondShot = await second.capture({ label: '第二次' })
    const secondFacts = second.facts()

    ui.check(firstFacts.runDir !== secondFacts.runDir, '两次运行各是各的产物目录', '')
    ui.check(
      firstFacts.fixturePort !== secondFacts.fixturePort,
      '两次运行各是各的端口',
      `${firstFacts.fixturePort} / ${secondFacts.fixturePort}`,
    )
    ui.check(firstFacts.home !== secondFacts.home, '两次运行各是各的家目录（配置与授权不串）', '')
    ui.check(firstFacts.dataDir !== secondFacts.dataDir, '两次运行各是各的记录库', '')
    ui.check(!secondShot.text.includes('答第一趟'), '第二次的屏上没有第一趟的痕迹', '')
    ui.check(secondShot.text.includes('答第二趟'), '第二次拿到的是自己那一份答复', '')
    ui.check(!firstShot.text.includes('答第二趟'), '第一次也没沾上第二趟', '')
    ui.check(
      existsSync(join(firstFacts.runDir, 'run.json')) && existsSync(join(secondFacts.runDir, 'run.json')),
      '两趟的现场都留着（没互相覆盖）',
      '',
    )

    // —— 并行两个 ——
    const [left, right] = await Promise.all([
      once('场景6-并行A', '并行甲', '答并行甲'),
      once('场景6-并行B', '并行乙', '答并行乙'),
    ])
    const leftFacts = left.facts()
    const rightFacts = right.facts()
    const leftShot = await left.capture({ label: '并行 A' })
    const rightShot = await right.capture({ label: '并行 B' })

    ui.check(leftFacts.pid !== rightFacts.pid, '并行两个是两个进程', `${leftFacts.pid} / ${rightFacts.pid}`)
    ui.check(
      leftFacts.fixturePort !== rightFacts.fixturePort,
      '并行两个各自一个端口',
      `${leftFacts.fixturePort} / ${rightFacts.fixturePort}`,
    )
    ui.check(leftFacts.runDir !== rightFacts.runDir, '并行两个各自一份产物', '')
    ui.check(leftShot.text.includes('答并行甲'), 'A 拿到自己的答复', '')
    ui.check(!leftShot.text.includes('答并行乙'), 'A 的屏上没有 B 的答复', '')
    ui.check(rightShot.text.includes('答并行乙'), 'B 拿到自己的答复', '')
    ui.check(!rightShot.text.includes('答并行甲'), 'B 的屏上没有 A 的答复', '')
  },
}

// ═══════════════════════════════════════════════════════════════════════
// 零件
// ═══════════════════════════════════════════════════════════════════════

/**
 * 直读记录库里的**工具结果**——「结果真到了」不靠屏上的字、也不靠模型之后复述。
 *
 * 库里那一条的载荷是 `{ok, output:{text}}`（记录域写的，见 `smoke.test.ts` 同款读法）。
 * 应用还在跑，故以**只读**打开（WAL 下并发读是安全的）。
 */
function toolResultsOf(session: UiSession): readonly { readonly ok: boolean; readonly text: string }[] {
  const db = readDatabase(join(session.facts().dataDir, 'records.db'))

  try {
    return db.entries
      .filter((entry) => entry.kind === 'tool-result')
      .map((entry) => {
        const payload = JSON.parse(entry.payload ?? '{}') as { ok?: boolean; output?: { text?: string } }

        return { ok: payload.ok === true, text: payload.output?.text ?? '' }
      })
  } finally {
    db.close()
  }
}

/**
 * 等那条结果**落进库**（顺带把它交回去）——屏上出现与落库是两条路，中间有个小缝。
 *
 * 有界：`timeoutMs` 到了就把当下这一份交回去（判据自己去红，不在这儿空等）。
 */
async function awaitToolResult(
  session: UiSession,
  needle: string,
  timeoutMs = 3_000,
): Promise<readonly { readonly ok: boolean; readonly text: string }[]> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const results = toolResultsOf(session)
    if (results.some((result) => result.ok && result.text.includes(needle))) return results
    if (Date.now() > deadline) return results
    await Bun.sleep(50)
  }
}

/** 六组场景的表——用例与命令行都从这儿取。 */
// ═══════════════════════════════════════════════════════════════════════
// 十 · 停止（U50）：停止不是回滚
// ═══════════════════════════════════════════════════════════════════════

/**
 * **停止不是回滚**（U50 · 设计「离开、停止与异常退出」末段与工单的验收）。
 *
 * > 停止**不是回滚**；已经发生的文件修改和远端操作**不能说成撤销**。
 *
 * 这一场造的是**真的改过东西**再停：模型那一头先让 `write` 工具**真写一个文件**
 * （走真闸门 → 真裁决卡 → 批准 → 真落盘），随后是一段长回话；趁着它还在长，从
 * `/resume` 里把这条运行停掉。判据三条：
 *
 * 1. 那个文件**原样还在**（停止没有把已经发生的事抹掉）；
 * 2. 屏上（含原始字节）**没有一句话**说「撤销 / 回滚 / 恢复」；
 * 3. 停本身是**真的**（回执说「停了」，且那一行落了定）。
 */
const stopNotRollback: Scenario = {
  name: 'stop-not-rollback',
  title: '停止不是回滚 —— 真改过文件再停，产物原样在，没有一句话说撤销',
  anchors: 'U50 验收「停止不是回滚」：造一次已经改过文件的停止，确认记录与回执不谎称撤销',
  story: async (ui, options) => {
    const written = '这一份是停止之前写下的'
    const streamed = '停我看看：这一句会一直长下去，长到按停为止。'

    const session = await ui.open({
      label: 'U50-停止不是回滚',
      columns: 100,
      rows: 30,
      turns: [
        // ① 先**真写一个文件**（write 是必闸：整文件覆盖要问）
        { kind: 'tool', name: 'write', args: { path: '产物.txt', content: written } },
        // ② 再是一段长回话——停就停在这上头（块多、块间慢：停下来要有东西可停）
        { kind: 'text', text: streamed, chunks: 60, chunkDelayMs: 400 },
      ],
      ...where(options),
    })

    // —— 真改一次东西 ——
    await session.send('改点东西')
    // 锚**状态行那句「等你定夺」**，不锚键位提示——`write` 必闸那一档的键位是
    // 「y / n」（轻的那一档才是 `y / a / n`），拿 `decideHint` 当条件会白等到超时（实测栽过）
    await session.key('enter', { until: { text: '等你定夺' }, timeoutMs: 15_000 })
    const card = await session.capture({ label: '裁决卡' })
    ui.check(card.text.includes('write'), '裁决卡点名了要调用的工具', card.text.slice(0, 400))

    await session.send('y', { until: { text: TOOL_DONE }, timeoutMs: 15_000 })
    const artifact = join(session.facts().workspace, '产物.txt')
    ui.check(existsSync(artifact), '那一笔真写下去了（停止之前，文件已经在）', artifact)

    // —— 长回话跑起来，然后**把它停掉** ——
    await session.wait({ text: '停我看看' }, { timeoutMs: 25_000 })

    // 从列表里停：`/resume` 开抽屉 → `ctrl+x` 停选中的那一条
    // ⚠️ 锚**那一行上的停止键**（它只在「抽屉开着 ＋ 选中那一条真能停」时才有）——
    //    拿别处的字当条件容易当场恒真（`/resume` 三个字本来就该打上去）
    await session.send('/resume')
    await session.key('enter', { until: { text: 'ctrl+x 停' }, timeoutMs: 15_000 })
    await session.key('ctrl+x')
    await session.wait({ text: '停了' }, { timeoutMs: 25_000 })
    // 那一行落了定（运行事实是推来的：等**那一行**读得出「已停止」）
    await waitScreen(session, (lines) => lines.some((line) => line.includes('已停止')), 20_000)

    const stopped = await session.capture({ label: '停了之后' })
    ui.check(
      stopped.lines.some((line) => line.includes('停了')),
      '停止的回执在（这一下是真停）',
      stopped.text.slice(0, 400),
    )

    // **那一屏不自相矛盾**（U54 · 缺陷 D34）——`/resume` 里 `ctrl+x` 停的正是**本窗这条**
    // 会话：执行者退场之后没人再报 `turn.end`，故从前那一格会一直写着「● 工作中」，
    // 与上面那句「停了」摆在同一屏上打架。修法是那一格改读管理者推的运行事实（`withRunFacts`）。
    //
    // ⚠️ 判据落在**状态行那一格**上（`statusLineOf`），不是全屏找那几个字：输入行那句占位
    //    「（工作中——想插话可以打…）」与列表详情里都可能出现同一个词。
    const status = statusLineOf(stopped.lines)
    ui.check(!status.includes('工作中'), '停完之后**状态行那一格不再写着「工作中」**', status)
    ui.check(status.includes(IDLE_STATE), '它收成了那一档：此刻没在跑（不是刚发生的那件事）', status)

    // —— 三条判据 ——
    ui.check(existsSync(artifact), '产物文件在停止之后仍然在', artifact)
    if (existsSync(artifact)) {
      ui.check(
        readFileSync(artifact, 'utf8') === written,
        '它的内容**一字没动**（停止没有把它抹掉、也没有写回去）',
        `实读：${readFileSync(artifact, 'utf8')}`,
      )
    }
    ui.check(
      !/撤销|回滚|恢复原状/u.test(session.rawText()),
      '**没有一句话**说「已经发生的被撤销了」',
      '（停止不是回滚：记录与回执都不谎称撤销）',
    )
  },
}

/**
 * **U52 · `/exit`**——「**停掉当前这条会话，资源确认退出之后**才退界面」。
 *
 * 三条判据各对工单里的一句话（判据名照抄工单，好对账）：
 *
 * - **一次就走**——敲一次回车就走，不按两次、也不要「再确认一次」；
 * - **等了再退**——回执**先「正在停」、后「停了」**：「受理」不是「停了」，
 *   而界面只在**后一拍**才收摊（设计：「**资源确认退出后**才报已停止」）；
 * - **点了名**——回执带的是**这条会话的名字**，不是「停了一个东西」。
 *
 * ⚠️ **还有一条是实测栽过才加上来的**：整批回执**只印一遍**。收摊若落在「写出去那几行」
 * 所属的**同一趟**重绘里，Ink 会把刚写出去的静态行**再写一遍**——真 PTY 上看得明明白白：
 * 那四条回执上下各一份（U52 开发时踩到，改法是**收摊挪到下一拍**，见 `app.ts` 那一处
 * `setTimeout`）。判据钉住它，免得哪一改又长回来。
 *
 * 两条路各走一趟：**空闲**（会话在、没在跑）与**工作中**（这一轮正长着）——
 * 后者钉的是「**不等这一轮**」：那一轮不会跑完，流式正文停在半截。
 */
const exitCommand: Scenario = {
  name: 'exit-command',
  title: '`/exit`：停掉这条会话再退出（一次就走 · 等了再退 · 回执只印一遍）',
  anchors: 'U52 验收：`/exit` 一次就走；资源确认退出之后才退界面；回执点名且不重印',
  story: async (ui, options) => {
    // —— ① 空闲：会话在、这一轮早跑完了 ——
    const session = await ui.open({
      label: 'U52-exit-空闲',
      columns: 100,
      rows: 30,
      turns: [{ kind: 'text', text: '收到，我在。', chunks: 2, chunkDelayMs: 120 }],
      ...where(options),
    })

    // ⚠️ **写一次、等这一下生效**（工单「界面验收工具」那处糖）。正文与回车仍**分两次写**
    //    （见 `driver.ts` 文件头注 2）——挤一块从 U56 起也走得通，但常态动作照旧是两下。
    //    锚带**前导空格**＝只认输入行那一格。
    await session.send('你好', { until: { text: ' › 你好' }, timeoutMs: 15_000 })
    await session.key('enter')
    await session.wait({ text: '收到，我在。' }, { timeoutMs: 25_000 })
    // 等**状态行那一格**闲下来（锚 `HINT_IDLE` 会量成窗口宽度，见 `IDLE_STATE` 那段注）
    await session.wait({ text: IDLE_STATE }, { timeoutMs: 20_000 })

    // ⚠️ **写一次、等这一下生效**（工单「界面验收工具」那处糖，也是踩出来的）：
    //    这一句写下去要等它真上了屏再敲回车——不然锚 `› /exit` 还没出现，回车就发出去了。
    //    （当年另有一层原因：回车与正文挤进同一读块会丢；那一条是 D35，U56 已修，
    //    正面那一形改由本文件的 `packed-enter` 钉着。）
    //    锚 `› /exit`（**前导空格**：那是输入行那一格）——候选那一行是
    //    `› /exit　停掉…`，**不带前导空格**，故这个锚只认输入行。
    await session.send('/exit', { until: { text: ' › /exit' }, timeoutMs: 15_000 })
    await session.key('enter')

    // **两拍都得在**：先「正在停」（受理），后「停了」（核销）
    await session.wait({ text: '正在停' }, { timeoutMs: 15_000 })
    await session.wait({ text: '停了' }, { timeoutMs: 25_000 })

    const leaving = await session.capture({ label: '空闲敲 /exit 之后' })
    const report = await session.close({ graceMs: 3_000 })

    ui.check(
      report.exit.by === 'app',
      '`/exit` 让应用自己退了场（不是我们杀的）',
      `退出缘由 ${report.exit.by}`,
    )
    ui.check(report.exit.code === 0, '退出码是 0（与关窗那条路一致）', `实际 ${report.exit.code}`)

    const said = leaving.lines
    ui.check(
      said.filter((line) => line.includes('正在停')).length === 1,
      '「正在停」那一句只印了一遍',
      `实际 ${said.filter((line) => line.includes('正在停')).length} 遍`,
    )
    ui.check(
      said.filter((line) => line.includes('停了')).length === 1,
      '「停了」那一句只印了一遍',
      `实际 ${said.filter((line) => line.includes('停了')).length} 遍`,
    )
    ui.check(
      said.some((line) => line.includes('正在停')),
      '回执**点了名**（说得出停的是哪一条）',
      said.filter((line) => line.includes('· ')).join(' / '),
    )
    ui.check(
      !said.some((line) => line.includes(HINT_EXIT_ARMED)),
      '**没有**冒 Ctrl+C 那一行（那是另一个键的门）',
      '（`/exit` 不挂「再按一次」那道门）',
    )

    // —— ② 工作中：这一轮正长着，敲 `/exit` ——
    const tail = '这一句是最后一截，跑到这儿就说明那一轮跑完了。'
    const busy = await ui.open({
      label: 'U52-exit-工作中',
      columns: 100,
      rows: 30,
      turns: [{ kind: 'text', text: `正文先长一会儿。${tail}`, chunks: 40, chunkDelayMs: 400 }],
      ...where(options),
    })

    await busy.send('说一句长话', { until: { text: ' › 说一句长话' }, timeoutMs: 15_000 })
    // 锚状态行那句「ctrl+c 中断」＝**这一轮真在跑**（它在工作中那一格才出现）
    await busy.key('enter', { until: { text: 'ctrl+c 中断' }, timeoutMs: 25_000 })

    await busy.send('/exit', { until: { text: ' › /exit' }, timeoutMs: 15_000 })
    await busy.key('enter')
    await busy.wait({ text: '停了' }, { timeoutMs: 30_000 })

    const mid = await busy.capture({ label: '工作中敲 /exit 之后' })
    const busyReport = await busy.close({ graceMs: 3_000 })

    ui.check(
      busyReport.exit.by === 'app',
      '工作中敲 `/exit` 也是应用自己退了场',
      `退出缘由 ${busyReport.exit.by}`,
    )
    ui.check(
      busyReport.exit.code === 0,
      '工作中敲 `/exit` 退出码也是 0',
      `实际 ${busyReport.exit.code}`,
    )
    // **不等这一轮**：那一轮没跑完，尾巴那一截始终没上屏
    ui.check(
      !mid.text.includes(tail),
      '那一轮**没有等它跑完**（尾巴那一截没上屏）',
      '（`/exit` 停的是这条会话，不是「跑完再走」）',
    )
    ui.check(
      mid.lines.some((line) => line.includes('停了')),
      '工作中的回执也说清了「停了」',
      mid.lines.filter((line) => line.includes('· ')).join(' / '),
    )

    // **那一屏不自相矛盾**（U54 · 缺陷 D34 的现场就是这一帧）——`/exit` 走的是**整体**那一档：
    // 执行者退场之后没人再报 `turn.end`，故从前那一格会一直写着「● 工作中」，与上面那句
    // 「停了」摆在同一屏上打架。⚠️ 这一帧**看得见**（U52 的回报当初记成「紧接着就退、看不见」，
    // 不对），故判据照样钉在这儿。
    const leavingStatus = statusLineOf(mid.lines)
    ui.check(!leavingStatus.includes('工作中'), '`/exit` 停完那一格不再写着「工作中」', leavingStatus)
    ui.check(leavingStatus.includes(IDLE_STATE), '它收成了那一档：此刻没在跑', leavingStatus)
  },
}

/**
 * **D35 · 正文与回车挤进同一个读块时，回车要有**——正反两面各钉住。
 *
 * ## 这一场为什么必须用**一次写**
 *
 * 驱动那边 `send()` 与 `key('enter')` 是**两次写**（`driver.ts` 文件头注 2 的老绕法），
 * 于是这一形从来照不到。而真 PTY 实测：**六次写、每字一次、间隔 0ms**，仍然并成同一个
 * `/exit\r` 读块——**合块与终端的写边界无关**，只取决于应用读得快不快（「App 正忙、
 * 敲完立刻回车」正是它）。故这里的「一次 `send`」与真终端里那一形**同源**。
 *
 * ## 反面比正面要紧
 *
 * 认回来的条件只有三条（`trailingEnterOf`）：末尾是 `\r` · 块里 `\r` 只这一个 · 块里没有 `\n`。
 * 这一场把「**粘贴的多行**」两种来路都钉住：**裸多行块**（终端不认 bracketed paste 时的样子）
 * 与**真 bracketed 粘贴**——都不许被切碎，也不许被当成交付发出去。
 */
const packedEnter: Scenario = {
  name: 'packed-enter',
  title: '正文与回车挤进同一个读块：那一按要作数（D35），粘贴的多行不许被切碎',
  anchors: 'U56 验收：一次写「正文＋回车」就提交；裸多行块与 bracketed 粘贴都原样进草稿',
  story: async (ui, options) => {
    // —— ① 正面：正文与回车挤进同一个读块 ——
    const session = await ui.open({
      label: 'U56-挤块-正面',
      columns: 100,
      rows: 30,
      turns: [{ kind: 'text', text: '收到，我在。', chunks: 2, chunkDelayMs: 60 }],
      ...where(options),
    })

    // 一次写：正文与回车同块——**修前这一下什么都不发生**（回车当场没有）
    await session.send('你好\r', { until: { text: '收到，我在。' }, timeoutMs: 25_000 })

    const sent = session.requests()
    ui.check(sent.length === 1, '一次写「正文＋回车」**提交了**（模型那头收到一条）', `实际 ${sent.length} 条`)
    ui.check(
      sent[0]?.lastUser === '你好',
      '提交出去的正文就是那一句（回车没被当成一个正文字符塞进去）',
      `实际 ${JSON.stringify(sent[0]?.lastUser)}`,
    )

    // 同一形再走一遍产品里最要紧的那条命令：`/exit` ——**一次写**，那一按要作数
    await session.send('/exit\r', { until: { text: '停了' }, timeoutMs: 30_000 })
    const leaving = await session.capture({ label: '一次写 /exit\\r 之后' })
    const report = await session.close({ graceMs: 3_000 })

    ui.check(
      leaving.lines.some((line) => line.includes('停了')),
      '一次写 `/exit\\r`：**停到「停了」那一拍**（回执落了记录区）',
      leaving.lines.filter((line) => line.includes('· ')).join(' / '),
    )
    ui.check(
      report.exit.by === 'app',
      '一次写 `/exit\\r`：应用**自己退了场**（不是我们杀的）',
      `退出缘由 ${report.exit.by}`,
    )
    ui.check(report.exit.code === 0, '退出码是 0', `实际 ${report.exit.code}`)

    // —— ② 反面一：**裸多行块**（终端不认 bracketed paste 时，粘贴就是这样落进来的）——
    const raw = await ui.open({
      label: 'U56-挤块-裸多行',
      columns: 100,
      rows: 30,
      turns: [{ kind: 'text', text: '收到，我在。' }],
      ...where(options),
    })

    // 一次写一整段带换行的正文：三行，末尾还带一个换行
    await raw.send('第一行\n第二行\n第三行\n', { until: { text: '第三行' }, timeoutMs: 20_000 })
    // 一段「CR 结尾的多行」——末尾虽然只有一个 `\r`，块里还有一个 ⇒ 也不许认
    await raw.send('甲\r乙\r', { until: { text: '› ' }, timeoutMs: 20_000 })
    // 普通多字符（一次写）：照旧是正文，不提交
    await raw.send('正文', { until: { text: '正文' }, timeoutMs: 20_000 })
    // 裸 LF ＝ `shift+回车` 的换行——**这条规矩一个字没动**
    await raw.send('\n', { until: { text: '正文' }, timeoutMs: 20_000 })

    const rawShot = await raw.capture({ label: '裸多行块 ＋ CR 多行 ＋ 普通正文' })
    const rawReport = await raw.close({ graceMs: 2_000 })

    ui.check(
      raw.requests().length === 0,
      '**裸多行块一次也没提交**（粘贴的多行不是「提交」）',
      `实际 ${raw.requests().length} 条请求`,
    )
    ui.check(
      rawShot.lines.some((line) => line.includes('第三行')),
      '那一整段**原样在草稿里**（三行都在，没被切碎）',
      rawShot.lines.filter((line) => line.includes('行')).join(' / '),
    )
    ui.check(rawReport.exit.by === 'sigterm', '反面那一场是我们收的场（它自己没走）', rawReport.exit.by)

    // —— ③ 反面二：**真 bracketed 粘贴**（marker 那一对字节）——
    const paste = await ui.open({
      label: 'U56-挤块-bracketed',
      columns: 100,
      rows: 30,
      turns: [{ kind: 'text', text: '收到，我在。', chunks: 2, chunkDelayMs: 60 }],
      ...where(options),
    })

    await paste.send('\u001B[200~粘贴的第一行\n粘贴的第二行\n\u001B[201~', {
      until: { text: '粘贴的第一行' },
      timeoutMs: 20_000,
    })
    await paste.wait({ text: '粘贴的第二行' }, { timeoutMs: 20_000 })

    ui.check(
      paste.requests().length === 0,
      'bracketed 粘贴**不提交**（它走的是另一条信道，不是「按了一下回车」）',
      `实际 ${paste.requests().length} 条请求`,
    )

    // 粘贴之后**紧跟**一次回车（另一次写）⇒ 该提交，交出去的必须**一个字不差**
    await paste.send('\r', { until: { text: '收到，我在。' }, timeoutMs: 25_000 })

    const pasted = paste.requests()
    ui.check(pasted.length === 1, '粘贴之后敲回车：提交了一次', `实际 ${pasted.length} 条`)
    ui.check(
      pasted[0]?.lastUser === '粘贴的第一行\n粘贴的第二行',
      '**粘贴的多行原样交给了模型**（换行还在、一个字没切）',
      `实际 ${JSON.stringify(pasted[0]?.lastUser)}`,
    )

    await paste.close({ graceMs: 2_000 })
  },
}

/** 等一屏条件成立——场景里那几处「等效果」用它（轮询是用例的事）。 */
async function waitScreen(
  session: UiSession,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    if (ok(lines)) return
    if (Bun.nanoseconds() > until) {
      throw new Error(`等屏超时（${timeoutMs}ms）：\n${lines.join('\n')}`)
    }
    await Bun.sleep(40)
  }
}

export const SCENARIOS: readonly Scenario[] = [
  bootInputResizeExit,
  drawerOpenClose,
  modelStreamApproval,
  mcpApproval,
  mcpApprovalEdge,
  mcpUnderscoreName,
  missingTextFailure,
  assistantAcrossCalls,
  isolationRepeatParallel,
  stopNotRollback,
  exitCommand,
  packedEnter,
]

export function scenarioNames(): readonly ScenarioName[] {
  return SCENARIOS.map((scenario) => scenario.name)
}

/**
 * **已知未修**的判据登记——欠着没还的那几条，指名道姓。
 *
 * 为什么要有这张表：把「我们知道它坏、暂时不修」写成**机器可读**的一条，而不是靠人的记忆。
 * **它不掩盖**——判据照样跑、照样打印、照样进账，只是不拦门（原来一条判据不过就抛
 * `ScenarioFailure` 把整个场景掐断，连带后面的步骤一条都跑不到）。
 *
 * ⚠️ **它会自清理**：登记着的判据**一旦通过**，`ui.test.ts` 会当场把门判红，提醒摘掉登记。
 * 所以它是**待还的债，不是免死金牌**——别往里加「反正也不会好」的条目。
 *
 * 现只一条：改窗重排后旧帧擦不干净（库内 `缺陷/D27`）。
 */
const KNOWN_OPEN = new Map<string, KnownOpen>([
  [
    // ⚠️ 判据名 2026-09-24 随 U45 改（那时是「只画了一条分隔线」）：交互区下沿多了第二条线，
    //    数**它自己这一帧**该是两条——**欠的仍是同一笔账**（残影把读数顶得更多）。
    '窄窗稳定后一共只画了两条分隔线',
    {
      defect: 'D27',
      why:
        '改窗重排后旧帧擦不干净，是 Ink 擦除路径的缺陷（上游 issue 907 关了、不修）。' +
        '修它得给 Ink 打依赖补丁，而「不背自己改依赖的债」是明确裁决——挂起，等不碰依赖的修法。',
    },
  ],
  [
    '改窗之后用户消息只有一条（旧帧没留在屏上）',
    { defect: 'D27', why: '同上：旧帧擦不干净 ⇒ 屏上留下两份，本条与上面那条是同一个现象的两个侧面。' },
  ],
  [
    '改窗之后答复只有一条',
    { defect: 'D27', why: '同上：答复那一半的同一现象。' },
  ],
])

/**
 * 跑一组场景——**成功失败都交回一份结构化的账**。
 *
 * 会话由运行器统一收摊（`finally` 里倒序 close，失败也收）——故事只管演，
 * 不必自己兜异常；真要中途收，`session.close()` 幂等（可重复调用）。
 */
export async function runScenario(
  name: ScenarioName,
  options: ScenarioOptions = {},
): Promise<ScenarioResult> {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name)
  if (scenario === undefined) {
    throw new Error(`不认得的场景「${name}」——有的是：${scenarioNames().join(' / ')}`)
  }

  const checks: CheckOutcome[] = []
  const sessions: UiSession[] = []
  const ui: ScenarioContext = {
    check: (ok, what, detail = '') => {
      // 登记过的判据：红了也**不掐断场景**——后面那些步骤（清草稿、正常退出）与本条无关，
      // 掐断只是让这一整趟跑不到底；而登记本身在账上写得明明白白，不构成掩盖。
      const known = KNOWN_OPEN.get(what)
      const outcome: CheckOutcome = known === undefined ? { what, ok, detail } : { what, ok, detail, knownOpen: known }
      checks.push(outcome)
      options.onCheck?.(outcome)
      if (!ok && known === undefined) throw new ScenarioFailure(what, detail)
    },
    note: (line) => options.onNote?.(line),
    open: async (sessionOptions) => {
      const session = await createUiSession(sessionOptions)
      sessions.push(session)

      return session
    },
  }

  let failure: ScenarioResult['failure']
  let lastScreen: readonly string[] | undefined

  try {
    await scenario.story(ui, options)
  } catch (error) {
    failure =
      error instanceof ScenarioFailure
        ? { what: error.what, detail: error.detail }
        : { what: '（未分类的抛出）', detail: error instanceof Error ? error.message : String(error) }

    // 最后那一眼：故事里最后起的那个会话还开着的话，把它此刻的屏抄下来
    const alive = sessions.at(-1)
    if (alive !== undefined) {
      try {
        lastScreen = (await alive.screen()).lines.map((line) => line.text)
      } catch {
        lastScreen = undefined
      }
    }
  } finally {
    for (const session of [...sessions].reverse()) {
      try {
        await session.close()
      } catch {
        // 收摊失败不该盖掉真正的失败——现场目录已经在盘上了
      }
    }
  }

  const runDirs = sessions.map((session) => session.runDir)

  return {
    name: scenario.name,
    title: scenario.title,
    anchors: scenario.anchors,
    ok: failure === undefined,
    runDirs,
    viewers: runDirs.map((dir) => join(dir, 'viewer.html')).filter((path) => existsSync(path)),
    checks,
    ...(failure === undefined ? {} : { failure }),
    ...(lastScreen === undefined ? {} : { lastScreen }),
  }
}

// —— 零件 ——

/** 位置类选项（有则带上，没有就不塞 `undefined`——`exactOptionalPropertyTypes` 看着呢）。 */
function where(options: ScenarioOptions): { artifacts?: string; checkout?: string } {
  return {
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
  }
}

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`）。 */
const isRule = (line: string): boolean => /^─+$/u.test(line.trim())

/**
 * 一帧里那**两条**分隔线各自的行号（U45 起是两条，见 `separatorOf`）。
 *
 * - `top`——**记录区与交互区之间**那一条（记录区的顶边）；
 * - `bottom`——**输入区与状态行之间**那一条（U59 挪到这儿；U45 那会儿它在状态行**之下**）。
 *
 * ⚠️ **认它们靠「这一帧最后的两条」**（U59 改的；U45 那版认的是「最后一条，且它下面是空白」）：
 * 布局是 `… 记录区 → 上沿 → 交互区 → 下沿 → 状态行`，故这一帧的收尾就是那两条
 * ——**下沿下面还有状态行那一行**，正是 U45 那条旧判据（「它下面是空白」）不再成立的原因。
 * 照旧判据办的话，`top` 会取到下沿 ⇒ **整个交互区与状态行当场算进记录区**
 * （抽屉一开，「记录区」多出七八行；实测：空名录后 9 行 · 开抽屉后 16 行）。
 *
 * 只录了半屏（还没画到下沿，只有一条线）时 `bottom` 给 `-1`，那一条只能算顶边
 * ——与 U45 之前同一副面孔。改窗残影（旧分隔线还留在屏上，D27）落在**上面**，
 * 而这两条是**这一帧最后画的两条**，故不受它影响（比旧判据还稳一点）。
 */
function dividersOf(lines: readonly string[]): { readonly top: number; readonly bottom: number } {
  const last = lines.findLastIndex(isRule)
  const before = lines.findLastIndex((line, at) => at < last && isRule(line))

  return before === -1 ? { top: last, bottom: -1 } : { top: before, bottom: last }
}

/**
 * 一帧里的**记录区**——**上沿**分隔线之上那些行。
 *
 * 「记录不丢不重」这类判据量的是它：上沿那条是活动区的顶边，它上面才是「发生过什么」。
 */
export function recordOf(capture: Capture): readonly string[] {
  const { top } = dividersOf(capture.lines)

  return top === -1 ? capture.lines : capture.lines.slice(0, top)
}

/**
 * 缓冲里的**记录区**（非空行）——「记录不丢不重」这类判据的取材。
 *
 * 取法是「**上沿**那条分隔线**之上**」：上沿以下就是**活动区**（输入行 / 抽屉 / 状态行），
 * 那里本来就该随操作变（抽屉开合动的正是它）；下沿那条（U45 加 · U59 挪）与它**之下**的
 * 状态行属**收尾**，更不在记录区里。
 */
function recordHistoryOf(capture: Capture): readonly string[] {
  const { top } = dividersOf(capture.history)

  return (top === -1 ? capture.history : capture.history.slice(0, top)).filter((line) => line.trim() !== '')
}

/** 某一行在缓冲里出现几次（「重影」判据要它）。 */
function countOf(needle: string, lines: readonly string[]): number {
  return lines.filter((line) => line === needle).length
}

/** 逐行**整行相等**地数（右侧空白不参战）——「这条记录出现几次」用它，别用子串（会数进别的行）。 */
function countExact(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.trimEnd() === needle).length
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}
