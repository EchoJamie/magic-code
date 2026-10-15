#!/usr/bin/env bun
import { parseDiagnosticsArgs } from './diagnostics.ts'
import type { DiagnosticsChange } from '@magic/contracts'
/** CLI：help/version/离线 check 是只读短路径；交互与脚本均连接选定 Engine。 */

import { homedir } from 'node:os'
import type { KernelEvent, RulesLoad, ModelChoice, ModelSwitchRequest } from '@magic/contracts'
import { resolve } from 'node:path'
import { resolveMagicHome, SOFTWARE_VERSION, NATIVE_PROTOCOL } from '@magic/contracts'
import { resolveModelChoice } from './agent-models.ts'
import { ConfigError, describeConfig } from '@magic/config'
import { workspaceOf } from './run/observation.ts'
import type { AppConnection, AppConnectionOptions } from './run/spawn-manager.ts'
import { attachShell } from './shell.ts'
import { selectedParent } from './components.ts'
import type { ShellScript } from './shell.ts'

const USAGE = `magic —— 软件工程智能体

用法：
  magic [选项]
  magic resume <id> [选项]
  magic help
  magic engine status|start|stop

选项：
  -h, --help          显示帮助
  -v, --version       显示版本
  --model <tier>      选择模型（默认 default）
  --allow-all         本次会话跳过所有操作确认
  --debug             保存并开启调试模式
  --no-debug          保存并关闭调试模式
  --log-level <level> 保存日志等级：error / warn / info / debug / trace
  --check             离线检查配置与工作区
  --settings          只打开本地设置，不连接或启动 Engine
  --script <file>     运行 JSON 脚本，输出 JSONL 事件与摘要

模型选择：default / cantrip / spell / arcane

说明：
  magic 打开交互界面，首次发送消息时创建会话。
  会话 id 可在 /resume 中查看；接回时只展示已有记录，输入后继续执行。
  --allow-all 仅启动时可用，可跳过改权限和改属主等操作的确认。
  不使用 --allow-all 时，改权限和改属主仍需确认。
  删除规则仍直接拒绝，不受 --allow-all 影响。

示例：
  magic --model spell
  magic resume <id>

界面内帮助：/help；模型设置：/model。
脚本格式与示例：README.md「脚本（--script）」。
`

export type Args = {
  readonly diagnostics?: DiagnosticsChange

  readonly version?: boolean
  readonly openRequest?: string
  readonly help: boolean
  readonly check: boolean
  readonly settings?: boolean
  readonly script?: string | undefined
  /**
   * **显式接续**那条会话（`magic resume <id>`）——不给＝新会话（D4：启动不接续）。
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
  let settings = false
  let model: ModelChoice | undefined
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
    if (arg === '--settings') { settings = true; continue }
    if (arg === '--script') {
      script = valueOf('--script', i)
      i += 1
      continue
    }
    if (arg === '--model') {
      const value = valueOf('--model', i)
      if (!['default', 'cantrip', 'spell', 'arcane'].includes(value)) throw new Error('--model 只能选择 default / cantrip / spell / arcane；请在 /model 配置实际型号')
      model = value as ModelChoice
      i += 1
      continue
    }
    if (arg === 'resume' && session === undefined) {
      session = valueOf('resume', i)
      if (session.trim() === '' || session.startsWith('-')) throw new Error('resume 缺少有效会话 id（见 magic --help）')
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
  if (settings && (check || script !== undefined || session !== undefined || model !== undefined || allowAll || openRequest !== undefined || diagnostics)) throw new Error('--settings 仅用于离线配置，请单独使用')
  if (openRequest !== undefined && (check || script !== undefined)) throw new Error('--open-request 仅用于终端接回')

  return {
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(openRequest === undefined ? {} : { openRequest }),
    help: false,
    check,
    ...(settings ? { settings: true } : {}),
    script,
    session,
    ...(allowAll ? { allowAll: true } : {}),
    ...(model === undefined ? {} : { switch: { choice: model } }),
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

function localMagicHome() {
  const home = homedir()
  const selected = resolveMagicHome({ ...process.env, MAGIC_HOME: process.env.MAGIC_HOME?.trim() || selectedParent(home) }, home)
  return { ...selected, base: resolve(selected.base) }
}

async function offlineSettings(): Promise<number> {
  if (process.stdin.isTTY !== true) throw new Error('本地设置需要一个终端，请在终端里运行 magic --settings')
  const { loadConfig } = await import('@magic/config')
  const { terminalSettings } = await import('./run/terminal-settings.ts')
  const { runTui } = await import('@magic/tui')
  const { writeClipboardText } = await import('@magic/execution')
  const magic = localMagicHome(), loaded = loadConfig({ magic }), workspace = workspaceOf(loaded, process.cwd())
  const tui = await runTui({
    settingsOnly: true,
    transport: terminalSettings({ send() { throw new Error('离线设置不执行运行命令') }, subscribe() { return () => {} } }, magic, workspace, undefined, true),
    copyText: writeClipboardText, magicBase: magic.base, dataDir: magic.base, home: magic.home, workspaceRoots: workspace.roots(),
    statusLine: loaded.config.statusLine, reducedMotion: loaded.config.motion?.reduced === true,
    turnDuration: loaded.config.turnDuration,
    receipts: ['本地设置：/model 管理模型与连接，/config 查看配置，/grants 管理授权。保存不启动 Engine；退出后运行 magic 开始工作。'],
  })
  await tui.waitUntilExit(); return 0
}

async function offlineCheck(args: Args): Promise<number> {
  const { loadConfig } = await import('@magic/config')
  const { resolveApiKey } = await import('@magic/model')
  const { createSkills, createProjectRules } = await import('@magic/execution')
  const { skillsCatalog, readGrantView } = await import('./run/observation.ts')
  const { parseRules } = await import('@magic/permission')
  const magic = localMagicHome()
  const loaded = loadConfig({ magic })
  const workspace = workspaceOf(loaded, process.cwd())
  const roots = workspace.roots()
  const chosen = args.switch === undefined ? undefined : resolveModelChoice({ providers: loaded.config.providers, configuredModels: loaded.config.models, config: args.switch })
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
  console.log(`  数据落点　${magic.base}`)
  console.log(`  工作区根　${roots.join(' · ')}`)
  const providers = Object.entries(loaded.config.providers).map(([id, provider]) => `${id}（${provider.name ?? id}）`)
  const current = chosen?.ok ? `${chosen.selection.provider}（${chosen.selection.model}）` : (loaded.providerId ?? '未选供应商')
  if (chosen?.ok) console.log(`—— 本次走 ${current}`)
  console.log(`  供应商表　${providers.length} 条——${providers.join(' · ')} · 当前走 ${current}`)
  console.log(`  权限规则　${rules.rules.length} 条 · 被拒 ${rules.rejected.length} 条`)
  for (const problem of rules.rejected) console.log(`             第 ${problem.index + 1} 条：${problem.reason}`)
  if (args.session !== undefined) {
    const { readSessionSummary } = await import('@magic/records')
    const session = readSessionSummary(magic.base, args.session)
    console.log(`  会话请求　${args.session}（${session === undefined ? '未找到保存记录' : session.archived ? '已归档；需明确恢复后才能接回' : '普通；只读检查未接回'}）`)
  }
  const projectRules = (await createProjectRules({ workspace, sources: loaded.config.rules?.sources ?? [], linkSources: loaded.config.rules?.linkSources ?? [] }).load([]))
  console.log(`  项目规约　${describeProjectRules(projectRules)}`)
  const grants = readGrantView(magic, workspace)
  console.log(`  授权　　　${grants.unreadable === undefined
    ? `${grants.view.grants.length} 条（本工作区） · ${grants.path}${grants.view.stale.length === 0 ? '' : ` · 陈旧的节 ${grants.view.stale.length} 个（/grants 里撤）`}`
    : `读不懂（本次不加载、也不会写它）：${grants.unreadable} · ${grants.path}`}`)
  if (grants.note !== undefined) console.log(`             ${grants.note}`)
  const skills = skillsCatalog((await createSkills({ workspace, magicBase: magic.base, home: magic.home, sources: loaded.config.skills?.sources ?? [] }).discover()))
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

/** 脚本只是另一种客户端：订阅与裁决复用既有驱动，执行全部经选定 Engine。 */
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
  client.onClose((error) => {
    disconnected = error ?? new Error('Magic Code 已退出，脚本已断开')
    rejectPending?.(disconnected)
  })
  client.onLine((line) => rejectPending?.(new Error(line)))
  const waitEvent = (matches: (event: KernelEvent) => boolean): Promise<KernelEvent> => {
    if (disconnected !== undefined) return Promise.reject(disconnected)
    return new Promise((resolve, reject) => {
      const finish = (event: KernelEvent | Error): void => {
        off()
        clearTimeout(timer)
        rejectPending = undefined
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
        const result = waitEvent((event) => event.kind === 'model.switched')
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
      })
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

/** 主动终端接入；测试可显式注入沙地发现与 Engine 路径，产品不增加第二种后台模式。 */
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
      const applied = resolveModelChoice({ providers: loaded.config.providers, configuredModels: loaded.config.models, config: args.switch })
      if (applied === undefined || !applied.ok) {
        console.error(`换模型不成功：${applied === undefined ? '尚未配置可用的供应商' : applied.reason}`)
        return 1
      }
    }
    const modelInfo = await readModelInfo(loaded, magic)
    const { runTui } = await import('@magic/tui')
    const { connectApp } = await import('./run/spawn-manager.ts')
    const connection = terminalConnection(client, async (session) => {
      const reopened = await connectApp({ intent: 'observe', expectedInstance: { base: magic.base }, connect: {
        cwd: process.cwd(), label: 'terminal', reattach: true,
        ...(session === undefined ? {} : { session }),
        ...(args.switch === undefined ? {} : { switch: args.switch }),
        ...(args.allowAll === true ? { allowAll: true } : {}),
      } })
      return reopened.client
    }, args.session)
    closingClient = connection.client
    const tui = await runTui((await terminalOptions({
      client: connection.client, reopen: connection.reopen, loaded, magic, cwd: process.cwd(),
      ...(args.switch === undefined ? {} : { switch: args.switch }),
      ...(args.session === undefined ? {} : { session: args.session }),
      ...(modelInfo === undefined ? {} : { modelInfo }),
    })))
    await tui.waitUntilExit()
    return 0
  } finally {
    closingClient.close()
  }
}

async function main(): Promise<number> {
  if (process.argv[2] === 'engine') {
    const action = process.argv[3]
    if (!['status', 'start', 'stop'].includes(action ?? '') || process.argv.length !== 4) { console.error('用法：magic engine status|start|stop'); return 1 }
    try {
      const { controlEngine } = await import('./run/spawn-manager.ts')
      const result = await controlEngine(action as 'status' | 'start' | 'stop', { home: homedir() })
      console.log(`Magic Engine：${result.state}${result.error ? `（${result.error}）` : ''}\n数据实例：${result.base}`)
      return result.state === 'failed' || result.state === 'unreachable' ? 1 : 0
    } catch (error) { console.error(String(error)); return 1 }
  }
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
    console.log(process.argv.includes('--json') ? JSON.stringify({ component: 'cli', version: SOFTWARE_VERSION, protocol: NATIVE_PROTOCOL }) : `magic ${SOFTWARE_VERSION}`)
    return 0
  }
  try {
    if (args.check) return await offlineCheck(args)
    if (args.settings) return await offlineSettings()
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

// 仅可执行入口启动客户端；导入参数解析或连接函数不启动外壳
// （`bun src/cli.ts` / `bin` 都算「直接跑」，`import.meta.main` 为真）。
if (import.meta.main) process.exit(await main())
