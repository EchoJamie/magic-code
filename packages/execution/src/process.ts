import type { OwnedProcess, ProcessLedger } from '@magic/contracts'
import { signalGroup, startTimeOf } from './groups.ts'

type Output = 'pipe' | 'ignore' | number

/** 固定启动屏障只消费一行；exec 保持 PID，剩余 stdin 留给实际程序。 */
const BARRIER = 'IFS= read -r magic_start && [ "$magic_start" = MAGIC_START ] || exit 125; exec "$@"'

export async function spawnOwned<O extends Output, E extends Output>(argv: readonly string[], options: {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdout: O
  readonly stderr: E
  readonly keepStdin?: boolean
  readonly signal?: AbortSignal
  readonly ledger?: ProcessLedger
  readonly kind: OwnedProcess['kind']
  readonly what: string
}): Promise<{ readonly process: Bun.Subprocess<'pipe', O, E>; readonly startedAt: number }> {
  options.signal?.throwIfAborted()
  const command = argv[0]
  const executable = command && Bun.which(command, { cwd: options.cwd, PATH: options.env?.PATH ?? (options.env ? '' : process.env.PATH) })
  if (!executable) throw Object.assign(new Error('找不到可执行文件'), { code: 'ENOENT' })
  const child = Bun.spawn(['/bin/sh', '-c', BARRIER, 'magic-tool', executable, ...argv.slice(1)], {
    cwd: options.cwd,
    env: options.env === undefined ? undefined : { ...options.env, ...(options.cwd ? { PWD: options.cwd } : {}) },
    stdin: 'pipe', stdout: options.stdout, stderr: options.stderr, detached: true,
  }) as Bun.Subprocess<'pipe', O, E>
  try {
    const startedAt = await startTimeOf(child.pid)
    if (startedAt === undefined) throw new Error(`无法核对工具进程 ${child.pid} 的启动身份，未放行`)
    options.signal?.throwIfAborted()
    await options.ledger?.add({ pgid: child.pid, startedAt, kind: options.kind, what: options.what })
    options.signal?.throwIfAborted()
    child.stdin.write('MAGIC_START\n')
    await child.stdin.flush()
    if (!options.keepStdin) child.stdin.end()
    return { process: child, startedAt }
  } catch (error) {
    child.stdin.end()
    signalGroup(child.pid, 'SIGKILL')
    await child.exited
    throw error
  }
}
