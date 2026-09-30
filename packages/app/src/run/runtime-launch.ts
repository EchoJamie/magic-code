import { realpathSync } from 'node:fs'

/** 装配唯一决定源码 / 发行启动形态；内部进程不再寻找源码或全局 Bun。 */
export function runtimeLaunch(entry?: string): readonly string[] {
  if (entry !== undefined) return [process.execPath, entry]
  return Bun.isStandaloneExecutable
    ? [realpathSync(process.execPath)]
    : [process.execPath, new URL('../cli.ts', import.meta.url).pathname]
}

export function softwareSource(): string {
  return realpathSync(runtimeLaunch().at(-1)!)
}
