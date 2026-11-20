/**
 * **说一句话，拿回一句文字**（U135）——外壳只往草稿里塞字符，别的一概不管。
 *
 * ## 为什么是一条第子进程
 *
 * 说话转写这件事只有 macOS 的 Speech 框架做得好，而它是 Objective-C／Swift 的
 * 异步 API：采音走 `AVAudioEngine`、转写走 `SFSpeechRecognizer`（端侧）。
 * 把它们搬进 TypeScript 这条路不划算，也没必要——**录一句、吐一行 JSON**，
 * 边界就是 stdout 的行，引擎将来换成别的（whisper.cpp 一类）也不用动外壳。
 *
 * 助手源码在 `voice/magic-voice.swift`，事件格式见那边的头注。
 *
 * ## 二进制从哪来
 *
 * 1. **嵌在 CLI 里**：打包时 `build-components.sh` 编好并签名，落在 `voice/build/magic-voice.bin`，
 *    `bun build --compile` 把它嵌进 `magic-cli`（安装产物仍只有那两个组件）。运行时释放到
 *    数据目录的 `voice/`（文件名带内容指纹）再执行。
 * 2. **源码态**（从仓库直接跑）：没有嵌入件，用 `swiftc` 现编一份到同一个 `voice/`。
 *
 * ## 授权
 *
 * 麦克风与语音识别两项权限归**跑命令的那个终端 App**（系统弹窗里显示的是它），
 * 我们既不能代点、也不做自己的开关。拒绝时助手报 `denied`，这里转成一句能照做的话。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 助手往 stdout 吐的每一行（见 `voice/magic-voice.swift` 头注）。 */
type VoiceEvent =
  | { readonly type: 'started' }
  | { readonly type: 'silence' }
  | { readonly type: 'final'; readonly text: string }
  | { readonly type: 'error'; readonly code: string; readonly message?: string }

export type VoiceHandlers = {
  /** 拿到最终文字——**只来一次**。 */
  readonly onFinal: (text: string) => void
  /** 失败：`code` 是助手给的那几个，`message` 是它带的原因（可能没有）。 */
  readonly onError: (code: string, message?: string) => void
}

/** 一次录音的把手：`stop` 收尾转写，`cancel` 直接丢掉（不产生文字）。 */
export type VoiceSession = {
  readonly stop: () => void
  readonly cancel: () => void
}

/**
 * **嵌在 CLI 里的那份二进制**（U135）——打包时编进 `magic-cli`，运行时释放到缓存再执行。
 *
 * 为什么不是「与 CLI 并排放一个文件」：那样安装产物里就多一个可执行文件，
 * 安装、验签、卸载都得为它再添一条账。这里把它当成 CLI 的一部分：**只有 `magic-cli` 一个产物**。
 *
 * 为什么仍然要落地再跑：Bun 的单文件里，嵌入的文件是 `/$bunfs/...` 这样的**虚拟路径**，
 * `posix_spawn` 不认它（实测 ENOENT）。所以读出来写到数据目录，再从那条真路径起进程。
 * 落地的是一份**已经签过名的**可执行文件——签名在 Mach-O 里，复制不会掉，TCC 认的正是它。
 *
 * 文件名带内容指纹：换了版本就换一份，不覆盖正在跑的那条进程。
 */
async function materializeEmbedded(directory: string): Promise<{ path: string } | null> {
  let embedded: string
  try {
    const module = (await import('../voice/build/magic-voice.bin', { with: { type: 'file' } })) as { default: string }
    embedded = module.default
  } catch {
    // 源码态（没打包）：没有嵌入件，交给下面现编那条路。
    return null
  }
  if (!existsSync(embedded)) return null

  let bytes: Buffer
  try { bytes = readFileSync(embedded) } catch { return null }
  // 空文件是**占位**（仓库里没有编好的那份）：当没有。
  if (bytes.length === 0) return null

  const path = join(directory, `magic-voice-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`)
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(path, bytes)
    chmodSync(path, 0o755)
  }
  return { path }
}

/**
 * 源码态那条路：用 `swiftc` 现编一份到缓存。
 *
 * 只在**没打包**（从仓库直接跑）时用得上——装好的包里 CLI 自带编好的那一份。
 */
async function compileFromSource(directory: string): Promise<{ path: string } | { reason: string }> {
  const sources = [
    join(import.meta.dir, '..', 'voice', 'main.swift'),
    join(import.meta.dir, '..', 'voice', 'Hotkey.swift'),
  ]
  const plist = join(import.meta.dir, '..', 'voice', 'Info.plist')
  const cached = join(directory, 'magic-voice')
  const newest = Math.max(0, ...sources.map((one) => (existsSync(one) ? statSync(one).mtimeMs : 0)))
  const fresh = existsSync(cached) && newest > 0 && statSync(cached).mtimeMs >= newest
  if (fresh) return { path: cached }
  if (newest === 0) return { reason: '本机没有可用的语音助手（既没有嵌在 CLI 里的，也找不到源码）。' }

  mkdirSync(dirname(cached), { recursive: true })
  const built = await new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    const child = spawn('swiftc', ['-O', ...sources, '-o', cached, ...(existsSync(plist) ? ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist] : [])], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => resolve({ ok: false, reason: error.message }))
    child.on('close', (code) => { resolve(code === 0 && existsSync(cached) ? { ok: true } : { ok: false, reason: stderr.trim() || `swiftc 退出码 ${String(code)}` }) })
  })
  if (!built.ok) return { reason: `编不出语音助手：${built.reason}` }
  return { path: cached }
}

/** 拿到可用二进制；拿不到就返回原因（**不抛**，由调用方那句话去说）。 */
async function ensureBinary(directory: string): Promise<{ path: string } | { reason: string }> {
  return (await materializeEmbedded(directory)) ?? (await compileFromSource(directory))
}

/**
 * **听「右 ⌥ 单独按一下」**（U135 的新取法）——起一条常驻助手，每次命中回调一次。
 *
 * 为什么不走终端：终端默认编码里没有裸修饰键，要它上报就得开 kitty 的 report-all，
 * 而那个位会把输入法组字的键也送进来（空格不选候选）。改成**本机只读监听**：
 * `CGEvent.tapCreate(.listenOnly)` 只看不改、不吞键，也不记录输入内容。
 *
 * ⚠️ **这一侧听见的是「整台机器」**（D75）：同一下右 ⌥ 会被**每个** Magic 窗口的监听听到。
 * 助手把一次轻点报成**两半**（`down` / `up`），配对与「哪一屏拿焦点」都归外壳判
 * （见 `focus.ts`）——这里只如实转手，不做判断。
 *
 * 首次启用要「输入监控」权限（系统设置 › 隐私与安全性 › 输入监控）；没有权限时
 * 助手起不来、打印一行错误就退出——这一版先不把它接进界面提示。
 *
 * 返回退订函数（TUI 收摊时调，助手随之结束）。
 */
export function startVoiceHotkey(onTap: (phase: 'down' | 'up') => void, options: { readonly directory: string }): () => void {
  let child: ChildProcessWithoutNullStreams | null = null
  let stopped = false

  void (async () => {
    const binary = await ensureBinary(options.directory)
    if ('reason' in binary) return
    if (stopped) return
    const started = spawn(binary.path, ['--listen'], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = started
    let buffer = ''
    started.stdout.setEncoding('utf8')
    started.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.includes('"hotkey"')) continue
        // 老助手只报「按完了」（没有 `phase`）：当松开那一半转手——配对规则见 `focus.ts`。
        onTap(/"phase"\s*:\s*"down"/.test(line) ? 'down' : 'up')
      }
    })
    // stderr 只留作诊断：界面这一版不展示（见上面那条注）。
    started.stderr.resume()
  })()

  return () => {
    stopped = true
    try { child?.kill('SIGTERM') } catch { /* 已经退了 */ }
  }
}

/**
 * 开一次录音。返回时助手可能还没起完——**事件走回调**，调用方只管状态。
 *
 * 失败一律经 `onError` 报（不抛），也**不静默**：说不出来的时候用户要知道为什么。
 */
export function startVoice(handlers: VoiceHandlers, options: { readonly directory: string }): VoiceSession {
  let child: ChildProcessWithoutNullStreams | null = null
  let cancelled = false
  let settled = false

  const settle = (run: () => void): void => {
    if (settled || cancelled) return
    settled = true
    run()
  }

  void (async () => {
    const binary = await ensureBinary(options.directory)
    if ('reason' in binary) {
      settle(() => { handlers.onError('unavailable', binary.reason) })
      return
    }
    if (cancelled) return

    const started = spawn(binary.path, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = started
    let buffer = ''
    let stderr = ''

    started.stdout.setEncoding('utf8')
    started.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        let event: VoiceEvent
        try {
          event = JSON.parse(line) as VoiceEvent
        } catch {
          continue
        }
        if (event.type === 'final') settle(() => { handlers.onFinal(event.text) })
        else if (event.type === 'error') settle(() => { handlers.onError(event.code, event.message) })
      }
    })
    started.stderr.setEncoding('utf8')
    started.stderr.on('data', (chunk: string) => { stderr += chunk })
    started.on('close', () => {
      // 没拿到终局就退了：说清楚是这条进程没了，不假装「没听见」。
      settle(() => {
        handlers.onError('exited', stderr.trim() === '' ? undefined : stderr.trim())
      })
    })
  })()

  return {
    stop: () => {
      // 收尾但照常转写：助手读到这一行就结束采音、等最终结果。
      try { child?.stdin.write('stop\n') } catch { /* 已经退了 */ }
    },
    cancel: () => {
      cancelled = true
      try { child?.kill('SIGTERM') } catch { /* 已经退了 */ }
    },
  }
}
