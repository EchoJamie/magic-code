import type { MetadataExtractor } from '@ai-sdk/openai-compatible'
import type { JSONValue } from 'ai'

type Detail = Record<string, JSONValue>
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** SDK 原生读取 reasoning_content；这里只保留它默认忽略的回传数据。 */
function detailsOf(raw: unknown, field: 'delta' | 'message'): Detail[] {
  if (!record(raw) || !Array.isArray(raw.choices)) return []
  const choice: unknown = raw.choices[0]
  if (!record(choice)) return []
  const message = choice[field]
  if (!record(message) || message.reasoning_details == null) return []
  const details = message.reasoning_details
  if (!Array.isArray(details) || !details.every(record)) {
    throw new Error('MiniMax reasoning_details 不是对象数组，无法完整保留思考协议数据')
  }
  // raw 来自 SDK 的 JSON 解码；未知字段也必须保留，不能只重建 text。
  return details as Detail[]
}

const metadataOf = (details: Detail[]) =>
  details.length === 0 ? undefined : { magicReasoning: { details } }

/** 按供应商给的块标识合并增量，保留 id、format 等全部字段。 */
export const MINIMAX_REASONING_METADATA: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => metadataOf(detailsOf(parsedBody, 'message')),
  createStreamExtractor() {
    const details: Detail[] = []
    const positions = new Map<string, number>()
    return {
      processChunk(raw) {
        for (const part of detailsOf(raw, 'delta')) {
          const key = typeof part.index === 'number' ? `index:${part.index}`
            : typeof part.id === 'string' ? `id:${part.id}` : undefined
          const position = key === undefined ? undefined : positions.get(key)
          if (position === undefined) {
            if (key !== undefined) positions.set(key, details.length)
            details.push({ ...part })
          } else {
            const previous = details[position]!
            details[position] = {
              ...previous,
              ...part,
              ...(typeof part.text === 'string'
                ? { text: (typeof previous.text === 'string' ? previous.text : '') + part.text }
                : {}),
            }
          }
        }
      },
      buildMetadata: () => metadataOf(details),
    }
  },
}
