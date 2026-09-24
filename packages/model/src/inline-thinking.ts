/**
 * 内嵌思考的切分 —— 把 `<tag>…</tag>` 里的内容从正文挪到 `thinking` 通道
 * （技术方案 · 模型策略 · 模型特征标记：归一据**生效标记**决定切不切）。
 *
 * **标记驱动，不是接缝通例**——切分只按生效标记来（见 `traits.ts`）。三处实现：
 *
 * - 标记命中 ⇒ `inlineThinkingSplitter(tag)`；
 * - 标记明说**无特征**（`traits: {}`）⇒ `passthroughSplitter`，正文原样、**不猜不切**；
 * - 标记**未命中**（不知道这个模型是哪一类）⇒ `probingSplitter`——**看模型自己怎么说**：
 *   **输出以某个已知标签开头**才认（认下并留存），否则原样走 `text`。
 *
 * ⚠️ 探针**不是**「无条件剥标签」：判据是「**以标签开头**」，不是「正文里出现过标签」——
 * 后者会把正常模型正文里引用的一段 `<think>` 也切走。常规模型的第一格输出多半与标签头
 * 八竿子打不着，故它在探针上**一步都不停**（见 `probingSplitter` 的留尾判据）。
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

/** 常规行为——正文原样走 `text`（生效标记**明说无特征**时的去处，见 `probingSplitter`）。 */
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

/**
 * 探针切分位（U65 第二层）——**生效标记未命中**时的第一段：看模型**第一个字**是什么。
 *
 * ## 为什么要有它
 *
 * 内置表是**出厂**那份：供应商每推一个新名字（`MiniMax-M2.7-highspeed` 就是这么来的）
 * 就漏一次，而每次都得靠用户真跑撞出来。加家族主干把「版本号不同」那一类接住了，
 * 但**新名字永远走在表前面**。而真跑里本来就有强信号：**模型自己把思考写在正文开头**。
 *
 * ## 判据（取严）
 *
 * **模型输出以某个已知标签开头**——三个限定词缺一不可：
 * - 「**模型输出**」：探针只装在**模型这条流**上。用户贴进来的东西走的是**输入**，
 *   根本不经过这里；模型「引用」用户那句话也不以标签开头，故同样不认；
 * - 「**以…开头**」：只看**这一格的最前头**。正文中间出现 `<think>` 字样不算数
 *   ——正常模型摘抄一段带标签的文本是常事，那不该被切走；
 * - 「**已知标签**」：认的是内置表里已有的那几个（`knownInlineTags()` 现取），
 *   不是「任何形如 `<x>` 的东西」——认下的是**内嵌思考**这一种行为，不是「尖括号都算」。
 *
 * ## 留尾：常规模型一步都不停
 *
 * 只要已经攒下的字**还是某个标签头的真前缀**（`<` / `<t` / `<thi`…）就先留住——
 * 因为标签**可能跨增量边界**（`<thi` ＋ `nk>`）。除此之外**当场判决**：
 *
 * - 第一格是「你」⇒ 立刻按常规行为办，一个字都不扣；
 * - 第一格是 `<div>` ⇒ 读到 `<d` 就分晓（`<d` 不是任何标签头的前缀），当即按正文吐出去。
 *
 * 故「常规模型照旧」不是靠自觉，是**判据本身**给的：它只在**真看着像标签开头**的那几个
 * 字节上犹豫，而那时犹豫本来就是对的。
 *
 * ## 认下了就记
 *
 * `learn` 在**认下的那一刻**回调一次（带着标签名）——归调用方（网关）记进
 * `LearnedTraits`：这个模型名下一次直接按它办，不必再过探针（见 `traits.ts`）。
 */
export function probingSplitter(input: {
  /** 已知的内嵌思考标签（不带尖括号）——空表＝没得认，直接常规行为。 */
  readonly tags: readonly string[]
  /** 认下时的回调——记进「认下的那些」，供**下一次**直接按它办。 */
  readonly learn?: ((tag: string) => void) | undefined
}): TextSplitter {
  const markers = input.tags
    .filter((tag) => tag.length > 0)
    .map((tag) => ({ tag, open: `<${tag}>` }))

  if (markers.length === 0) return passthroughSplitter()

  /** 攒下的头几个字——**只在还可能是标签头时才非空**（见留尾判据）。 */
  let held = ''
  /** 判下来之后交给谁——判之前是 `undefined`。 */
  let decided: TextSplitter | undefined

  return {
    push(text: string): readonly InlineDelta[] {
      if (decided !== undefined) return decided.push(text)
      held += text

      // 还可能是某个标签头的头一段——留住，别急着当正文吐出去
      if (markers.some((one) => one.open.length > held.length && one.open.startsWith(held))) {
        return []
      }

      const hit = markers.find((one) => held.startsWith(one.open))
      if (hit === undefined) {
        decided = passthroughSplitter()
      } else {
        // 认标签**连同它已经读到的这一段**一起交给内嵌切分器：它就地吃掉开标签、翻进思考态
        decided = inlineThinkingSplitter(hit.tag)
        input.learn?.(hit.tag)
      }

      const pending = held
      held = ''
      return decided.push(pending)
    },

    flush(): readonly InlineDelta[] {
      if (decided !== undefined) return decided.flush()
      if (held.length === 0) return []
      // 到这儿＝流只吐了半截标签头就断了（`<thi`）——**不完整的标签不是标签**，按正文算
      const out: readonly InlineDelta[] = [{ channel: 'text', text: held }]
      held = ''
      return out
    },
  }
}
