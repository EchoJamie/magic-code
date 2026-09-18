/**
 * U05 · 沙箱 `exec`（阶段 1 唯一实装的沙箱原语）——验收判据 1–5。
 *
 * 六条判据中与本文件相关者（工作分解 · 验收判据）：
 * 1. **回环**——常规命令 → `ok:true` · exit=0 · stdout 正确；exit 非 0 命令 → `ok:true` · exit≠0；
 * 2. **流式**——`onOutput` 按序收到 stdout / stderr 增量（拼接与终值一致；截断时到上限为止）；
 * 3. **超限**——超 `maxOutputBytes` → `truncated` ＋ 终值截断；
 * 4. **失败三例**——timeout / cwd 越界（**进程不启动**）/ 启动失败——各归 `reason`；
 * 5. **取消**——`opts.signal` 中止在途 → **返回不抛**。
 *
 * 两条实测教训（U01 契约层审查 M1 / M2 的实测，本文件沿用）：
 * - 「命令不存在」＝ **exit 127**（经 shell），**不是**沙箱级失败——别与启动失败混为一类；
 * - `Bun.spawn` 对不存在的**可执行文件**直接抛 ENOENT / cwd 不存在同样抛——**抛**才是启动失败。
 *
 * **多根（U18）**另有一节——判据「`exec` 的 `cwd` 解析与 `WorkspaceService.resolve` **同源**」
 * （技术方案 · 执行 · 工作区）：沙箱侧不另写一份路径规则，故多根下三条路径
 * （相对 / 绝对落任一根 / 越界）在此**实测**——同源若破，那一节当场红。
 *
 * 测试用 fs 不受守护拦（守护面收窄至各包 `src/`）——夹具照用临时目录。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecResult, OutputDelta, Sandbox } from '@magic/contracts'
import { createSandbox, createWorkspaceService } from '../src/index.ts'

// —— 夹具 ——

const roots: string[] = []

/** 造一个真临时目录当真工作区（调用方负责清理）。 */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'magic-exec-'))
  roots.push(root)
  return root
}

/** 造一个落在默认根上的沙箱，返回沙箱与其（规范化后的）根。 */
function sandboxOn(root: string): { box: Sandbox; root: string } {
  const workspace = createWorkspaceService({ roots: [root] })
  return { box: createSandbox({ workspace }), root: workspace.defaultRoot() }
}

/** 造一个**多条根**的沙箱——`defaultRoot()` ＝ 列表第一项（技术方案 · 执行 · 工作区）。 */
function sandboxOnAll(raw: readonly string[]): { box: Sandbox; roots: readonly string[] } {
  const workspace = createWorkspaceService({ roots: raw })
  return { box: createSandbox({ workspace }), roots: workspace.roots() }
}

/** 取规范化后的第 n 条根——索引位在 `noUncheckedIndexedAccess` 下带 `undefined`。 */
function nth(roots: readonly string[], index: number): string {
  const root = roots[index]
  if (root === undefined) throw new Error(`第 ${index + 1} 条根缺席——夹具出问题了`)
  return root
}

/** 一步到位：新根 ＋ 新沙箱。 */
function freshSandbox(): { box: Sandbox; root: string } {
  return sandboxOn(freshRoot())
}

/** 取 `ok:true` 分支——失败分支直接判死，避免静默拿空串（顺带把判别联合收窄给 tsc）。 */
function okOf(result: ExecResult): Extract<ExecResult, { ok: true }> {
  if (!result.ok) throw new Error(`期望命令跑过（ok:true），实为沙箱失败：${result.reason}`)
  return result
}

/** 收结果里的 stdout / stderr。 */
function streamsOf(result: ExecResult): { stdout: string; stderr: string; exit: number } {
  const { stdout, stderr, exit } = okOf(result)
  return { stdout, stderr, exit }
}

// 收尾——测试进程退出前清掉临时目录（失败时也清）
process.on('exit', () => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定
    }
  }
})

// —— 类型层探针（tsc 校验；`bun test` 只剥类型，不做检查）——
type _FaceMatchesPort = ReturnType<typeof createSandbox> extends Sandbox ? true : never
const _faceProbe: _FaceMatchesPort = true
void _faceProbe

// ══ 判据 1 · 回环 ═════════════════════════════════════════════════════

describe('判据 1 · 回环——命令跑了', () => {
  test('常规命令 → ok:true · exit=0 · stdout 正确', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('echo hello', {})

    expect(result.ok).toBe(true)
    const { stdout, exit } = streamsOf(result)
    expect(exit).toBe(0)
    expect(stdout).toBe('hello\n')
  })

  test('stderr 单独成道——不混进 stdout', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('echo out; echo err >&2', {})

    const { stdout, stderr } = streamsOf(result)
    expect(stdout).toBe('out\n')
    expect(stderr).toBe('err\n')
  })

  test('exit 非 0 命令 → ok:true · exit≠0（**命令失败不是沙箱失败**）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('exit 3', {})

    expect(result.ok).toBe(true)
    expect(streamsOf(result).exit).toBe(3)
  })

  test('「命令不存在」＝ exit 127——命令失败，不是沙箱级失败', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('definitely-not-a-command-xyz', {})

    expect(result.ok).toBe(true) // ← 关键区分：沙箱没坏，是命令没找着
    const { exit, stderr } = streamsOf(result)
    expect(exit).toBe(127)
    expect(stderr).toContain('not found')
  })

  test('cwd 缺省＝默认根（启动目录）', async () => {
    const { box, root } = freshSandbox()

    const result = await box.exec('pwd', {})

    // macOS 上 /tmp 一类符号链接经规范化后 `pwd` 与根同形
    expect(streamsOf(result).stdout.trim()).toBe(root)
  })

  test('cwd 显式给出（根内相对路径）＝在该目录里跑', async () => {
    const { box, root } = freshSandbox()
    writeFileSync(join(root, 'marker.txt'), 'x')

    const result = await box.exec('ls', { cwd: '.' })

    expect(streamsOf(result).stdout).toContain('marker.txt')
  })
})

/**
 * U18 · **多根下的 `cwd`**——技术方案 · 执行：「`exec` 的 `cwd` 解析与
 * `WorkspaceService.resolve` **同源**」。
 *
 * 这是**实测**不是复述：同源若破，这一节当场红——沙箱认一套根、解析认另一套。
 * 沙箱侧不另写一份路径规则（`sandbox.ts` 只调 `workspace.resolve` / `defaultRoot`），
 * 故此处咬住的是「那条路真的接上了」：**进程真起来、真在认的那条根里跑**。
 */
describe('多根——cwd 与 `resolve` 同源', () => {
  test('cwd 缺省＝**默认根**（列表第一项）——不是第二根', async () => {
    const [first, second] = [freshRoot(), freshRoot()]
    const { box, roots: real } = sandboxOnAll([first, second])

    expect(streamsOf(await box.exec('pwd', {})).stdout.trim()).toBe(nth(real, 0))
    expect(streamsOf(await box.exec('pwd', {})).stdout.trim()).not.toBe(nth(real, 1))
  })

  test('cwd 给相对路径＝落默认根（不落第二根）', async () => {
    const { box, roots: real } = sandboxOnAll([freshRoot(), freshRoot()])
    writeFileSync(join(nth(real, 0), 'in-first.txt'), 'x')

    const result = await box.exec('ls', { cwd: '.' })

    expect(streamsOf(result).stdout).toContain('in-first.txt')
  })

  test('cwd 给**第二根的绝对路径**＝通过，且真在该根里跑（多根的主要收益）', async () => {
    const { box, roots: real } = sandboxOnAll([freshRoot(), freshRoot()])
    writeFileSync(join(nth(real, 1), 'in-second.txt'), 'x')

    const result = await box.exec('pwd', { cwd: nth(real, 1) })

    expect(streamsOf(result).stdout.trim()).toBe(nth(real, 1))
    // 相对这个 cwd 的命令也落在第二根（pwd 对了不代表 shell 真在那儿跑，故再落一个文件）
    writeFileSync(join(nth(real, 1), 'also-here.txt'), 'x')
    expect(streamsOf(await box.exec('ls', { cwd: nth(real, 1) })).stdout)
      .toContain('also-here.txt')
  })

  test('cwd 落**所有根之外** → `out-of-bounds`，且进程不启动', async () => {
    const { box, roots: real } = sandboxOnAll([freshRoot(), freshRoot()])
    const marker = join(nth(real, 0), 'oops.txt')

    // `tmpdir()` 是两根的**共同父级**——不在任何一根内（「越界＝所有根之外」）
    const result = await box.exec(`touch ${marker}`, { cwd: tmpdir() })

    expect(failureOf(result).reason).toBe('out-of-bounds')
    expect(existsSync(marker)).toBe(false) // 命令有副作用也没发生＝确实没启动
  })

  test('cwd 经 `..` 拱出**默认根** → `out-of-bounds`（第二根接不住）', async () => {
    const { box } = sandboxOnAll([freshRoot(), freshRoot()])

    expect(failureOf(await box.exec('echo hi', { cwd: '..' })).reason).toBe('out-of-bounds')
  })
})

// ══ 判据 2 · 流式 ═════════════════════════════════════════════════════

describe('判据 2 · 流式——增量实时到达', () => {
  test('增量**实时**到——不是跑完才一次性给（首段早于终局数百毫秒）', async () => {
    const { box } = freshSandbox()
    const deltas: OutputDelta[] = []
    let firstDeltaAt = 0

    const started = Date.now()
    const result = await box.exec('printf A; sleep 0.3; printf B', {
      onOutput: (delta) => {
        firstDeltaAt ||= Date.now() - started
        deltas.push(delta)
      },
    })

    expect(deltas.map((delta) => delta.text).join('')).toBe('AB')
    expect(streamsOf(result).stdout).toBe('AB')
    // 首段在命令仍在睡（≈300ms）时就已到手——否则增量语义形同虚设
    expect(firstDeltaAt).toBeGreaterThan(0)
    expect(firstDeltaAt).toBeLessThan(250)
  })

  test('按序——分次写出的 stdout 增量顺序与拼接收束后一致', async () => {
    const { box } = freshSandbox()
    const deltas: OutputDelta[] = []

    const result = await box.exec('printf 1; sleep 0.15; printf 2; sleep 0.15; printf 3', {
      onOutput: (delta) => deltas.push(delta),
    })

    const text = deltas.filter((delta) => delta.channel === 'stdout').map((delta) => delta.text)
    expect(text.join('')).toBe('123')
    expect(text.length).toBeGreaterThan(1) // 确为增量，不是一整块
    expect(text.join('')).toBe(streamsOf(result).stdout) // 拼接 ＝ 终值
  })

  test('两道流各归各的 `channel`——拼接各自等于终值', async () => {
    const { box } = freshSandbox()
    const deltas: OutputDelta[] = []

    const result = await box.exec(
      'printf o1; printf e1 >&2; sleep 0.15; printf o2; printf e2 >&2',
      { onOutput: (delta) => deltas.push(delta) },
    )

    const onChannel = (channel: OutputDelta['channel']): string =>
      deltas.filter((delta) => delta.channel === channel).map((delta) => delta.text).join('')

    const { stdout, stderr } = streamsOf(result)
    expect(onChannel('stdout')).toBe(stdout)
    expect(onChannel('stderr')).toBe(stderr)
    expect(stdout).toBe('o1o2')
    expect(stderr).toBe('e1e2')
  })

  test('不给 `onOutput` 照常跑（回调是可选位）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('echo quiet', {})

    expect(streamsOf(result).stdout).toBe('quiet\n')
  })

  test('多字节字符跨块——增量拼接不产生乱码（解码按流式续接）', async () => {
    const { box } = freshSandbox()
    const deltas: OutputDelta[] = []

    // 1.5KB 中文：足以跨多次读取（每次 read 的块边界不保证落在字符边界上）
    const result = await box.exec('printf "中%.0s" $(seq 1 500)', {
      onOutput: (delta) => deltas.push(delta),
    })

    const joined = deltas.map((delta) => delta.text).join('')
    expect(joined).toBe(streamsOf(result).stdout)
    expect(joined).not.toContain('�')
    expect(joined).toHaveLength(500)
  })
})

// ══ 判据 3 · 超限 ═════════════════════════════════════════════════════

describe('判据 3 · 超限——截断加标记', () => {
  const CAP = 64

  test('超 `maxOutputBytes` → `truncated` ＋ 终值截断（按字节计）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('printf "A%.0s" $(seq 1 500)', { maxOutputBytes: CAP })

    if (!result.ok) throw new Error('期望命令跑过')
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(CAP)
    expect(result.stdout).toBe('A'.repeat(CAP)) // 截到上限为止，不是齐根砍
  })

  test('未超上限 → 不设 `truncated`（字段缺席＝没截）· 全文完好', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('printf "A%.0s" $(seq 1 10)', { maxOutputBytes: CAP })

    if (!result.ok) throw new Error('期望命令跑过')
    expect(result.truncated).toBeUndefined()
    expect(result.stdout).toBe('A'.repeat(10))
  })

  test('恰好等于上限 → 不算截断（边界不多不少）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('printf "A%.0s" $(seq 1 64)', { maxOutputBytes: CAP })

    if (!result.ok) throw new Error('期望命令跑过')
    expect(result.truncated).toBeUndefined()
    expect(result.stdout).toHaveLength(CAP)
  })

  test('截断时增量也**到上限为止**——增量拼接 ＝ 终值 ＝ 上限内前缀', async () => {
    const { box } = freshSandbox()
    const deltas: OutputDelta[] = []

    const result = await box.exec('printf "A%.0s" $(seq 1 500)', {
      maxOutputBytes: CAP,
      onOutput: (delta) => deltas.push(delta),
    })

    const joined = deltas.map((delta) => delta.text).join('')
    if (!result.ok) throw new Error('期望命令跑过')
    expect(joined).toBe(result.stdout)
    expect(Buffer.byteLength(joined)).toBeLessThanOrEqual(CAP)
  })

  test('**每道流各自计**——stdout 截了不牵连 stderr', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('printf "A%.0s" $(seq 1 500); printf "E%.0s" $(seq 1 3) >&2', {
      maxOutputBytes: CAP,
    })

    if (!result.ok) throw new Error('期望命令跑过')
    expect(result.truncated).toBe(true)
    expect(result.stdout).toBe('A'.repeat(CAP))
    expect(result.stderr).toBe('EEE') // 另一道流完好
  })

  test('多字节——截在字符中间不吐乱码（半个字符丢掉，不编造替换符）', async () => {
    const { box } = freshSandbox()

    // 「中」＝ 3 字节；上限 10 字节 ＝ 3 个整字 ＋ 1 字节残片
    const result = await box.exec('printf "中%.0s" $(seq 1 20)', { maxOutputBytes: 10 })

    if (!result.ok) throw new Error('期望命令跑过')
    expect(result.truncated).toBe(true)
    expect(result.stdout).toBe('中中中')
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(10)
  })

  test('大输出不卡死——命令写 5MB、上限 1KB，仍照常收束（读干不辍）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('yes x | head -c 5000000; echo DONE >&2', {
      maxOutputBytes: 1024,
      timeoutMs: 20_000,
    })

    const { stdout, stderr, exit } = streamsOf(result)
    expect(exit).toBe(0) // 没被截断这件事拖死
    expect(okOf(result).truncated).toBe(true)
    expect(stdout.length).toBeLessThanOrEqual(1024)
    expect(stderr).toBe('DONE\n') // 排空到 EOF，命令的收尾输出照样收得到
  })
})

// ══ 判据 4 · 失败三例 ═════════════════════════════════════════════════

/** 断死一例沙箱级失败——顺带把 `reason` 的**排他性**钉住（不许拿别的原因顶账）。 */
function failureOf(result: ExecResult): { reason: string; message: string } {
  if (result.ok) throw new Error(`期望沙箱级失败（ok:false），实为命令跑过：exit=${result.exit}`)
  return { reason: result.reason, message: result.message }
}

describe('判据 4 · 失败三例——各归 `reason`', () => {
  test('超时 → `reason: timeout`（不把 SIGKILL 的 137 当答案）', async () => {
    const { box } = freshSandbox()

    const started = Date.now()
    const result = await box.exec('sleep 5', { timeoutMs: 300 })
    const elapsed = Date.now() - started

    expect(failureOf(result).reason).toBe('timeout')
    expect(elapsed).toBeLessThan(3000) // 真收命了，不是等它自己睡醒
  })

  test('超时**连命令起的孙进程一起收**——不留一窝孤儿', async () => {
    const { box, root } = freshSandbox()
    const marker = join(root, 'escaped.txt')

    // 后台子壳 1 秒后落一个文件；若不按进程组收，超时杀掉的只是直接子进程
    const result = await box.exec(`(sleep 1; touch ${marker}) & sleep 5`, { timeoutMs: 300 })

    expect(failureOf(result).reason).toBe('timeout')
    await new Promise((resolve) => setTimeout(resolve, 1200)) // 熬过后台子壳本该落文件的那一刻
    expect(existsSync(marker)).toBe(false)
  })

  test('cwd 越界 → `reason: out-of-bounds`——**进程不启动**', async () => {
    const { box, root } = freshSandbox()
    const marker = join(root, 'oops.txt')

    const result = await box.exec(`touch ${marker}`, { cwd: tmpdir() }) // tmpdir 在根之外

    expect(failureOf(result).reason).toBe('out-of-bounds')
    expect(existsSync(marker)).toBe(false) // 命令有副作用也没发生＝确实没启动
  })

  test('cwd 经 `..` 拱出根 → 同样归 `out-of-bounds`', async () => {
    const { box } = freshSandbox()

    expect(failureOf(await box.exec('echo hi', { cwd: '..' })).reason).toBe('out-of-bounds')
  })

  test('启动失败（cwd 在根内但不存在）→ `reason: spawn`，且点出 cwd', async () => {
    const { box, root } = freshSandbox()

    const result = await box.exec('echo hi', { cwd: 'no-such-dir' })

    expect(failureOf(result).reason).toBe('spawn')
    // Bun 的 ENOENT 文案指向可执行名（`posix_spawn 'sh'`），真凶通常是 cwd——
    // 报文里补上 cwd，排障才不必反推
    expect(failureOf(result).message).toContain(join(root, 'no-such-dir'))
  })

  test('三例**互不串门**——各归各的 `reason`', async () => {
    const { box } = freshSandbox()

    const reasons = [
      failureOf(await box.exec('sleep 5', { timeoutMs: 200 })).reason,
      failureOf(await box.exec('echo hi', { cwd: '/etc' })).reason,
      failureOf(await box.exec('echo hi', { cwd: 'no-such-dir' })).reason,
    ]

    expect(reasons).toEqual(['timeout', 'out-of-bounds', 'spawn'])
  })
})

describe('判据 4 · 两条实测陷阱——别混为一类', () => {
  test('「命令不存在」＝ exit 127（命令失败）；「cwd 不存在」＝ 启动失败——两界', async () => {
    const { box } = freshSandbox()

    const missingCommand = await box.exec('definitely-not-a-command-xyz', {})
    const badSpawn = await box.exec('echo hi', { cwd: 'no-such-dir' })

    expect(missingCommand.ok).toBe(true) // 沙箱好好的，是命令没找着
    expect(streamsOf(missingCommand).exit).toBe(127)
    expect(failureOf(badSpawn).reason).toBe('spawn') // 沙箱没能把进程立起来
  })

  test('命令**自己**死成 137 ≠ 超时（不从退出码反推沙箱级失败）', async () => {
    const { box } = freshSandbox()

    const selfKilled = await box.exec('kill -9 $$', { timeoutMs: 5000 })
    const timedOut = await box.exec('sleep 5', { timeoutMs: 300 })

    // 同一个 137，两界分明：一个是命令失败（ok:true），一个是沙箱级失败（ok:false）
    expect(streamsOf(selfKilled).exit).toBe(137)
    expect(failureOf(timedOut).reason).toBe('timeout')
  })
})

// ══ 判据 5 · 取消 ═════════════════════════════════════════════════════
//
// 返回形态的取舍（本单元自决 · 已随回报备案，见 `回报/U05.md`·待决一）：
// 冻契约的 `ExecFailureReason` 只有 timeout / out-of-bounds / spawn **三例**，
// **没有取消位**——而三例都是「沙箱级失败」。取消不是沙箱坏了，是调用方叫停，
// 故不挤进 `reason`（挤进去就是拿别人的名分顶账）：取消按**命令被信号终止**返回
// `ok: true` ＋ exit 137（SIGKILL），**取消这件事由调用方自持的 `signal` 判定**——
// 信息不丢：`signal.aborted` 就是那条判据。超时则相反（调用方推不出），故归 `reason`。

describe('判据 5 · 取消——中止在途，返回不抛', () => {
  test('`signal` 中止在途 → 返回（不抛）· 且不再等命令自然结束', async () => {
    const { box } = freshSandbox()
    const controller = new AbortController()

    const started = Date.now()
    const pending = box.exec('sleep 5', { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const result = await pending // ← 若抛，本行即失败
    const elapsed = Date.now() - started

    expect(result, '取消＝返回值，不是异常').toBeDefined()
    expect(typeof result.ok).toBe('boolean')
    expect(elapsed).toBeLessThan(3000)
  })

  test('取消姿态＝命令被信号终止（ok:true · exit 137）——不是沙箱级失败', async () => {
    const { box } = freshSandbox()
    const controller = new AbortController()

    const pending = box.exec('sleep 5', { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const result = await pending

    expect(streamsOf(result).exit).toBe(137) // 被 SIGKILL 收命的退出码
    expect(controller.signal.aborted).toBe(true) // ← 取消的事实由调用方这一侧判定
  })

  test('取消**连孙进程一起收**——不留一窝孤儿', async () => {
    const { box, root } = freshSandbox()
    const marker = join(root, 'escaped-by-cancel.txt')
    const controller = new AbortController()

    const pending = box.exec(`(sleep 1; touch ${marker}) & sleep 5`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await pending

    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(existsSync(marker)).toBe(false)
  })

  test('已中止的信号 → **不启动进程**（副作用不发生）', async () => {
    const { box, root } = freshSandbox()
    const marker = join(root, 'never-ran.txt')
    const controller = new AbortController()
    controller.abort()

    const result = await box.exec(`touch ${marker}`, { signal: controller.signal })

    expect(result.ok).toBe(true)
    expect(streamsOf(result).exit).toBe(137)
    expect(existsSync(marker)).toBe(false)
  })

  test('取消 ≠ 超时——同一批 `sleep 5`，两界分明', async () => {
    const { box } = freshSandbox()
    const controller = new AbortController()

    const canceled = box.exec('sleep 5', { signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const canceledResult = await canceled

    const timedOutResult = await box.exec('sleep 5', { timeoutMs: 200 })

    expect(canceledResult.ok).toBe(true) // 命令跑了、被信号收掉
    expect(failureOf(timedOutResult).reason).toBe('timeout') // 沙箱叫停的
  })

  test('取消前已产出的输出照常带回——增量已实时到手，终值也在', async () => {
    const { box } = freshSandbox()
    const controller = new AbortController()
    const deltas: OutputDelta[] = []

    const pending = box.exec('printf hello; sleep 5', {
      signal: controller.signal,
      onOutput: (delta) => deltas.push(delta),
    })
    setTimeout(() => controller.abort(), 300)
    const result = await pending

    // 被收命不等于白跑——「事先说出来的话」不该因为收尾仓促而丢
    expect(streamsOf(result).stdout).toBe('hello')
    expect(deltas.map((delta) => delta.text).join('')).toBe('hello')
  })

  test('跑完的命令不受信号影响——事后中止不该误伤已终局的结果', async () => {
    const { box } = freshSandbox()
    const controller = new AbortController()

    const result = await box.exec('echo ok', { signal: controller.signal })
    controller.abort() // 事后再中止

    expect(streamsOf(result).exit).toBe(0)
    expect(streamsOf(result).stdout).toBe('ok\n')
  })
})

// ══ 阶段边界 · 选项韧性 ═══════════════════════════════════════════════

describe('阶段边界——五原语齐（U13 补齐四件）', () => {
  test('四原语不再是桩：桩的「未实装」报文消失，真实现按名分报错', async () => {
    const { box, root } = freshSandbox()
    writeFileSync(join(root, 'a.txt'), 'x')

    // 阶段 1 的留桩曾**同步抛「未实装」**（桩要响，不静默给空结果）；
    // U13 实装后同一处是真行为——读得到、写得上、列得出、匹配得中
    expect((await box.read('a.txt')).content).toBe('x')
    await box.write('b.txt', { text: 'y' })
    expect((await box.list('.')).map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(await box.match('a.txt', { mode: 'glob' })).toHaveLength(1)

    // 认不出的路径：给的是**精确名分**（不存在），不是「未实装」
    const failure = await box.read('no-such.txt').then(
      () => '（没抛）',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(failure).toMatch(/不存在/)
    expect(failure).not.toMatch(/未实装/)
  })
})

describe('选项韧性——非法值不悄悄变成另一种语义', () => {
  test('`maxOutputBytes: NaN` 不把输出截光（回落实现常量）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('printf hello', { maxOutputBytes: Number.NaN })

    // NaN 会让「剩余额度」恒为假——不管住就是「全都截掉」，且没有任何报错
    expect(streamsOf(result).stdout).toBe('hello')
    expect(okOf(result).truncated).toBeUndefined()
  })

  test('`timeoutMs: NaN` 不立刻收命（回落实现常量）', async () => {
    const { box } = freshSandbox()

    const result = await box.exec('printf done', { timeoutMs: Number.NaN })

    expect(streamsOf(result).exit).toBe(0)
    expect(streamsOf(result).stdout).toBe('done')
  })

  test('`timeoutMs: 0` / 负数＝回落常量，不是「立刻超时」也不是「无上限」', async () => {
    const { box } = freshSandbox()

    const zero = await box.exec('printf a', { timeoutMs: 0 })
    const negative = await box.exec('printf b', { timeoutMs: -1 })

    expect(streamsOf(zero).exit).toBe(0)
    expect(streamsOf(negative).exit).toBe(0)
  })
})

describe('消费者回调的错——不静默，也不留孤儿', () => {
  test('`onOutput` 抛错：异常上抛（消费者自己的 bug 不吞），且命令被收走', async () => {
    const { box, root } = freshSandbox()
    const marker = join(root, 'leaked.txt')

    // 后台子壳写在**输出之前**：本用例的回调在首个 chunk 上就炸，收命发生在毫秒级——
    // 而 `sh` fork 出后台子壳也要几毫秒，先 fork 后输出才让「收命时子壳已在组内」成为
    // 确定性事实（实测：反过来写会撞上 fork 窗口，子壳逃逸——见回报·已知限度一）。
    await expect(
      box.exec(`(sleep 1; touch ${marker}) & printf tick; sleep 5`, {
        onOutput: () => {
          throw new Error('消费者炸了')
        },
      }),
    ).rejects.toThrow('消费者炸了')

    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(existsSync(marker)).toBe(false) // 抛出去也得把进程收拾干净
  })
})
