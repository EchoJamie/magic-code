/**
 * 内嵌思考的切分 —— 把 `<tag>…</tag>` 里的内容从正文挪到 `thinking` 通道
 * （技术方案 · 模型策略 · 模型特征标记：归一据**生效标记**决定切不切）。
 *
 * **标记驱动，不是接缝通例**——本文件只被生效标记命中时启用（见 `traits.ts`）；
 * 皆未命中时走 `passthroughSplitter`，正文原样、**不猜不切**。
 *
 * 三条硬要求（都用测试钉住）：
 * ① 标签本身**不出现在任何通道**（`text` 通道不带标签）；
 * ② 流式增量——标签可能**跨增量边界**（`<thi` ＋ `nk>`），故不足一个完整标签的尾巴要留住；
 * ③ 收尾须 flush——流终止时手里留的残片要吐出（不完整的标签按正文算）。
 */

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

/** 常规行为——正文原样走 `text`（皆未命中的唯一去处）。 */
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
 * 状态机只有两态（正文 / 思考）；标签一开一合即翻转。留尾策略见文件头注 ②。
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
