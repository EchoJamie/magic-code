/**
 * `web_fetch` —— **取网页：取回 → 转 markdown → 按问题提炼 → 只交答案**（U72）。
 *
 * 出处：设计 · 网页与搜索「两件工具」表的第一行。**省的是上下文**——页面上万字，
 * 主模型不必看；这一件取回来、转成 markdown、让**一次模型调用**按模型自己给的问题
 * 把答案挑出来，只把答案交回去。（要原文时走 `exec` ＋ `curl`，那条路各管各的。）
 *
 * ## 为什么它不在「工具集 v1 七件」里（与 `skill` 同一处境）
 *
 * 那七件都是**对工作区的动作**（经沙箱）；这一件要的两样依赖不在本域默认射程里——
 * **取回面**（`WebSource`：出网是执行边界的事）与**提炼面**（`PageDistiller`：
 * 一次不带工具的模型调用）。故它由装配造好、从 `options.tools` 那个**追加出口**进来
 * （同 `defineSkillTool` / `definePlanTools`）。
 *
 * ⚠️ **「工具可以调模型」只到这一件为止**（设计 · 工具执行与权限那条护栏）：依赖是
 * **构造入参**，不是执行现场——`ToolRunContext` 一个字都没多。别的工具想调模型，
 * 是**再加一条这样的窄端口 ＋ 一次裁决**，不是把这一位挂到公共现场上。
 *
 * ## 那一次提炼调用的护栏（工单最要紧的一条）
 *
 * **不带任何工具、深度恒为 1**。它不是靠本文件的自觉：`PageDistiller.distill` 的入参里
 * **根本没有「工具」这一格**，交给模型域的 `ModelRequest` 也就没有 `tools` 可填
 * ——模型发不出工具调用，是**结构上**发不出（用例另有一支直接咬住出站请求的 `tools`）。
 *
 * ## 回执为什么非要写「不是原文」
 *
 * 「提炼」是**有损**的：它决定了主模型看到什么。「这一页没提到 X」**可能只是那句话没问到**
 * （设计原话）。不说清这一句，模型会把「我没问到」读成「没有」——那是一个据以做决定的
 * 错误结论，比答不出来坏得多。故抬头与结尾各说一遍（两处读者不同：抬头给扫一眼的，
 * 结尾给准备下结论的）。
 *
 * ## 措辞为什么在这个文件里而不在 `messages.ts`
 *
 * 同 `skill-tool.ts` / `plan-tools.ts`：`messages.ts` 收的是**分发那一层**的固定报文
 * （拒绝 / 取消 / 未注册……），而这几句是**这一件工具自己的话**（它的抬头、它的回执、
 * 它的出口提示），与它的参数模式同生共死，放在一起改起来才不会只改一半。
 */

import type { PageDistiller, WebSource } from '@magic/contracts'
import { WEB_CACHE_TTL_MS, webTargetOf } from '@magic/contracts'
import { isText } from './args.ts'
import { htmlToMarkdown } from './html.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused } from './toolkit.ts'

/** 页面正文交给提炼模型的上限（字符）——超出只取前一段**并明说**（见回执那几行）。 */
export const WEB_PAGE_MAX_CHARS = 100_000

/** 提炼出来的答案的上限（字符）——这一件的全部意义是**省上下文**，答案也得有界。 */
export const WEB_ANSWER_MAX_CHARS = 20_000

/** 缓存条数上限——**短时缓存**，不是资料库（见 `cacheOf`）。 */
export const WEB_CACHE_MAX_ENTRIES = 32

/**
 * 参数模式——键名锚定在本文件（`url` / `prompt`）。
 *
 * 不放进契约的「参数键全表」：那张表管的是**工具集 v1 七件**（阶段 2 冻结的公开词表），
 * 而这一件是与 `skill` 同一处来的**按需长出来的一件**（见文件头注）。
 *
 * `description` 是给模型读的说明书——两句话各答一件事：**取哪一页** · **要问什么**。
 * ⚠️ 末一句是**用法约束**（什么时候**不要**用它）：「要原文时用 exec ＋ curl」不写在这里，
 * 模型就会拿这一件去要原文，然后怪它给的答案不全。
 */
export const WEB_FETCH_PARAMETERS = {
  type: 'object',
  description:
    '取一个网页，按你的问题把答案挑出来——只回答案，不把整页原文塞进上下文。' +
    '要页面原文时不要用它，改用 exec 跑 curl。',
  properties: {
    url: {
      type: 'string',
      description: '要取的网页地址（http 一律按 https 取；本机地址与没有点的主机名取不了）',
    },
    prompt: {
      type: 'string',
      description: '你要知道什么——这一趟就按它从这一页里挑答案',
    },
  },
  required: ['url', 'prompt'],
  additionalProperties: false,
} as const

/**
 * 工具的构造入参——**两样依赖都由装配递进来**（见文件头注那两条「为什么」）。
 *
 * ⚠️ **`distiller` 缺席 ＝ 还没配「取网页用的模型」**——不是「这次装配没装」那种内部状态，
 * 而是**配置里那一格空着**（装配据 `MagicConfig.webFetch` 决定递不递）。缺席时这一件
 * **明说取不到**并**收束这一轮**（工单第 5 条），**不静默拿别的模型顶上**。
 *
 * 用「有没有这一位」表达，而不是再传一个 `configured: boolean`：**没有提炼模型就没有
 * 提炼这回事**，一个空对象或一句布尔标记都只是把同一件事换个地方说，还会多出
 * 「有一位但用不了」这种说不清的中间态。
 */
export type WebFetchDeps = {
  readonly web: WebSource
  /**
   * 提炼面——**每次调用现问一次**（给的是取它的函数，不是它本身）。
   *
   * 为什么不给现成的那一件：`webFetch` 那一格**随时可能被配上**，而这一件工具是
   * **造一次、用一路**的（缓存挂在它身上，不能每轮重造）。给函数＝**读数跟着配置走**：
   * 用户配完接着说一句，下一趟就通了（工单第 5 条那三步的第三步）。
   * 返回 `undefined` ＝ 此刻还没配。
   */
  readonly distiller?: (() => PageDistiller | undefined) | undefined
  /** 时钟——缓存与耗时都据它（用例里钉住时间）。 */
  readonly now?: (() => number) | undefined
}

/**
 * **还没配提炼用的模型**——这一轮就地收束（工单第 5 条）。
 *
 * ⚠️ **首行是一句要在 48 列里说全的话**——外壳取结果首行作结论，且**截到 48 列**
 * （`log.ts` 的 `firstLineOf`）。工单对它的要求正是「**用户看得到「去 /config 挑一个」**」，
 * 故这两截必须落在首行的前 48 列里（不然用户得先按 `ctrl+o` 才读得到，那就不叫看得到）。
 * 「这一轮停住」那半句因此下沉到第二行——它给**模型**看（模型读全文，不受这一截限制）。
 */
const NOT_CONFIGURED = [
  '还没配提炼用的模型——去 /config 挑一个',
  '这一趟取不到答案，这一轮就停在这儿：不拿别的模型顶上，也不绕道去抓原文。',
  '配好之后接着说一句就能继续。',
].join('\n')

/** 缓存里的一页——**取回来并转好 markdown 的那一份**（不是答案：答案随问题变）。 */
type CachedPage = {
  readonly at: number
  readonly url: string
  readonly status: number
  readonly bytes: number
  readonly chars: number
  readonly title?: string
  readonly markdown: string
}

export function defineWebFetchTool(deps: WebFetchDeps): ToolDefinition {
  const now = deps.now ?? Date.now
  const cache = new Map<string, CachedPage>()

  /**
   * 取回一页（或从短时缓存里拿）——`hit` 说这一页是不是缓存给的。
   *
   * ## 缓存的是**取回来的那一页**，不是答案
   *
   * 答案随问题变（同一个页面换一个问题就是另一个答案），拿它当缓存键要把问题也算进去，
   * 而那样**一条也用不上**（用户不会问两遍一样的问题）。缓存页面则两件事都成立：
   * 省掉的是**真取网那一次**（慢、且是对外的一次请求），而每次的问题照旧现提炼。
   *
   * ## 命中**要说一声**
   *
   * 设计明写：「命中要说一声，不假装是刚取的」。所以回执上那一行会换成「缓存命中」，
   * **不报取回耗时**——那一刻没有取回这回事，报一个数就是编。
   */
  const pageOf = async (
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly ok: true; readonly page: CachedPage; readonly hit: boolean } | { readonly ok: false; readonly output: string }> => {
    const cached = cache.get(url)
    if (cached !== undefined && now() - cached.at < WEB_CACHE_TTL_MS) {
      // 顺手挪到末尾——`Map` 的插入序就是这里用的 LRU
      cache.delete(url)
      cache.set(url, cached)
      return { ok: true, page: cached, hit: true }
    }

    const fetched = await deps.web.fetchPage(url, signal === undefined ? {} : { signal })

    if (!fetched.ok) {
      // 跨主机重定向**不跟**，但要说清**从哪跳到哪**——模型据此自己再取一次（设计明写）。
      //
      // ⚠️ **措辞由本工具一处出**（实现给的 `reason` 在这一支上不用）：屏上那半句结论
      // 只有**首行前 48 列**（`firstLineOf`），而「不跟跨主机跳转」这件事必须在那一截里。
      // 两处各说一遍（实现一句、这里再缀一句）只会把要紧的那几个字挤出屏外。
      if (fetched.kind === 'off-host-redirect') {
        const to = fetched.to ?? '另一处'
        const host = webTargetOf(to)

        return {
          ok: false,
          output: [
            `取不得这一页：它跳到了另一个域名（${host.ok ? host.host : to}）——不跟跨主机跳转。`,
            `从 ${fetched.from ?? url} 跳到 ${to}——要那一页，按新地址再取一次。`,
          ].join('\n'),
        }
      }
      return { ok: false, output: fetched.reason }
    }

    if (fetched.status >= 400) {
      return {
        ok: false,
        output: `取回失败：这个地址回了 ${fetched.status}（${fetched.bytes} 字节）——页面没取到，也就没有可提炼的内容`,
      }
    }

    // HTML 转 markdown；纯文本（`text/plain` 一类）原样用——它不是 HTML，转一遍只会伤它
    const looksHtml = /<\s*(?:!doctype|html|body|div|p|article|head)\b/iu.test(fetched.body.slice(0, 4096))
    const page: CachedPage = {
      at: now(),
      url: fetched.url,
      status: fetched.status,
      bytes: fetched.bytes,
      chars: fetched.body.length,
      ...(looksHtml ? htmlToMarkdown(fetched.body) : { markdown: fetched.body }),
    }

    cache.set(url, page)
    // 满了就把最早那一条挤掉——缓存只为省一次取网，不承担留存
    if (cache.size > WEB_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined && oldest !== url) cache.delete(oldest)
    }

    return { ok: true, page, hit: false }
  }

  return {
    spec: {
      name: 'web_fetch',
      summary: '取网页（取回 → 按问题提炼 → 只回答案）',
      parameters: WEB_FETCH_PARAMETERS,
      // **声明的是方向**（外发 ⇒ 必闸）；判定与「总是允许按域名」都在权限域
      //（`analyze.ts` 的 `analyzeWebFetch`，那张卡上写着域名）
      danger: { level: 'gated', reason: 'outbound' },
    },

    async run(args, ctx): Promise<ToolRunResult> {
      const url = args['url']
      if (!isText(url)) return refused('参数错误：url 须为非空字符串')

      const prompt = args['prompt']
      if (!isText(prompt)) return refused('参数错误：prompt 须为非空字符串')

      // **发请求之前就拒**（设计明写）——本机地址 / 无点主机名 / 非 http(s) 一律取不得
      const target = webTargetOf(url)
      if (!target.ok) return refused(target.reason)

      // ⚠️ **没配提炼模型：这一轮停住**（工单第 5 条）——拦在**取回之前**：
      // 这一趟注定提炼不了，那一次取网就不必发出去（既省一次对外请求，也不必先让人
      // 批一张注定跑不出结果的卡）。`halt` 让循环**不开下一轮**：模型看得到这句话，
      // 却没有下一轮去「想办法」——尤其不能改用 `exec curl` 把这一手整个绕过去。
      const distiller = deps.distiller?.()
      if (distiller === undefined) return { ok: false, output: NOT_CONFIGURED, halt: true }

      const started = now()

      const got = await pageOf(target.url, ctx.signal)
      if (!got.ok) return refused(got.output)

      const { page, hit } = got
      const body = page.markdown
      if (body.trim() === '') {
        return refused(
          `取回成功（${page.status} · ${formatBytes(page.bytes)}），但正文里没有可提炼的文字` +
            '——这一页大概是脚本渲染出来的，本工具读到的是空壳；要它渲染后的样子，改用 exec 里的浏览器类命令',
        )
      }

      const over = body.length > WEB_PAGE_MAX_CHARS
      const distilled = await distiller.distill(
        {
          url: page.url,
          page: over ? body.slice(0, WEB_PAGE_MAX_CHARS) : body,
          prompt,
        },
        ctx.signal === undefined ? {} : { signal: ctx.signal },
      )

      // 配了但这一趟没成（连不上 / 供应商报错 / 没给出答案）——**照普通失败办**：
      // 模型据这句话改法或如实告诉用户。它**不 `halt`**：halt 只留给「没配」那一种
      //（那一种才是模型没法自己处置的——它的每一种「想办法」都会把这一手绕过去）。
      if (!distilled.ok) return refused(`提炼没成：${distilled.reason}`)

      return {
        ok: true,
        output: compose({
          page,
          hit,
          elapsedMs: now() - started,
          model: distilled.model,
          answer: distilled.answer,
          over,
        }),
      }
    },
  }
}

/**
 * 回执 —— **两行抬头 ＋ 答案**。抬头报收据，答案在最后（它是这一份的正文）。
 *
 * ## 那句「不是原文」为什么落在抬头而不是结尾
 *
 * 它必须说（设计明写：别让模型把「没问到」读成「没有」），但**只说一遍**——
 * 开头一句、结尾再来一句，那是同一件事说两遍（一屏上的每条各说一件别处没说的）。
 * 落在抬头那两行里，与「取的哪个地址、多大、多久、哪个模型」同处：它们都是
 * **这一份是什么**的说明，读到第一行就一起读到。
 *
 * ## 答案为什么放末行（这一条是给屏上的）
 *
 * 工具行折着的时候，外壳取**末条非空行**当那半句结论（`log.ts` 的 `summaryOf`）——
 * 答案放末行 ⇒ 屏上那半句就是**它答了什么**。放别的行，屏上要么是那句警告、
 * 要么是收据，都不是「结果是什么」。
 */
function compose(input: {
  readonly page: CachedPage
  readonly hit: boolean
  readonly elapsedMs: number
  readonly model: string
  readonly answer: string
  readonly over: boolean
}): string {
  const { page, hit, elapsedMs, model, answer, over } = input

  // 命中不报取回耗时——那一刻没有取回这回事（见 `pageOf`）
  const retrieval = hit
    ? `${page.url} · ${page.status} · ${formatBytes(page.bytes)} · 缓存命中（${WEB_CACHE_TTL_MS / 60_000} 分钟内取过，没有再取）`
    : `${page.url} · ${page.status} · ${formatBytes(page.bytes)} · ${formatMs(elapsedMs)}`

  const truncated = answer.length > WEB_ANSWER_MAX_CHARS
  const body = truncated ? answer.slice(0, WEB_ANSWER_MAX_CHARS) : answer

  return [
    `取回 ${retrieval}${over ? ` · 正文超长，只把前 ${WEB_PAGE_MAX_CHARS} 字交给提炼` : ''}`,
    // 收据第二行——**「这是什么」**：哪个模型提炼的、以及那句要紧的分寸
    `提炼 按你问的那件事挑出的答案 · 不是原文 · 模型 ${model}`,
    // 收据第三行——**「它答不了什么」**：与上一行各说一件事，不是重复（那一条是说清
    // 「这是提炼」，这一条是说清「提炼可能漏」——「没问到 ≠ 没有」正是这一处）
    '没问到的这一页未必没有；要看原文，用 exec ＋ curl 取。',
    '',
    body,
    ...(truncated ? ['', `[答案超长，已截到 ${WEB_ANSWER_MAX_CHARS} 字]`] : []),
  ].join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}
