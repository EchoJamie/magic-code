/** 仅供显式声明 inlineThinking 的兼容接口使用；未知协议保留正文，不按标签猜测。 */

/** 切出的增量——只可能是这两条通道（`toolcall` 不由此产出）。 */
export type InlineDelta = {
  readonly channel: 'text' | 'thinking'
  readonly text: string
}

/** 正文切分位——生效标记决定实现（原样 / 内嵌思考）。 */
export type TextSplitter = {
  push(text: string): readonly InlineDelta[]
  flush(): readonly InlineDelta[]
}

/** 常规行为——正文原样走 `text`（没有显式内嵌声明时的去处）。 */
export function passthroughSplitter(): TextSplitter {
  return {
    push: (text) => (text.length > 0 ? [{ channel: 'text', text }] : []),
    flush: () => [],
  }
}

/** `buffer` 的尾巴里，最长的一段是 `marker` 的**真前缀**（不含整个 `marker`）的长度。 */
function partialMarkerTailLength(buffer: string, marker: string): number {
  const longest = Math.min(buffer.length, marker.length - 1)
  for (let length = longest; length > 0; length -= 1) {
    if (buffer.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

/**
 * 内嵌思考的切分器——`tag: 'think'` 即认 `<think>` / `</think>`。
 *
 * 状态机只有两态（正文 / 思考）；标签一开一合即翻转，跨增量的半截标签留在 buffer。
 */
export function inlineThinkingSplitter(tag: string): TextSplitter {
  const open = `<${tag}>`
  const close = `</${tag}>`
  let buffer = ''
  let thinking = false

  const channel = (): InlineDelta['channel'] => (thinking ? 'thinking' : 'text')

  return {
    push(text: string): readonly InlineDelta[] {
      buffer += text
      const out: InlineDelta[] = []

      for (;;) {
        const marker = thinking ? close : open
        const at = buffer.indexOf(marker)
        if (at === -1) break
        if (at > 0) out.push({ channel: channel(), text: buffer.slice(0, at) })
        buffer = buffer.slice(at + marker.length)
        thinking = !thinking
      }

      // 剩余部分无完整标签——吐掉安全前缀，留住可能是标签前缀的尾巴（跨增量边界的半截标签）
      const held = partialMarkerTailLength(buffer, thinking ? close : open)
      const safe = buffer.slice(0, buffer.length - held)
      if (safe.length > 0) out.push({ channel: channel(), text: safe })
      buffer = buffer.slice(buffer.length - held)

      return out
    },

    flush(): readonly InlineDelta[] {
      if (buffer.length === 0) return []
      const out: InlineDelta[] = [{ channel: channel(), text: buffer }]
      buffer = ''
      return out
    },
  }
}
