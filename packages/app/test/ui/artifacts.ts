/**
 * 界面验收 · 现场产物（U40）——**成功失败都留同一套东西**。
 *
 * ## 一次运行一个目录，谁都不许覆盖谁
 *
 * `<产物根>/<run-id>/`：`run-id` ＝ 时间戳 ＋ 一个唯一的后缀，**已存在就让位**
 * （「产物目录不得覆盖已有运行」）。产物根缺省是**仓库里的 `.ui-runs/`**
 * （`.gitignore` 已忽略）——不是 `/tmp`：这一套是要**给人看**的，
 * 散在临时目录里就等于没有（工单原话：不要再留在 `/tmp` 的未入库脚本里）。
 *
 * ## 五件东西（每件都对应一句要求）
 *
 * | 文件 | 是什么 | 对应的话 |
 * | --- | --- | --- |
 * | `run.json` | 运行信息：提交 / dirty / 版本 / 尺寸 / 颜色 / 结局 | 「记录实际 Git 提交、dirty 标记、运行时版本、尺寸与颜色设置」 |
 * | `steps.ndjson` | 命令/步骤时间线（含每步时的**字节水位**） | 「命令/步骤时间线」 |
 * | `raw.bin` | **原样**的 stdout 字节（不转义、不裁内容） | 「原始终端字节」 |
 * | `frames/*.txt` `.json` | 每一步的帧文本 ＋ 字格/光标数据 | 「检查点帧文本与字格/光标数据」 |
 * | `viewer.html` | 最小本地查看页 | 「简洁的本地 HTML 查看页」 |
 *
 * ⚠️ **输出量有界，触界即说**：`raw.bin` 到了上限就**停写并置 `truncated`**
 * （`run.json` 里说得出「这份现场不完整」，查看页上也印出来）——
 * **不静默截断后宣称验证通过**。
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VtCursor } from './vt.ts'

/** 原始字节的缺省上限（8 MiB）——够一次界面验收跑完，又不至于把仓库撑爆。 */
export const RAW_LIMIT_BYTES = 8 * 1024 * 1024

/** 一帧（写进 `frames/*.json` 的那份）——**够画出这一屏**，且与尺寸无关地自洽。 */
export type FrameRecord = {
  readonly n: number
  /** 出自第几步（`steps.ndjson` 里的 `n`）。 */
  readonly step: number
  readonly label: string
  readonly at: number
  readonly columns: number
  readonly rows: number
  /**
   * 光标：坐标 ＋ **显隐**（同一支 VT 取样，见 `vt.ts`·`VtCursor`）。
   *
   * 之所以要显隐：应用会把终端光标藏起来（自己另画一个），藏起来的那个停在下方回退位
   * ——只按坐标画出来就是「把没显示的光标画给人看」。
   */
  readonly cursor: VtCursor
  /** 可见区之上压着的行数（滚进 scrollback 的）。 */
  readonly scrollback: number
  readonly total: number
  /** 用到的样式表（`fg|bg|attrs`）——行里只存下标。 */
  readonly styles: readonly string[]
  readonly lines: readonly {
    readonly wrapped: boolean
    /**
     * `[起始列, 文本, 占用列数, 样式下标]`——同一样式的连续单宽格已并成一段。
     *
     * 占用列数**从格子上取**（宽字符 2、其余 1），不是拿字体去猜：查看页按它落位，
     * 猜错就与真终端对不上（宽字符那一格尤其）。
     */
    readonly runs: readonly (readonly [number, string, number, number])[]
  }[]
}

export type RunStep = {
  readonly n: number
  readonly at: number
  readonly action: string
  readonly bytes: number
  readonly [key: string]: unknown
}

/** 运行信息——「避免旧帧冒充新提交」靠的就是它。 */
export type RunInfo = {
  readonly run: string
  readonly label: string
  readonly startedAt: string
  finishedAt?: string
  readonly checkout: string
  readonly commit: string
  readonly dirty: boolean
  readonly bun: string
  readonly app: {
    readonly argv: readonly string[]
    readonly cwd: string
    readonly home: string
    readonly dataDir: string
    readonly configPath: string
    readonly forceColor: string
  }
  readonly terminal: {
    readonly columns: number
    readonly rows: number
    readonly scrollback: number
    readonly term: string
  }
  readonly fixture: { readonly baseURL: string; readonly port: number } | null
  readonly rawLimitBytes: number
  steps: number
  frames: number
  truncated: boolean
  /** 结局：跑完 / 被关 / 卡在哪一步。 */
  outcome: 'running' | 'completed' | 'failed' | 'closed'
  failure?: { readonly step: string; readonly kind: string; readonly detail: string; readonly condition?: unknown }
  exit?: { readonly code: number | null; readonly signal: string | null }
}

/** 一次运行的现场。 */
export type Artifacts = {
  readonly runDir: string
  readonly info: RunInfo
  /** 记一步（返回步号）——`at` 与 `bytes` 由这一层补。 */
  step(action: string, fields?: Record<string, unknown>): number
  /** 原始字节（**原样**落盘；触界即停并置 `truncated`）。 */
  raw(chunk: string): void
  /** 此刻的字节水位（步与字节对得上号）。 */
  bytes(): number
  /** 存一帧（文本 ＋ 字格数据），返回帧号。 */
  frame(frame: Omit<FrameRecord, 'n'>, plain: string): number
  /** 收尾：刷字节、写 `run.json`、生成查看页。 */
  finish(outcome: RunInfo['outcome'], extra?: { failure?: RunInfo['failure']; exit?: RunInfo['exit'] }): void
}

export type ArtifactsOptions = {
  /** 产物根（缺省 `<checkout>/.ui-runs`）。 */
  readonly root: string
  readonly label: string
  readonly checkout: string
  readonly app: RunInfo['app']
  readonly terminal: RunInfo['terminal']
  readonly fixture?: { readonly baseURL: string; readonly port: number } | null
  readonly rawLimitBytes?: number
}

/** 起一份现场——目录当场建好（失败时也有地方可写）。 */
export function createArtifacts(options: ArtifactsOptions): Artifacts {
  const runDir = claimRunDir(options.root, options.label)
  mkdirSync(join(runDir, 'frames'), { recursive: true })

  const started = Bun.nanoseconds()
  const now = (): number => (Bun.nanoseconds() - started) / 1e6
  const rawPath = join(runDir, 'raw.bin')
  const stepsPath = join(runDir, 'steps.ndjson')
  const rawLimit = options.rawLimitBytes ?? RAW_LIMIT_BYTES

  const info: RunInfo = {
    run: runDir.slice(runDir.lastIndexOf('/') + 1),
    label: options.label,
    startedAt: new Date().toISOString(),
    ...gitFacts(options.checkout),
    checkout: options.checkout,
    bun: Bun.version,
    app: options.app,
    terminal: options.terminal,
    fixture: options.fixture ?? null,
    rawLimitBytes: rawLimit,
    steps: 0,
    frames: 0,
    truncated: false,
    outcome: 'running',
  }

  let pending: string[] = []
  let pendingBytes = 0
  let written = 0
  let stepCount = 0
  let frameCount = 0

  /** 写一份 `run.json`——**开局就写一次**（跑到一半也看得见这一趟是什么），收尾再写一次。 */
  const writeInfo = (): void => {
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(info, null, 2), 'utf8')
  }
  writeInfo()

  const flush = (): void => {
    if (pending.length === 0) return
    appendFileSync(rawPath, pending.join(''), 'utf8')
    // ⚠️ 落盘即记账：早先只在「攒够 64KB」那一支里加 `written`，于是**收尾时刷出去的那一截
    // 没算进去**——`rawBytes` 报 0、步骤时间线上的字节水位也对不上（实测）
    written += pendingBytes
    pending = []
    pendingBytes = 0
  }

  return {
    runDir,
    info,

    step: (action, fields = {}) => {
      stepCount += 1
      const line: RunStep = { n: stepCount, at: round(now()), action, bytes: written + pendingBytes, ...fields }
      flush()
      appendFileSync(stepsPath, `${JSON.stringify(line)}\n`, 'utf8')
      info.steps = stepCount

      return stepCount
    },

    raw: (chunk) => {
      if (info.truncated) return
      pending.push(chunk)
      pendingBytes += Buffer.byteLength(chunk, 'utf8')

      if (written + pendingBytes > rawLimit) {
        // 触界：**停写并说**——把已攒的落地，标上不完整，之后再来的字节一律不收
        flush()
        info.truncated = true
        appendFileSync(
          stepsPath,
          `${JSON.stringify({ n: stepCount, at: round(now()), action: 'truncated', bytes: written, limit: rawLimit })}\n`,
          'utf8',
        )
        return
      }

      if (pendingBytes >= 64 * 1024) flush()
    },

    bytes: () => written + pendingBytes,

    frame: (frame, plain) => {
      flush()
      frameCount += 1
      const record: FrameRecord = { ...frame, n: frameCount }
      const name = `${String(frameCount).padStart(4, '0')}-${slug(frame.label)}`
      writeFileSync(join(runDir, 'frames', `${name}.json`), JSON.stringify(record), 'utf8')
      writeFileSync(
        join(runDir, 'frames', `${name}.txt`),
        `${plain}\n\n—— 第 ${frame.step} 步 · ${frame.label} · ${frame.columns}×${frame.rows} · ` +
          `光标 (${frame.cursor.x}, ${frame.cursor.y})${frame.cursor.hidden === true ? ' **隐藏**' : ''} · ` +
          `存档 ${frame.scrollback} 行 ——\n`,
        'utf8',
      )
      info.frames = frameCount

      return frameCount
    },

    finish: (outcome, extra = {}) => {
      flush()
      info.finishedAt = new Date().toISOString()
      info.outcome = outcome
      info.steps = stepCount
      info.frames = frameCount
      if (extra.failure !== undefined) info.failure = extra.failure
      if (extra.exit !== undefined) info.exit = extra.exit

      writeInfo()
    },
  }
}

/**
 * 认领一个没被占用的运行目录。
 *
 * run-id ＝ `<UTC 时间戳>-<标签>`，撞了就往后加序号——**绝不覆盖**已有运行。
 * 时间戳取 UTC 的紧凑写法（本地时区会让产物名在换时区后对不上号）。
 */
function claimRunDir(root: string, label: string): string {
  mkdirSync(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const base = `${stamp}-${slug(label)}`

  for (let suffix = 0; suffix < 1_000; suffix += 1) {
    const candidate = join(root, suffix === 0 ? base : `${base}-${suffix}`)
    if (!existsSync(candidate)) {
      mkdirSync(candidate, { recursive: false })
      return candidate
    }
  }

  throw new Error(`产物目录连着 1000 个都已被占用：${root}/${base}`)
}

/** 提交与脏标记——**从被测 checkout 现取**（不是从我们这头抄的）。 */
function gitFacts(checkout: string): { commit: string; dirty: boolean } {
  const commit = Bun.spawnSync(['git', '-C', checkout, 'rev-parse', 'HEAD'])
  const status = Bun.spawnSync(['git', '-C', checkout, 'status', '--porcelain'])

  return {
    commit: commit.exitCode === 0 ? commit.stdout.toString().trim() : '(不是 git 仓库)',
    // 只要有输出（含未跟踪）就算脏——「旧帧冒充新提交」正是这一位在防
    dirty: status.exitCode === 0 && status.stdout.toString().trim() !== '',
  }
}

/** 标签 → 文件名安全的形式（中文留着，只把分隔符与空白换成 `-`）。 */
function slug(label: string): string {
  return label.replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'run'
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** 读回一份现场（查看页生成用）——**只看这几个文件**，不依赖内存里的状态。 */
export function readRun(runDir: string): { info: RunInfo; steps: RunStep[]; frames: FrameRecord[] } {
  const info = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunInfo
  const steps = readJsonLines<RunStep>(join(runDir, 'steps.ndjson'))
  const framesDir = join(runDir, 'frames')
  const frames = (existsSync(framesDir) ? readdirSync(framesDir) : [])
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(framesDir, name), 'utf8')) as FrameRecord)

  return { info, steps, frames }
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

/** 整块删掉一次运行（清场用——**只在明确要删时才调**）。 */
export function removeRun(runDir: string): void {
  rmSync(runDir, { recursive: true, force: true })
}
