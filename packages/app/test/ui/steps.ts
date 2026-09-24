/**
 * 界面验收 · **步骤文件**（U51）——「一趟脚本」那一等入口的那一半。
 *
 * ## 一句话
 *
 * **给一个步骤文件，一条命令跑完一趟、自己收尾、帧与读数落盘。**
 *
 * 由头是已经发生的事：U43–U49 那一轮，看界面的人**每一单都在装置外面自己搭一套**
 * （bash ＋ FIFO 把 `serve` 包起来、手写步骤、自己取帧、自己收尾，前后五个脚本）。
 * 他们要的其实就是这个文件——**换来的那五套装置全都可以删掉**。
 *
 * ## 步骤文件长什么样
 *
 * 一个 JSON 对象（或直接是一个数组）：
 *
 * ```jsonc
 * {
 *   "label": "u44-翻页",              // 可选：产物目录名
 *   "out": "/tmp/看看",               // 可选：产物根（缺省 <仓库>/.ui-runs）
 *   "checkout": "/path/to/repo",       // 可选：被测 checkout
 *   "steps": [
 *     { "cmd": "start", "as": "甲", "cols": 100, "rows": 30,
 *       "turns": [{ "kind": "text", "text": "说一句长话" }],
 *       "files": { ".magic/skills/twins/SKILL.md": "---\nname: twins\n---\n\n正文\n" } },
 *     { "cmd": "send", "session": "甲", "text": "说一句长话" },
 *     { "cmd": "key", "session": "甲", "key": "enter",
 *       "wait": { "text": "说一句长话" }, "timeoutMs": 20000 },
 *     { "cmd": "capture", "session": "甲", "label": "01-提交之后" },
 *     { "cmd": "resize", "session": "甲", "columns": 46, "rows": 30 },
 *     { "cmd": "capture", "session": "甲", "label": "02-窄窗" },
 *     { "cmd": "quit", "session": "甲" },
 *     { "cmd": "close", "session": "甲" }
 *   ]
 * }
 * ```
 *
 * ## 三处要记牢的
 *
 * 1. **一套词汇，两条入口**——每个步骤**就是控制通道的一条命令**（`start` / `send` /
 *    `key` / `resize` / `wait` / `capture` / `close` / `sessions`），本文件**自己不复制
 *    任何驱动逻辑**，它把每一步原样交给 `createControl` 去办。于是
 *    「在 `serve` 里怎么做」与「在步骤文件里怎么写」是**同一件事**，学一次就够。
 * 2. **本入口一条判据都不跑**（U51 第二条）——装置负责**真实驱动 ＋ 如实取帧**，
 *    **判据归看帧的人**。这里出现的 `"wait"` 是**驱动**（等屏上某个条件成立），
 *    不是判据；它没等到就是**这一步没走成**，如实记下来、原地停住，**不替谁下结论**。
 * 3. **几处糖**（只此几处，其余一字不改照抄控制通道）：
 *    - `start` 多一个 `as`——给这个窗口起个名字，后面的步骤用 `session` 指它；
 *    - `start` 还收 `files`——**起手先摆几份文件**（相对路径 → 内容）。
 *      技能 / 规约这类**按目录发现**的东西，屏上要验的那几屏得先有材料；
 *      没有这一口，验技能就只能绕开本入口另搭一套装置（U51 要删掉的正是那种重复）。
 *      `"~/…"` 开头的几条落在**沙地的家目录**里（U58 加的），验「用户那一类来源」用它。
 *    - `send` / `key` 多 `wait` ＋ `timeoutMs`——「写一次，**等这一下生效**」。
 *      ⚠️ 这两个字是**踩出来的**：写一次不等待，取帧会抢在这一键被受理之前
 *      （U49 真跑里栽过一次：`key('tab')` 之后那一帧抓到的还是旧屏）。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createControl } from './control.ts'
import type { Control, ControlRequest } from './control.ts'

/** 步骤文件的一条步骤——**就是控制通道的一条命令**，只多下面这一处。 */
export type Step = ControlRequest & {
  /** `start` 用：给这个窗口起个名字（后面的步骤用 `session` 指它）。 */
  readonly as?: string
}

/** 步骤文件（对象形）。数组形也收——那就是 `steps` 本身。 */
export type StepFile = {
  /** 产物标签（进目录名）。 */
  readonly label?: string
  /** 产物根。 */
  readonly out?: string
  /** 被测 checkout。 */
  readonly checkout?: string
  readonly steps: readonly Step[]
}

/** 一个窗口的落点（`start` 那一步的答复里带着）——报告里逐个列出来。 */
export type SessionDir = {
  readonly session: string
  readonly runDir: string
  readonly pid: number
}

export type StepOutcome = {
  readonly n: number
  readonly cmd: string
  readonly session?: string
  readonly ok: boolean
  /** 记下来的**读数**——控制通道那一整条答复（原样，不裁剪）。 */
  readonly reply: Record<string, unknown>
  readonly error?: { readonly kind: string; readonly message: string }
}

export type StepRun = {
  readonly ok: boolean
  /** 这一趟自己的现场目录（`steps.ndjson` · `report.txt` · `summary.json` 都在里面）。 */
  readonly runDir: string
  readonly outcomes: readonly StepOutcome[]
  /** 挂在哪一步（没挂＝`undefined`）。 */
  readonly failure?: { readonly step: number; readonly cmd: string; readonly detail: string }
  /** 每个窗口自己的现场目录（帧与原始字节都在那儿）。 */
  readonly sessionDirs: readonly SessionDir[]
  /** 人读的那一页（与 `report.txt` 同一份内容）。 */
  readonly report: string
}

export type StepRunOptions = {
  /** 产物根——步骤文件自己没写 `out` 时用它。 */
  readonly artifacts?: string
  readonly checkout?: string
  /** 这一趟叫什么（进目录名）——不给就取 `script`。 */
  readonly label?: string
  /** 一步步报进度（命令行用它打给人看）。 */
  readonly onStep?: (outcome: StepOutcome) => void
}

/**
 * 解析步骤文件——**只认那两处糖，别的一字不改**。
 *
 * 坏文件**当场说清楚哪一条坏在哪儿**（工单原话：「装置坏了要当场说」）——
 * 别让它跑到一半才炸在一个看不懂的地方。
 */
export function parseSteps(text: string): { label?: string; out?: string; checkout?: string; steps: readonly Step[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`步骤文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }

  // 两种形：**光一个数组**（最省事），或**一个带 `label` / `out` / `steps` 的对象**
  const bare = Array.isArray(parsed)
  const file = (bare ? { steps: parsed } : parsed) as StepFile | undefined
  if (file === undefined || file === null || !Array.isArray(file.steps) || file.steps.length === 0) {
    throw new Error('步骤文件里没有 steps（给一个数组，或一个带 steps 的对象）')
  }

  for (const [at, step] of file.steps.entries()) {
    const where = `第 ${at + 1} 条`
    if (typeof step !== 'object' || step === null) throw new Error(`${where}不是对象`)
    if (typeof step.cmd !== 'string') throw new Error(`${where}缺 cmd`)
    if (!COMMANDS.has(step.cmd)) {
      throw new Error(`${where}的 cmd 不认得：「${step.cmd}」——有的是：${[...COMMANDS].join(' / ')}`)
    }
  }

  return {
    ...(file.label === undefined ? {} : { label: file.label }),
    ...(file.out === undefined ? {} : { out: file.out }),
    ...(file.checkout === undefined ? {} : { checkout: file.checkout }),
    steps: file.steps,
  }
}

/** 控制通道认的那几条——**这里是白名单，不是第二套实现**（真正的处理在 `control.ts`）。 */
const COMMANDS = new Set(['start', 'send', 'key', 'resize', 'wait', 'capture', 'quit', 'close', 'sessions'])

/**
 * 跑一趟步骤文件——**一条命令跑完、自己收尾**。
 *
 * 收尾是**这一层负责**的：正常走完、某一步挂了、答复送不出去，三条路都汇到 `finally`
 * 里那一次 `closeAll()`（自己起的应用与端点一个不留）。谁也**不需要**在外面
 * `kill` 它——那正是规划侧上一轮不得不做的事。
 */
export async function runSteps(
  steps: readonly Step[],
  options: StepRunOptions = {},
): Promise<StepRun> {
  const runDir = claimScriptDir(options.artifacts ?? join(process.cwd(), '.ui-runs'), options.label ?? 'script')
  const stepsPath = join(runDir, 'steps.ndjson')
  const outcomes: StepOutcome[] = []
  let failure: StepRun['failure']
  /**
   * 会话目录——**一开就记**（`start` 那一步的答复里带着），不等到收尾再问。
   *
   * 由头（实测栽过）：`close` 会把那个窗口从控制面上摘掉，收尾那一刻问出来的是一张空表，
   * 报告里就一个现场都没有了。
   */
  const sessionDirs: SessionDir[] = []

  const control: Control = createControl({
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.checkout === undefined ? {} : { checkout: options.checkout }),
    log: (line) => console.error(`[ui] ${line}`),
  })

  const record = (outcome: StepOutcome): void => {
    outcomes.push(outcome)
    appendFileSync(stepsPath, `${JSON.stringify(outcome)}\n`, 'utf8')
    options.onStep?.(outcome)
  }

  try {
    for (const [at, step] of steps.entries()) {
      const n = at + 1
      const line = JSON.stringify(toCommand(step, n))
      const reply = await control.handle(line)
      const parsed = JSON.parse(reply) as Record<string, unknown>
      const ok = parsed['ok'] === true
      const session = sessionNameOf(parsed)

      record({
        n,
        cmd: step.cmd,
        ...(session === undefined ? {} : { session }),
        ok,
        reply: parsed,
      })

      // 窗口一开就记下它的落点——**不能等收尾再问**：`close` 会把它从控制面上摘掉，
      // 收尾那一刻问出来的是一张空表（实测栽过：报告里一个现场都没有）。
      if (ok && step.cmd === 'start' && session !== undefined) {
        sessionDirs.push({
          session,
          runDir: String(parsed['runDir'] ?? ''),
          pid: Number(parsed['pid'] ?? 0),
        })
      }

      if (!ok) {
        const error = parsed['error'] as { kind?: string; message?: string } | undefined
        failure = {
          step: n,
          cmd: step.cmd,
          detail: `${error?.kind ?? 'failed'}：${error?.message ?? '（没有缘由）'}`,
        }
        break
      }
    }
  } finally {
    // **收尾只有这一处**：谁来跑（走完 / 抛了 / 中途 break）都从这儿出去。
    try {
      await control.closeAll()
    } catch (error) {
      console.error(`[ui] 收尾出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const ok = failure === undefined
  const report = renderReport({ runDir, steps, outcomes, failure, ok })

  writeFileSync(join(runDir, 'report.txt'), report, 'utf8')
  writeFileSync(
    join(runDir, 'summary.json'),
    `${JSON.stringify(
      {
        ok,
        steps: outcomes.length,
        of: steps.length,
        ...(failure === undefined ? {} : { failure }),
        // ⚠️ **会话目录在 `closeAll` 之前取**（收完就没了）——收尾前先抄一份
        sessions: sessionDirs,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return {
    ok,
    runDir,
    outcomes,
    ...(failure === undefined ? {} : { failure }),
    sessionDirs,
    report,
  }
}

/**
 * 步骤 → 控制通道的命令。**只拆一处糖**：`as` 换成 `session`（`start` 起的窗口就叫这个名字）。
 *
 * `wait` ＋ `timeoutMs` 不必在这儿改名——**它们本来就在控制通道的词汇里**（`send` / `key`
 * 的「写一次、等它生效」，见 `control.ts`·`untilOf`）。于是步骤文件里写什么、
 * `serve` 里写什么，是**同一个词**；处理它们的也只有 `control.ts` 那一处。
 */
function toCommand(step: Step, n: number): Record<string, unknown> {
  const { as, ...rest } = step

  return { ...rest, id: rest.id ?? n, ...(as === undefined ? {} : { session: as }) }
}

function sessionNameOf(reply: Record<string, unknown>): string | undefined {
  const name = reply['session']

  return typeof name === 'string' ? name : undefined
}

/** 人读的那一页——**跑完打在屏幕上，也落成 `report.txt`**。 */
function renderReport(init: {
  runDir: string
  steps: readonly Step[]
  outcomes: readonly StepOutcome[]
  failure: StepRun['failure']
  ok: boolean
}): string {
  const lines: string[] = []
  lines.push(`界面验收 · 步骤文件一趟`)
  lines.push(`  现场　${init.runDir}`)
  lines.push(`  走的　${init.outcomes.length}/${init.steps.length} 步`)
  lines.push('')

  for (const outcome of init.outcomes) {
    const mark = outcome.ok ? '✓' : '✗'
    const who = outcome.session === undefined ? '' : ` [${outcome.session}]`
    const detail = describeOutcome(outcome)
    lines.push(`  ${mark} ${String(outcome.n).padStart(2)} ${outcome.cmd}${who}${detail}`)
  }

  if (init.failure !== undefined) {
    lines.push('')
    lines.push(`  挂在哪　第 ${init.failure.step} 步（${init.failure.cmd}）：${init.failure.detail}`)
  }

  lines.push('')
  lines.push(`  ${init.ok ? '走完了' : '没走完'}——本入口一条判据都没跑：帧与读数在这儿，判据归看帧的人。`)

  return `${lines.join('\n')}\n`
}

/** 一条步骤的「读数」糊成一行——**帧就报它落在哪个文件**，别把整屏糊进报告。 */
function describeOutcome(outcome: StepOutcome): string {
  if (!outcome.ok) return `　${outcome.error?.message ?? '没过'}`

  const reply = outcome.reply
  if (outcome.cmd === 'capture') {
    const frame = reply['frame'] as
      | { readonly n?: number; readonly label?: string; readonly columns?: number; readonly rows?: number; readonly files?: { readonly text?: string } }
      | undefined
    const runDir = typeof reply['runDir'] === 'string' ? reply['runDir'] : ''

    return `　${frame?.columns}×${frame?.rows}　帧 ${runDir}/${frame?.files?.text ?? ''}`
  }
  if (outcome.cmd === 'start') return `　pid ${String(reply['pid'] ?? '')}　${String(reply['runDir'] ?? '')}`
  if (outcome.cmd === 'wait') return `　等到了（${String(reply['elapsedMs'] ?? '')}ms）`
  if (outcome.cmd === 'close') return `　退出缘由 ${(reply['exit'] as { by?: string } | undefined)?.by ?? ''}`

  return ''
}

/** 这一趟自己的现场目录（`<产物根>/<时间戳>-script-<标签>/`）——**绝不覆盖已有运行**。 */
function claimScriptDir(root: string, label: string): string {
  mkdirSync(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const base = `${stamp}-script-${slug(label)}`

  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = join(root, suffix === 0 ? base : `${base}-${suffix}`)
    if (!existsSync(candidate)) {
      mkdirSync(candidate, { recursive: false })
      return candidate
    }
  }

  throw new Error(`产物目录连着 1000 个都已被占用：${root}/${base}`)
}

/** 标签 → 文件名安全的形式（中文留着，只把分隔符与空白换成 `-`）。 */
function slug(label: string): string {
  return label.replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'script'
}
