/** 诊断运行设置；与数据路径、模型配置相互独立。 */
export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const
export type LogLevel = typeof LOG_LEVELS[number]
export type Diagnostics = { readonly debugMode: boolean; readonly logLevel: LogLevel }
export type DiagnosticsChange = Partial<Diagnostics>
export function isLogLevel(value: unknown): value is LogLevel { return LOG_LEVELS.includes(value as LogLevel) }
export function diagnosticsOf(config: DiagnosticsChange): Diagnostics {
  return { debugMode: config.debugMode ?? false, logLevel: config.logLevel ?? 'info' }
}
export function validDiagnosticsChange(value: unknown): value is DiagnosticsChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (v.debugMode !== undefined || v.logLevel !== undefined)
    && (v.debugMode === undefined || typeof v.debugMode === 'boolean')
    && (v.logLevel === undefined || isLogLevel(v.logLevel))
}
