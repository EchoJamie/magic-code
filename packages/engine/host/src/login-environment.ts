/**
 * **登录 shell 环境**——把「用户自己的环境」采集一次，交给执行域。
 *
 * 为什么需要它：执行者进程的环境取决于**它是怎么被拉起来的**——终端里起（完整）与
 * GUI 里起（launchd 的最小 PATH）不是同一套；而用户在 `.zshrc` / `.bash_profile` 里
 * 配的 PATH、版本管理器、代理，只存在于他的登录 shell 里。拿不到那一份，命令就会
 * 报「找不到可执行文件」，然后靠一条条 `export PATH=…` 去补——那不是环境，是补丁。
 *
 * 采集形态：`$SHELL -ilc 'env -0'`。
 * - `-i` 让 zsh/bash 读交互启动文件（`.zshrc` / `.bashrc`），`-l` 读登录启动文件；
 * - `env -0` 用 NUL 分隔——值里带换行的变量（多行 key、证书）不会被拆成假变量；
 * - stdin 接 /dev/null、stderr 丢弃、硬超时 2s：启动文件卡住或吵闹都不该拖住执行者；
 * - 校验 `PATH` 与 `HOME` 存在，缺任何一个都算采集失败。
 *
 * 失败**不抛**：回落到调用方给的那份环境，并把 `source` 标成 `inherited`——「这份是从哪
 * 来的」必须说得出来，否则排查时会把它当成用户环境。
 *
 * 测试与调试可用 `MAGIC_SHELL_ENV=inherited` 关掉采集（不读真实启动文件）。
 */

import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'

export type LoginEnvironment = {
  /** 执行命令要用的环境（采集成功＝用户登录环境；失败＝传入的那份）。 */
  readonly env: Readonly<Record<string, string>>
  /** 用户的 shell（采到的就是它；`$SHELL` 缺失时按系统账户的 shell 兜底）。 */
  readonly shell: string
  /** 这份环境从哪来——`login-shell` 是真采到的，`inherited` 是回落。 */
  readonly source: 'login-shell' | 'inherited'
}

/** 采集最多等这么久——启动文件卡住时宁可回落，不拖着执行者起不来。 */
const CAPTURE_TIMEOUT_MS = 2_000

/** 用户 shell：环境里的 `$SHELL` 优先，其次系统账户登记的那个，最后 `sh`。 */
function shellOf(inherited: Readonly<Record<string, string>>): string {
  const fromEnv = inherited['SHELL']?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const shell = userInfo().shell?.trim()
    if (shell !== undefined && shell !== '') return shell
  } catch {
    // 取不到账户信息（容器/受限环境）就按 sh 来
  }
  return '/bin/sh'
}

/** `env -0` 的字节流 → 变量表；只认合法变量名，值里允许任意字符（含换行与 `=`）。 */
function parseNul(bytes: Uint8Array): Record<string, string> {
  const env: Record<string, string> = {}
  for (const piece of new TextDecoder().decode(bytes).split('\0')) {
    const at = piece.indexOf('=')
    if (at <= 0) continue
    const key = piece.slice(0, at)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = piece.slice(at + 1)
  }
  return env
}

/** 采一次登录 shell 的环境；失败给 `undefined`（由调用方回落）。 */
function capture(shell: string): Record<string, string> | undefined {
  try {
    // ⚠️ **killSignal 用 SIGKILL**（2026-11-25 实测）：登录交互 shell 可能捕获/忽略
    // SIGTERM，超时后 spawnSync 随之永久挂死——执行者连诊断日志都建不起来，整个
    // 恢复链静默卡死。强杀是「采集失败就回落」这条约定能成立的前提。
    const result = spawnSync(shell, ['-ilc', 'env -0'], {
      encoding: 'buffer',
      timeout: CAPTURE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    if (result.error !== undefined || result.status !== 0 || result.stdout === null) return undefined
    const env = parseNul(result.stdout)
    if (env['PATH'] === undefined || env['HOME'] === undefined || env['PATH'] === '') return undefined
    return env
  } catch {
    return undefined
  }
}

/**
 * 登录环境与调用方给的环境**合并**——调用方显式给的值优先（API key、窗口标记都在那儿），
 * 登录环境补齐它没有的键。
 *
 * `PATH` 单独判：调用方给的那条若**没覆盖登录 PATH 的目录**（GUI 起进程时只有 launchd 的
 * 最小 PATH 就是这种），以登录 PATH 为准并把调用方多出来的目录接在后面；若已经覆盖了
 * （终端里起的进程本就带着用户 PATH），尊重调用方那条。
 */
function merge(inherited: Readonly<Record<string, string>>, login: Readonly<Record<string, string>>): Record<string, string> {
  const merged: Record<string, string> = { ...login, ...inherited }
  const loginPath = login['PATH'] ?? ''
  const inheritedPath = inherited['PATH'] ?? ''
  if (loginPath === '') return merged
  const parts = inheritedPath.split(':')
  if (inheritedPath !== '' && loginPath.split(':').every(dir => dir === '' || parts.includes(dir))) return merged
  const joined = [...loginPath.split(':'), ...parts].filter((dir, index, all) => dir !== '' && all.indexOf(dir) === index)
  if (joined.length > 0) merged['PATH'] = joined.join(':')
  return merged
}

/** 读用户的登录环境——采集一次，失败回落并标源。 */
export function readLoginEnvironment(inherited: Readonly<Record<string, string>>): LoginEnvironment {
  const shell = shellOf(inherited)
  if (inherited['MAGIC_SHELL_ENV'] === 'inherited') return { env: inherited, shell, source: 'inherited' }

  const captured = capture(shell)
  return captured === undefined
    ? { env: inherited, shell, source: 'inherited' }
    : { env: merge(inherited, captured), shell, source: 'login-shell' }
}
