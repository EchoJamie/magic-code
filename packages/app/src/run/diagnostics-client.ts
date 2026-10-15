import { homedir } from 'node:os'
import type { DiagnosticsChange } from '@magic/contracts'
import { configStamp } from '@magic/config'
import { saveDiagnostics } from '../diagnostics.ts'

/** 入口已确定配置实例；诊断保存与 Engine 是否在线无关。 */
export async function applyHostDiagnostics(target: { readonly base: string }, change: DiagnosticsChange, home = homedir()): Promise<string> {
  const configPath = `${target.base}/config.json`
  await saveDiagnostics({ home, base: target.base }, change, configStamp(configPath))
  return '诊断设置已保存；运行中的入口随后采用，离线入口下次启动采用'
}
