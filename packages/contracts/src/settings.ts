import type { DiagnosticsChange } from './diagnostics.ts'
import type { AgentRoleConfig, StatusLineConfig } from './config.ts'
import type { ProviderSaveRequest, ModelConfigureRequest } from './control.ts'
import type { McpServerConfig } from './mcp.ts'
import type { ProviderModelOverride } from './model.ts'

/** 窄设置动作；不接收任意命令、路径补丁或整份配置覆写。 */
export type SettingsAction =
  | ({ readonly type: 'diagnostics.set'; readonly source?: 'app' | 'cli' } & DiagnosticsChange)
  | ({ readonly type: 'provider.save' } & ProviderSaveRequest)
  | { readonly type: 'provider.remove'; readonly provider: string }
  | ({ readonly type: 'model.configure' } & ModelConfigureRequest)
  | { readonly type: 'model.clear'; readonly choice: string }
  | { readonly type: 'model.override'; readonly provider: string; readonly model: string; readonly override: ProviderModelOverride | null }
  | { readonly type: 'model.refresh'; readonly provider: string }
  | { readonly type: 'prefs.set'; readonly statusLine?: StatusLineConfig; readonly reducedMotion?: boolean }
  | { readonly type: 'mcp.save'; readonly name: string; readonly server: McpServerConfig; readonly secrets: Readonly<Record<string, string | null>> }
  | { readonly type: 'mcp.remove'; readonly name: string }
  | { readonly type: 'mcp.reconnect'; readonly name: string; readonly session: string; readonly gen: number }
  | { readonly type: 'sources.set'; readonly source: 'rules.sources' | 'rules.linkSources' | 'skills.sources'; readonly paths: readonly string[] }
  | { readonly type: 'role.save'; readonly id: string; readonly role: AgentRoleConfig }
  | { readonly type: 'role.remove'; readonly id: string }
  | { readonly type: 'workspace.set'; readonly roots: readonly string[] | null }
  | { readonly type: 'permissions.set'; readonly rules: readonly unknown[] }
  | { readonly type: 'data.set'; readonly directory: string | null }
  | { readonly type: 'grants.revoke'; readonly workspace: string; readonly index?: number; readonly grantStamp: string | null }

/** configuration 仅包含已知可编辑字段，凭据值绝不返回。 */
export type SettingsSnapshot = {
  readonly preview: Readonly<Record<string, unknown>>
  readonly configPath: string
  readonly dataDir: string
  readonly base: string
  readonly stamp: string | null
  readonly configuration: Readonly<Record<string, unknown>>
  readonly catalog: readonly unknown[]
  readonly vendors: readonly unknown[]
  readonly sources: readonly { readonly source: string; readonly path: string; readonly resolved: string; readonly problem?: string }[]
  readonly grants: readonly { readonly workspace: string; readonly entries: readonly unknown[] }[]
  readonly grantStamp: string | null
  readonly grantProblem?: string
  readonly mcp: readonly { readonly session: string; readonly gen: number | null; readonly servers: readonly unknown[] }[]
  readonly canChangeData: boolean
}

export type SettingsPreview = { readonly statusLine: StatusLineConfig; readonly columns: number; readonly reducedMotion: boolean }
