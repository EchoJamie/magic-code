import type { BackgroundRunning, BackgroundFinish, BackgroundStop } from './ports.ts'

export type BackgroundTarget = { readonly execution: string; readonly session: string; readonly id: string }
export type BackgroundCommand = BackgroundRunning & BackgroundTarget & { readonly member?: string; readonly agent?: string }
export type BackgroundView = {
  readonly commands: readonly BackgroundCommand[]
  readonly waiting: readonly string[]
  readonly unknown?: true
  readonly result?: { readonly target: BackgroundTarget; readonly outcome: BackgroundStop }
}
export type BackgroundCommandRequest =
  | { readonly type: 'background.list' }
  | { readonly type: 'background.stop'; readonly target: BackgroundTarget }

export type BackgroundChange = BackgroundFinish | {
  readonly id: string; readonly command: string; readonly outputPath: string
  readonly state: 'unconfirmed'; readonly reason: string; readonly stoppedBy: 'user' | 'model'
}
