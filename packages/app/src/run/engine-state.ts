import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostDiscovery } from '@magic/contracts'
import { decodeHostDiscovery } from '@magic/contracts'
import { startTimeOf } from '@magic/execution'

export function readEngineState(path: string): HostDiscovery | undefined {
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const value = decodeHostDiscovery(JSON.parse(raw))
  if (!value || !['starting', 'ready', 'stopping', 'stopped', 'failed'].includes(value.state) || !value.lifecycle) throw new Error('Engine 生命周期记录不可读')
  return value
}
export function writeEngineState(path: string, value: HostDiscovery): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('Engine 私有目录不属于当前用户')
  chmodSync(directory, 0o700)
  const temporary = `${path}.${process.pid}.tmp`
  try { writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
  finally { try { unlinkSync(temporary) } catch {} }
}
/** 没有 PID 身份不能把失联判作已经停止。 */
export async function engineAlive(state: HostDiscovery): Promise<boolean | undefined> {
  if (state.pid === undefined || state.startedAt === undefined) return state.state === 'stopped' || state.state === 'failed' ? false : undefined
  try { process.kill(state.pid, 0) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; return undefined }
  const startedAt = await startTimeOf(state.pid)
  if (startedAt === undefined) return undefined
  return Math.abs(startedAt - state.startedAt) <= 1000
}
