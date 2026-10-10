import { diagnosticsOf, isLogLevel, type Diagnostics, type DiagnosticsChange, type MagicHome } from '@magic/contracts'
import { editConfigFile } from './config-save.ts'
import { loadConfig, parseConfig } from './config.ts'

/** Parse the complete invocation before saving anything. Absence leaves persisted values untouched. */
export function parseDiagnosticsArgs(argv: readonly string[]): DiagnosticsChange | undefined {
  let debugMode: boolean | undefined
  let logLevel: Diagnostics['logLevel'] | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--debug' || arg === '--no-debug') {
      const value = arg === '--debug'
      if (debugMode !== undefined && debugMode !== value) throw new Error('--debug 与 --no-debug 不能同时使用')
      debugMode = value
    } else if (arg === '--log-level') {
      const value = argv[++i]
      if (!isLogLevel(value)) throw new Error('--log-level 须指定 error / warn / info / debug / trace')
      if (logLevel !== undefined && logLevel !== value) throw new Error('--log-level 不能指定不同等级')
      logLevel = value
    }
  }
  return debugMode === undefined && logLevel === undefined ? undefined : {
    ...(debugMode === undefined ? {} : { debugMode }), ...(logLevel === undefined ? {} : { logLevel }),
  }
}
export async function saveDiagnostics(magic: MagicHome, change: DiagnosticsChange, stamp: string | null): Promise<Diagnostics> {
  const path = `${magic.base}/config.json`
  const outcome = await editConfigFile({ path, expectedStamp: stamp, validate: raw => { parseConfig(raw, path, magic) }, update: raw => ({ ok: true, raw: { ...raw, ...(change.debugMode === undefined ? {} : { debugMode: change.debugMode }), ...(change.logLevel === undefined ? {} : { logLevel: change.logLevel }) } }) })
  if (!outcome.ok) throw new Error(outcome.reason)
  return diagnosticsOf(loadConfig({ magic }).config)
}
