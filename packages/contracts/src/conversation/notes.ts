import type { MemorySource } from './memory.ts'
import type { ResolvedPath, Sandbox } from '../ports.ts'

/**
 * 路径为本会话笔记目录内的规范相对路径；cursor 仅由宿主传递，不展示给模型。
 *
 * 分页与普通文件**同一套**：`from` 从 1 数、`lines` 最多多少行（见 `NotePage`）。
 * 早先这里是字符偏移（`offset`/`limit`）——那样一个工具里就有两种地址，模型把
 * `grep` 报的行号换成偏移得先猜；现在只有行。
 */
export type NoteReadQuery = {
  readonly path?: string
  readonly from?: number
  readonly lines?: number
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
  /** **本页第一行**（1 起）。 */
  readonly from: number
  /** **本页最后一行**（1 起，含）；空文件为 0。 */
  readonly through: number
  /** 整个文件的行数——续读与「已读到末尾」都按它对。 */
  readonly totalLines: number
  readonly complete: boolean
  /** 下一页的第一行；缺席＝已到末尾。 */
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
  /**
   * **内部整写**（不经过业务工具与审批）——给系统的自动行为用（压缩交接把材料写进笔记）。
   *
   * 与工具侧 `write` 的差别只有一条：不做「覆盖前须完整读取」的收据校验；仍然校验路径、
   * 符号链接与并发改变（写入前取当前正文，变了就拒绝）。笔记是模型自己的工作记忆，
   * 不是用户代码，自动整理写它不该弹审批。
   */
  overwrite?(path: string, text: string): Promise<void>
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
    /** 本次压缩生成的接续简报；缺省保留旧摘要文本。 */
    readonly text?: string
  }): number
}
