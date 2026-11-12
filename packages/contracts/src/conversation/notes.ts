import type { MemorySource } from './memory.ts'
import type { ResolvedPath, Sandbox } from '../ports.ts'

/** 路径为本会话笔记目录内的规范相对路径；cursor 仅由宿主传递，不展示给模型。 */
export type NoteReadQuery = {
  readonly path?: string
  readonly offset?: number
  readonly limit?: number
  readonly cursor?: string
}
export type NoteLink =
  | { readonly kind: 'note'; readonly label: string; readonly path: string }
  | { readonly kind: 'source'; readonly label: string; readonly source: MemorySource; readonly inputRef?: string }
  | { readonly kind: 'unavailable'; readonly label: string; readonly target: string; readonly reason: string }
export type NotePage = {
  readonly session: string
  readonly path: string
  readonly absolute: string
  readonly text: string
  readonly offset: number
  readonly total: number
  readonly complete: boolean
  readonly next?: number
  readonly cursor: string
  readonly links: readonly NoteLink[]
}
export type NoteState = {
  readonly directory: string
  readonly path: string
  readonly status: 'ready' | 'empty' | 'entry-missing' | 'missing' | 'changed'
  readonly files: readonly string[]
  readonly page?: NotePage
}

/** 每个调用者持有自己的完整读取依据；同会话的保存由执行域串行。 */
export interface WorkingNotes {
  readonly directory: string
  read(query?: NoteReadQuery): Promise<NoteState>
  snapshot(): Promise<Readonly<Record<string, string>>>
  writes(): Readonly<Record<string, string>>
  resolve(path: string): ResolvedPath | undefined
  bindTarget(target: ResolvedPath, tool: string, signal?: AbortSignal): { sandbox: Sandbox; release(): Promise<void> }
  saved(): number
  fork(pageLimit?: number): WorkingNotes
}

export type ContextCoverage = { readonly summary: number | null; readonly coveredThrough: number | null }
export interface CoverageRecords {
  read(): ContextCoverage
  publish(input: {
    readonly previousSummary: number | null
    readonly from: number
    readonly through: number
    readonly at: number
    readonly compact?: { readonly requestId: string; readonly focus?: string }
    readonly notesSaved: boolean
  }): number
}
