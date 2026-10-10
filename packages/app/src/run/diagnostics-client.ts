import { homedir } from 'node:os'
import type { DiagnosticsChange } from '@magic/contracts'
import { configStamp } from '../cache-access.ts'
import { runSettingsCall } from '../settings-call.ts'

/** 入口已确定配置实例；诊断保存与 Engine 是否在线无关。 */
export async function applyHostDiagnostics(target: { readonly base: string }, change: DiagnosticsChange, source: 'app' | 'cli' = 'cli', home = homedir(), environment = process.env): Promise<string> {
  const configPath = `${target.base}/config.json`
  const result = await runSettingsCall({ request: crypto.randomUUID(), home, base: target.base, configPath,
    stamp: configStamp(configPath), action: { type: 'diagnostics.set', source, ...change } }, environment)
  if (!result.saved) throw new Error(result.error ?? '诊断设置未保存')
  return result.note! + (result.error ? `；${result.error}` : '')
}
