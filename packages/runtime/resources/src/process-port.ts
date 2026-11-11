/**
 * `ProcessPort` 的 Bun 实现——只有这一层知道 `spawnOwned` 与进程组细节。
 * MCP 适配器与工具运行时经端口取进程，不再 import 执行域。
 */
import type { ProcessHandle, ProcessPort, ProcessSpawnOptions } from '@magic/contracts'
import { spawnOwned } from './process.ts'

export function createBunProcessPort(): ProcessPort {
  return {
    async spawn(argv: readonly string[], options: ProcessSpawnOptions): Promise<ProcessHandle> {
      const { process: child } = await spawnOwned(argv, {
        cwd: options.cwd,
        env: options.env,
        stdout: 'pipe',
        stderr: 'ignore',
        keepStdin: options.keepStdin,
        signal: options.signal,
        ledger: options.ledger,
        kind: options.kind,
        what: options.what,
      })
      return {
        pid: child.pid,
        stdin: child.stdin === undefined ? null : {
          write: (data: string | Uint8Array) => child.stdin.write(data),
          flush: () => child.stdin.flush(),
          end: () => child.stdin.end(),
        },
        stdout: child.stdout,
        exited: child.exited.then(code => code ?? 0),
      }
    },
  }
}
