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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE, placeholderOf } from '@magic/tui'
import { UiWaitTimeout, createUiSession } from './driver.ts'
import type { Capture, UiSession, UiSessionOptions } from './driver.ts'
import type { FixtureTurn } from './fixture.ts'
import { readDatabase } from '../support.ts'

/** 没出包的文案锚（见文件头注 3）——判据用到它们时，`detail` 里写上这一份。 */
const COPY = {
  pickerHint: '↑↓ 选 · 回车 定 · esc 收起',
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

/** 一条判据的结论——过了的也一并交回（给人看这一组到底判了些什么）。 */
export type CheckOutcome = {
  readonly what: string
  readonly ok: boolean
  readonly detail: string
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
    const dividers = cleared.lines.filter((line) => /^─+$/u.test(line.trim())).length
    ui.check(dividers === 1, '窄窗稳定后一共只画了一条分隔线', `可见区实际 ${dividers} 条`)
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

    // —— 退出：空闲时 ctrl+c ＝ 走人 ——
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 2_000 })
    ui.check(report.exit.by === 'app', 'ctrl+c 让应用自己退了场', `退出缘由 ${report.exit.by}`)
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
export const SCENARIOS: readonly Scenario[] = [
  bootInputResizeExit,
  drawerOpenClose,
  modelStreamApproval,
  missingTextFailure,
  assistantAcrossCalls,
  isolationRepeatParallel,
]

export function scenarioNames(): readonly ScenarioName[] {
  return SCENARIOS.map((scenario) => scenario.name)
}

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
      const outcome: CheckOutcome = { what, ok, detail }
      checks.push(outcome)
      options.onCheck?.(outcome)
      if (!ok) throw new ScenarioFailure(what, detail)
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

/**
 * 一帧里的**记录区**——分隔线**之上**那些行。
 *
 * 「记录不丢不重」这类判据量的是它：分隔线是活动区的顶边，它上面才是「发生过什么」。
 */
export function recordOf(capture: Capture): readonly string[] {
  // ⚠️ 取**最后一条**分隔线：活动帧那条才是记录区的顶边。取第一条的话，改窗残影（旧分隔线
  //    还留在屏上）会把记录区截在半路（与 `recordHistoryOf` 同一口径）。
  let at = -1
  for (let row = capture.lines.length - 1; row >= 0; row -= 1) {
    if (/^─+$/u.test((capture.lines[row] as string).trim())) {
      at = row
      break
    }
  }

  return at === -1 ? capture.lines : capture.lines.slice(0, at)
}

/**
 * 缓冲里的**记录区**（非空行）——「记录不丢不重」这类判据的取材。
 *
 * 取法是「最后一条分隔线**之上**」：分隔线以下就是**活动区**（输入行 / 抽屉 / 状态行），
 * 那里本来就该随操作变（抽屉开合动的正是它）。
 */
function recordHistoryOf(capture: Capture): readonly string[] {
  const lines = capture.history
  let divider = -1
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    if (/^─{4,}$/u.test((lines[at] as string).trim())) {
      divider = at
      break
    }
  }

  return (divider === -1 ? lines : lines.slice(0, divider)).filter((line) => line.trim() !== '')
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
