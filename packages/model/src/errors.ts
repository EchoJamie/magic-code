/**
 * 错误归一 —— 接缝的**分档**（技术方案 · 模型策略 · 错误分档）。
 *
 * 三档（共享语言 `ModelErrorTier`）与内核动作：
 * - `transient`（限流 / 网络）→ 退避重试；
 * - `context-limit`（上下文超限）→ 触发压缩后重发（不换模型）；
 * - `terminal`（内容策略等）→ 停下报告用户。
 *
 * 分工：**分档在接缝，处置在循环**（技术方案：回退逻辑放内核、不依赖 SDK 自动机制——
 * 故取件层关掉 SDK 自动重试，见 `ai-sdk.ts` 的 `maxRetries: 0`）；退避 / 压缩 / 停下的
 * 策略是 U04 / U17 的事，本层只把「是哪一档」判准并归一成 `model.error`。
 *
 * 密钥纪律：本层产出的**一切文本**先经脱敏——key 永不入记录 / 事件（共享语言 · 配置形制）。
 */

import { APICallError, LoadAPIKeyError } from 'ai'
import type { ModelErrorTier } from '@magic/contracts'

/** 判档用的文本上限——足够容纳错误体，又不至于把整段回声喂进正则。 */
const CLASSIFY_TEXT_LIMIT = 4000

/** 报给用户的错误消息上限——错误也要能一屏读完。 */
const MESSAGE_TEXT_LIMIT = 500

// —— 特征表（判档不绑单一措辞：供应商措辞各异，按特征匹配）——

/**
 * 上下文超限。
 * 先于 HTTP 码判定——它是最具体的信号，且对应**不同动作**（压缩重发，而非退避）。
 */
const CONTEXT_LIMIT_PATTERNS: readonly RegExp[] = [
  /context[\s_-]*(length|window|limit|size)/i,
  /(maximum|max)[\s_-]*context/i,
  /context[\s_-]*length[\s_-]*exceeded/i,
  /too[\s_-]*many[\s_-]*tokens/i,
  /(prompt|input|message|conversation)[\s_-]*(is[\s_-]*)?too[\s_-]*(long|large|big)/i,
  /(reduce|shorten|truncate)[\s_-]*(the[\s_-]*)?(prompt|input|messages?|length|conversation)/i,
  /exceed(s|ed)?[\s_-]*(the[\s_-]*)?(max|maximum)[\s_-]*(context|token)/i,
  /token[\s_-]*(limit|budget)[\s_-]*(exceeded|reached|over)/i,
]

/** 瞬时（限流 / 网络）——HTTP 码缺失或不堪用时的兜底判据。 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /rate[\s_-]*limit/i,
  /too[\s_-]*many[\s_-]*requests/i,
  /(requests?|tokens?)[\s_-]*per[\s_-]*(minute|second|hour|day)/i,
  /overloaded?/i,
  /temporar(y|ily)[\s_-]*(unavailable|failure|error|issue)/i,
  /service[\s_-]*unavailable/i,
  /timed?[\s_-]*out/i,
  /timeout/i,
  /(econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|ehostunreach|econnaborted)/i,
  /socket[\s_-]*(hang[\s_-]*up|closed)/i,
  /(network|connection)[\s_-]*(error|reset|refused|closed|lost|failed)/i,
  /fetch[\s_-]*failed/i,
  /bad[\s_-]*gateway/i,
]

/** 瞬时档的 HTTP 状态码——限流 / 请求超时 / 上游故障。 */
function isTransientStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

// —— 判档 ——

/**
 * 报错对象里可用的文本（消息 + 响应体 + data）——判档与报错共用一份。
 *
 * 去重：`APICallError` 的 `message` 常已内嵌响应体（真端点实测：MiniMax 的 400
 * 会把同一个 JSON 带三遍），原样拼出来是一屏废话——已在场的片段不再重复追加。
 */
function errorTextOf(error: unknown, limit: number): string {
  const chunks: string[] = []

  const push = (text: string | undefined): void => {
    const trimmed = text?.trim()
    if (trimmed === undefined || trimmed.length === 0) return
    if (chunks.some((chunk) => chunk.includes(trimmed))) return
    chunks.push(trimmed)
  }

  if (error instanceof Error) push(error.message)
  else if (typeof error === 'string') push(error)
  else if (error !== null && error !== undefined && typeof error !== 'object') push(String(error))

  if (APICallError.isInstance(error)) {
    push(error.responseBody)
    if (error.data !== undefined) {
      try {
        push(JSON.stringify(error.data))
      } catch {
        // 循环引用等——跳过 data，不影响判档
      }
    }
  }

  return chunks.join(' — ').slice(0, limit)
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

/**
 * 错误分档——把任意的供应商 / SDK / 运行时错误收敛到三档。
 *
 * 判序：**上下文超限特征 → HTTP 码 → 网络特征 → 缺 key → 兜底终态**。
 * 兜底取终态（不取瞬时）：看不懂的错误宁可停下问人，也不要拿退避重试去撞——
 * 技术方案 · 错误分档的终态语义即「停下报告用户」。
 */
export function classifyModelError(error: unknown): ModelErrorTier {
  const text = errorTextOf(error, CLASSIFY_TEXT_LIMIT)

  if (matchesAny(CONTEXT_LIMIT_PATTERNS, text)) return 'context-limit'

  if (APICallError.isInstance(error)) {
    if (isTransientStatus(error.statusCode)) return 'transient'
    // 无状态码＝请求未落地（网络层）——SDK 的 isRetryable 对此为真
    if (error.statusCode === undefined && error.isRetryable) return 'transient'
    return 'terminal'
  }

  if (matchesAny(TRANSIENT_PATTERNS, text)) return 'transient'

  if (LoadAPIKeyError.isInstance(error)) return 'terminal'

  return 'terminal'
}

// —— 中断 ——

/**
 * 中断判定——调用方主动 abort（Ctrl+C）。
 *
 * 中断**不是**模型错误：接缝不发 `model.error`，由结果上的 `aborted` 标记，
 * 处置归主循环（`turn.end` 的 `aborted` 收束方式）。
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const named = error as { name?: unknown; message?: unknown }
  if (named.name === 'AbortError') return true
  const message = typeof named.message === 'string' ? named.message : ''
  return /abort(ed)?[\s_-]*(signal|request|error)?/i.test(message) && message.length < 200
}

// —— 脱敏 ——

/** 兜底的令牌特征——即便调用方没把具体 key 传进来，也别把形似令牌的串写进记录。 */
const GENERIC_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\b(?:sk|api|key|token)[-_][A-Za-z0-9_-]{8,}/gi,
]

/**
 * 脱敏——把具体 key 与形似令牌的串换成 `***`。
 * key 永不入记录 / 事件（共享语言 · 配置形制 · 密钥纪律）——这是最后一道闸，不是唯一一道。
 */
export function redactSecrets(text: string, secret?: string | undefined): string {
  let out = text
  if (secret && secret.length > 0) {
    out = out.split(secret).join('***')
  }
  for (const pattern of GENERIC_SECRET_PATTERNS) {
    out = out.replace(pattern, '***')
  }
  return out
}

/** 归一后的错误消息——已脱敏、已限长，可直接进事件 / 记录 / 屏幕。 */
export function describeModelError(error: unknown, secret?: string | undefined): string {
  const raw = errorTextOf(error, MESSAGE_TEXT_LIMIT).trim()
  const message = raw.length > 0 ? raw : '模型调用失败（未提供错误详情）'
  return redactSecrets(message, secret)
}
