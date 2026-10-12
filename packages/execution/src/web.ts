/**
 * **取回面**（`WebSource` · U72）——出网这一件原语的实现。
 *
 * 出处：设计 · 网页与搜索「两件工具」表的第一行（抓一个 URL）；端口在契约 `ports.ts`。
 * 它落在执行域的理由与沙箱同源：**出网是边界动作**（读文件、起进程、发请求，都是「内核
 * 替模型伸出去的那只手」），网络边界要在一处落实，而不是让每个调用方各记一遍。
 *
 * ## 网络边界
 *
 * 1. **只认 http / https，且 `http` 一律升 `https`**、`localhost` 与无点主机名**发请求之前
 *    就拒**——判据是契约的 `webTargetOf`（**再走一遍**：本文件不假设上游替它判过，
 *    也不自己另写一套「什么叫合法地址」）；
 * 2. **不跟随跨主机重定向**——跳到别的主机就**不跟**，把「从哪跳到哪」交回去
 *    （设计明写：让模型自己再取一次）。跟过去的代价是具体的：**卡上写的那个域名与实际
 *    到达的域名不是一个**，而那张卡正是用户点头的地方。同主机的跳转照跟（`http → https`、
 *    补斜杠那一类换地址不变人），上限几跳，多了就报连不上。
 *
 * 响应体完整读取后才返回成功；读取失败、超时或取消不返回部分正文。
 *
 * ## 超时：**这一件有缺省上界**（与 `exec` 那条「不设上界」不冲突）
 *
 * `exec` 不定上界，是因为**只有模型知道自己在跑什么**（`ls` 还是构建），它按那件事给。
 * 这一件不是那样：动作只有一种（一个 HTTP GET），模型给不出更好的判断，而**挂死的代价
 * 全在用户那边**——一轮就此不动，无人看管时永远不回。故这里定一个宽裕的缺省（够慢站
 * 慢慢回），到点如实报「超时」，不谎称页面不存在。
 */

import type { PageFetch, WebSource } from '@magic/contracts'
import { webTargetOf } from '@magic/contracts'

/** 缺省超时——一次 GET 用不到这么久（见文件头注最后一段）。 */
export const WEB_FETCH_TIMEOUT_MS = 30_000

/** 同主机重定向最多跟几跳——跟上界同理，防环。 */
export const WEB_FETCH_MAX_REDIRECTS = 5

/** 出网时自报的名字——有些站点对没有 UA 的请求直接 403。 */
const USER_AGENT = 'magic/0.0 (+https://github.com/EchoJamie/magic-code)'

export type WebSourceOptions = {
  /** 取件实现——缺省全局 `fetch`（用例里换成桩，不出网）。 */
  readonly fetch?: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) | undefined
  readonly timeoutMs?: number | undefined
}

export function createWebSource(options: WebSourceOptions = {}): WebSource {
  const send = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS

  return {
    async fetchPage(raw: string, opts?: { readonly signal?: AbortSignal }): Promise<PageFetch> {
      // **发请求之前那一关**（见文件头注第 1 条）——地址不合格就连一个包都不发
      const first = webTargetOf(raw)
      if (!first.ok) return { ok: false, kind: 'refused', reason: first.reason }

      const deadline = AbortSignal.timeout(timeoutMs)
      const signal =
        opts?.signal === undefined ? deadline : AbortSignal.any([opts.signal, deadline])

      let current = first.url

      try {
        for (let hop = 0; hop <= WEB_FETCH_MAX_REDIRECTS; hop += 1) {
          const response = await send(current, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
            signal,
          })

          const location = response.headers.get('location')

          // **跨主机不跟**（见文件头注第 2 条）——同主机照跟
          if (isRedirect(response.status) && location !== null) {
            const next = webTargetOf(new URL(location, current).toString())
            if (!next.ok) {
              return {
                ok: false,
                kind: 'off-host-redirect',
                reason: `这个地址跳到了一个取不得的地方（${next.reason}）`,
                from: current,
                to: new URL(location, current).toString(),
              }
            }
            if (next.host !== first.host) {
              return {
                ok: false,
                kind: 'off-host-redirect',
                reason: `这个地址跳到了另一个域名（${next.host}）——本工具不跟跨主机跳转`,
                from: current,
                to: next.url,
              }
            }

            // 同主机：读完这个小响应体释放连接，再跟下一跳
            await response.body?.cancel().catch(() => {})
            current = next.url
            continue
          }

          if (response.status === 206) {
            await response.body?.cancel().catch(() => {})
            return { ok: false, kind: 'failed', reason: '服务器仅返回部分页面（HTTP 206），无法完整提炼' }
          }

          const body = await response.arrayBuffer()

          return {
            ok: true,
            url: current,
            status: response.status,
            bytes: body.byteLength,
            body: new TextDecoder().decode(body),
            ...(response.headers.get('content-type') === null
              ? {}
              : { contentType: response.headers.get('content-type') as string }),
          }
        }

        return {
          ok: false,
          kind: 'failed',
          reason: `取不回「${raw}」：它连着跳了 ${WEB_FETCH_MAX_REDIRECTS} 跳以上（像是转圈），已放弃`,
        }
      } catch (error) {
        return { ok: false, kind: 'failed', reason: `取不回「${current}」：${describe(error)}` }
      }
    },
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 抛出来的原委——`AbortError` 说人话（它是「超时 / 被掐断」，不是「页面坏了」）。 */
function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `超过 ${WEB_FETCH_TIMEOUT_MS / 1000} 秒没有回应（这一趟不再等）`
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '被中止'
    // `fetch` 的失败理由是「连不上 / 域名解析不了」那一类——原样带出（本域不改它的口径）
    return error.message === '' ? error.name : error.message
  }
  return String(error)
}
