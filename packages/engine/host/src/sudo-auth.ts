/**
 * 执行者这一侧的 sudo 认证端口（U129）。
 *
 * 一条链，四个边界：
 * 1. 工具域 `exec` 认出合格的短 sudo → 调 `SudoAuth.authenticate`；
 * 2. 本模块向管理者发 `sudo.request`（只有 `requestId` 与命令，**没有密码**）；
 * 3. 管理者把 UI 的 `sudo.answer` 送回来——密码只在这一跳经过内存；
 * 4. 密码交给执行域的 `validateSudoPassword`（`sudo -S -v` 的 stdin），随后丢弃。
 *
 * 密码**不落事件、不落记录、不进模型上下文**：本模块只认识 `SudoAuth` 与链路消息。
 */

import type { ExecutorToManager, ManagerToExecutor, SudoAuth, SudoAuthResult } from '@magic/contracts'
import { validateSudoPassword } from '@magic/resources'

export type SudoAuthLink = {
  send(message: ExecutorToManager): boolean
}

export type SudoAuthPort = {
  readonly auth: SudoAuth
  /** 管理者送回来的答复——由执行者的消息循环转进来。 */
  answer(message: Extract<ManagerToExecutor, { t: 'sudo.answer' }>): void
  /** 轮收束 / 收摊：在途认证一律取消，原命令不启动。 */
  cancelAll(): void
}

export function createSudoAuth(options: {
  readonly link: SudoAuthLink
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** 测试可换掉实际认证那一跳；缺省＝真的 `sudo -S -v`。 */
  readonly validate?: (password: string, input: { cwd: string; env?: Readonly<Record<string, string>>; signal?: AbortSignal }) => Promise<{ ok: boolean; detail?: string }>
}): SudoAuthPort {
  const waiting = new Map<string, (answer: { password?: string; cancelled?: boolean }) => void>()
  const validate = options.validate ?? ((password, input) => validateSudoPassword(password, input))

  const port: SudoAuth = {
    authenticate: ({ command, cwd, signal }) => new Promise<SudoAuthResult>((resolve) => {
      if (signal?.aborted === true) {
        resolve({ ok: false, reason: 'cancelled' })
        return
      }
      const requestId = crypto.randomUUID()
      let done = false
      const finish = (result: SudoAuthResult): void => {
        if (done) return
        done = true
        waiting.delete(requestId)
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const onAbort = (): void => {
        options.link.send({ t: 'sudo.cancel', requestId, reason: '已取消' })
        finish({ ok: false, reason: 'cancelled' })
      }

      waiting.set(requestId, (answer) => {
        if (answer.cancelled === true) {
          finish({ ok: false, reason: 'cancelled' })
          return
        }
        const password = answer.password ?? ''
        void validate(password, {
          cwd: cwd ?? options.cwd,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(signal === undefined ? {} : { signal }),
        }).then(
          (valid) => finish(valid.ok ? { ok: true } : {
            ok: false,
            reason: 'failed',
            ...(valid.detail === undefined ? {} : { detail: valid.detail }),
          }),
          (error: unknown) => finish({
            ok: false,
            reason: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
      })

      signal?.addEventListener('abort', onAbort, { once: true })
      if (!options.link.send({ t: 'sudo.request', requestId, command })) {
        finish({ ok: false, reason: 'failed', detail: '管理者连接不可用' })
      }
    }),
  }

  return {
    auth: port,
    answer(message) {
      const settle = waiting.get(message.requestId)
      if (settle === undefined) return // 迟到 / 重复答复——静默
      waiting.delete(message.requestId)
      settle(message.cancelled === true ? { cancelled: true } : { password: message.password ?? '' })
    },
    cancelAll() {
      for (const requestId of [...waiting.keys()]) {
        options.link.send({ t: 'sudo.cancel', requestId, reason: '这一轮已收束' })
      }
      for (const settle of [...waiting.values()]) settle({ cancelled: true })
      waiting.clear()
    },
  }
}
