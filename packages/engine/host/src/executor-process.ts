/**
 * 执行者子进程入口——`magic-engine executor …` 那条路。
 *
 * 独立子进程 = 真并行 + 故障隔离：崩了只带走自己（管理者的其他会话照常），失控了
 * 有 SIGTERM/SIGKILL 兜底。与管理者之间只有一条 socket 连接：
 *
 *   连上 → `executor.hello`（发车令牌配对）→ `runExecutor`（装配、报 ready、服务到收摊）
 *
 * 数据面：自己开库连接（WAL 多进程），写等待给有界值——写撞上的那一刻排队而不是
 * 整轮失败。账本自己记；变动经 `ledger.owned` 自报给管理者（崩溃后的收回依据）。
 */
import type { MagicHome, ModelSwitchRequest } from '@magic/contracts'
import { socketHandlers, linkOf, type Link, type ManagerToExecutor } from './wire.ts'
import { createWorkEnvironment } from './work-environment.ts'
import { runExecutor } from './executor.ts'

export type ExecutorProcessArgs = {
  readonly executionId: string
  readonly home: string
  /** **解析好的统一基础路径与监听地址**——发车时管理者注入，子进程不自取（「配置注入」同向）。 */
  readonly base: string
  readonly socket: string
  readonly cwd: string
  readonly session: string | null
  readonly switch?: ModelSwitchRequest | undefined
}

function parseArgs(argv: readonly string[]): ExecutorProcessArgs {
  const value = (name: string): string => {
    const at = argv.indexOf(name)
    const found = at < 0 ? undefined : argv[at + 1]
    if (found === undefined || found === '') throw new Error(`缺少启动参数 ${name}`)
    return found
  }
  const session = argv.includes('--session') ? value('--session') : null
  const switchAt = argv.indexOf('--switch')
  return {
    executionId: value('--execution-id'),
    socket: value('--socket'),
    home: value('--home'),
    base: value('--base'),
    cwd: value('--cwd'),
    session,
    ...(switchAt < 0 ? {} : { switch: JSON.parse(argv[switchAt + 1]!) as ModelSwitchRequest }),
  }
}

/** 子进程自己的环境——发车时已按 `network.env` 合成过，这里原样快照。 */
function ownEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * 跑一个执行者子进程；返回退出码（0 = 正常收场，1 = 失败）。
 *
 * 管理者交付已解析的基础路径和监听地址，执行者使用同一运行身份。
 */
export async function runExecutorProcess(argv: readonly string[]): Promise<number> {
  let args: ExecutorProcessArgs
  try { args = parseArgs(argv) }
  catch (error) { console.error(String(error instanceof Error ? error.message : error)); return 1 }

  // 发车单已带解析好的落点与地址——子进程不自推导（「配置注入」同向）。

  const magic: MagicHome = { home: args.home, base: args.base }

  // **裸 SIGTERM/SIGINT 只记录、不响应**——停止的权威在管理者：`bye`（优雅收场）
  // 或宽限后的 SIGKILL 兜底，两者都不依赖裸信号。实测本机环境存在对子进程的
  // **零星 SIGTERM**（来源不在本仓任何代码路径——manager 与 child 两侧都钩过
  // `process.kill` 均无调用；独立进程组也不豁免）。若响应它，一次幽灵信号就
  // 中断整轮工作——宁可通过管理者的停止路径收，也不吃来历不明的信号。
  const why = (n: string): void => { console.error(`[executor-child] ${n} @${Date.now() % 100000} (仅记录)`) }
  process.on('SIGTERM', () => why('SIGTERM'))
  process.on('SIGINT', () => why('SIGINT'))
  const controller = new AbortController()

  const socket = await Bun.connect({ unix: args.socket, socket: socketHandlers() })
  const link = linkOf(socket)
  // 报到——配不上号（管理者不认识这个令牌）连接会被当场关掉，装配那头经 onClose 收摊。
  link.send({ t: 'executor.hello', executionId: args.executionId })

  const { createRecordsStore } = await import('@magic/data')
  const store = createRecordsStore({ dataDir: magic.base, workspace: [], busyTimeoutMs: 5_000 })
  const { createProcessLedger } = await import('@magic/resources')
  const ledger = createProcessLedger(owned => { link.send({ t: 'ledger.owned', owned }) })

  const environment = ownEnvironment()
  const outcome = await runExecutor({
    executionId: args.executionId,
    network: createWorkEnvironment(environment),
    environment,
    link: link as unknown as Link<ManagerToExecutor>,
    records: store,
    ledger,
    signal: controller.signal,
    session: args.session,
    cwd: args.cwd,
    magic,
    ...(args.switch === undefined ? {} : { switch: args.switch }),
  })
  store.close()
  return outcome.kind === 'ok' ? 0 : 1
}
