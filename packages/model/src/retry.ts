/**
 * 退避重试 —— 错误分档的**瞬时档处置**（技术方案 · 模型策略 · 错误分档）。
 *
 * 三档各归其位（本文件只管第一档）：
 * - **瞬时**（限流 / 网络）→ **退避重试**（本文件）；
 * - **上下文超限** → 触发压缩后重发（不换模型）——**本轮不做**（压缩归阶段 3 · U19）；
 *   本文件对这一档的态度是**不重试**：它不是「等一会儿就好」的事，重来只是把同一堵墙再撞一遍；
 * - **终态**（内容策略等）→ **停下报告用户**——不重试，原样交给事件流。
 *
 * **为什么重试落在接缝，而不是对话域的主循环**——技术方案 · 错误分档：
 * 「回退逻辑放内核、不依赖 SDK 自动机制」（取件层 `maxRetries: 0` 即为此）。而接缝是
 * **唯一**知道「这次失败发生在什么位置」的地方：SDK 的流是逐块吐的，一旦有内容块越过归一，
 * 内核侧就已经看见半截正文了——那时再重试＝把两次回答拼在一起。故：
 *
 * ① **只在「未定局」时重试**——失败之前**没有任何会产事件的块**越过接缝
 *    （`start` / `start-step` 这类不产事件的块不算），整次尝试**原样丢弃**、重来一次，
 *    于是内核侧只看得见最终成功的那一次（一次 `model.call.start` … 一次 `model.call.end`）；
 * ② **一旦定局**（有内容越过），失败**照原样上报**——半截正文 ＋ `model.error`，不重试；
 * ③ **不做跨供应商回退**（技术方案 · 模型策略：首站不做）——本文件只对**同一个请求**
 *    重来，不换条目、不换模型。调研警示的「流式回退在库层有未决问题」正是②那条：
 *    本文件不碰它，因为「已出内容的重来」压根没做。
 *
 * **重试在事件流里不发声**——`model.error` 是**终局信号**（归一的不变式 ④：其后不再有事件），
 * 拿它兼作「正在重试」的进度信号＝把终局信号用成过程信号，渲染与记录两侧都会误判。
 * 故次数记在**聚合结果**上（`ModelCallResult.attempts`），事件流保持「一次调用」的样子。
 * 进程里的静默等待有代价（用户看着屏幕不动），要补「正在重试」的呈现得先有那个 kind——
 * 见回报「待决」。
 *
 * **退避节奏**——指数（`base × 2^(n-1)`）＋ 上限 `maxDelayMs`；**不加抖动**：单用户 CLI
 * 没有惊群可言，确定性反而让「等了几秒」可被用例钉住。供应商给了 `Retry-After` 则以它为准
 * （仍受上限约束——比上限更长的等待，宁可早点停下报告用户，也不把人晾在屏幕前）。
 */

import { APICallError } from 'ai'
import type { VendorStreamPart } from './normalize.ts'
import type { VendorStreamer } from './ai-sdk.ts'
import { classifyModelError, isAbortError } from './errors.ts'

// —— 策略 ——

/**
 * 退避重试的策略。
 *
 * `maxAttempts` 是**总尝试次数（含首次）**——`1` ＝ 不重试（要关掉重试就说 1，别加开关）。
 */
export type RetryPolicy = {
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

/**
 * 缺省策略——3 次尝试、800ms 起步、上限 8s。
 *
 * 上限刻意压在**十秒以内**：CLI 里「停下来告诉你」比「默默等两分钟」有用；真遇到长窗口的
 * 限流，第三次仍失败即如实上报，由用户决定等多久。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 800,
  maxDelayMs: 8_000,
}

/** 等一会儿——注入点（测试不真等）。`signal` 中止即 reject（抛 AbortError）。 */
export type Sleeper = (delayMs: number, signal?: AbortSignal | undefined) => Promise<void>

export const realSleep: Sleeper = (delayMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortDuringBackoff())
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    function onAbort(): void {
      clearTimeout(timer)
      reject(abortDuringBackoff())
    }

    // `once` —— 中止只该响一次；`removeEventListener` 防的是「等待已结束、信号才响」
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** 退避等待里被中断——名字与措辞走归一的 `isAbortError` 那条路（中断**不是**模型错误）。 */
function abortDuringBackoff(): Error {
  const error = new Error('重试等待被中断')
  error.name = 'AbortError'
  return error
}

// —— 判据 ——

/**
 * 不产事件的块——可以攒着、也可在重试时整批丢弃（丢弃＝当作没发生过）。
 *
 * 只列 `start` / `start-step` 两支（归一里它们本来就返回空）。**刻意取窄**：
 * 多攒一个块，就多一分「攒着的块其实有副作用」的风险；宁可少攒。
 */
const HARMLESS_PART_TYPES: ReadonlySet<string> = new Set(['start', 'start-step'])

/** 值得重试吗——**只有瞬时档**；中断一律不重试（它不是错误，是用户按了停）。 */
function isWorthRetrying(error: unknown): boolean {
  if (isAbortError(error)) return false
  return classifyModelError(error) === 'transient'
}

/**
 * 第 `attempt` 次尝试失败后该等多久（`attempt` 从 1 起）。
 * 供应商给了 `Retry-After`（秒）则以它为准，仍受 `maxDelayMs` 约束。
 */
function delayAfter(attempt: number, error: unknown, policy: RetryPolicy): number {
  const hinted = retryAfterMsOf(error)
  if (hinted !== undefined) return Math.min(hinted, policy.maxDelayMs)

  const backoff = policy.baseDelayMs * 2 ** (attempt - 1)
  return Math.min(backoff, policy.maxDelayMs)
}

/**
 * `Retry-After` 提示（毫秒）——限流响应常带它，照着等能一次到位（省一轮白撞）。
 *
 * 只认**整数秒**这一形（HTTP-date 那一形罕见且要解析日期，不值当）；解析不出即当没给。
 */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (!APICallError.isInstance(error)) return undefined

  const raw = error.responseHeaders?.['retry-after']?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  if (!/^\d+$/.test(raw)) return undefined

  const seconds = Number.parseInt(raw, 10)
  return seconds > 0 ? seconds * 1000 : undefined
}

// —— 装配 ——

/** 策略归一——给了就用（`undefined` ＝缺省）；不合法即当场报（配置错的策略不该等到半夜才现形）。 */
function normalizePolicy(policy: RetryPolicy | undefined): RetryPolicy {
  if (policy === undefined) return DEFAULT_RETRY_POLICY
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(`重试策略的 maxAttempts 须是 ≥1 的整数（现给 ${policy.maxAttempts}）`)
  }
  if (!(policy.baseDelayMs >= 0) || !(policy.maxDelayMs >= policy.baseDelayMs)) {
    throw new Error(
      `重试策略的间隔不合法（baseDelayMs ${policy.baseDelayMs} · maxDelayMs ${policy.maxDelayMs}）`,
    )
  }
  return policy
}

export type RetryOptions = {
  /** 缺省 `DEFAULT_RETRY_POLICY`。 */
  readonly policy?: RetryPolicy | undefined
  /** 等待实现——缺省真等；测试注入以便零耗时。 */
  readonly sleep?: Sleeper | undefined
  /** 每次尝试开工时回调（从 1 起）——聚合结果据它记 `attempts`。 */
  readonly onAttempt?: ((attempt: number) => void) | undefined
}

/**
 * 给取件层流套一层退避重试——**瞬时档**才重来，且**只在未定局时**（见文件头注①）。
 *
 * 输入输出都是取件层流（`VendorStreamPart`）——本层在**归一之下**：归一与内核
 * 都只看得见最终那一次尝试，重试在它们眼里不存在（除了聚合结果上的计数）。
 */
export function withTransientRetry(
  streamer: VendorStreamer,
  options: RetryOptions = {},
): VendorStreamer {
  const policy = normalizePolicy(options.policy)
  const sleep = options.sleep ?? realSleep

  return function retrying(request, streamOptions) {
    return retryLoop()

    async function* retryLoop(): AsyncGenerator<VendorStreamPart> {
      for (let attempt = 1; ; attempt += 1) {
        options.onAttempt?.(attempt)

        /** 攒着的无害块（未定局前不吐——重试时整批丢弃）。 */
        const held: VendorStreamPart[] = []
        let committed = false
        /** 失败两种形态各归各的处理：`error` 块交归一认，抛出照抛（归一的 catch 认）。 */
        let failure: { readonly error: unknown; readonly part?: VendorStreamPart } | undefined

        try {
          for await (const part of streamer(request, streamOptions)) {
            if (part.type === 'error') {
              if (committed) {
                // 已定局——照原样上报（半截正文 ＋ model.error），不重试（文件头注②）
                yield part
                return
              }
              failure = { error: part.error, part }
              break
            }

            if (!committed) {
              if (HARMLESS_PART_TYPES.has(part.type)) {
                held.push(part)
                continue
              }
              // 头一个会产事件的块——自此定局：重试不再安全
              committed = true
              yield* held
              held.length = 0
            }

            yield part
          }

          // 没出错而又走下循环＝流已走完（正常收束）
          if (failure === undefined) return
        } catch (error) {
          // 已定局时抛出照抛（半截内容已出，重来＝拼接两次回答）；未定局则记账待判
          if (committed) throw error
          failure = { error }
        }

        const exhausted = attempt >= policy.maxAttempts
        if (exhausted || !isWorthRetrying(failure.error)) {
          // 不重来——把这次尝试**原样**吐完（该出的事件一条不少），由上层照常收场
          yield* held
          if (failure.part !== undefined) yield failure.part
          else throw failure.error
          return
        }

        await sleep(delayAfter(attempt, failure.error, policy), streamOptions?.signal)
      }
    }
  }
}
