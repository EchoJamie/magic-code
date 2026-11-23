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
import { tmpdir } from 'node:os'
import { resolveMagicHome, type MagicHome, type ModelSwitchRequest } from '@magic/contracts'
import { runPathsOf } from './paths.ts'
import { socketHandlers, linkOf, type Link, type ManagerToExecutor } from './wire.ts'
import { createWorkEnvironment } from './work-environment.ts'
import { runExecutor } from './executor.ts'

export type ExecutorProcessArgs = {
  readonly executionId: string
  readonly home: string
  readonly parent: string
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
    home: value('--home'),
    parent: value('--parent'),
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
 * 与 `runEngine` 同款的身份解析：`home` 是数据实例落点，`parent` 决定基础路径。
 */
export async function runExecutorProcess(argv: readonly string[]): Promise<number> {
  let args: ExecutorProcessArgs
  try { args = parseArgs(argv) }
  catch (error) { console.error(String(error instanceof Error ? error.message : error)); return 1 }

  const magic: MagicHome = resolveMagicHome({ MAGIC_HOME: args.parent }, args.home)
  const paths = runPathsOf(magic, tmpdir())

  const controller = new AbortController()
  process.on('SIGTERM', () => controller.abort())
  process.on('SIGINT', () => controller.abort())

  const socket = await Bun.connect({ unix: paths.socket, socket: socketHandlers() })
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
