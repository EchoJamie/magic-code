/**
 * 界面验收 · **只驱动、只取帧**（U51 第二条）——同一趟故事，**一条判据都不判**。
 *
 * ## 它和 `runScenario` 是什么关系
 *
 * **同一支故事，两个跑法**：
 *
 * | 跑法 | 给谁 | 交什么 |
 * | --- | --- | --- |
 * | `runScenario`（`scenarios.ts`） | **开发自验** | 判据过没过（该红就红、该拦就拦） |
 * | 本文件 | **看帧的人** | **每一帧 ＋ 它的读数**，一个结论都不下 |
 *
 * 由头（`研发/界面验收工具`·目标一节）：
 *
 * > **用同一台摄像机不算不独立；把开发写的判据当成我的验收，才算。**
 *
 * 装置负责**真实驱动 ＋ 如实取帧**——这两件谁用都是同一件事实；**判据归看帧的人**。
 * 故本跑法**借着开发写的那套故事**（哪几步值得停下来看一眼，写故事的人最清楚），
 * 但在每个该判的地方**只取一帧、记下此刻的读数**，然后照走不误——**不中断、不通过、不否决**。
 *
 * ⚠️ **互不替代**：`scenarios.ts` 那份判据一个字没动，`bun test` 那条门照旧判它那份；
 * 这是**另一条取用方式**，不是它的替代品，也不许谁拿它的绿去顶门。
 *
 * ⚠️ **本文件不动 `scenarios.ts` 一个字**（那个文件这一轮归别的单）：它只**读**那份
 * `SCENARIOS`，自己另起一个 `ScenarioContext` 把 `check` 接过来。
 *
 * ## 一条界要分清
 *
 * 故事里那些 `session.wait(...)` **不是判据**，是**驱动**（等屏上某个条件成立才往下走）。
 * 它们该等还得等——等不到就是**这一趟没走成**（`UiWaitTimeout`），本跑法**如实停在那儿**、
 * 把已经取到的帧与读数交出来，**不假装跑完了**。判据那一路（`check`）才是本跑法**不判**的那一半。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { UiWaitTimeout, createUiSession } from './driver.ts'
import type { Capture, UiSession, UiSessionOptions } from './driver.ts'
import { SCENARIOS, scenarioNames } from './scenarios.ts'
import type { ScenarioContext, ScenarioName, ScenarioOptions } from './scenarios.ts'

/** 一条**读数**——故事在该判的那一点上，屏上**实际**是什么（原样，不判对错）。 */
export type Reading = {
  /** 故事原话（开发写的那条判据的名字）——**它是「看哪儿」，不是「判什么」**。 */
  readonly what: string
  /** 开发那条判据本来会得到什么——**只作记账**，本跑法不据它下结论。 */
  readonly held: boolean
  /** 故事给的细读（很多条判据把实际值写在 `detail` 里）。 */
  readonly detail: string
  /** 这一刻取的帧（那一屏已经读不动时缺席——**如实缺席，不补一张别的**）。 */
  readonly frame?: Capture
}

export type FramesRun = {
  readonly name: ScenarioName
  readonly title: string
  readonly anchors: string
  /** 故事走完没有——**与判据过没过无关**（本跑法一条都不判）。 */
  readonly ok: boolean
  readonly readings: readonly Reading[]
  readonly runDirs: readonly string[]
  readonly viewers: readonly string[]
  /** 没走完：卡在哪一步。 */
  readonly failure?: { readonly what: string; readonly detail: string }
}

export type FramesRunOptions = ScenarioOptions

/** 场景名——与判据那条路同一份目录（`list` 用它）。 */
export function framesScenarioNames(): readonly ScenarioName[] {
  return scenarioNames()
}

/**
 * 跑一趟——**故事照走，该判的地方换成取帧**。
 *
 * 会话由本跑法统一收摊（`finally` 里倒序关，走不完也关）——故事只管演。
 */
export async function runScenarioFrames(
  name: ScenarioName,
  options: FramesRunOptions = {},
): Promise<FramesRun> {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name)
  if (scenario === undefined) {
    throw new Error(`不认得的场景「${name}」——有的是：${scenarioNames().join(' / ')}`)
  }

  const readings: Reading[] = []
  const sessions: UiSession[] = []
  /** 还欠着帧的读数下标（`check` 是同步的、取帧不是——见 `snapPending`）。 */
  const pending: number[] = []
  let failure: FramesRun['failure']

  /**
   * **补帧**——把欠着的那几条读数当下的屏取下来。
   *
   * 为什么能这么欠着：`ScenarioContext.check` 是**同步**的（`scenarios.ts` 的形），
   * 而 `capture` 不是。而**两次 `check` 之间一定隔着一次驱动**（故事总得等屏、敲键），
   * 故在每一次驱动调用之后补——那一屏与 check 那一刻**一模一样**（中间什么都没发出去）。
   */
  const snapPending = async (): Promise<void> => {
    if (pending.length === 0) return
    const session = sessions.at(-1)
    if (session === undefined) {
      pending.length = 0
      return
    }
    for (const at of pending.splice(0)) {
      const reading = readings[at] as Reading
      try {
        readings[at] = { ...reading, frame: await session.capture({ label: labelOf(reading.what) }) }
      } catch {
        // 取不到就取不到——读数照在，别把这一趟拖垮
      }
    }
  }

  /**
   * 交给故事的会话——**驱动那几个动作外面裹一层「回来先把欠的帧补上」**。
   *
   * 为什么裹在这儿而不是 `check` 里：见 `snapPending` 的注（同步 / 异步那一刀）。
   */
  const shielded = (session: UiSession): UiSession => {
    const after = async <T>(run: () => Promise<T>): Promise<T> => {
      const out = await run()
      await snapPending()

      return out
    }

    return new Proxy(session, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver) as unknown
        if (typeof value !== 'function') return value
        const name = String(key)
        if (!WRAPPED.has(name)) return value.bind(target)

        return (...args: unknown[]) =>
          after(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args))
      },
    })
  }

  const ui: ScenarioContext = {
    /** **判据换成取帧**——这就是本跑法与 `runScenario` 的全部差别。 */
    check: (held, what, detail = '') => {
      readings.push({ what, held, detail })
      pending.push(readings.length - 1)
    },
    note: (line) => options.onNote?.(line),
    open: async (sessionOptions: UiSessionOptions) => {
      const session = await createUiSession(sessionOptions)
      sessions.push(session)
      await snapPending()

      return shielded(session)
    },
  }

  try {
    await scenario.story(ui, options)
  } catch (error) {
    if (error instanceof UiWaitTimeout) {
      failure = {
        what: `驱动没走成：${describeCondition(error.condition)}`,
        detail: `${Math.round(error.elapsedMs)}ms 没等到——现场 ${error.runDir}`,
      }
    } else {
      failure = { what: '（未分类的抛出）', detail: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    await snapPending().catch(() => {})
    for (const session of [...sessions].reverse()) {
      try {
        await session.close()
      } catch {
        // 收摊失败不该盖掉真正的失败——现场已经在盘上了
      }
    }
  }

  const runDirs = sessions.map((session) => session.runDir)

  return {
    name: scenario.name,
    title: scenario.title,
    anchors: scenario.anchors,
    ok: failure === undefined,
    readings,
    runDirs,
    viewers: runDirs.map((dir) => join(dir, 'viewer.html')).filter((path) => existsSync(path)),
    ...(failure === undefined ? {} : { failure }),
  }
}

/** 驱动那几个动作——补帧只挂在这些之后（`screen` / `rawText` 这类**只读**的不挂）。 */
const WRAPPED = new Set(['send', 'key', 'resize', 'wait', 'capture', 'quit', 'close', 'dropTerminal'])

/** 帧的标签——取判据名（**看帧的人认得出这一屏是在看什么**），太长就截。 */
function labelOf(what: string): string {
  return what.replace(/[\s/\\:*?"<>|]+/g, '-').slice(0, 40)
}

function describeCondition(condition: unknown): string {
  if (typeof condition !== 'object' || condition === null) return String(condition)
  const entry = condition as {
    text?: string
    absent?: string
    at?: { row: number; text: string }
    writtenFrame?: number
  }
  if (entry.text !== undefined) return `出现「${entry.text}」`
  if (entry.absent !== undefined) return `不再出现「${entry.absent}」`
  if (entry.writtenFrame !== undefined) return `${entry.writtenFrame} 列的完整帧`
  if (entry.at !== undefined) return `第 ${entry.at.row} 行出现「${entry.at.text}」`

  return JSON.stringify(condition)
}

/** 一条读数糊成一行（命令行与报告都用它）。 */
export function describeReading(reading: Reading): string {
  const frame = reading.frame === undefined ? '（没取到帧）' : `${reading.frame.columns}×${reading.frame.rows}`
  const detail = reading.detail === '' ? '' : `　${reading.detail}`
  // ⚠️ 「本来会红」也照打——**这正是「读数」的意思**：看着的人自己决定那算不算事
  const held = reading.held ? '' : '　← 开发那条判据在这儿本来会红'

  return `${reading.what}　${frame}${detail}${held}`
}

export { describeCondition as describeFramesCondition }
