/**
 * 网页正文 → markdown（U72）——「取回」与「提炼」中间那一步。
 *
 * 出处：设计 · 网页与搜索「两件工具」表：**抓一个 URL → 转成 markdown → 让一次模型调用
 * 按问题提炼**。这一步管中间那一跳。
 *
 * ## 为什么自己写，不取件
 *
 * 与契约那两个纯函数同一条取向（`@magic/tools` 只依赖 `@magic/contracts`，不加运行时依赖）：
 * 这一件要的东西是**有界的**——把正文的块级结构、链接、列表、代码这些**读得出来的形**留下来，
 * 够模型按问题找答案即可。真正的解析器（HTML5 容错那一整套）为的是**像素级还原**，
 * 而这一趟的终点是**一个模型读这一段字**，不是浏览器渲染它。
 *
 * ## 它做得成什么、做不成什么（都写在这儿，别指望读代码推）
 *
 * 做得成：丢脚本 / 样式 / 注释 / `head`，块级元素之间留空行，标题成 `#`，
 * 列表成 `-` / `1.`，链接成 `[文字](地址)`，图片成 `![说明](地址)`，代码块成围栏，
 * 表格按行铺成 `|` 格，实体解码，空白折叠。
 *
 * 做不成（**有意**）：不还原 CSS 布局、不做 DOM 树、不处理 `<template>` 里的影子内容、
 * 不纠正畸形嵌套。⚠️ 一个已知的粗处：正文里裸写的 `<`（如「a < b」）会被当成标签的开头
 * ——真实的 HTML 正文里这本来也该写成 `&lt;`，不为此再上一套解析器。
 */

/** 转出来的那两件——`title` 给回执抬头用（取不到就不给）。 */
export type PageText = {
  readonly title?: string
  readonly markdown: string
}

/** 块级元素——进出都保证与前后隔开（成段）。 */
const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'main', 'menu', 'nav', 'p',
  'section', 'summary', 'table', 'tbody', 'tfoot', 'thead',
])

/** 整块丢掉的东西——它们要么不是正文，要么这一件读不懂。 */
const NOISE = /<(script|style|noscript|template|svg|iframe|canvas|head)\b[^>]*>[\s\S]*?<\/\1>/giu

const TOKEN = /<[^>]*>/gu
const TAG_NAME = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/u

export function htmlToMarkdown(html: string): PageText {
  const title = titleOf(html)
  const body = html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(NOISE, ' ')
    // 没闭合的那几个（少见，但漏掉的话整页正文会被当脚本吞掉）
    .replace(/<(script|style|noscript|template|svg|iframe|canvas)\b[^>]*>/giu, ' ')

  const out: string[] = []
  let buffer = ''
  /** `<pre>` 深度——里面的空白**一个字都不许折叠**（代码靠它）。 */
  let pre = 0
  /** `<blockquote>` 深度——行首加 `> `（引用是语义，丢了模型读不出那是引用）。 */
  let quote = 0
  /** 链接栈——`<a>` 可以套着别的内联元素。 */
  const links: (string | undefined)[] = []
  /** 列表栈——`-1` ＝无序，`>= 0` ＝有序的**下一个序号**。 */
  const lists: number[] = []

  /** 保证结尾至少有 `n` 个换行（多不退——末尾统一收）。 */
  const ensure = (n: number): void => {
    buffer = buffer.replace(/[ \t]+$/u, '')
    const trailing = /\n+$/u.exec(buffer)?.[0].length ?? 0
    if (trailing < n) buffer += '\n'.repeat(n - trailing)
  }

  const write = (chunk: string): void => {
    if (chunk === '') return

    // 代码块里原样落（只把 CRLF 归一）
    if (pre > 0) {
      buffer += chunk.replace(/\r\n?/gu, '\n')
      return
    }

    // 引用里**行首**补 `> `（多行段落也照补：否则第二行掉出引用）
    if (quote > 0 && (buffer === '' || buffer.endsWith('\n'))) buffer += '> '

    const flat = chunk.replace(/\s+/gu, ' ')
    if (flat === ' ') {
      // 纯空白：只在**行中**留一个词距，行首行尾一概不留
      if (buffer !== '' && !buffer.endsWith('\n') && !buffer.endsWith(' ')) buffer += ' '
      return
    }

    buffer += buffer.endsWith('\n') ? flat.replace(/^ /u, '') : flat
  }

  const open = (name: string, raw: string): void => {
    if (name === 'br') {
      ensure(1)
      return
    }
    if (name === 'hr') {
      ensure(2)
      write('---')
      ensure(2)
      return
    }
    if (name === 'img') {
      const alt = attributeOf(raw, 'alt') ?? ''
      const src = attributeOf(raw, 'src')
      if (src !== undefined) write(`![${alt}](${src})`)
      return
    }
    if (name === 'pre') {
      pre += 1
      ensure(2)
      write('```')
      ensure(1)
      return
    }
    if (name === 'code') {
      if (pre === 0) write('`')
      return
    }
    if (name === 'strong' || name === 'b') {
      write('**')
      return
    }
    if (name === 'em' || name === 'i') {
      write('*')
      return
    }
    if (name === 'a') {
      const href = attributeOf(raw, 'href')
      links.push(href)
      if (href !== undefined) write('[')
      return
    }
    if (name === 'h1' || name === 'h2' || name === 'h3' || name === 'h4' || name === 'h5' || name === 'h6') {
      ensure(2)
      write(`${'#'.repeat(Number(name.slice(1)))} `)
      return
    }
    if (name === 'ul' || name === 'ol') {
      ensure(2)
      lists.push(name === 'ol' ? 1 : -1)
      return
    }
    if (name === 'li') {
      ensure(1)
      const current = lists.at(-1) ?? -1
      const marker = current < 0 ? '- ' : `${current}. `
      if (current >= 0) lists[lists.length - 1] = current + 1
      write(`${'  '.repeat(Math.max(0, lists.length - 1))}${marker}`)
      return
    }
    if (name === 'blockquote') {
      ensure(2)
      quote += 1
      return
    }
    if (name === 'tr') {
      ensure(1)
      return
    }
    if (name === 'td' || name === 'th') {
      // 格子的开头写 `| `、结尾写一个空格（`close` 那一半），行尾由 `tr` 收上那个 `|`
      // ——合成 `| 甲 | 乙 |` 这一形（md 的表格行）
      write('| ')
      return
    }
    if (BLOCKS.has(name)) {
      ensure(2)
    }
  }

  const close = (name: string): void => {
    if (name === 'pre') {
      ensure(1)
      write('```')
      ensure(2)
      pre = Math.max(0, pre - 1)
      return
    }
    if (name === 'code') {
      if (pre === 0) write('`')
      return
    }
    if (name === 'strong' || name === 'b') {
      write('**')
      return
    }
    if (name === 'em' || name === 'i') {
      write('*')
      return
    }
    if (name === 'a') {
      const href = links.pop()
      if (href !== undefined) write(`](${href})`)
      return
    }
    if (name === 'ul' || name === 'ol') {
      lists.pop()
      ensure(2)
      return
    }
    if (name === 'blockquote') {
      ensure(2)
      quote = Math.max(0, quote - 1)
      return
    }
    if (name === 'tr') {
      // 行尾那一个 `|`（格尾已经留过空格了，这儿不再多加一个）
      write('|')
      ensure(1)
      return
    }
    if (name === 'td' || name === 'th') {
      // 格尾留一个空格：下一个格的 `| ` 接上来才不黏
      write(' ')
      return
    }
    if (BLOCKS.has(name)) ensure(2)
  }

  let at = 0
  for (const matched of body.matchAll(TOKEN)) {
    write(decodeEntities(body.slice(at, matched.index)))
    at = matched.index + matched[0].length

    const raw = matched[0]
    const name = TAG_NAME.exec(raw)?.[1]?.toLowerCase()
    if (name === undefined) continue

    // 自闭合那几件（`br` / `hr` / `img`）没有闭合标签可等，只走 `open` 这一半
    if (raw.startsWith('</')) close(name)
    else open(name, raw)
  }
  write(decodeEntities(body.slice(at)))

  out.push(
    buffer
      // 三行以上并成两行（嵌套块会多留几层空白）
      .replace(/\n{3,}/gu, '\n\n')
      .replace(/[ \t]+\n/gu, '\n')
      .trim(),
  )

  return title === undefined ? { markdown: out[0] ?? '' } : { title, markdown: out[0] ?? '' }
}

/** `<title>` 的正文——取不到就不给这一位（不拿第一个标题顶替）。 */
function titleOf(html: string): string | undefined {
  const matched = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  const text = matched?.[1] === undefined ? '' : decodeEntities(matched[1]).replace(/\s+/gu, ' ').trim()

  return text === '' ? undefined : text
}

/**
 * 取一个属性的值——两种引号都认。
 *
 * ⚠️ **不做实体解码之外的加工**：`href` 原样用（相对地址也照原样写进 markdown——
 * 把它拼成绝对地址需要知道 base，而这一件不知道也不猜）。
 */
function attributeOf(raw: string, name: string): string | undefined {
  const matched = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(raw)
  const value = matched?.[2] ?? matched?.[3] ?? matched?.[4]

  return value === undefined ? undefined : decodeEntities(value).trim()
}

/** 认得的实体——五个具名 ＋ 数字两种写法；其余原样留着（不猜）。 */
const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      // 越界 / 解析不出：原样留着（编一个字符出来比留着更坏）
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }

    return NAMED[body.toLowerCase()] ?? whole
  })
}
