#!/usr/bin/env bun
import { parseDiagnosticsArgs } from './diagnostics.ts'
import type { DiagnosticsChange } from '@magic/contracts'
/** CLI：help/version/离线 check 是只读短路径；交互与脚本均连接所属 App。 */

import { homedir } from 'node:os'
import type { KernelEvent, RulesLoad, ModelAlias, ModelSwitchRequest } from '@magic/contracts'
import { resolveMagicHome, SOFTWARE_VERSION } from '@magic/contracts'
import type { ModelSwitchResult } from '@magic/model'
import type { RunTuiOptions } from '@magic/tui'
import type { Assembly } from './assembly.ts'
import { resolveModelChoice } from './agent-models.ts'
import { ConfigError, describeConfig } from './config.ts'
import { workspaceOf } from './assembly.ts'
import type { AppConnection, AppConnectionOptions } from './run/spawn-manager.ts'
import { attachShell } from './shell.ts'
import type { ShellScript } from './shell.ts'

const USAGE = `magic —— 软件工程智能体

用法：
  magic [选项]
  magic help

选项：
  -h, --help          显示帮助
  -v, --version       显示版本
  --session <id>      接回已有会话，输入后继续执行
  --model <tier>      选择模型（默认 default）
  --allow-all         本次会话跳过所有操作确认
  --debug             保存并开启调试模式
  --no-debug          保存并关闭调试模式
  --log-level <level> 保存日志等级：error / warn / info / debug / trace
  --check             离线检查配置与工作区，不连接 App
  --script <file>     运行 JSON 脚本，输出 JSONL 事件与摘要

模型选择：default / cantrip / spell / arcane

说明：
  magic 打开交互界面，首次发送消息时创建会话。
  会话 id 可在 /resume 中查看；接回时只展示已有记录。
  --allow-all 仅启动时可用，包括删除、改权限和改属主操作。
  不使用 --allow-all 时，上述操作仍需确认。

示例：
  magic --model spell
  magic --session <id>

界面内帮助：/help；模型设置：/model。
脚本格式与示例：README.md「脚本（--script）」。
`

export type Args = {
  readonly diagnostics?: DiagnosticsChange

  readonly version?: boolean
  readonly openRequest?: string
  readonly help: boolean
  readonly check: boolean
  readonly script?: string | undefined
  /**
   * **显式接续**那条会话（`--session <id>`）——不给＝新会话（D4：启动不接续）。
   *
   * 它是**恢复入口**（`U25`）：给了 id ⇒ 装配开局装载它、`boot` 跑一次恢复
   * （处置在途、重建现场）。**由应用层受理**（`@magic/actions`）——受理在这里，
   * 编排在那儿，本文件只把 id 递过去。
   *
   * ⚠️ **给了它就得在库里**（U28）：`main` 里那一道校验（`records.hasSession`）——
   * 打错一个字母**报错退场**，不静默开一条空的（见 `main` 里那段注）。
   */
  readonly session?: string | undefined
  /** 开局的换模型请求（`--model` 的落地）——两件都没给即 `undefined`。 */
  readonly switch?: ModelSwitchRequest | undefined
  /**
   * **全放行**（U73）——`--allow-all` 带没带。
   *
   * ⚠️ **这是它在产品上的唯一入口**：界面里**没有**任何切进全放行的键位、slash 或设置项
   * ——「开始那一刻」是它唯一的入口，因为**能中途切的，就等于模型能说服用户切、或误按就切**
   * （`设计/工具执行与权限`·「全放行：只在起会话那一刻给」）。它因此不落 `config.json`：
   * 不是配置，是**这一次起会话**的状态；也**不是「模式」**——它只是权限这一维的一个取值。
   */
  readonly allowAll?: boolean | undefined
}

export function parseArgs(argv: readonly string[]): Args {
  if (argv.some(arg => arg === '--help' || arg === '-h') || argv[0] === 'help') return { help: true, check: false }
  const diagnostics = parseDiagnosticsArgs(argv)
  let script: string | undefined
  let check = false
  let model: ModelAlias | undefined
  let session: string | undefined
  let allowAll = false
  let openRequest: string | undefined

  /** 取值——缺值 / 撞上另一个选项即报（`--model --check` 这类笔误不该被当成名字）。 */
  const valueOf = (flag: string, index: number): string => {
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} 缺值（见 magic --help）`)
    }
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--debug' || arg === '--no-debug') continue
    if (arg === '--log-level') { i++; continue }
    if (arg === '--help' || arg === '-h' || (i === 0 && arg === 'help')) return { help: true, check: false }
    if (arg === '--version' || arg === '-v') return { help: false, version: true, check: false }
    if (arg === '--open-request') {
      openRequest = valueOf(arg, i)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(openRequest)) {
        throw new Error('--open-request 必须是 UUID')
      }
      i += 1
      continue
    }
    if (arg === '--check') {
      check = true
      continue
    }
    if (arg === '--script') {
      script = valueOf('--script', i)
      i += 1
      continue
    }
    if (arg === '--model') {
      const value = valueOf('--model', i)
      if (!['default', 'cantrip', 'spell', 'arcane'].includes(value)) throw new Error('--model 只能选择 default / cantrip / spell / arcane；请在 /model 配置实际型号')
      model = value as ModelAlias
      i += 1
      continue
    }
    if (arg === '--session') {
      session = valueOf('--session', i)
      i += 1
      continue
    }
    if (arg === '--allow-all') {
      allowAll = true
      continue
    }
    throw new Error(`不认得的参数「${arg}」（见 magic --help）`)
  }

  if (check && diagnostics) throw new Error('--check 是只读检查，不能与诊断修改参数同时使用')
  if (openRequest !== undefined && (check || script !== undefined)) throw new Error('--open-request 仅用于终端接回')

  return {
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(openRequest === undefined ? {} : { openRequest }),
    help: false,
    check,
    script,
    session,
    ...(allowAll ? { allowAll: true } : {}),
    ...(model === undefined ? {} : { switch: { alias: model } }),
  }
}

/** 读脚本文件——`Bun.file` 是 fs 触达，本包（装配根）在守护的域外，用得起（见守护注）。 */
async function readScript(path: string): Promise<ShellScript> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`脚本文件不存在：${path}`)

  const parsed: unknown = JSON.parse(await file.text())
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`脚本须是对象：${path}`)

  const inputs = (parsed as { inputs?: unknown }).inputs
  if (!Array.isArray(inputs) || !inputs.every(isStep)) {
    throw new Error(
      `脚本的 inputs 须是数组，元素为字符串（交代）、{"switch":{…}}（换模型）` +
        `或 {"input":{…}}（带结构化信息的交代）：${path}`,
    )
  }

  return parsed as ShellScript
}

/** 一步的形态判据——交代（字符串）· 换模型（`{ switch: … }`）· 一整份结构化交代（`{ input: … }`）。 */
function isStep(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

  const step = value as { readonly switch?: unknown; readonly input?: unknown }
  const shape = (one: unknown): boolean => typeof one === 'object' && one !== null && !Array.isArray(one)
  // 两形取其一——`{switch}` 与 `{input}` 各判各的（写混了不该被猜中）
  if (step.switch !== undefined) return shape(step.switch)
  if (step.input !== undefined) return shape(step.input)
  return false
}

async function offlineCheck(args: Args): Promise<number> {
  const { loadConfig } = await import('./config.ts')
  const { resolveApiKey } = await import('@magic/model')
  const { createSkills, createProjectRules } = await import('@magic/execution')
  const { skillsCatalog, readGrantView } = await import('./run/observation.ts')
  const { parseRules } = await import('@magic/permission')
  const magic = resolveMagicHome(process.env, homedir())
  const loaded = loadConfig({ magic })
  const workspace = workspaceOf(loaded, process.cwd())
  const roots = workspace.roots()
  const chosen = args.switch === undefined ? undefined : resolveModelChoice({ providers: loaded.config.providers, aliases: loaded.config.modelAliases, config: args.switch })
  if (args.switch !== undefined && (chosen === undefined || !chosen.ok)) {
    console.error(`换模型不成功：${chosen === undefined ? '尚未配置可用的供应商' : chosen.reason}`)
    return 1
  }
  const providerId = chosen?.ok ? chosen.selection.provider : loaded.providerId
  if (providerId !== undefined) {
    resolveApiKey({ providerId, config: loaded.config.providers[providerId]!, env: process.env, configPath: loaded.path })
  }
  const rules = parseRules(loaded.config.permissions?.rules ?? [])
  console.log('magic —— 离线配置检查')
  console.log(`  ${describeConfig(loaded)}`)
  console.log(`  数据落点　${loaded.config.dataDir}`)
  console.log(`  工作区根　${roots.join(' · ')}`)
  const providers = Object.entries(loaded.config.providers).map(([id, provider]) => `${id}（${provider.name ?? id}）`)
  const current = chosen?.ok ? `${chosen.selection.provider}（${chosen.selection.model}）` : (loaded.providerId ?? '未选供应商')
  if (chosen?.ok) console.log(`—— 本次走 ${current}`)
  console.log(`  供应商表　${providers.length} 条——${providers.join(' · ')} · 当前走 ${current}`)
  console.log(`  权限规则　${rules.rules.length} 条 · 被拒 ${rules.rejected.length} 条`)
  for (const problem of rules.rejected) console.log(`             第 ${problem.index + 1} 条：${problem.reason}`)
  if (args.session !== undefined) console.log(`  会话请求　${args.session}（离线检查不连接或校验会话）`)
  const projectRules = createProjectRules({ workspace, sources: loaded.config.rules?.sources ?? [], linkSources: loaded.config.rules?.linkSources ?? [] }).load([])
  console.log(`  项目规约　${describeProjectRules(projectRules)}`)
  const grants = readGrantView(magic, workspace)
  console.log(`  授权　　　${grants.unreadable === undefined
    ? `${grants.view.grants.length} 条（本工作区） · ${grants.path}${grants.view.stale.length === 0 ? '' : ` · 陈旧的节 ${grants.view.stale.length} 个（/grants 里撤）`}`
    : `读不懂（本次不加载、也不会写它）：${grants.unreadable} · ${grants.path}`}`)
  if (grants.note !== undefined) console.log(`             ${grants.note}`)
  const skills = skillsCatalog(createSkills({ workspace, magicBase: magic.base, home: magic.home, sources: loaded.config.skills?.sources ?? [] }).discover())
  console.log(`  技能　　　${skills.skills.length === 0 ? '无（放 .magic/skills/<名称>/SKILL.md 就来）' : skills.skills.map((one) => `${one.name}（${one.label}）`).join(' · ')}`)
  if (skills.problems.length > 0) console.log(`             有 ${skills.problems.length} 个没读进来`)
  for (const problem of skills.problems) console.log(`             ${problem.path}\n             ${problem.message}`)
  console.log('  外部工具　未连接（离线检查）')
  return 0
}

function describeProjectRules(load: RulesLoad): string {
  const count = (kind: string): number => load.documents.filter((rule) => rule.kind === kind).length

  const roots = count('agents') + count('claude-md')
  const native = count('magic-rules')
  const compat = count('claude-rules')
  const extra = count('source')

  const head =
    load.documents.length === 0
      ? '无（放 AGENTS.md 或 .magic/rules/*.md 就来——根一级的这几份开局就会送到模型）'
      : `${load.documents.length} 份（目录规约 ${roots} · 原生规则 ${native} · 兼容规则 ${compat} · 补充来源 ${extra}）`

  const broken = load.problems.filter((problem) => problem.kind === 'error')
  const chosen = load.problems.filter((problem) => problem.kind === 'choice')
  const lines = [head]

  // **一条占两行**（路径一行、缘由一行），且**一条都不摞在一行里**：
  // 缘由里带着绝对路径与整句说明，摞起来一条就有一百四十来列——八十列的终端会从中间
  // 折断，而这一屏正是用户拿来对着改的地方，读不成行就等于没写。
  // 缩进照「数据落点」那一处的先例；缘由再往里让两格，让「说的是哪个文件」一眼分得开。
  const stated = (problems: typeof load.problems): string =>
    problems
      .map((problem) => `             · ${problem.path}\n               ${problem.message}`)
      .join('\n')

  if (broken.length > 0) {
    lines.push(`             ⚠️ 有 ${broken.length} 条没进来：`, stated(broken))
  }
  // 取舍那几条**照说、不报警**：想查「我写的那份为什么没在管」的人，看的就是这几行
  if (chosen.length > 0) {
    lines.push(`             另有 ${chosen.length} 条按规矩让位（原生优先 / 同目录两份取一）：`, stated(chosen))
  }

  return lines.join('\n')
}

/**
 * **起外壳那一下的入参**——装配 → `runTui` 的全部接线就这一处。
 *
 * **导出是给用例锚的**（照 `scriptOptions` 的先例，缺陷 D16 那笔账）：状态行 ④ 的分母
 * （U20 留的位 · 本轮接的那一跳）落在**本文件的这一行**上，判据要是自己「照同样方式接一遍」
 * 就只咬住了装配那半边——**倒回这一行，用例照样绿**。故把这一处做成**可取件的接缝**：
 * 用例拿 `tuiOptions(assembly).contextWindow` 验，倒回 `contextWindow` 那一句当场红。
 *
 * 分母**从配置里读，不发命令**。⚠️ 别改成「开机发一次 `model.list`」：装配的 `listModels`
 * 会在没会话时 `session.new`（要开一张空壳才盖得出信封），与 D5「空手打开不占存储」相抵。
 * 条目没声明、内置表也不认得 ⇒ `null` ⇒ 屏上只报已用量——**不编**。
 */
export function tuiOptions(assembly: Assembly): RunTuiOptions {
  return {
    transport: assembly.shell,
    boot: () => assembly.boot(),
    // 开机那一刻的读数（外壳那时还不知道模型名）。**此后**每一次切换 / 调用的分母不走这儿
    // ——由事件自带（`model.switched` / `model.call.start` 的 `inputBudget`，U41 返修：
    // 产生处写位），外壳不再拿一张窗长表自己查（旧链已删）。
    contextWindow: assembly.contextWindow,
    // 工作区（U26）：列表按工作区分组要它认「别的项目」——与交给记录域的是**同一个值**
    // （`workspace.roots()`：realpath 后的规范形 · 声明序），一头锚进记录、一头用于认路。
    // `/config` 第 4 行那一格也读它（U71）。
    workspaceRoots: assembly.workspaceRoots,
    // **数据目录与家目录**（U71 · `/config` 第 4 行）——那一格报「配成什么样」，而这两件
    // 是**启动那一刻定下的**（配置 ＋ `MAGIC_HOME`），没有任何命令问得到：故与工作区根
    // 一样，从装配这一侧**递值**（窗口那一侧的同一条，见 `run/terminal.ts`）。
    // 家目录只用来把屏上的路径缩成 `~/…`（省那一格的地方）——**不参与任何解析**。
    dataDir: assembly.config.config.dataDir,
    home: assembly.magic.home,
    // 启动那几句（U22 · 审计第 13 条）：解析从严（读不懂的规则 / 授权**不生效**）原先
    // 只有 `--check` 会说，走 TUI 这条路**一声不响**。话由装配备好（`Assembly.notices`）、
    // 外壳落成记录区的一行回执——**空数组＝启动一句多余的话都不说**。
    receipts: assembly.notices,
  }
}

/**
 * 脚本驱动接的那几件——**导出是给用例锚的**（缺陷 D16 的判据要咬住本文件这一行接线，
 * 而不是只咬住装配那半边）。
 *
 * `onSwitch` **走装配那一条产出路径**（`assembly.switchModel`）：与命令面同一处产
 * `model.switched`（**落库**）——本文件不另存一份状态、也不直调注册表。
 */
export function scriptOptions(
  assembly: Assembly,
  onEvent: (event: KernelEvent) => void,
  /** 换成功时那一行人读的痕迹（真跑给 `console.log`；用例给空实现，别往测试输出里漏）。 */
  note: (line: string) => void = () => {},
): {
  readonly onEvent: (event: KernelEvent) => void
  readonly onSwitch: (request: ModelSwitchRequest) => ModelSwitchResult
  readonly boot: () => Promise<void>
} {
  return {
    onEvent,
    // **启动流转也接上**（U25）：给了 `--session` 就走恢复那一趟。不接的话
    // 「接续 + 恢复」这条链在无人值守里静默缺席——正是本单元要收掉的那种空白。
    boot: () => assembly.boot(),
    onSwitch: (request) => {
      const result = assembly.switchModel(request)
      if (result.ok) {
        note(`—— 换模型：走 ${result.selection.provider}（${result.selection.model}）`)
      }
      return result
    },
  }
}

/** 脚本只是另一种客户端：订阅与裁决复用既有驱动，执行全部经 App 所属核心。 */
export async function runAppScript(args: Args & { readonly script: string }, options: AppConnectionOptions = {}): Promise<void> {
  const script = await readScript(args.script)
  const { client } = await connectTerminal(args, options)
  const { clientTransport } = await import('./run/terminal.ts')
  const queued = [...(script.decisions ?? [])]
  const transport = clientTransport(client)
  const handle = attachShell(transport, {
    timeoutMs: script.timeoutMs,
    decide: () => queued.shift() ?? 'approve',
    onEvent: (event) => {
      if (event.kind !== 'model.delta' && event.kind !== 'tool.output.delta') console.log(JSON.stringify(event))
    },
  })
  let session = args.session
  let switches = 0
  let disconnected: Error | undefined
  let rejectPending: ((error: Error) => void) | undefined
  let needsExecutor = false
  client.onClose((error) => {
    disconnected = error ?? new Error('Magic Code 已退出，脚本已断开')
    rejectPending?.(disconnected)
  })
  client.onDetached((why) => { if (needsExecutor) rejectPending?.(new Error(why)) })
  client.onLine((line) => rejectPending?.(new Error(line)))
  const waitEvent = (matches: (event: KernelEvent) => boolean, execution = false): Promise<KernelEvent> => {
    if (disconnected !== undefined) return Promise.reject(disconnected)
    return new Promise((resolve, reject) => {
      needsExecutor = execution
      const finish = (event: KernelEvent | Error): void => {
        off()
        clearTimeout(timer)
        rejectPending = undefined
        needsExecutor = false
        if (event instanceof Error) reject(event)
        else resolve(event)
      }
      const off = transport.subscribe((event) => { if (matches(event)) finish(event) })
      const timer = setTimeout(() => finish(new Error('等待脚本命令完成超时')), script.timeoutMs ?? 120_000)
      rejectPending = (error) => finish(error)
    })
  }
  client.onTarget((target) => { session = target ?? undefined })
  try {
    for (const step of script.inputs) {
      if (typeof step !== 'string' && 'switch' in step) {
        const result = waitEvent((event) => event.kind === 'model.switched', true)
        client.send({ type: 'model.switch', ...step.switch })
        const event = await result
        if (event.kind !== 'model.switched') throw new Error('换模型未返回结果')
        if (!event.data.ok) throw new Error(`换模型不成功：${event.data.reason}`)
        switches += 1
        console.log(`—— 换模型：走 ${event.data.provider}（${event.data.model}）`)
        continue
      }
      const input = typeof step === 'string' ? { text: step } : step.input
      const ref = crypto.randomUUID()
      let accepted = false
      const completed = waitEvent((event) => {
        if (event.kind === 'input.settled' && event.data.ref === ref) {
          if (!event.data.ok) return true
          accepted = true
          session = event.session
        }
        return accepted && event.kind === 'turn.end' && !event.data.continues && event.session === session
      }, true)
      client.send({ type: 'input.submit', ...input, ref })
      const event = await completed
      if (event.kind === 'input.settled' && !event.data.ok) throw new Error(event.data.reason)
    }
    // 统计沿只读历史接口，客户端不直接打开 records.db。
    let entries = 0
    if (session !== undefined) {
      const history = waitEvent((event) => {
        if (event.kind !== 'session.history' || event.data.session !== session) return false
        entries += event.data.entries.length
        return event.data.done
      })
      client.send({ type: 'history.read', session })
      await history
    }
    console.log(`—— 会话 ${session ?? '未建立'} · 事件 ${handle.events.length} 条 · 条目 ${entries} 条 · 裁决 ${handle.decisions.length} 次 · 换模型 ${switches} 次`)
  } finally {
    handle.dispose()
    client.close()
  }
}

/**
 * **执行者那一支**（U48）——`magic --internal-executor …`。
 *
 * ⚠️ **不是产品命令**：用户敲不出来（`--help` 里一个字都没有），也没有任何一条产品路径
 * 需要它。它是**管理者与执行者之间的私约**——管理者按这几个参数起进程，进程照它连回去
 * （见 `./run/launch.ts` 与 `./run/executor.ts`）。与 `ui.ts` 那条「研发设施不是产品命令」
 * 同一条口径：**别把它写进 USAGE**。
 *
 * 返回 `undefined` ＝ 「这不是执行者那一支」，`main` 接着按普通入口走。
 */
async function runExecutorMode(argv: readonly string[]): Promise<number | undefined> {
  if (argv[0] !== '--internal-executor') return undefined

  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }

  const socket = argv[1]
  const token = valueOf('--token')
  const session = valueOf('--session')
  const cwd = valueOf('--cwd')
  const magicHome = valueOf('--magic-home')
  const magicBase = valueOf('--magic-base')

  if (
    socket === undefined ||
    token === undefined ||
    session === undefined ||
    cwd === undefined ||
    magicHome === undefined ||
    magicBase === undefined
  ) {
    console.error('执行者入参不全——这条入口由管理者调用，不手工跑（见 packages/app/src/run/launch.ts）')
    return 1
  }

  const { runExecutor } = await import('./run/executor.ts')
  const raw = valueOf('--switch')
  const outcome = await runExecutor({
    socket,
    token,
    session: session === '-' ? null : session,
    cwd,
    magic: { home: magicHome, base: magicBase },
    ...(raw === undefined ? {} : { switch: JSON.parse(raw) as ModelSwitchRequest }),
    // **全放行**（U73）——无值的一个开关（`launch.ts` 的 `--allow-all`）。
    // 它是**私约里的那一半**：用户那一侧的名字与说法写在 `USAGE`，用户敲不出来这一支。
    ...(argv.includes('--allow-all') ? { allowAll: true } : {}),
  })

  return outcome.kind === 'ok' ? 0 : 1
}

/** 主动终端接入；测试可显式注入沙地发现/App 路径，产品不增加第二种后台模式。 */
export async function connectTerminal(args: Args, options: AppConnectionOptions = {}): Promise<AppConnection> {
  const { connectApp } = await import('./run/spawn-manager.ts')
  return connectApp({
    ...options,
    intent: 'open',
    ...(args.diagnostics === undefined ? {} : { diagnostics: args.diagnostics }),
    connect: {
      cwd: process.cwd(), label: 'terminal',
      ...(args.session === undefined ? {} : { session: args.session }),
      ...(args.openRequest === undefined ? {} : { openRequest: args.openRequest }),
      ...(args.switch === undefined ? {} : { switch: args.switch }),
      ...(args.allowAll === true ? { allowAll: true } : {}),
    },
  })
}

async function runTerminal(args: Args): Promise<number> {
  if (process.stdin.isTTY !== true) {
    console.error('外壳需要一个终端（stdin 不是 TTY）——请在终端里启动。')
    return 1
  }
  const { client, loaded, magic } = await connectTerminal(args)
  let closingClient = client
  try {
    const { readModelInfo, terminalOptions, terminalConnection } = await import('./run/terminal.ts')
    workspaceOf(loaded, process.cwd())
    if (args.switch !== undefined) {
      const applied = resolveModelChoice({ providers: loaded.config.providers, aliases: loaded.config.modelAliases, config: args.switch })
      if (applied === undefined || !applied.ok) {
        console.error(`换模型不成功：${applied === undefined ? '尚未配置可用的供应商' : applied.reason}`)
        return 1
      }
    }
    const modelInfo = await readModelInfo(loaded)
    const { runTui } = await import('@magic/tui')
    const { reopenApp } = await import('./run/spawn-manager.ts')
    const connection = terminalConnection(client, async (session) => {
      const reopened = await reopenApp({ expectedInstance: { base: magic.base, dataDir: client.dataDir }, connect: {
        cwd: process.cwd(), label: 'terminal',
        ...(session === undefined ? {} : { session }),
        ...(args.switch === undefined ? {} : { switch: args.switch }),
        ...(args.allowAll === true ? { allowAll: true } : {}),
      } })
      return reopened.client
    }, args.session)
    closingClient = connection.client
    const tui = await runTui(terminalOptions({
      client: connection.client, reopen: connection.reopen, loaded, magic, cwd: process.cwd(),
      ...(args.switch === undefined ? {} : { switch: args.switch }),
      ...(args.session === undefined ? {} : { session: args.session }),
      ...(modelInfo === undefined ? {} : { modelInfo }),
    }))
    await tui.waitUntilExit()
    return 0
  } finally {
    closingClient.close()
  }
}

/** 内部管理者入口只能由 App 的专用生命管道调用。 */
async function runManagerMode(argv: readonly string[]): Promise<number | undefined> {
  if (argv[0] !== '--internal-manager') return undefined

  const { runHostedManager } = await import('./run/host-runtime.ts')
  return runHostedManager(argv.slice(1))
}

async function main(): Promise<number> {
  if (process.argv[2] === '--internal-diagnostics') {
    try {
      const argv = process.argv.slice(3)
      const change = parseDiagnosticsArgs(argv)
      if (!change) throw new Error('缺少诊断设置')
      const at = argv.indexOf('--home')
      const home = at < 0 ? undefined : argv[at + 1]
      const { locateHost, readHostDiscovery } = await import('./run/host-discovery.ts')
      const { applyHostDiagnostics } = await import('./run/diagnostics-client.ts')
      const found = readHostDiscovery(locateHost(home === undefined ? {} : { home }))
      if (!found) throw new Error('所属 App 尚未就绪，未修改设置')
      console.error(await applyHostDiagnostics(found, change, 'app'))
      return 0
    } catch (error) { console.error(error instanceof Error ? error.message : '诊断设置未确认'); return 1 }
  }
  // **内部那两支先走**（U48）——它们不认 `--help` 那一族，也不该被 `parseArgs` 拦下
  const asManager = await runManagerMode(process.argv.slice(2))
  if (asManager !== undefined) return asManager

  const asExecutor = await runExecutorMode(process.argv.slice(2))
  if (asExecutor !== undefined) return asExecutor

  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  if (args.help) {
    console.log(USAGE)
    return 0
  }

  if (args.version) {
    console.log(`magic ${SOFTWARE_VERSION}`)
    return 0
  }
  try {
    if (args.check) return await offlineCheck(args)
    if (args.script === undefined) return await runTerminal(args)
  } catch (error) {
    console.error(`${error instanceof ConfigError ? '配置有问题：' : ''}${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  try {
    await runAppScript({ ...args, script: args.script })
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

// **只有被当作入口跑时才真的跑**——`scriptOptions` 导出给用例锚，import 本文件不该起外壳
// （`bun src/cli.ts` / `bin` 都算「直接跑」，`import.meta.main` 为真）。
if (import.meta.main) process.exit(await main())
