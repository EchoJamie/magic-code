/**
 * sudo 专用认证（U129）——**代码固定执行 `sudo -S -v`**，密码只写认证进程的 stdin。
 *
 * 三条边界：
 * - **不拼 shell**：直接 `spawn(['sudo', '-S', '-v'])`，密码不经命令行参数、环境或文件描述符；
 * - **不进命令**：认证成功之后，原命令另起一条 `sudo -n …`（由权限域算好的 `SudoPlan.run`），
 *   它的 stdin 仍是 `/dev/null`（执行域既有策略），拿不到密码；
 * - **不自动重试**：密码错误 / 取消都只回结果，下一次由用户明确发起。
 *
 * ⚠️ **系统时间戳是全局的**：`sudo -v` 认证的是用户，macOS 的 sudo 时间戳在其有效期内
 * 对同一终端会话的其它 sudo 命令同样有效——这是用户已确认接受的代价，UI 组件须说明。
 */

/** 认证结果——不说密码、不说命令行（那些都不该出现在错误里）。 */
export type SudoValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail?: string }

/** 认证进程的 stdout / stderr 留多少——只为一句话的缘由，不攒整份输出。 */
const MAX_REASON_BYTES = 2_000

function clip(text: string): string {
  const one = text.replace(/\s+/gu, ' ').trim()
  return one.length <= MAX_REASON_BYTES ? one : `${one.slice(0, MAX_REASON_BYTES)}…`
}

/**
 * 用密码跑一次 `sudo -S -v`。
 *
 * 取消时杀认证进程并返回失败；调用方据 `signal.aborted` 区分「取消」与「密码错误」。
 */
export async function validateSudoPassword(
  password: string,
  options: {
    readonly cwd?: string
    readonly env?: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
  } = {},
): Promise<SudoValidation> {
  /** 取消判据——包一层函数，免得 TS 把「已经判过不是」的收窄带过 `await`。 */
  const aborted = (): boolean => options.signal?.aborted === true
  if (aborted()) return { ok: false, detail: '已取消' }

  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(['sudo', '-S', '-v'], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env === undefined ? undefined : { ...options.env, PWD: options.cwd ?? process.cwd() },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  } catch (error) {
    return { ok: false, detail: `无法启动 sudo：${error instanceof Error ? error.message : String(error)}` }
  }

  const killed = (): void => {
    try { proc.kill('SIGTERM') } catch { /* 已经退出 */ }
  }
  options.signal?.addEventListener('abort', killed, { once: true })

  try {
    // 密码只走这一条管道；写完立刻关掉，认证进程再读就是 EOF。
    try {
      proc.stdin.write(`${password}\n`)
      await proc.stdin.flush()
    } catch {
      // sudo 可能已经退出（例如 sudoers 不允许这个用户）——退出码与 stderr 会说明
    }
    try { proc.stdin.end() } catch { /* 已经关了 */ }

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (aborted()) return { ok: false, detail: '已取消' }
    if (code === 0) return { ok: true }

    // stderr 可能带 sudo 的提示（不会回显密码）——只留一句可读的缘由
    const reason = clip([stderr, stdout].filter((text) => text.trim() !== '').join(' '))
    return { ok: false, ...(reason === '' ? {} : { detail: reason }) }
  } catch (error) {
    return { ok: false, detail: `sudo 认证进程失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    options.signal?.removeEventListener('abort', killed)
  }
}
