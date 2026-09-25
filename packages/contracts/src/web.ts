/**
 * 共享语言 · 取网页（U72）。
 *
 * 出处：设计 · 网页与搜索（「两件工具」表的第一行）。这一件把**取回 → 转 markdown →
 * 按问题提炼 → 只交答案**串起来，省的是**主模型的上下文**（页面上万字，主模型不必看）。
 *
 * 本文件只有**两样**（都是「一处定、两处用」的规则载体，同 `config.ts` 的那三个纯函数）：
 *
 * 1. **`webTargetOf`——「这个地址取不取」的判定**。它是**产品规则**，不是某一域的实现细节：
 *    - 工具执行体据它**在发请求之前**拒（`localhost` / 无点主机名 / 非 http(s)）；
 *    - 权限域据它算**这一次发往哪个域名**（裁决卡上要写清去向，「总是允许」按域名记）；
 *    - 执行域的取回实现**再走一遍**（边界纪律：谁也不假设上游替它判过）。
 *
 *    ⚠️ **两处各写一遍就是两套「什么叫合法地址」**——审核展示的那个域名与实际发出去的
 *    那个域名从此可以不相等，而两处都「看着对」（`rules.ts` 对三格规则的那条老话同此）。
 *
 * 2. **`WEB_TARGET_SCHEME` 一类常量**——规矩只有一份：`http` 一律升 `https`、
 *    只认 http / https、`localhost` 与无点主机名一律拒（设计 · 网页与搜索「已定的取舍」）。
 *
 * ## 为什么拒的是**这几类**
 *
 * - **`localhost`**——取本机服务不是「取网页」，那件事归 `exec` ＋ `curl`（模型想调本地
 *   什么，说得出它要跑的命令）；从「取网页」这条路上进来，等于开了一条绕过命令分析的口子。
 * - **无点主机名**（`intranet` / `router`）——它们几乎只能是内网短名，公网上根本解析不了；
 *   拒掉不误伤正常取网。
 * - **IP 字面量**——同一条由头的推广：`127.0.0.1` 有「点」，却正是要挡的那一个；
 *   内网段（`10.` / `192.168.`）同理。**只认域名**这条规矩比逐条列黑名单牢靠。
 */

/** 取网页只认这两种协议（设计：不接任意协议）。 */
export const WEB_SCHEMES: readonly string[] = ['http:', 'https:']

/** 缓存时长——参照面是 15 分钟（设计 · 网页与搜索「已定的取舍」）。 */
export const WEB_CACHE_TTL_MS = 15 * 60 * 1000

/** 一次取网的**目标**——归一之后的地址 ＋ 它的域名（裁决卡与「总是允许」都认后者）。 */
export type WebTarget = {
  readonly ok: true
  /** 归一之后的地址（`http` 已升 `https`；凭据已摘掉）。 */
  readonly url: string
  /** 域名（小写，不含端口）——**这就是「发给哪个域名」那一格**。 */
  readonly host: string
}

/** 取不得——`reason` 是**给模型看的一句话**（它据此改法，不是看一句异常）。 */
export type WebTargetRefusal = {
  readonly ok: false
  readonly reason: string
}

/**
 * 归一一个地址——取得到就给 `{ ok: true, url, host }`，取不得就给**缘由**。
 *
 * 认得的写法：`https://host/path` · `http://host/path`（升 `https`）·
 * `host/path`（**没写协议按 `https` 办**——「取网页」这件事今天只有这一种合理默认）。
 * 认不得的：其它协议（`ftp:` / `file:` / `data:`）· 没有主机名 ·
 * `localhost` 与无点主机名 · IP 字面量（含 `[::1]`）。
 *
 * ⚠️ **凭据一律摘掉**（`https://user:pass@host/`）——那份口令是模型从别处抄来的，
 * 让它随一次取网发到第三方站点去，不是这一件该做的事；摘掉之后地址仍然成立。
 */
export function webTargetOf(raw: unknown): WebTarget | WebTargetRefusal {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '参数错误：url 须为非空字符串' }
  }

  const text = raw.trim()
  // **显式写了协议吗**——认的是 `scheme:` 那一段本身（`ftp:` / `file:` / `data:` 都算），
  // 不是「有没有 `//`」：`data:text/html,…` 没有 `//`，按「没写协议」补一发 `https://`
  // 会把它拼成一个解析不了的怪东西，报出来的是「不是一个能用的网址」——
  // 而它真正的毛病是**协议不对**（那句才是模型改得了的那一句）。
  const explicit = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(text)
  const withScheme = explicit ? text : `https://${text}`

  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, reason: `取不得「${text}」——这不是一个能用的网址` }
  }

  if (!WEB_SCHEMES.includes(parsed.protocol)) {
    return {
      ok: false,
      reason: `取不得「${text}」——「取网页」只认 http / https（这个是 ${parsed.protocol.replace(':', '')}）`,
    }
  }

  // 凭据不进这一趟（见函数头注）
  parsed.username = ''
  parsed.password = ''
  // **一律升 https**（设计明写）——解析之后再改协议，主机与路径原样
  parsed.protocol = 'https:'

  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '')

  if (host === '') {
    return { ok: false, reason: `取不得「${text}」——里面没有主机名` }
  }
  if (isLocalHost(host)) {
    return {
      ok: false,
      reason: `取不得「${text}」——本机地址（localhost）不走「取网页」这条路；要访问本地服务用 exec ＋ curl`,
    }
  }
  // ⚠️ **IP 那一条在「无点」之前**：`[::1]` 这一形**没有点**，落在后面就会被报成
  // 「不是一个完整域名」——话是拒了，可说错了缘由（`127.0.0.1` 有「点」，正好反过来）。
  // 两条各报各的，模型才知道自己该改什么。
  if (isIpLiteral(host)) {
    return { ok: false, reason: `取不得「${text}」——这串地址是直接写的 IP（${host}），只取域名` }
  }
  if (!host.includes('.')) {
    return { ok: false, reason: `取不得「${text}」——「${host}」不是一个完整域名（没有点的主机名一律不取）` }
  }

  return { ok: true, url: parsed.toString(), host }
}

/** `localhost` 与它的各级子域（`a.localhost`）——同一条由头。 */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost')
}

/**
 * IP 字面量——`127.0.0.1` / `192.168.1.1`（纯数字点串）与 `[::1]` / `[fe80::1]`（方括号）。
 *
 * ⚠️ 认法**不看具体网段**：逐条列私网段总有漏的（还有 `169.254.` 与各种映射写法），
 * 而「取网页取的是域名」这条规矩本来就排除了字面地址这一整类。
 */
function isIpLiteral(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) return true
  return /^[0-9.]+$/u.test(host)
}
